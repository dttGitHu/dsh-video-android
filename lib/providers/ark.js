/**
 * 火山方舟通用适配器：Doubao Seedream（图像）/ Doubao Seedance（视频）共用。
 *
 * 与 jimeng.js 同一套鉴权与端点，只是把 name / label / supports / 默认模型
 * 参数化，便于池里出现多个「方舟账号 + 不同模型」的条目。
 * @module providers/ark
 */
import { randomUUID } from 'node:crypto'
import { ProviderError, classifyFailure } from './errors.js'
import { requestJson } from './http.js'
import { classifyJimengError, composeJimengVideoText, SIZE_BY_RATIO } from './jimeng.js'

/**
 * 创建方舟供应商。
 * @param {{
 *   name: string, label: string, supports?: string[],
 *   apiKey: string, apiKeySource?: string, baseURL: string,
 *   imageModel?: string, videoModel?: string,
 * }} config
 * @param {{fetchImpl?: typeof fetch, requestTimeoutMs?: number}} [deps]
 */
export function createArkProvider(config, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const requestTimeoutMs = deps.requestTimeoutMs ?? 60_000
  const name = config.name
  const label = config.label
  const supports = Array.isArray(config.supports) && config.supports.length > 0 ? config.supports : ['image', 'video']
  const baseURL = String(config.baseURL ?? 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '')
  const apiKey = String(config.apiKey ?? '').trim()
  const imageModel = String(config.imageModel ?? 'doubao-seedream-4-0-20260415')
  const videoModel = String(config.videoModel ?? 'doubao-seedance-2-0-260128')
  const authorization = () => ({ authorization: `Bearer ${apiKey}` })

  function requireKey() {
    if (apiKey === '') {
      throw new ProviderError({
        provider: name, kind: 'auth', retryable: false,
        message: `未配置 ${config.envName ?? 'API Key'}（${label}）：请在环境变量或 cordis.patch.yml 的 config.providers 里配置`,
      })
    }
  }

  function failFromPayload(payload, httpStatus = 200) {
    const code = payload?.error?.code ?? payload?.code ?? null
    const message = payload?.error?.message ?? payload?.message ?? '未知错误'
    const classified = classifyJimengError({ code, message, httpStatus })
    return new ProviderError({
      provider: name, kind: classified.kind, retryable: classified.retryable,
      httpStatus, code, message: `${label}：${message}`, raw: payload,
    })
  }

  return {
    name,
    label,
    supports,
    isConfigured() {
      if (apiKey === '') return { ok: false, missing: [config.envName ?? 'API Key'] }
      return { ok: true, source: config.apiKeySource ?? 'env' }
    },
    async submit({ kind, prompt, params = {}, signal }) {
      requireKey()
      if (!supports.includes(kind)) {
        throw new ProviderError({ provider: name, kind: 'server', retryable: false, message: `${label} 不支持生成 ${kind}` })
      }
      if (kind === 'image') {
        const body = {
          model: params.model || imageModel,
          prompt,
          response_format: 'url',
          size: params.size || SIZE_BY_RATIO[params.aspectRatio] || '1024x1024',
        }
        if (params.seed !== undefined) body.seed = params.seed
        const response = await requestJson({
          fetchImpl, provider: name, url: `${baseURL}/images/generations`, method: 'POST',
          headers: authorization(), body, timeoutMs: requestTimeoutMs, signal,
        })
        const url = response.json?.data?.[0]?.url ?? null
        if (!url) {
          throw new ProviderError({ provider: name, kind: 'server', retryable: false, message: `${label} 图像接口没有返回 URL`, raw: response.json })
        }
        return { taskId: `${name}-image-${randomUUID()}`, url, raw: response.json }
      }
      const text = composeJimengVideoText(prompt, params)
      const body = { model: params.model || videoModel, content: [{ type: 'text', text }] }
      if (params.seed !== undefined) body.seed = params.seed
      const response = await requestJson({
        fetchImpl, provider: name, url: `${baseURL}/contents/generations/tasks`, method: 'POST',
        headers: authorization(), body, timeoutMs: requestTimeoutMs, signal,
      })
      const taskId = response.json?.id ?? null
      if (!taskId) {
        throw new ProviderError({ provider: name, kind: 'server', retryable: false, message: `${label} 视频接口没有返回任务 id`, raw: response.json })
      }
      return { taskId, raw: response.json }
    },
    async poll(taskId, options = {}) {
      requireKey()
      const response = await requestJson({
        fetchImpl, provider: name, url: `${baseURL}/contents/generations/tasks/${encodeURIComponent(taskId)}`,
        headers: authorization(), timeoutMs: requestTimeoutMs, signal: options.signal,
      })
      const payload = response.json ?? {}
      const status = String(payload.status ?? '').toLowerCase()
      if (status === 'succeeded' || status === 'success') {
        const url = payload.content?.video_url ?? payload.video_url ?? null
        if (!url) return { status: 'failed', error: { kind: 'server', retryable: false, message: `${label} 任务成功但没有视频 URL` }, raw: payload }
        return { status: 'succeeded', url, raw: payload }
      }
      if (status === 'failed' || status === 'cancelled' || status === 'expired') {
        const classified = classifyJimengError({ code: payload.error?.code ?? null, message: payload.error?.message ?? status, httpStatus: 200 })
        return { status: 'failed', error: { kind: classified.kind, retryable: classified.retryable, message: `${label} 任务失败：${payload.error?.message ?? '未给出原因'}` }, raw: payload }
      }
      return { status: 'pending', raw: payload }
    },
    classifyError(error) {
      if (error instanceof ProviderError) return { kind: error.kind, retryable: error.retryable }
      const classified = classifyFailure({ code: error?.code, message: error?.message, httpStatus: error?.httpStatus, provider: name })
      return { kind: classified.kind, retryable: classified.retryable }
    },
  }
}
