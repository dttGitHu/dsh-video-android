/**
 * 即梦适配器（火山方舟 Ark）。
 *
 * 鉴权：方舟 API Key，`Authorization: Bearer <JIMENG_API_KEY>`。
 * 图像：POST /images/generations —— 同步返回图片 URL。
 * 视频：POST /contents/generations/tasks → 任务 id；GET 同一路径 + /{id} 轮询。
 *
 * 平台专有错误码先过 JIMENG_CODE_MAP，未命中再交给通用五类映射。
 * @module providers/jimeng
 */
import { randomUUID } from 'node:crypto'
import { ProviderError, classifyFailure } from './errors.js'
import { requestJson } from './http.js'

export const JIMENG_NAME = 'jimeng'
export const JIMENG_LABEL = '即梦（火山方舟）'

/** 方舟常见错误码 / 关键文案 → 五类失败。按顺序匹配，先命中先返回。 */
export const JIMENG_CODE_MAP = [
  { test: /(input|output)?[_\s-]?sensitive|sensitivecontent|content[_\s-]?policy|risk/i, kind: 'content_review' },
  { test: /authentication|invalid[_\s-]*api[_\s-]*key|unauthori[sz]ed|signature/i, kind: 'auth' },
  { test: /ratelimit|rate[_\s-]?limit|quota|throttl/i, kind: 'rate_limit' },
  { test: /internal|service[_\s-]?unavailable|servererror/i, kind: 'server' },
  { test: /invalid[_\s-]?parameter|bad[_\s-]?request/i, kind: 'server' },
]

/** 常见宽高比 → 方舟图像尺寸（可用 params.size 覆盖）。 */
export const SIZE_BY_RATIO = {
  '1:1': '1024x1024',
  '16:9': '1280x720',
  '9:16': '720x1280',
  '4:3': '1152x864',
  '3:4': '864x1152',
  '21:9': '1512x648',
}

/**
 * 把平台专有错误码归类；没有命中就用通用规则。
 * @param {{code?: string|number|null, message?: string|null, httpStatus?: number|null}} input
 */
export function classifyJimengError(input) {
  const text = `${input.code ?? ''} ${input.message ?? ''}`
  for (const rule of JIMENG_CODE_MAP) {
    if (rule.test.test(text)) return { kind: rule.kind, retryable: rule.kind !== 'auth' }
  }
  return classifyFailure({ ...input, provider: JIMENG_NAME })
}

/**
 * 方舟视频任务把参数写在 text 里（`--duration 5 --ratio 16:9` 形式）。
 * @param {string} prompt
 * @param {{aspectRatio?: string, duration?: number|string, resolution?: string, watermark?: boolean}} params
 */
export function composeJimengVideoText(prompt, params = {}) {
  const parts = [String(prompt ?? '').trim()]
  if (params.aspectRatio) parts.push(`--ratio ${params.aspectRatio}`)
  if (params.duration !== undefined && params.duration !== null && params.duration !== '') {
    const duration = Math.max(1, Math.round(Number(params.duration)))
    if (Number.isFinite(duration)) parts.push(`--duration ${duration}`)
  }
  if (params.resolution) parts.push(`--resolution ${params.resolution}`)
  if (params.watermark === true) parts.push('--watermark true')
  return parts.join(' ')
}

/**
 * 创建即梦适配器。
 * @param {{
 *   apiKey: string,
 *   apiKeySource?: string,
 *   baseURL: string,
 *   imageModel: string,
 *   videoModel: string,
 * }} config
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   requestTimeoutMs?: number,
 * }} [deps]
 */
export function createJimengProvider(config, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const requestTimeoutMs = deps.requestTimeoutMs ?? 60_000
  const baseURL = String(config.baseURL ?? 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '')
  const apiKey = String(config.apiKey ?? '').trim()
  const imageModel = String(config.imageModel ?? 'doubao-seedream-4-0-20260415')
  const videoModel = String(config.videoModel ?? 'doubao-seedance-2-0-260128')

  const authorization = () => ({ authorization: `Bearer ${apiKey}` })

  function requireKey() {
    if (apiKey === '') {
      throw new ProviderError({
        provider: JIMENG_NAME,
        kind: 'auth',
        retryable: false,
        message: '未配置 JIMENG_API_KEY（即梦）：请在环境变量或 cordis.patch.yml 的 config.providers.jimeng.apiKey 里配置',
      })
    }
  }

  /** 把一次业务失败转成 ProviderError（方舟错误码优先）。 */
  function failFromPayload(payload, httpStatus = 200) {
    const code = payload?.error?.code ?? payload?.code ?? null
    const message = payload?.error?.message ?? payload?.message ?? '未知错误'
    const classified = classifyJimengError({ code, message, httpStatus })
    return new ProviderError({
      provider: JIMENG_NAME,
      kind: classified.kind,
      retryable: classified.retryable,
      httpStatus,
      code,
      message: `即梦：${message}`,
      raw: payload,
    })
  }

  return {
    name: JIMENG_NAME,
    label: JIMENG_LABEL,
    supports: ['image', 'video'],

    /** 密钥是否就绪（调度器先查这个，再决定是否尝试）。 */
    isConfigured() {
      if (apiKey === '') return { ok: false, missing: ['JIMENG_API_KEY'] }
      return { ok: true, source: config.apiKeySource ?? 'env' }
    },

    /**
     * 提交任务。图像同步返回 URL；视频返回任务 id。
     * @param {{kind: 'image'|'video', prompt: string, params?: Record<string, any>, signal?: AbortSignal}} input
     */
    async submit({ kind, prompt, params = {}, signal }) {
      requireKey()
      if (kind === 'image') {
        const body = {
          model: params.model || imageModel,
          prompt,
          response_format: 'url',
          size: params.size || SIZE_BY_RATIO[params.aspectRatio] || '1024x1024',
        }
        if (params.seed !== undefined) body.seed = params.seed
        if (params.watermark === true) body.watermark = true
        const response = await requestJson({
          fetchImpl,
          provider: JIMENG_NAME,
          url: `${baseURL}/images/generations`,
          method: 'POST',
          headers: authorization(),
          body,
          timeoutMs: requestTimeoutMs,
          signal,
        })
        const url = response.json?.data?.[0]?.url ?? null
        if (!url) {
          throw new ProviderError({
            provider: JIMENG_NAME,
            kind: 'server',
            retryable: false,
            message: '即梦图像接口返回成功，但响应里没有图片 URL',
            raw: response.json,
          })
        }
        return { taskId: `jimeng-image-${randomUUID()}`, url, raw: response.json }
      }

      const text = composeJimengVideoText(prompt, params)
      const body = {
        model: params.model || videoModel,
        content: [{ type: 'text', text }],
      }
      if (params.seed !== undefined) body.seed = params.seed
      const response = await requestJson({
        fetchImpl,
        provider: JIMENG_NAME,
        url: `${baseURL}/contents/generations/tasks`,
        method: 'POST',
        headers: authorization(),
        body,
        timeoutMs: requestTimeoutMs,
        signal,
      })
      const taskId = response.json?.id ?? null
      if (!taskId) {
        throw new ProviderError({
          provider: JIMENG_NAME,
          kind: 'server',
          retryable: false,
          message: '即梦视频接口返回成功，但响应里没有任务 id',
          raw: response.json,
        })
      }
      return { taskId, raw: response.json }
    },

    /**
     * 查询一个视频任务。
     * @param {string} taskId
     * @param {{signal?: AbortSignal}} [options]
     */
    async poll(taskId, options = {}) {
      requireKey()
      const response = await requestJson({
        fetchImpl,
        provider: JIMENG_NAME,
        url: `${baseURL}/contents/generations/tasks/${encodeURIComponent(taskId)}`,
        headers: authorization(),
        timeoutMs: requestTimeoutMs,
        signal: options.signal,
      })
      const payload = response.json ?? {}
      const status = String(payload.status ?? '').toLowerCase()

      if (status === 'succeeded' || status === 'success') {
        const url = payload.content?.video_url ?? payload.video_url ?? null
        if (!url) {
          return {
            status: 'failed',
            error: { kind: 'server', retryable: false, message: '即梦任务成功，但响应里没有视频 URL' },
            raw: payload,
          }
        }
        return { status: 'succeeded', url, raw: payload }
      }

      if (status === 'failed' || status === 'cancelled' || status === 'expired') {
        const classified = classifyJimengError({
          code: payload.error?.code ?? null,
          message: payload.error?.message ?? status,
          httpStatus: 200,
        })
        return {
          status: 'failed',
          error: {
            kind: classified.kind,
            retryable: classified.retryable,
            message: `即梦任务${status === 'failed' ? '失败' : status}：${payload.error?.message ?? '未给出原因'}`,
          },
          raw: payload,
        }
      }

      return { status: 'pending', raw: payload }
    },

    /** 统一错误分类入口。 */
    classifyError(error) {
      if (error instanceof ProviderError) return { kind: error.kind, retryable: error.retryable }
      const classified = classifyJimengError({
        code: error?.code ?? null,
        message: error?.message ?? String(error),
        httpStatus: error?.httpStatus ?? null,
      })
      return { kind: classified.kind, retryable: classified.retryable }
    },
  }
}
