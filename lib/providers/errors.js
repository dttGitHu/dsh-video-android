/**
 * 统一的失败分类：不管供应商是即梦还是可灵，调度器只认这五类。
 *
 *   rate_limit      限流 / 配额 / 调用频率
 *   auth            鉴权失败 / 密钥失效 / 签名错误
 *   content_review  内容审核不通过
 *   network         网络层失败（DNS、连接、超时、证书）
 *   server          服务端错误、参数错误、任务失败等其余情况
 *
 * 分类规则是一张有序映射表：先看 HTTP 状态，再看错误码/文案关键词兜底，
 * 最后落到 server。这样两家平台的新错误码不会漏进「未分类」黑洞。
 * @module providers/errors
 */

/** 五类失败的稳定标识。 */
export const FAILURE_KINDS = Object.freeze(['rate_limit', 'auth', 'content_review', 'network', 'server'])

/** 每类失败默认是否值得重试（供应商内或跨供应商）。 */
export const RETRYABLE_BY_KIND = Object.freeze({
  rate_limit: true,
  auth: false,
  content_review: true,
  network: true,
  server: true,
})

/** 内容审核相关关键词（中英双语 + 常见平台错误码）。 */
const CONTENT_REVIEW_PATTERNS = [
  /sensitive/i,
  /content[_ -]?policy/i,
  /content[_ -]?moderation/i,
  /content[_ -]?filter/i,
  /risk[_ -]?control/i,
  /inappropriate/i,
  /policy[_ -]?violation/i,
  /violat\w*/i,
  /审核/,
  /敏感/,
  /违规/,
  /安全策略/,
]

/** 鉴权相关关键词。 */
const AUTH_PATTERNS = [
  /unauthori[sz]ed/i,
  /invalid[_\s-]*(api[_\s-]*)?key/i,
  /api[_\s-]*key[_\s-]*invalid/i,
  /authentication/i,
  /signature/i,
  /token[_\s-]*(invalid|expired)/i,
  /forbidden/i,
  /鉴权/,
  /密钥/,
  /签名/,
  /未授权/,
]

/** 模型未开通 / 账号欠费 / 无访问权限：属于配置问题，归 auth 且不重试。 */
const MODEL_ACCESS_PATTERNS = [
  /modelnotopen/i,
  /invalidendpointormodel/i,
  /not\s+activated/i,
  /activate\s+the\s+model/i,
  /insufficient[\s_-]*(balance|quota)/i,
  /arrearage/i,
  /account[\s_-]*suspended/i,
]

/** 限流相关关键词。 */
const RATE_LIMIT_PATTERNS = [
  /rate[_\s-]*limit/i,
  /too[_\s-]*many[_\s-]*requests/i,
  /quota/i,
  /throttl/i,
  /concurren\w*/i,
  /限流/,
  /调用频率/,
  /配额/,
]

/** 可灵/方舟常见的「任务失败」状态，不适合重试（内容已被拒或参数不可用）。 */
const TERMINAL_SERVER_CODES = [/invalid[_\s-]*parameter/i, /bad[_\s-]*request/i, /task[_\s-]*failed/i]

function anyMatch(patterns, text) {
  return patterns.some((pattern) => pattern.test(text))
}

/**
 * 把一次 HTTP 失败映射成五类之一。
 * @param {{httpStatus?: number|null, code?: string|number|null, message?: string|null, provider?: string}} input
 * @returns {{kind: string, retryable: boolean, reason: string}}
 */
export function classifyFailure(input = {}) {
  const httpStatus = Number.isFinite(input.httpStatus) ? input.httpStatus : null
  const text = `${input.code ?? ''} ${input.message ?? ''}`

  // 1) 状态码优先：429 一定限流；401 一定鉴权。
  if (httpStatus === 429) return { kind: 'rate_limit', retryable: true, reason: 'HTTP 429' }
  if (httpStatus === 401) return { kind: 'auth', retryable: false, reason: 'HTTP 401' }

  // 2) 模型未开通 / 无权限：先于审核判断，避免把「ModelNotOpen」误判成内容问题。
  if (anyMatch(MODEL_ACCESS_PATTERNS, text)) {
    return { kind: 'auth', retryable: false, reason: '模型未开通或无访问权限' }
  }

  // 3) 内容审核：平台常用 400/403 + 专属错误码，所以先看文案。
  if (anyMatch(CONTENT_REVIEW_PATTERNS, text)) {
    return { kind: 'content_review', retryable: true, reason: '内容审核关键词' }
  }

  // 3) 鉴权关键词（部分平台把失效 Key 报成 400 或 403）。
  if (anyMatch(AUTH_PATTERNS, text)) {
    return { kind: 'auth', retryable: false, reason: '鉴权关键词' }
  }

  // 4) 限流关键词（有些平台 200 + 业务码表示限流）。
  if (anyMatch(RATE_LIMIT_PATTERNS, text)) {
    return { kind: 'rate_limit', retryable: true, reason: '限流关键词' }
  }

  // 5) 其余状态码归类。
  if (httpStatus === 403) return { kind: 'auth', retryable: false, reason: 'HTTP 403' }
  if (httpStatus !== null && httpStatus >= 500) return { kind: 'server', retryable: true, reason: `HTTP ${httpStatus}` }
  if (anyMatch(TERMINAL_SERVER_CODES, text)) return { kind: 'server', retryable: false, reason: '参数/任务终态错误' }

  // 6) 兜底：服务端类，允许切换供应商再试一次。
  return { kind: 'server', retryable: true, reason: httpStatus === null ? '未知错误' : `HTTP ${httpStatus}` }
}

/**
 * 网络层异常（fetch 抛出的 TypeError / 超时 / DNS 失败）的统一归类。
 * @param {unknown} error
 * @param {AbortSignal} [signal]
 * @returns {{kind: string, retryable: boolean, reason: string, cancelled: boolean}}
 */
export function classifyNetworkFailure(error, signal) {
  const name = error?.name ?? ''
  const message = String(error?.message ?? error ?? '')
  if (signal?.aborted) {
    return { kind: 'network', retryable: false, reason: '调用被取消', cancelled: true }
  }
  if (name === 'TimeoutError' || /timed?\s*out|timeout/i.test(message)) {
    return { kind: 'network', retryable: true, reason: '请求超时', cancelled: false }
  }
  if (name === 'AbortError') {
    return { kind: 'network', retryable: false, reason: '请求被中断', cancelled: true }
  }
  return { kind: 'network', retryable: true, reason: '网络请求失败', cancelled: false }
}

/**
 * 带分类信息的供应商错误：适配器内部统一抛它，调度器不用猜。
 */
export class ProviderError extends Error {
  /**
   * @param {{provider: string, kind: string, message: string, httpStatus?: number|null, code?: string|number|null, retryable?: boolean, raw?: unknown, cancelled?: boolean}} input
   */
  constructor(input) {
    super(input.message)
    this.name = 'ProviderError'
    this.provider = input.provider
    this.kind = FAILURE_KINDS.includes(input.kind) ? input.kind : 'server'
    this.httpStatus = input.httpStatus ?? null
    this.code = input.code ?? null
    this.retryable = input.retryable ?? RETRYABLE_BY_KIND[this.kind] ?? true
    this.raw = input.raw ?? null
    this.cancelled = input.cancelled === true
  }
}
