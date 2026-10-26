/**
 * 模块 1 的工具：film_probe_ffmpeg —— 探测本机 FFmpeg / ffprobe 是否可用。
 *
 * 它存在的意义不只是「问问装没装」：它是整个插件的第一条真实链路 ——
 * 模型下发参数 → host 侧工具执行 → proot 容器里 spawn 外部进程 → 结构化结果回给模型。
 * 这条链路通了，后面的供应商 HTTP 调用、FFmpeg 导出才有地基。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { classifySpawnError, runVersionProbe } from '../probe.js'

/**
 * 可空字符串的 JSON Schema 子集写法（value schema DSL：可空用 oneOf，必填用
 * 字段上的 required: true —— 对象节点本身不接受 required 数组）。
 */
const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] }
const NULLABLE_INTEGER = { oneOf: [{ type: 'integer' }, { type: 'null' }] }

/** 探测错误：种类 + 一句话说明。 */
const NULLABLE_ERROR = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true },
        message: { type: 'string', required: true },
      },
    },
    { type: 'null' },
  ],
}

/** 单个可执行文件的探测结果。 */
const PROBE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    command: { type: 'string', required: true },
    resolvedPath: { ...NULLABLE_STRING, required: true },
    ok: { type: 'boolean', required: true },
    exitCode: { ...NULLABLE_INTEGER, required: true },
    version: { ...NULLABLE_STRING, required: true },
    banner: { type: 'string', required: true },
    ms: { type: 'integer', required: true },
    error: { ...NULLABLE_ERROR, required: true },
  },
}

/** 工具返回值。 */
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    ffmpeg: { ...PROBE_SCHEMA, required: true },
    ffprobe: { ...PROBE_SCHEMA, required: true },
    settings: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        ffmpegPath: { type: 'string', required: true },
        ffprobePath: { type: 'string', required: true },
        outputDir: { type: 'string', required: true },
        timeoutMs: { type: 'integer', required: true },
        sources: {
          type: 'object',
          additionalProperties: false,
          required: true,
          properties: {
            ffmpegPath: { type: 'string', required: true },
            ffprobePath: { type: 'string', required: true },
            outputDir: { type: 'string', required: true },
            timeoutMs: { type: 'string', required: true },
          },
        },
      },
    },
    env: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        platform: { type: 'string', required: true },
        arch: { type: 'string', required: true },
        node: { type: 'string', required: true },
      },
    },
    hint: { ...NULLABLE_STRING, required: true },
  },
}

/**
 * 给模型/用户的下一步提示：只说真正需要动手的那一条。
 * @param {{ok: boolean, error: {kind: string, message: string}|null}} ffmpeg
 * @param {{ok: boolean, error: {kind: string, message: string}|null}} ffprobe
 */
export function buildHint(ffmpeg, ffprobe) {
  if (!ffmpeg.ok) {
    if (ffmpeg.error?.kind === 'not-found') {
      return 'ffmpeg 不在 PATH 里：用环境变量 FILM_STUDIO_FFMPEG 指向它的绝对路径，或在 cordis.patch.yml 的 config.ffmpegPath 里写死路径，然后重启 DSHA。'
    }
    if (ffmpeg.error?.kind === 'permission-denied' || ffmpeg.error?.kind === 'not-executable') {
      return '找到了 ffmpeg 但没有执行权限：给它 chmod +x，或换一个可执行的路径。'
    }
    if (ffmpeg.error?.kind === 'timeout') {
      return 'ffmpeg -version 超时：检查这个可执行文件是否真的能跑（例如换一个版本），也可以调大 config.timeoutMs。'
    }
    return `ffmpeg 探测失败（${ffmpeg.error?.kind ?? 'unknown'}）：${ffmpeg.error?.message ?? '原因未知'}`
  }
  if (!ffprobe.ok) {
    return 'ffmpeg 可用，但 ffprobe 不可用。探测本身不受影响；第四步导出时需要它读素材时长/分辨率，届时用 FILM_STUDIO_FFPROBE 指过去即可。'
  }
  return null
}

/** 把一次探测结果渲染成一行（模型读的是文字，不是 JSON）。 */
function renderProbe(label, probe) {
  if (probe.ok) {
    const version = probe.version === null ? '版本未知' : probe.version
    return `${label}：${version}（${probe.resolvedPath ?? probe.command}，${probe.ms}ms）`
  }
  return `${label}：不可用 —— ${probe.error?.message ?? '原因未知'}（${probe.ms}ms）`
}

/**
 * 执行探测：ffmpeg 与 ffprobe 并行，谁失败都不影响另一个的结论。
 * @param {Record<string, unknown>} args
 * @param {{signal?: AbortSignal}} exec
 * @param {ReturnType<typeof import('../settings.js').resolveSettings>} settings
 */
export async function executeProbe(args, exec, settings) {
  const ffmpegCommand = typeof args?.ffmpegPath === 'string' && args.ffmpegPath.trim() !== ''
    ? args.ffmpegPath.trim()
    : settings.ffmpegPath
  const timeoutMs = settings.timeoutMs
  const signal = exec?.signal

  const [ffmpeg, ffprobe] = await Promise.all([
    runVersionProbe({ command: ffmpegCommand, timeoutMs }, signal),
    runVersionProbe({ command: settings.ffprobePath, timeoutMs }, signal),
  ])

  return {
    ok: ffmpeg.ok,
    ffmpeg,
    ffprobe,
    settings: {
      ffmpegPath: settings.ffmpegPath,
      ffprobePath: settings.ffprobePath,
      outputDir: settings.outputDir,
      timeoutMs: settings.timeoutMs,
      sources: settings.sources,
    },
    env: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    },
    hint: buildHint(ffmpeg, ffprobe),
  }
}

/**
 * 注册用的工具定义。
 * @param {ReturnType<typeof import('../settings.js').resolveSettings>} settings
 */
export function buildProbeTool(settings) {
  return defineTool({
    name: 'film_probe_ffmpeg',
    description:
      '探测本机 FFmpeg / ffprobe 是否可用：实际执行 `ffmpeg -version` 与 `ffprobe -version`，' +
      '返回可执行文件路径、退出码、版本号与执行耗时。用于确认 DSHA（Linux arm64 + glibc proot 容器）里' +
      '外部进程调用链路是否通畅、导出前 FFmpeg 是否就绪。路径来自环境变量 FILM_STUDIO_FFMPEG / FILM_STUDIO_FFPROBE' +
      '或插件配置，也可用 ffmpegPath 参数临时覆盖。',
    parameters: {
      ffmpegPath: {
        type: 'string',
        description: '可选：临时覆盖 ffmpeg 可执行文件路径（绝对路径或 PATH 里的命令名）。不传则用配置值。',
      },
      includeBanner: {
        type: 'boolean',
        description: '可选：是否在返回结果里带上 ffmpeg -version 的原始输出前几行。默认 false。',
      },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => {
        const lines = [`整体：${value.ok ? '可用' : '不可用'}`]
        lines.push(renderProbe('ffmpeg', value.ffmpeg))
        lines.push(renderProbe('ffprobe', value.ffprobe))
        lines.push(
          `配置来源：ffmpeg=${value.settings.sources.ffmpegPath}，ffprobe=${value.settings.sources.ffprobePath}，输出目录=${value.settings.outputDir}`,
        )
        if (value.hint) lines.push(`下一步：${value.hint}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: true,
    execute: async (args, exec) => {
      const result = await executeProbe(args, exec, settings)
      if (args?.includeBanner === true) return result
      return {
        ...result,
        ffmpeg: { ...result.ffmpeg, banner: '' },
        ffprobe: { ...result.ffprobe, banner: '' },
      }
    },
  })
}

export { classifySpawnError }
