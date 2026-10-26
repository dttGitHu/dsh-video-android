/**
 * 轮询：有上限、有退避、可取消。
 *
 * 默认节奏（对应「5s 起步 → 10s → 20s 封顶」）：
 *   提交后先等 initialDelayMs（默认 5s）
 *   第 1 次查询后隔 10s，第 2 次后 20s，之后一直 20s
 *   最多 maxPolls 次（默认 60）
 *
 * 所有等待都通过 `sleep(ms, signal)`：插件卸载或会话取消时 signal abort，
 * 定时器立即清理，不会留下「僵尸等待」。
 * @module polling
 */
import { ProviderError } from './providers/errors.js'

/** 默认轮询节奏。 */
export const DEFAULT_POLLING = Object.freeze({
  maxPolls: 60,
  initialDelayMs: 5_000,
  maxDelayMs: 20_000,
})

/**
 * 第 n 次查询之后、下一次查询之前的等待时长（n 从 1 开始）。
 * 5s 起步（首次查询前），之后 10s、20s、20s…
 * @param {number} n 已完成的查询次数（>= 1）
 * @param {{initialDelayMs?: number, maxDelayMs?: number}} [options]
 */
export function pollDelayMs(n, options = {}) {
  const initial = Math.max(0, Number(options.initialDelayMs ?? DEFAULT_POLLING.initialDelayMs) || 0)
  const max = Math.max(0, Number(options.maxDelayMs ?? DEFAULT_POLLING.maxDelayMs) || 0)
  if (n <= 0) return initial
  const doubled = initial * 2 ** n
  return max > 0 ? Math.min(max, doubled) : doubled
}

/**
 * 可取消的等待。
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('等待被取消'))
      return
    }
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(signal.reason ?? new Error('等待被取消'))
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, Math.max(0, ms))
    // 不 unref：独立脚本/测试里只有这一个定时器时，unref 会让进程提前退出
    // （表现为 unsettled top-level await）。插件卸载时会 abort → clearTimeout。
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * 轮询直到任务成功、失败或达到上限。
 * @param {{
 *   provider: {name: string, poll: Function},
 *   taskId: string,
 *   kind: 'image'|'video',
 *   maxPolls?: number,
 *   initialDelayMs?: number,
 *   maxDelayMs?: number,
 *   signal?: AbortSignal,
 *   sleepImpl?: typeof sleep,
 *   onPoll?: (info: {polls: number, status: string}) => void,
 * }} input
 */
export async function pollUntilDone(input) {
  const {
    provider,
    taskId,
    kind,
    signal,
    onPoll,
  } = input
  const maxPolls = Math.max(1, Math.round(Number(input.maxPolls ?? DEFAULT_POLLING.maxPolls)))
  const initialDelayMs = Math.max(0, Number(input.initialDelayMs ?? DEFAULT_POLLING.initialDelayMs))
  const maxDelayMs = Math.max(0, Number(input.maxDelayMs ?? DEFAULT_POLLING.maxDelayMs))
  const wait = input.sleepImpl ?? sleep

  let polls = 0
  let lastStatus = 'pending'

  // 提交后先等一个起步间隔，避免打空请求。
  await wait(initialDelayMs, signal)

  while (polls < maxPolls) {
    if (signal?.aborted) {
      throw new ProviderError({
        provider: provider.name,
        kind: 'network',
        retryable: false,
        cancelled: true,
        message: `${provider.name} 轮询被取消`,
      })
    }

    const result = await provider.poll(taskId, { kind, signal })
    polls += 1
    lastStatus = result?.status ?? 'pending'
    onPoll?.({ polls, status: lastStatus })

    if (lastStatus === 'succeeded') {
      return { status: 'succeeded', url: result.url ?? null, polls, raw: result.raw ?? null }
    }
    if (lastStatus === 'failed') {
      throw new ProviderError({
        provider: provider.name,
        kind: result?.error?.kind ?? 'server',
        retryable: result?.error?.retryable ?? false,
        message: result?.error?.message ?? `${provider.name} 任务失败`,
        raw: result?.raw ?? null,
      })
    }
    if (polls >= maxPolls) {
      throw new ProviderError({
        provider: provider.name,
        kind: 'server',
        retryable: false,
        message: `${provider.name} 轮询 ${maxPolls} 次仍未完成（最后状态 ${lastStatus}），已放弃`,
      })
    }

    await wait(pollDelayMs(polls, { initialDelayMs, maxDelayMs }), signal)
  }

  throw new ProviderError({
    provider: provider.name,
    kind: 'server',
    retryable: false,
    message: `${provider.name} 轮询达到上限（${maxPolls} 次）`,
  })
}
