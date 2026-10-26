/**
 * 子进程执行器：无 shell、有超时、可取消、登记到导出作用域。
 *
 * 超时与取消都用 SIGKILL：ffmpeg 收到 SIGTERM 偶尔会卡在写文件上，
 * 手机上宁可强制结束，再由临时目录清理兜底。
 * @module export/runner
 */
import { spawn } from 'node:child_process'

const MAX_OUTPUT_BYTES = 256 * 1024

/**
 * 执行一个外部命令。
 * @param {{
 *   command: string,
 *   args: string[],
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 *   scope?: {trackChild: Function},
 *   cwd?: string,
 * }} options
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string, timedOut: boolean, cancelled: boolean, spawnError: string|null, durationMs: number}>}
 */
export function runProcess(options) {
  const { command, args = [], timeoutMs = 120_000, signal, scope, cwd } = options

  return new Promise((resolve) => {
    const startedAt = Date.now()
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let cancelled = false
    let child = null
    let untrack = () => {}

    const finish = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      untrack()
      resolve({
        ok: payload.ok === true,
        code: payload.code ?? null,
        stdout,
        stderr,
        timedOut,
        cancelled,
        spawnError: payload.spawnError ?? null,
        durationMs: Date.now() - startedAt,
      })
    }

    const kill = () => {
      try {
        child?.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
    }

    const onAbort = () => {
      cancelled = true
      kill()
    }

    if (signal?.aborted) {
      finish({ ok: false, code: null, spawnError: '调用被取消' })
      return
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })

    const timer = setTimeout(() => {
      timedOut = true
      kill()
      finish({ ok: false, code: null, spawnError: `超时（${timeoutMs}ms），已终止进程` })
    }, Math.max(100, timeoutMs))
    timer.unref?.()

    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd })
    } catch (error) {
      finish({ ok: false, code: null, spawnError: String(error?.message ?? error) })
      return
    }

    untrack = scope?.trackChild(child) ?? (() => {})

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString()
    })

    child.on('error', (error) => {
      finish({ ok: false, code: null, spawnError: String(error?.message ?? error) })
    })
    child.on('close', (code) => {
      finish({ ok: code === 0, code })
    })
  })
}
