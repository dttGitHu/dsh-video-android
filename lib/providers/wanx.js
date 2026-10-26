/**
 * 通义万相适配器（DashScope）：图像 text2image 与视频 video-generation 均为异步任务。
 *
 * 鉴权：`Authorization: Bearer <DASHSCOPE_API_KEY>`；异步提交要带 `X-DashScope-Async: enable`。
 * 提交返回 output.task_id，查询 GET /api/v1/tasks/{id}，状态 PENDING/RUNNING/SUCCEEDED/FAILED。
 *
 * "Wanx" 与 "Tongyi-Wanx" 共用本适配器，只是配置项与标识不同。
 * @module providers/wanx
 */
import { ProviderError, classifyFailure } from './errors.js'
import { requestJson } from './http.js'

/** 比例 → 万相尺寸（用 * 分隔）。 */
export const SIZE_BY_RATIO = {
  '1:1': '1024*1024',
  '16:9': '1280*720',
  '9:16': '720*1280',
  '4:3': '1152*864',
  '3:4': '864*1152',
  '21:9': '1680*720',
}

function mapStatus(status) {
  const value = String(status ?? '').toUpperCase()
  if (value === 'SUCCEEDED' || value === 'SUCCESS') return 'succeeded'
  if (value === 'FAILED' || value === 'CANCELED' || value === 'CANCELLED') return 'failed'
  return 'pending'
}

/**
 * 创建万相供应商。
 * @param {{
 *   name: string, label: string,
 *   apiKey: string, apiKeySource?: string, baseURL?: string,
 *   imageModel?: string, videoModel?: string,
 * }} config
 * @param {{fetchImpl?: typeof fetch, requestTimeoutMs?: number}} [deps]
 */
export function createWanxProvider(config, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const requestTimeoutMs = deps.requestTimeoutMs ?? 60_000
  const name = config.name
  const label = config.label
  const baseURL = String(config.baseURL ?? 'https://dashscope.aliyuncs.com/api/v1').replace(/\/+$/, '')
  const apiKey = String(config.apiKey ?? '').trim()
  const imageModel = String(config.imageModel ?? 'wanx2.1-t2i-turbo')
  const videoModel = String(config.videoModel ?? 'wanx2.1-t2v-turbo')
  const headers = () => ({ authorization: `Bearer ${apiKey}`, 'x-dashscope-async': 'enable' })

  function requireKey() {
    if (apiKey === '') {
      throw new ProviderError({
        provider: name, kind: 'auth', retryable: false,
        message: `未配置 ${config.envName ?? 'DASHSCOPE_API_KEY'}（${label}）：请在环境变量或 cordis.patch.yml 的 config.providers 里配置`,
      })
    }
  }

  function failFromPayload(payload, httpStatus = 200) {
    const code = payload?.code ?? payload?.error?.code ?? null
    const message = payload?.message ?? payload?.error?.message ?? '未知错误'
    const classified = classifyFailure({ code, message, httpStatus, provider: name })
    return new ProviderError({
      provider: name, kind: classified.kind, retryable: classified.retryable,
      httpStatus, code, message: `${label}：${message}`, raw: payload,
    })
  }

  return {
    name,
    label,
    supports: ['image', 'video'],
    isConfigured() {
      if (apiKey === '') return { ok: false, missing: [config.envName ?? 'DASHSCOPE_API_KEY'] }
      return { ok: true, source: config.apiKeySource ?? 'env' }
    },
    async submit({ kind, prompt, params = {}, signal }) {
      requireKey()
      if (kind === 'image') {
        const body = {
          model: params.model || imageModel,
          input: { prompt },
          parameters: {
            size: params.size || SIZE_BY_RATIO[params.aspectRatio] || '1024*1024',
            n: 1,
          },
        }
        if (params.negativePrompt) body.parameters.negative_prompt = params.negativePrompt
        const response = await requestJson({
          fetchImpl, provider: name, url: `${baseURL}/services/aigc/text2image/image-synthesis`, method: 'POST',
          headers: headers(), body, timeoutMs: requestTimeoutMs, signal,
        })
        const taskId = response.json?.output?.task_id ?? null
        if (!taskId) throw failFromPayload(response.json)
        return { taskId, raw: response.json }
      }

      const body = {
        model: params.model || videoModel,
        input: { prompt },
        parameters: {
          size: SIZE_BY_RATIO[params.aspectRatio] || '1280*720',
          duration: Math.max(1, Math.round(Number(params.duration ?? 5))),
        },
      }
      if (params.negativePrompt) body.parameters.negative_prompt = params.negativePrompt
      const response = await requestJson({
        fetchImpl, provider: name, url: `${baseURL}/services/aigc/video-generation/video-synthesis`, method: 'POST',
        headers: headers(), body, timeoutMs: requestTimeoutMs, signal,
      })
      const taskId = response.json?.output?.task_id ?? null
      if (!taskId) throw failFromPayload(response.json)
      return { taskId, raw: response.json }
    },
    async poll(taskId, options = {}) {
      requireKey()
      const response = await requestJson({
        fetchImpl, provider: name, url: `${baseURL}/tasks/${encodeURIComponent(taskId)}`,
        headers: { authorization: `Bearer ${apiKey}` }, timeoutMs: requestTimeoutMs, signal: options.signal,
      })
      const payload = response.json ?? {}
      const output = payload.output ?? {}
      const status = mapStatus(output.task_status)
      if (status === 'succeeded') {
        const results = Array.isArray(output.results) ? output.results : []
        const url = output.video_url ?? results[0]?.url ?? null
        if (!url) return { status: 'failed', error: { kind: 'server', retryable: false, message: `${label} 任务成功但没有素材 URL` }, raw: payload }
        return { status: 'succeeded', url, raw: payload }
      }
      if (status === 'failed') {
        return {
          status: 'failed',
          error: { kind: 'server', retryable: false, message: `${label} 任务失败：${output.message ?? payload.message ?? '未给出原因'}` },
          raw: payload,
        }
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
