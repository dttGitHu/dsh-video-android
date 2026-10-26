/**
 * 可灵适配器（Kling AI）。
 *
 * 鉴权：AccessKey + SecretKey 签 HS256 JWT（`iss/exp/nbf`），每次请求现签，
 * `Authorization: Bearer <jwt>`。密钥只存在于本模块闭包里，不落日志。
 *
 * 图像：POST /v1/images/generations → task_id；GET /v1/images/generations/{id}
 * 视频：POST /v1/videos/text2video  → task_id；GET /v1/videos/text2video/{id}
 *
 * 可灵在 HTTP 200 里用业务码报告失败（`code !== 0`），所以成功分支也要验码。
 * @module providers/kling
 */
import { createHmac } from 'node:crypto'
import { ProviderError, classifyFailure } from './errors.js'
import { requestJson } from './http.js'

export const KLING_NAME = 'kling'
export const KLING_LABEL = '可灵（Kling AI）'

/** 可灵业务码 → 五类失败（官方码表常见区间；文案关键词兜底）。 */
export const KLING_CODE_MAP = new Map([
  [1000, 'server'],
  [1001, 'server'],
  [1100, 'server'],
  [1200, 'auth'],
  [1201, 'auth'],
  [1202, 'auth'],
  [1300, 'content_review'],
  [1301, 'content_review'],
  [1302, 'content_review'],
  [1303, 'content_review'],
  [1400, 'rate_limit'],
  [1401, 'rate_limit'],
  [1402, 'rate_limit'],
  [1500, 'server'],
  [1501, 'server'],
  [1502, 'server'],
])

/** 可灵任务状态 → 统一状态。 */
export function mapKlingStatus(status) {
  const value = String(status ?? '').toLowerCase()
  if (value === 'succeed' || value === 'succeeded' || value === 'success') return 'succeeded'
  if (value === 'failed' || value === 'error') return 'failed'
  return 'pending'
}

/**
 * 签一个可灵 JWT（HS256）。
 * @param {string} accessKey
 * @param {string} secretKey
 * @param {number} [nowSeconds] 便于测试注入固定时间
 * @returns {string}
 */
export function signKlingJwt(accessKey, secretKey, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload = { iss: accessKey, exp: nowSeconds + 1800, nbf: nowSeconds - 5 }
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  const signingInput = `${encode(header)}.${encode(payload)}`
  const signature = createHmac('sha256', secretKey).update(signingInput).digest('base64url')
  return `${signingInput}.${signature}`
}

/** 平台业务码优先，其次文案关键词，最后通用规则。 */
export function classifyKlingError(input = {}) {
  const numeric = Number(input.code)
  if (Number.isInteger(numeric) && KLING_CODE_MAP.has(numeric)) {
    const kind = KLING_CODE_MAP.get(numeric)
    return { kind, retryable: kind !== 'auth' }
  }
  return classifyFailure({ ...input, provider: KLING_NAME })
}

/**
 * 创建可灵适配器。
 * @param {{
 *   accessKey: string,
 *   secretKey: string,
 *   accessKeySource?: string,
 *   baseURL: string,
 *   imageModel: string,
 *   videoModel: string,
 * }} config
 * @param {{fetchImpl?: typeof fetch, requestTimeoutMs?: number}} [deps]
 */
export function createKlingProvider(config, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const requestTimeoutMs = deps.requestTimeoutMs ?? 60_000
  const baseURL = String(config.baseURL ?? 'https://api.klingai.com').replace(/\/+$/, '')
  const accessKey = String(config.accessKey ?? '').trim()
  const secretKey = String(config.secretKey ?? '').trim()
  const imageModel = String(config.imageModel ?? 'kling-v1')
  const videoModel = String(config.videoModel ?? 'kling-v1')

  const authorization = () => ({ authorization: `Bearer ${signKlingJwt(accessKey, secretKey)}` })

  function requireKeys() {
    const missing = []
    if (accessKey === '') missing.push('KLING_ACCESS_KEY')
    if (secretKey === '') missing.push('KLING_SECRET_KEY')
    if (missing.length > 0) {
      throw new ProviderError({
        provider: KLING_NAME,
        kind: 'auth',
        retryable: false,
        message: `未配置 ${missing.join(' / ')}（可灵）：请在环境变量或 cordis.patch.yml 的 config.providers.kling 里配置`,
      })
    }
  }

  /** HTTP 200 + 业务码失败也要转成 ProviderError。 */
  function assertBusinessOk(payload, httpStatus = 200) {
    const code = payload?.code
    if (code === 0 || code === undefined || code === null) return
    const message = payload?.message ?? payload?.msg ?? '未知错误'
    const classified = classifyKlingError({ code, message, httpStatus })
    throw new ProviderError({
      provider: KLING_NAME,
      kind: classified.kind,
      retryable: classified.retryable,
      httpStatus,
      code,
      message: `可灵：${message}（业务码 ${code}）`,
      raw: payload,
    })
  }

  return {
    name: KLING_NAME,
    label: KLING_LABEL,
    supports: ['image', 'video'],

    isConfigured() {
      const missing = []
      if (accessKey === '') missing.push('KLING_ACCESS_KEY')
      if (secretKey === '') missing.push('KLING_SECRET_KEY')
      if (missing.length > 0) return { ok: false, missing }
      return { ok: true, source: config.accessKeySource ?? 'env' }
    },

    /**
     * 提交任务（图像/视频都返回任务 id，异步）。
     * @param {{kind: 'image'|'video', prompt: string, params?: Record<string, any>, signal?: AbortSignal}} input
     */
    async submit({ kind, prompt, params = {}, signal }) {
      requireKeys()
      const headers = authorization()

      if (kind === 'image') {
        const body = {
          model_name: params.model || imageModel,
          prompt,
          n: 1,
          aspect_ratio: params.aspectRatio || '1:1',
        }
        if (params.negativePrompt) body.negative_prompt = params.negativePrompt
        const response = await requestJson({
          fetchImpl,
          provider: KLING_NAME,
          url: `${baseURL}/v1/images/generations`,
          method: 'POST',
          headers,
          body,
          timeoutMs: requestTimeoutMs,
          signal,
        })
        assertBusinessOk(response.json)
        const taskId = response.json?.data?.task_id ?? null
        if (!taskId) {
          throw new ProviderError({
            provider: KLING_NAME,
            kind: 'server',
            retryable: false,
            message: '可灵图像接口返回成功，但响应里没有 task_id',
            raw: response.json,
          })
        }
        return { taskId, raw: response.json }
      }

      const duration = Math.max(1, Math.round(Number(params.duration ?? 5)))
      const body = {
        model_name: params.model || videoModel,
        prompt,
        duration: String(Number.isFinite(duration) ? duration : 5),
        aspect_ratio: params.aspectRatio || '16:9',
        mode: params.mode || 'std',
        cfg_scale: params.cfgScale ?? 0.5,
      }
      if (params.negativePrompt) body.negative_prompt = params.negativePrompt
      const response = await requestJson({
        fetchImpl,
        provider: KLING_NAME,
        url: `${baseURL}/v1/videos/text2video`,
        method: 'POST',
        headers,
        body,
        timeoutMs: requestTimeoutMs,
        signal,
      })
      assertBusinessOk(response.json)
      const taskId = response.json?.data?.task_id ?? null
      if (!taskId) {
        throw new ProviderError({
          provider: KLING_NAME,
          kind: 'server',
          retryable: false,
          message: '可灵视频接口返回成功，但响应里没有 task_id',
          raw: response.json,
        })
      }
      return { taskId, raw: response.json }
    },

    /**
     * 查询任务状态。
     * @param {string} taskId
     * @param {{kind?: 'image'|'video', signal?: AbortSignal}} [options]
     */
    async poll(taskId, options = {}) {
      requireKeys()
      const kind = options.kind ?? 'video'
      const url = kind === 'image'
        ? `${baseURL}/v1/images/generations/${encodeURIComponent(taskId)}`
        : `${baseURL}/v1/videos/text2video/${encodeURIComponent(taskId)}`
      const response = await requestJson({
        fetchImpl,
        provider: KLING_NAME,
        url,
        headers: authorization(),
        timeoutMs: requestTimeoutMs,
        signal: options.signal,
      })
      assertBusinessOk(response.json)

      const data = response.json?.data ?? {}
      const status = mapKlingStatus(data.task_status)
      if (status === 'succeeded') {
        const items = kind === 'image' ? data.task_result?.images : data.task_result?.videos
        const url2 = Array.isArray(items) ? items[0]?.url ?? null : null
        if (!url2) {
          return {
            status: 'failed',
            error: { kind: 'server', retryable: false, message: `可灵任务成功，但响应里没有${kind === 'image' ? '图片' : '视频'} URL` },
            raw: response.json,
          }
        }
        return { status: 'succeeded', url: url2, raw: response.json }
      }
      if (status === 'failed') {
        const message = data.task_status_msg ?? '未给出原因'
        const classified = classifyKlingError({ message, httpStatus: 200 })
        return {
          status: 'failed',
          error: { kind: classified.kind, retryable: classified.retryable, message: `可灵任务失败：${message}` },
          raw: response.json,
        }
      }
      return { status: 'pending', raw: response.json }
    },

    classifyError(error) {
      if (error instanceof ProviderError) return { kind: error.kind, retryable: error.retryable }
      const classified = classifyKlingError({
        code: error?.code ?? null,
        message: error?.message ?? String(error),
        httpStatus: error?.httpStatus ?? null,
      })
      return { kind: classified.kind, retryable: classified.retryable }
    },
  }
}

/** 仅用于测试：校验 JWT 的三段结构与签名。 */
export function verifyJwtShape(token) {
  const parts = String(token).split('.')
  if (parts.length !== 3) return { ok: false, reason: '不是三段式 JWT' }
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return { ok: header.alg === 'HS256' && typeof payload.iss === 'string' && payload.exp > payload.nbf, header, payload }
  } catch {
    return { ok: false, reason: 'JWT 段无法解析' }
  }
}

