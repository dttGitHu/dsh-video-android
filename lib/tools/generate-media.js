/**
 * 模块 2 的工具：film_generate_image / film_generate_video。
 *
 * 工具本身不做供应商逻辑，只做三件事：
 *   1. 把模型参数整理成统一的 params；
 *   2. 用 ctx.effect 登记的 AbortController 包住整次调用（卸载/取消都能中断）；
 *   3. 把调度器的结果（含 switchTrace / attempts）原样结构化返回。
 * @module tools/generate-media
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { generateWithFailover } from '../scheduler.js'
import { trackCall } from '../lifecycle.js'

/** 可空字符串。 */
const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] }
const NULLABLE_INTEGER = { oneOf: [{ type: 'integer' }, { type: 'null' }] }

/** switchTrace 的一条切换记录。 */
const SWITCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
    reason: { type: 'string', required: true },
    attempt: { type: 'integer', required: true },
    message: { ...NULLABLE_STRING, required: true },
  },
}

/** 单次尝试的明细。 */
const ATTEMPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    provider: { type: 'string', required: true },
    outcome: { type: 'string', enum: ['succeeded', 'failed', 'skipped'], required: true },
    kind: { ...NULLABLE_STRING, required: true },
    message: { ...NULLABLE_STRING, required: true },
    ms: { type: 'integer', required: true },
    polls: { ...NULLABLE_INTEGER, required: true },
  },
}

/** 最终错误。 */
const ERROR_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true },
        provider: { ...NULLABLE_STRING, required: true },
        retryable: { type: 'boolean', required: true },
        message: { type: 'string', required: true },
      },
    },
    { type: 'null' },
  ],
}

/** 生成结果。 */
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    kind: { type: 'string', enum: ['image', 'video'], required: true },
    provider: { ...NULLABLE_STRING, required: true },
    providerLabel: { ...NULLABLE_STRING, required: true },
    taskId: { ...NULLABLE_STRING, required: true },
    url: { ...NULLABLE_STRING, required: true },
    polls: { type: 'integer', required: true },
    elapsedMs: { type: 'integer', required: true },
    switchTrace: { type: 'array', items: SWITCH_SCHEMA, required: true },
    attempts: { type: 'array', items: ATTEMPT_SCHEMA, required: true },
    error: { ...ERROR_SCHEMA, required: true },
  },
}

/** 把调度器结果裁成工具 schema 的形状。 */
export function toToolResult(result, kind) {
  const error = result?.error
    ? {
        kind: String(result.error.kind ?? 'server'),
        provider: result.error.provider ?? null,
        retryable: result.error.retryable === true,
        message: String(result.error.message ?? '生成失败'),
      }
    : null
  return {
    ok: result?.ok === true,
    kind,
    provider: result?.provider ?? null,
    providerLabel: result?.providerLabel ?? null,
    taskId: result?.taskId ?? null,
    url: result?.url ?? null,
    polls: Number.isFinite(result?.polls) ? result.polls : 0,
    elapsedMs: Number.isFinite(result?.elapsedMs) ? result.elapsedMs : 0,
    switchTrace: Array.isArray(result?.switchTrace)
      ? result.switchTrace.map((item) => ({
          from: String(item.from),
          to: String(item.to),
          reason: String(item.reason),
          attempt: Math.round(Number(item.attempt) || 0),
          message: item.message ?? null,
        }))
      : [],
    attempts: Array.isArray(result?.attempts)
      ? result.attempts.map((item) => ({
          provider: String(item.provider),
          outcome: ['succeeded', 'failed', 'skipped'].includes(item.outcome) ? item.outcome : 'failed',
          kind: item.kind ?? null,
          message: item.message ?? null,
          ms: Math.max(0, Math.round(Number(item.ms) || 0)),
          polls: Number.isFinite(item.polls) ? Math.round(item.polls) : null,
        }))
      : [],
    error,
  }
}

const KIND_LABEL = { image: '图片', video: '视频' }

function formatSeconds(ms) {
  return `${(Number(ms) / 1000).toFixed(1)}s`
}

/**
 * 渲染给模型看的摘要：成功一行结论 + 素材 URL + 切换/尝试明细。
 * @param {{kind: 'image'|'video'}} args
 * @param {ReturnType<typeof toToolResult>} value
 */
export function renderResult(args, value) {
  try {
    const label = KIND_LABEL[value.kind] ?? value.kind
    const lines = []
    if (value.ok) {
      lines.push(`✓ ${value.providerLabel ?? value.provider ?? '供应商'} 生成${label}成功（${formatSeconds(value.elapsedMs)}，轮询 ${value.polls} 次）`)
      if (value.url) lines.push(`素材：${value.url}`)
    } else {
      lines.push(`✗ 生成${label}失败（${formatSeconds(value.elapsedMs)}）`)
      if (value.error) lines.push(`原因：${value.error.kind} —— ${value.error.message}`)
    }

    if (value.switchTrace.length > 0) {
      lines.push('切换记录：')
      for (const item of value.switchTrace) {
        const detail = item.message ? `：${item.message}` : ''
        lines.push(`  · ${item.from} → ${item.to}（${item.reason}，第 ${item.attempt} 次尝试）${detail}`)
      }
    }

    if (value.attempts.length > 0) {
      lines.push('尝试明细：')
      for (const item of value.attempts) {
        if (item.outcome === 'skipped') {
          lines.push(`  · ${item.provider}：跳过（${item.message ?? '未配置'}）`)
        } else if (item.outcome === 'succeeded') {
          lines.push(`  · ${item.provider}：成功（${formatSeconds(item.ms)}${item.polls === null ? '' : `，${item.polls} 次轮询`}）`)
        } else {
          lines.push(`  · ${item.provider}：失败（${item.kind ?? '未知'}，${formatSeconds(item.ms)}）`)
        }
      }
    }
    return [{ type: 'text', text: lines.join('\n') }]
  } catch (error) {
    return [{ type: 'text', text: `生成结果渲染失败：${String(error?.message ?? error)}` }]
  }
}

/** 图片/视频共用参数。 */
const COMMON_PARAMS = {
  provider: {
    type: 'string',
    enum: ['jimeng', 'doubao-seedream', 'doubao-seedance', 'wanx', 'tongyi-wanx', 'kling'],
    description: '可选：优先使用的供应商（如 doubao-seedance）；失败仍会自动切换到下一家。',
  },
  aspectRatio: {
    type: 'string',
    enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    description: '可选：画面比例。',
  },
  model: {
    type: 'string',
    description: '可选：覆盖该供应商的模型名（默认用配置里的模型）。',
  },
  negativePrompt: {
    type: 'string',
    description: '可选：负向提示词（可灵支持）。',
  },
  maxPolls: {
    type: 'integer',
    description: '可选：轮询上限次数，默认 60（测试时可调小）。',
  },
}

/**
 * 构建一个生成工具。
 * @param {{
 *   name: string,
 *   kind: 'image'|'video',
 *   description: string,
 *   settings: object,
 *   providers: Array<any>,
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   taskScope: {track: Function, abortAll: Function},
 *   timeoutMs?: number,
 * }} input
 */
export function buildGenerateTool(input) {
  const { name, kind, description, settings, providers, ctx, taskScope, timeoutMs } = input
  const params = kind === 'video'
    ? {
        ...COMMON_PARAMS,
        duration: { type: 'integer', description: '可选：时长秒数（可灵常用 5 或 10；即梦会写进 --duration）。' },
        resolution: { type: 'string', description: '可选：即梦分辨率，例如 720p / 1080p。' },
        mode: { type: 'string', enum: ['std', 'pro'], description: '可选：可灵模式，默认 std。' },
        cfgScale: { type: 'number', description: '可选：可灵 cfg_scale，默认 0.5。' },
      }
    : {
        ...COMMON_PARAMS,
        duration: undefined,
        size: { type: 'string', description: '可选：图片尺寸（即梦用，如 1024x1024）。' },
        seed: { type: 'integer', description: '可选：随机种子。' },
      }

  // 去掉为空的占位项，避免把 undefined 塞进 schema。
  for (const key of Object.keys(params)) {
    if (params[key] === undefined) delete params[key]
  }

  return defineTool({
    name,
    description,
    parameters: {
      prompt: { type: 'string', required: true, description: '画面/视频提示词，支持中文。' },
      ...params,
    },
    output: {
      schema: RESULT_SCHEMA,
      render: renderResult,
    },
    timeoutMs,
    execute: async (args, exec) => {
      const controller = new AbortController()
      const release = trackCall(ctx, taskScope, {
        controller,
        outerSignal: exec?.signal,
        label: `dsh-film-studio: ${name}`,
      })
      try {
        const result = await generateWithFailover({
          kind,
          prompt: args.prompt,
          params: {
            provider: args.provider,
            aspectRatio: args.aspectRatio,
            model: args.model,
            negativePrompt: args.negativePrompt,
            duration: args.duration,
            resolution: args.resolution,
            mode: args.mode,
            cfgScale: args.cfgScale,
            size: args.size,
            seed: args.seed,
          },
          settings,
          providers,
          signal: controller.signal,
          maxPolls: args.maxPolls,
        })
        return toToolResult(result, kind)
      } finally {
        release()
      }
    },
  })
}
