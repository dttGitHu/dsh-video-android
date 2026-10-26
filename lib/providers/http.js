/**
 * 供应商 HTTP 客户端：把 fetch 的原始失败收敛成 ProviderError。
 *
 * 关键点：
 * - 只用 Node 原生 fetch（约束 3），不引 axios / node-fetch；
 * - 每次请求一个内部 AbortController 负责超时，外部 signal 负责取消；
 * - 超时与取消都清理定时器，不把 timer 泄漏给事件循环；
 * - 响应正文先按文本读，再尽力 JSON.parse，错误信息不会因为非 JSON 响应而丢失。
 * @module providers/http
 */
import { ProviderError, classifyFailure, classifyNetworkFailure } from './errors.js'

/** 默认单请求超时。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

/**
 * 发一个 JSON 请求（成功时返回解析后的 JSON）。
 * @param {{
 *   fetchImpl: typeof fetch,
 *   url: string,
 *   method?: string,
 *   headers?: Record<string, string>,
 *   body?: unknown,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 *   provider: string,
 * }} options
 * @returns {Promise<{status: number, json: any, text: string}>}
 */
export async function requestJson(options) {
  const {
    fetchImpl,
    url,
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    signal,
    provider,
  } = options

  const controller = new AbortController()
  const onOuterAbort = () => {
    try {
      controller.abort(signal?.reason ?? new Error('调用被取消'))
    } catch {
      /* 已经 abort 过 */
    }
  }
  const timer = setTimeout(() => {
    try {
      controller.abort(new DOMException('请求超时', 'TimeoutError'))
    } catch {
      /* 忽略 */
    }
  }, timeoutMs)
  timer.unref?.()

  if (signal?.aborted) {
    clearTimeout(timer)
    throw new ProviderError({
      provider,
      kind: 'network',
      retryable: false,
      cancelled: true,
      message: `${provider} 请求被取消`,
    })
  }
  signal?.addEventListener?.('abort', onOuterAbort, { once: true })

  try {
    const response = await fetchImpl(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })

    const text = await response.text()
    let json = null
    try {
      json = text === '' ? null : JSON.parse(text)
    } catch {
      json = null
    }

    if (!response.ok) {
      const code = json?.error?.code ?? json?.code ?? json?.data?.code ?? null
      const message =
        json?.error?.message ??
        json?.message ??
        json?.error?.msg ??
        (text.trim() === '' ? `HTTP ${response.status}` : text.trim().slice(0, 500))
      const classified = classifyFailure({ httpStatus: response.status, code, message, provider })
      throw new ProviderError({
        provider,
        kind: classified.kind,
        retryable: classified.retryable,
        httpStatus: response.status,
        code,
        message: classified.kind === 'content_review'
          ? `${provider} 内容审核未通过：${message}`
          : `${provider} 请求失败（${classified.reason}）：${message}`,
        raw: json,
      })
    }

    return { status: response.status, json, text }
  } catch (error) {
    if (error instanceof ProviderError) throw error
    const classified = classifyNetworkFailure(error, signal)
    throw new ProviderError({
      provider,
      kind: classified.kind,
      retryable: classified.retryable,
      cancelled: classified.cancelled,
      message: `${provider} 网络失败（${classified.reason}）：${String(error?.message ?? error)}`,
      raw: null,
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onOuterAbort)
  }
}
