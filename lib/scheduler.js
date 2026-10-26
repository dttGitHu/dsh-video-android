/**
 * 调度器：供应商池 + 失败分类 + 逐个切换 + 结构化 switchTrace。
 *
 * 策略（对应模块 2 的要求）：
 * - rate_limit / network / server：同一供应商内先退避重试一次，再切换；
 * - auth：不同供应商内重试，直接切换（可能是单个 Key 失效）；
 * - content_review：不重试同一家，直接跨供应商（不同平台审核尺度不同）。
 *
 * 每一次跨供应商的切换都会写进 switchTrace，形如：
 *   { from: 'jimeng', to: 'kling', reason: 'rate_limit', attempt: 2 }
 * attempt 表示「切换后将是第几次供应商尝试」。
 * @module scheduler
 */
import { pollUntilDone, sleep } from './polling.js'

/** 可重试的失败类型（同供应商内值得再试一次）。 */
const SAME_PROVIDER_RETRY_KINDS = new Set(['rate_limit', 'network', 'server'])

function clamp(value, min, max) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return min
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

/**
 * 决定尝试顺序：显式指定的供应商优先，其余按池顺序。
 * @param {Array<{name: string}>} providers
 * @param {string} [preferred]
 */
export function orderProviders(providers, preferred) {
  const ordered = []
  if (typeof preferred === 'string' && preferred !== '') {
    const match = providers.find((provider) => provider.name === preferred)
    if (match) ordered.push(match)
  }
  for (const provider of providers) {
    if (!ordered.includes(provider)) ordered.push(provider)
  }
  return ordered
}

/** 未配置供应商的 attempt 记录。 */
function skippedAttempt(provider, config) {
  return {
    provider: provider.name,
    outcome: 'skipped',
    kind: 'auth',
    message: `未配置 ${config.missing.join(' / ')}`,
    missing: [...config.missing],
    ms: 0,
    polls: null,
  }
}

/** 全池都没有可用密钥时的错误（验收项 3：必须可读，不是裸 fetch 报错）。 */
export function buildMissingProvidersError(providers) {
  const missing = []
  for (const provider of providers) {
    const config = provider.isConfigured()
    if (!config.ok) missing.push({ provider: provider.name, label: provider.label, missing: [...config.missing] })
  }
  const detail = missing.map((item) => `${item.label}：缺 ${item.missing.join(' / ')}`).join('；')
  return {
    kind: 'auth',
    provider: null,
    retryable: false,
    message: `未配置任何可用的生成供应商。${detail}。请配置环境变量（JIMENG_API_KEY / KLING_ACCESS_KEY / KLING_SECRET_KEY）或 cordis.patch.yml 的 config.providers，然后重启 DSHA。`,
    missing,
  }
}

/** 汇总最终失败原因：每家一条，未配置也写清楚。 */
function summarizeFailure(attempts, providers) {
  const labels = new Map(providers.map((provider) => [provider.name, provider.label]))
  const latest = new Map()
  for (const attempt of attempts) latest.set(attempt.provider, attempt)
  const lines = []
  for (const [name, attempt] of latest) {
    const label = labels.get(name) ?? name
    if (attempt.outcome === 'skipped') {
      lines.push(`${label}：未配置（${(attempt.missing ?? []).join(' / ')}）`)
    } else if (attempt.outcome === 'failed') {
      lines.push(`${label}：${attempt.kind} —— ${attempt.message}`)
    }
  }
  return lines.length === 0 ? '没有供应商可供尝试。' : `所有尝试都失败。${lines.join('；')}`
}

/**
 * 执行一次生成（图像或视频），失败自动切换供应商。
 * @param {{
 *   kind: 'image'|'video',
 *   prompt: string,
 *   params?: Record<string, any>,
 *   settings: ReturnType<typeof import('./settings.js').resolveSettings>,
 *   providers: Array<any>,
 *   signal?: AbortSignal,
 *   maxPolls?: number,
 *   initialDelayMs?: number,
 *   maxDelayMs?: number,
 *   sleepImpl?: typeof sleep,
 * }} input
 */
export async function generateWithFailover(input) {
  const { kind, prompt, params = {}, settings, providers, signal } = input
  const wait = input.sleepImpl ?? sleep
  const polling = settings?.polling ?? {}
  const failover = settings?.failover ?? {}

  const maxPolls = clamp(input.maxPolls ?? polling.maxPolls ?? 60, 1, 240)
  const initialDelayMs = clamp(input.initialDelayMs ?? polling.initialDelayMs ?? 5_000, 0, 60_000)
  const maxDelayMs = clamp(input.maxDelayMs ?? polling.maxDelayMs ?? 20_000, 0, 120_000)
  const sameProviderRetries = clamp(failover.sameProviderRetries ?? 1, 0, 3)
  const retryDelayMs = clamp(failover.retryDelayMs ?? 800, 0, 30_000)

  const startedAt = Date.now()
  const attempts = []
  const switchTrace = []
  const ordered = orderProviders(providers, params.provider)

  // 池里谁有密钥谁没密钥，先分清楚：没有密钥的供应商不发请求。
  const available = []
  for (const provider of ordered) {
    // 先按生成类型过滤：图像专用供应商不参与视频任务，反之亦然。
    if (Array.isArray(provider.supports) && !provider.supports.includes(kind)) {
      attempts.push({
        provider: provider.name,
        outcome: 'skipped',
        kind: 'server',
        message: `不支持生成 ${kind}`,
        missing: [],
        ms: 0,
        polls: null,
      })
      continue
    }
    const config = provider.isConfigured()
    if (config.ok) available.push(provider)
    else attempts.push(skippedAttempt(provider, config))
  }

  if (available.length === 0) {
    return {
      ok: false,
      provider: null,
      providerLabel: null,
      taskId: null,
      url: null,
      polls: 0,
      attempts,
      switchTrace,
      elapsedMs: Date.now() - startedAt,
      error: buildMissingProvidersError(providers),
    }
  }

  let lastFailure = null

  for (let index = 0; index < available.length; index += 1) {
    const provider = available[index]
    const attemptNo = index + 1

    for (let retry = 0; retry <= sameProviderRetries; retry += 1) {
      if (signal?.aborted) break

      const attemptStarted = Date.now()
      let polls = 0

      try {
        const submitted = await provider.submit({ kind, prompt, params, signal })

        // 图像这类同步接口：submit 直接带回素材 URL，不用轮询。
        if (typeof submitted?.url === 'string' && submitted.url !== '') {
          attempts.push({
            provider: provider.name,
            outcome: 'succeeded',
            kind: null,
            message: null,
            ms: Date.now() - attemptStarted,
            polls: 0,
          })
          return {
            ok: true,
            provider: provider.name,
            providerLabel: provider.label,
            taskId: submitted.taskId ?? null,
            url: submitted.url,
            polls: 0,
            attempts,
            switchTrace,
            elapsedMs: Date.now() - startedAt,
          }
        }

        const polled = await pollUntilDone({
          provider,
          taskId: submitted.taskId,
          kind,
          maxPolls,
          initialDelayMs,
          maxDelayMs,
          signal,
          sleepImpl: wait,
          onPoll: ({ polls: done }) => {
            polls = done
          },
        })

        attempts.push({
          provider: provider.name,
          outcome: 'succeeded',
          kind: null,
          message: null,
          ms: Date.now() - attemptStarted,
          polls,
        })
        return {
          ok: true,
          provider: provider.name,
          providerLabel: provider.label,
          taskId: submitted.taskId ?? null,
          url: polled.url,
          polls,
          attempts,
          switchTrace,
          elapsedMs: Date.now() - startedAt,
        }
      } catch (error) {
        const classified = provider.classifyError(error)
        const cancelled = error?.cancelled === true || signal?.aborted === true
        const failure = {
          kind: classified.kind,
          provider: provider.name,
          retryable: classified.retryable,
          message: error?.message ?? String(error),
          cancelled,
        }
        attempts.push({
          provider: provider.name,
          outcome: 'failed',
          kind: failure.kind,
          message: failure.message,
          ms: Date.now() - attemptStarted,
          polls,
        })

        if (cancelled) {
          return {
            ok: false,
            provider: provider.name,
            providerLabel: provider.label,
            taskId: null,
            url: null,
            polls,
            attempts,
            switchTrace,
            elapsedMs: Date.now() - startedAt,
            error: {
              kind: 'network',
              provider: provider.name,
              retryable: false,
              message: '生成任务被取消。',
            },
          }
        }

        lastFailure = failure

        // 同一家先退避重试一次（只对限流/网络/服务端）。
        if (retry < sameProviderRetries && SAME_PROVIDER_RETRY_KINDS.has(classified.kind)) {
          await wait(retryDelayMs * (retry + 1), signal)
          continue
        }
        break
      }
    }

    // 记录切到下一家的结构化轨迹。
    const next = available[index + 1]
    if (next) {
      switchTrace.push({
        from: provider.name,
        to: next.name,
        reason: lastFailure?.kind ?? 'server',
        attempt: attemptNo + 1,
        message: lastFailure?.message ?? null,
      })
    }
  }

  return {
    ok: false,
    provider: lastFailure?.provider ?? available[available.length - 1]?.name ?? null,
    providerLabel: null,
    taskId: null,
    url: null,
    polls: 0,
    attempts,
    switchTrace,
    elapsedMs: Date.now() - startedAt,
    error: {
      kind: lastFailure?.kind ?? 'server',
      provider: lastFailure?.provider ?? null,
      retryable: false,
      message: summarizeFailure(attempts, ordered),
    },
  }
}
