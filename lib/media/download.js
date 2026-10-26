/**
 * 素材下载：把远程 URL 落成本地文件，带超时、大小上限与可取消。
 *
 * 模块 3 用来把生成结果存进项目 assets/，模块 4 用来把远程素材拉到临时目录。
 * 只依赖 Node 原生 fetch 与 stream，不引第三方库。
 * @module media/download
 */
import { createWriteStream } from 'node:fs'
import { mkdir, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** 默认单文件上限 200MB。 */
export const DEFAULT_MAX_BYTES = 200 * 1024 * 1024
/** 默认下载超时 120 秒。 */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000

/** 常见内容类型 → 扩展名。 */
const EXT_BY_TYPE = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
}

/**
 * 从 URL 猜扩展名（优先路径后缀，其次 content-type）。
 * @param {string} url
 * @param {string} [contentType]
 */
export function guessExtension(url, contentType) {
  try {
    const pathname = new URL(url).pathname
    const matched = pathname.match(/\.(png|jpe?g|webp|gif|mp4|mov|webm|m4v)$/i)
    if (matched) return `.${matched[1].toLowerCase().replace('jpeg', 'jpg')}`
  } catch {
    /* 不是合法 URL，继续按 content-type */
  }
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase()
  return EXT_BY_TYPE[type] ?? ''
}

/**
 * 下载到文件。
 * @param {{
 *   url: string,
 *   destination: string,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   maxBytes?: number,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {Promise<{path: string, bytes: number, contentType: string, extension: string}>}
 */
export async function downloadToFile(options) {
  const {
    url,
    destination,
    signal,
    timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    fetchImpl = globalThis.fetch,
  } = options

  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason ?? new Error('下载被取消'))
  if (signal?.aborted) throw new Error('下载被取消')
  signal?.addEventListener?.('abort', onAbort, { once: true })

  const timer = setTimeout(() => controller.abort(new Error(`下载超时（${timeoutMs}ms）`)), Math.max(1000, timeoutMs))
  timer.unref?.()

  let response
  try {
    response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' })
  } catch (error) {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
    throw new Error(`下载失败：${String(error?.message ?? error)}`)
  }

  try {
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
    const lengthHeader = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(lengthHeader) && lengthHeader > maxBytes) {
      throw new Error(`素材过大：${Math.round(lengthHeader / 1024 / 1024)}MB > 上限 ${Math.round(maxBytes / 1024 / 1024)}MB`)
    }

    await mkdir(dirname(destination), { recursive: true })
    let written = 0
    const body = response.body
    if (!body) throw new Error('下载失败：响应没有内容')

    const source = Readable.fromWeb(body)
    source.on('data', (chunk) => {
      written += chunk.length
      if (written > maxBytes) {
        source.destroy(new Error(`素材超过大小上限 ${Math.round(maxBytes / 1024 / 1024)}MB`))
      }
    })

    await pipeline(source, createWriteStream(destination, { mode: 0o600 }))
    const info = await stat(destination)
    return {
      path: destination,
      bytes: info.size,
      contentType: String(response.headers.get('content-type') ?? ''),
      extension: guessExtension(url, response.headers.get('content-type')),
    }
  } catch (error) {
    await unlink(destination).catch(() => {})
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}
