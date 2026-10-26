/**
 * 模块 4 的工具：导出前预检 + 合成 MP4。
 *
 *   film_check_assets  检查项目里每个镜头素材是否就绪，缺什么、为什么
 *   film_export_mp4    合成本地 MP4（图片转片段/视频裁剪/统一规格/拼接/ffprobe 校验）
 *
 * 子进程与临时目录都登记在 exportScope，插件卸载时统一 SIGKILL + 删目录。
 * @module tools/export
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { sanitizeProjectId } from '../settings.js'
import { checkAssets, exportProject } from '../export/exporter.js'

const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] }
const NULLABLE_NUMBER = { oneOf: [{ type: 'number' }, { type: 'null' }] }
const NULLABLE_INTEGER = { oneOf: [{ type: 'integer' }, { type: 'null' }] }

const ERROR_SCHEMA = {
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

const SCENE_CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sceneId: { type: 'string', required: true },
    index: { type: 'integer', required: true },
    status: { type: 'string', required: true },
    kind: { type: 'string', enum: ['image', 'video', 'none'], required: true },
    source: { type: 'string', enum: ['local', 'remote', 'none'], required: true },
    ready: { type: 'boolean', required: true },
    reason: { ...NULLABLE_STRING, required: true },
    durationSec: { ...NULLABLE_NUMBER, required: true },
  },
}

const MISSING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sceneId: { type: 'string', required: true },
    index: { type: 'integer', required: true },
    reason: { type: 'string', required: true },
  },
}

const CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    projectId: { type: 'string', required: true },
    storyboardPath: { type: 'string', required: true },
    total: { type: 'integer', required: true },
    ready: { type: 'integer', required: true },
    missingScenes: { type: 'array', items: MISSING_SCHEMA, required: true },
    scenes: { type: 'array', items: SCENE_CHECK_SCHEMA, required: true },
    error: { ...ERROR_SCHEMA, required: true },
  },
}

const SEGMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sceneId: { type: 'string', required: true },
    kind: { type: 'string', enum: ['image', 'video'], required: true },
    source: { type: 'string', enum: ['local', 'remote'], required: true },
    durationSec: { type: 'number', required: true },
    ms: { type: 'integer', required: true },
  },
}

const SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    fps: { type: 'integer', required: true },
    imageDurationSec: { type: 'number', required: true },
    kenBurns: { type: 'boolean', required: true },
    kenBurnsDirection: { type: 'string', enum: ['in', 'out'], required: true },
    kenBurnsStrength: { type: 'string', enum: ['light', 'medium'], required: true },
  },
}

const EXPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    projectId: { type: 'string', required: true },
    storyboardPath: { type: 'string', required: true },
    outputPath: { ...NULLABLE_STRING, required: true },
    fileSize: { ...NULLABLE_INTEGER, required: true },
    durationSec: { ...NULLABLE_NUMBER, required: true },
    width: { ...NULLABLE_INTEGER, required: true },
    height: { ...NULLABLE_INTEGER, required: true },
    segments: { type: 'array', items: SEGMENT_SCHEMA, required: true },
    spec: { oneOf: [SPEC_SCHEMA, { type: 'null' }], required: true },
    warnings: { type: 'array', items: { type: 'string' }, required: true },
    elapsedMs: { type: 'integer', required: true },
    exportId: { ...NULLABLE_STRING, required: true },
    lastPhase: { ...NULLABLE_STRING, required: true },
    lastSceneIndex: { ...NULLABLE_INTEGER, required: true },
    error: { ...ERROR_SCHEMA, required: true },
  },
}

const PROGRESS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    found: { type: 'boolean', required: true },
    exportId: { ...NULLABLE_STRING, required: true },
    projectId: { ...NULLABLE_STRING, required: true },
    phase: { type: 'string', required: true },
    label: { ...NULLABLE_STRING, required: true },
    sceneIndex: { ...NULLABLE_INTEGER, required: true },
    sceneTotal: { type: 'integer', required: true },
    status: { ...NULLABLE_STRING, required: true },
    elapsedMs: { ...NULLABLE_INTEGER, required: true },
    error: { ...ERROR_SCHEMA, required: true },
  },
}

function renderCheck(value) {
  const lines = [`${value.ok ? '✓' : '✗'} 素材检查：${value.ready}/${value.total} 就绪（项目 ${value.projectId}）`]
  if (value.missingScenes.length > 0) {
    lines.push('未就绪：')
    for (const item of value.missingScenes) lines.push(`  · #${item.index} ${item.sceneId}：${item.reason}`)
    lines.push('先补齐素材（film_regenerate_scene），再导出。')
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderExport(value) {
  if (!value.ok) {
    return [{ type: 'text', text: `✗ 导出失败：${value.error?.message ?? '未知原因'}` }]
  }
  const lines = [
    `✓ 已导出 MP4：${value.outputPath}`,
    `规格：${value.width}x${value.height} · ${value.spec?.fps ?? 30}fps · ${(value.fileSize / 1024 / 1024).toFixed(2)}MB · ${(value.durationSec ?? 0).toFixed(1)}s`,
    `片段：${value.segments.length} 段（${value.segments.map((item) => `${item.sceneId}:${item.kind}:${item.durationSec}s`).join('，')}）`,
  ]
  if (value.warnings.length > 0) lines.push(`注意：${value.warnings.join('；')}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

function compact(input) {
  const output = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value
  }
  return output
}

/**
 * 构建导出工具。
 * @param {{
 *   projects: any,
 *   settings: any,
 *   scope: ReturnType<typeof import('../export/scope.js').createExportScope>,
 *   progress: ReturnType<typeof import('../export/progress.js').createExportProgress>,
 *   deps?: {fetchImpl?: typeof fetch, downloadTimeoutMs?: number, maxDownloadBytes?: number},
 * }} input
 */
export function buildExportTools(input) {
  const { projects, settings, scope, progress, deps = {} } = input

  async function loadProject(projectId) {
    const paths = await projects.ensure(projectId)
    const store = projects.store(projectId)
    const current = await store.read()
    return { paths, store, storyboard: current.storyboard }
  }

  return [
    defineTool({
      name: 'film_check_assets',
      description:
        '导出前预检：检查指定项目里每个镜头的素材是否就绪（本地 assets/ 优先，其次远程 URL），' +
        '返回每个镜头的状态、来源（local/remote/none）与缺失原因。导出前先跑它，能避免生成到一半才发现缺素材。',
      parameters: {
        projectId: { type: 'string', description: '项目 id，默认 default' },
      },
      output: { schema: CHECK_SCHEMA, render: (_args, value) => renderCheck(value) },
      isConcurrencySafe: true,
      execute: async (args) => {
        const projectId = sanitizeProjectId(args.projectId)
        const { paths, store, storyboard } = await loadProject(projectId)
        const checked = await checkAssets({ projectId, paths, storyboard, store })
        const ok = checked.total > 0 && checked.missingScenes.length === 0
        return {
          ok,
          projectId,
          storyboardPath: store.filePath,
          total: checked.total,
          ready: checked.ready,
          missingScenes: checked.missingScenes,
          scenes: checked.scenes,
          error: ok ? null : { kind: 'server', message: checked.missingScenes.length > 0 ? `${checked.missingScenes.length} 个镜头素材未就绪` : '没有镜头可导出' },
        }
      },
    }),

    defineTool({
      name: 'film_export_progress',
      description:
        '查询一次导出（film_export_mp4）的当前阶段：checking/downloading/segment(第 N/M 段)/concat/verifying/done/failed。' +
        '阶段式反馈，不做精确百分比；导出结束后 30 秒内仍可查到终态，之后返回 unknown。',
      parameters: {
        exportId: { type: 'string', required: true, description: 'film_export_mp4 返回的 exportId，或 projectId' },
      },
      output: {
        schema: PROGRESS_SCHEMA,
        render: (_args, value) => [{
          type: 'text',
          text: value.found
            ? `导出进度：${value.phase}${value.label ? ' — ' + value.label : ''}${value.sceneIndex !== null ? `（${value.sceneIndex}/${value.sceneTotal}）` : ''}`
            : `导出已结束或 id 不存在（${value.label ?? 'unknown'}）`,
        }],
      },
      isConcurrencySafe: true,
      execute: async (args) => {
        const entry = progress.get(String(args.exportId ?? ''))
        if (!entry) {
          return {
            ok: false,
            found: false,
            exportId: null,
            projectId: null,
            phase: 'unknown',
            label: '导出已结束或 id 不存在',
            sceneIndex: null,
            sceneTotal: 0,
            status: null,
            elapsedMs: null,
            error: { kind: 'server', message: '导出已结束或 id 不存在' },
          }
        }
        return {
          ok: true,
          found: true,
          exportId: entry.exportId,
          projectId: entry.projectId,
          phase: entry.phase,
          label: entry.label,
          sceneIndex: entry.sceneIndex,
          sceneTotal: entry.sceneTotal,
          status: entry.ok === null ? 'running' : entry.ok ? 'done' : 'failed',
          elapsedMs: entry.finishedAt ? entry.finishedAt - entry.startedAt : entry.updatedAt - entry.startedAt,
          error: entry.error ?? null,
        }
      },
    }),

    defineTool({
      name: 'film_export_mp4',
      description:
        '把分镜素材合成为本地 MP4：图片镜头按指定时长生成片段（可选 Ken Burns 缓慢推近），视频镜头裁剪到指定时长，' +
        '统一 scale+pad 到 1280x720/30fps 后拼接，输出 H.264 + AAC。合成前会自动检查素材，缺素材直接拒绝并给出原因；' +
        '路径可配置（config.ffmpegPath / DSH_FFMPEG_PATH / PATH），默认输出到项目 output/final.mp4，有 120 秒超时。',
      parameters: {
        projectId: { type: 'string', description: '项目 id，默认 default' },
        outputPath: { type: 'string', description: '可选：输出文件路径；相对路径按项目目录解析' },
        imageDurationSec: { type: 'number', description: '图片镜头时长（秒），默认 3' },
        kenBurns: { type: 'boolean', description: '图片镜头是否启用 Ken Burns 缓慢缩放，默认 false' },
        kenBurnsDirection: { type: 'string', enum: ['in', 'out'], description: 'Ken Burns 方向：in 推近 / out 拉远，默认 in' },
        kenBurnsStrength: { type: 'string', enum: ['light', 'medium'], description: 'Ken Burns 幅度：light 轻微 / medium 中等，默认 light' },
        width: { type: 'integer', description: '输出宽度，默认 1280' },
        height: { type: 'integer', description: '输出高度，默认 720' },
        fps: { type: 'integer', description: '输出帧率，默认 30' },
        timeoutMs: { type: 'integer', description: '合成超时（毫秒），默认 120000' },
      },
      timeoutMs: 600_000,
      output: { schema: EXPORT_SCHEMA, render: (_args, value) => renderExport(value) },
      execute: async (args, exec) => {
        const projectId = sanitizeProjectId(args.projectId)
        const { paths, store, storyboard } = await loadProject(projectId)
        const totalScenes = storyboard.scenes.length
        const exportId = progress.start({ projectId, sceneTotal: totalScenes })
        const result = await exportProject({
          projectId,
          paths,
          storyboard,
          settings,
          scope,
          store,
          options: compact({
            outputPath: args.outputPath,
            imageDurationSec: args.imageDurationSec,
            kenBurns: args.kenBurns,
            kenBurnsDirection: args.kenBurnsDirection,
            kenBurnsStrength: args.kenBurnsStrength,
            width: args.width,
            height: args.height,
            fps: args.fps,
            timeoutMs: args.timeoutMs,
            signal: exec?.signal,
          }),
          onProgress: (event) => {
            progress.update(exportId, {
              phase: event.phase,
              label: event.label,
              sceneIndex: event.sceneIndex,
              sceneTotal: event.sceneTotal,
              error: event.error,
            })
          },
          deps: {
            fetchImpl: deps.fetchImpl,
            downloadTimeoutMs: deps.downloadTimeoutMs,
            maxDownloadBytes: deps.maxDownloadBytes,
          },
        })
        progress.finish(exportId, { ok: result.ok, error: result.error })
        return {
          ok: result.ok,
          projectId: result.projectId,
          storyboardPath: result.storyboardPath,
          outputPath: result.outputPath ?? null,
          fileSize: result.fileSize ?? null,
          durationSec: result.durationSec ?? null,
          width: result.width ?? null,
          height: result.height ?? null,
          segments: result.segments ?? [],
          spec: result.spec ?? null,
          warnings: result.warnings ?? [],
          elapsedMs: result.elapsedMs ?? 0,
          exportId,
          lastPhase: result.lastPhase ?? null,
          lastSceneIndex: result.lastSceneIndex ?? null,
          error: result.error ?? null,
        }
      },
    }),
  ]
}
