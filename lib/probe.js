/**
 * 外部可执行文件探测：在 proot（Linux arm64 + glibc）容器里 spawn 一个子进程，
 * 拿到它的版本信息。
 *
 * 约束：
 * - 不用 shell（避免注入，也避免 /bin/sh 在不同发行版里的差异）；
 * - 不依赖 PATH 一定正确：先解析路径，再执行，错误分类给到调用方；
 * - 支持 AbortSignal 与超时，不把挂死的子进程留在后台。
 */
import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join, sep } from 'node:path'

/** 探测结果的错误种类。 */
export const PROBE_ERROR_KINDS = [
  'not-found',
  'permission-denied',
  'not-executable',
  'timeout',
  'aborted',
  'exit-code',
  'spawn-failed',
]

/** 把 spawn 的同步/异步错误归到稳定的种类上。 */
export function classifySpawnError(error) {
  switch (error?.code) {
    case 'ENOENT':
      return 'not-found'
    case 'EACCES':
      return 'permission-denied'
    case 'ENOEXEC':
      return 'not-executable'
    default:
      return 'spawn-failed'
  }
}

/** 是否是「可以直接执行」的文件。 */
function isExecutableFile(path) {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 把命令解析成绝对路径：绝对路径/含分隔符的直接校验，其余按 PATH 逐个目录找。
 * @param {string} command
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function findExecutable(command, env = process.env) {
  if (typeof command !== 'string' || command.trim() === '') return null
  const trimmed = command.trim()
  if (isAbsolute(trimmed) || trimmed.includes(sep) || trimmed.includes('/')) {
    return isExecutableFile(trimmed) ? trimmed : null
  }
  const dirs = String(env.PATH ?? '').split(delimiter)
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = join(dir, trimmed)
    if (isExecutableFile(candidate)) return candidate
  }
  return null
}

/** 从 `-version` 的输出里取版本号与版本横幅。 */
export function parseVersionOutput(stdout, stderr) {
  const text = String(stdout ?? '').trim() || String(stderr ?? '').trim()
  const firstLine = text.split('\n')[0]?.trim() ?? ''
  const match = firstLine.match(/version\s+([0-9][^\s]*)/i)
  return {
    version: match ? match[1] : null,
    banner: text === '' ? '' : text.split('\n').slice(0, 6).join('\n').trim(),
  }
}

/**
 * 执行 `<command> -version` 并收集结果。
 * @param {{command: string, timeoutMs: number}} spec
 * @param {AbortSignal} [signal]
 * @returns {Promise<{command: string, resolvedPath: string|null, ok: boolean, exitCode: number|null, version: string|null, banner: string, ms: number, error: {kind: string, message: string}|null}>}
 */
export function runVersionProbe(spec, signal) {
  const { command, timeoutMs } = spec
  const resolvedPath = findExecutable(command)

  return new Promise((resolve) => {
    const startedAt = Date.now()
    let stdout = ''
    let stderr = ''
    let settled = false
    let child = null
    let timer = null

    const finish = (extra) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      try {
        signal?.removeEventListener?.('abort', onAbort)
      } catch {
        /* 忽略 */
      }
      resolve({ command, resolvedPath, ms: Date.now() - startedAt, ...extra })
    }

    const killChild = () => {
      try {
        child?.kill('SIGKILL')
      } catch {
        /* 已经退出 */
      }
    }

    const onAbort = () => {
      killChild()
      finish({
        ok: false,
        exitCode: null,
        version: null,
        banner: '',
        error: { kind: 'aborted', message: `探测 ${command} 的调用被取消` },
      })
    }

    timer = setTimeout(() => {
      killChild()
      finish({
        ok: false,
        exitCode: null,
        version: null,
        banner: (stdout + stderr).trim(),
        error: { kind: 'timeout', message: `${command} -version 超过 ${timeoutMs}ms 没有返回` },
      })
    }, timeoutMs)
    timer.unref?.()

    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })

    if (resolvedPath === null) {
      finish({
        ok: false,
        exitCode: null,
        version: null,
        banner: '',
        error: {
          kind: 'not-found',
          message: `找不到可执行文件 "${command}"：它不在 PATH 里，也不是一个可执行文件`,
        },
      })
      return
    }

    try {
      child = spawn(resolvedPath, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      finish({
        ok: false,
        exitCode: null,
        version: null,
        banner: '',
        error: { kind: classifySpawnError(error), message: String(error?.message ?? error) },
      })
      return
    }

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', (error) => {
      killChild()
      finish({
        ok: false,
        exitCode: null,
        version: null,
        banner: (stdout + stderr).trim(),
        error: { kind: classifySpawnError(error), message: String(error?.message ?? error) },
      })
    })

    child.on('close', (code) => {
      const parsed = parseVersionOutput(stdout, stderr)
      if (code === 0) {
        finish({ ok: true, exitCode: 0, version: parsed.version, banner: parsed.banner, error: null })
        return
      }
      finish({
        ok: false,
        exitCode: code,
        version: parsed.version,
        banner: parsed.banner,
        error: {
          kind: 'exit-code',
          message: `${command} -version 以退出码 ${code} 结束${stderr.trim() === '' ? '' : `：${stderr.trim().split('\n')[0]}`}`,
        },
      })
    })
  })
}
