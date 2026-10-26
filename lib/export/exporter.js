/**
 * 导出编排：检查素材 → 下载远程素材 → 逐段转码 → 拼接 → ffprobe 校验 → 清理。
 *
 * 所有 ffmpeg/ffprobe 子进程登记在导出作用域（scope）里：超时、取消、插件卸载
 * 都会 SIGKILL，临时目录在同一清理路径里删除。
 * @module export/exporter
 */
import { mkdir, mkdtemp, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { downloadToFile, guessExtension } from '../media/download.js'
import { findExecutable } from '../probe.js'
import { runProcess } from './runner.js'
import {
  DEFAULT_SPEC,
  concatArgs,
  concatListEntry,
  imageSegmentArgs,
  probeArgs,
  videoSegmentArgs,
} from './command.js'

const DEFAULT_EXPORT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024

/**
 * 素材是否可用：存在且不是目录即可。
 * 普通文件要求非空；FIFO/特殊文件（例如测试用的慢输入）也允许——
 * 它们可能是流式素材，交给 ffmpeg 自己处理。
 */
function existsFile(path) {
  return stat(path)
    .then((info) => (info.isDirectory() ? false : info.isFile() ? info.size > 0 : true))
    .catch(() => false)
}

/**
 * 检查项目内所有镜头素材就绪情况。
 * @param {{
 *   projectId: string,
 *   paths: {projectDir: string, assetsDir: string, outputDir: string, storyboardPath: string},
 *   storyboard: any,
 *   store: {filePath: string},
 * }} input
 */
export async function checkAssets(input) {
  const { paths, storyboard, store } = input
  const scenes = Array.isArray(storyboard?.scenes) ? storyboard.scenes : []
  const items = []

  for (const scene of scenes) {
    const kind = scene.videoUrl || scene.assets?.video ? 'video' : scene.imageUrl || scene.assets?.image ? 'image' : 'none'
    const relative = kind === 'video' ? scene.assets?.video : kind === 'image' ? scene.assets?.image : null
    const localPath = relative ? join(paths.projectDir, relative) : null
    const localReady = localPath ? await existsFile(localPath) : false
    const remoteUrl = kind === 'video' ? scene.videoUrl : kind === 'image' ? scene.imageUrl : null
    const remoteReady = typeof remoteUrl === 'string' && /^https?:\/\//i.test(remoteUrl)

    let ready = false
    let reason = null
    if (scene.status !== 'done') {
      reason = `镜头状态是 ${scene.status}，不是 done`
    } else if (kind === 'none') {
      reason = '没有素材（缺少 imageUrl / videoUrl / assets）'
    } else if (localReady) {
      ready = true
    } else if (remoteReady) {
      ready = true
    } else {
      reason = relative ? `本地素材缺失：${relative}` : '没有可用的本地或远程素材'
    }

    items.push({
      sceneId: scene.id,
      index: scene.index,
      status: scene.status,
      kind,
      source: localReady ? 'local' : remoteReady ? 'remote' : 'none',
      localPath: localReady ? localPath : null,
      remoteUrl: remoteReady ? remoteUrl : null,
      durationSec: kind === 'video' ? Math.max(1, Number(scene.params?.duration) || 5) : null,
      ready,
      reason,
    })
  }

  const missing = items.filter((item) => !item.ready)
  return {
    projectId: input.projectId,
    storyboardPath: store?.filePath ?? paths.storyboardPath,
    total: items.length,
    ready: items.length - missing.length,
    missingScenes: missing.map((item) => ({ sceneId: item.sceneId, index: item.index, reason: item.reason })),
    scenes: items.map(({ localPath, remoteUrl, ...rest }) => rest),
    internal: items,
  }
}

/**
 * 合成 MP4。
 * @param {{
 *   projectId: string,
 *   paths: any,
 *   storyboard: any,
 *   settings: any,
 *   scope: ReturnType<import('./scope.js').createExportScope>,
 *   options?: {outputPath?: string, imageDurationSec?: number, kenBurns?: boolean, width?: number, height?: number, fps?: number, timeoutMs?: number, signal?: AbortSignal},
 *   store: {filePath: string},
 *   deps?: {fetchImpl?: typeof fetch, downloadTimeoutMs?: number, maxDownloadBytes?: number},
 * }} input
 */
export async function exportProject(input) {
  const { projectId, paths, storyboard, settings, scope, store, deps = {} } = input
  const options = input.options ?? {}
  const startedAt = Date.now()
  const warnings = []
  const onProgress = typeof input.onProgress === 'function' ? input.onProgress : () => {}
  let stage = 'checking'
  let stageScene = null
  const emit = (phase, extra = {}) => {
    stage = phase
    if (extra.sceneIndex !== undefined) stageScene = extra.sceneIndex
    try {
      onProgress({
        phase,
        label: extra.label ?? null,
        sceneIndex: extra.sceneIndex ?? stageScene,
        sceneTotal: extra.sceneTotal ?? null,
        error: extra.error ?? null,
      })
    } catch {
      /* 进度回调不能影响导出 */
    }
  }
  const fail = (message, kind, checked, extra = {}) => {
    // 失败前的阶段才是「最后完成的阶段」，先记下来再切到 failed。
    const lastPhase = stage
    const lastScene = stageScene
    emit('failed', { label: message, error: { kind, message } })
    return failure(message, kind, checked, { ...extra, lastPhase, lastSceneIndex: lastScene })
  }

  const spec = {
    width: Math.max(160, Math.round(Number(options.width ?? DEFAULT_SPEC.width))),
    height: Math.max(160, Math.round(Number(options.height ?? DEFAULT_SPEC.height))),
    fps: Math.min(60, Math.max(10, Math.round(Number(options.fps ?? DEFAULT_SPEC.fps)))),
    imageDurationSec: Math.min(30, Math.max(1, Number(options.imageDurationSec ?? DEFAULT_SPEC.imageDurationSec))),
    kenBurns: options.kenBurns === true,
    kenBurnsDirection: options.kenBurnsDirection === 'out' ? 'out' : 'in',
    kenBurnsStrength: options.kenBurnsStrength === 'medium' ? 'medium' : 'light',
  }
  const timeoutMs = Math.min(600_000, Math.max(5_000, Math.round(Number(options.timeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS))))
  const deadline = startedAt + timeoutMs

  emit('checking', { label: '检查素材' })
  const checked = await checkAssets({ projectId, paths, storyboard, store })
  if (checked.total === 0) {
    return fail('没有镜头可导出：分镜是空的。', 'server', checked)
  }
  if (checked.missingScenes.length > 0) {
    const detail = checked.missingScenes
      .map((item) => `#${item.index} ${item.sceneId}：${item.reason}`)
      .join('；')
    return fail(`有 ${checked.missingScenes.length} 个镜头素材未就绪，已拒绝导出：${detail}`, 'server', checked)
  }

  const ffmpeg = findExecutable(settings.ffmpegPath)
  if (ffmpeg === null) {
    return fail(
      `找不到 ffmpeg 可执行文件 "${settings.ffmpegPath}"：请设置 config.ffmpegPath、环境变量 DSH_FFMPEG_PATH，或安装 ffmpeg 到 PATH`,
      'server',
      checked,
    )
  }
  const ffprobe = findExecutable(settings.ffprobePath)
  if (ffprobe === null) {
    return fail(
      `找不到 ffprobe 可执行文件 "${settings.ffprobePath}"：请设置 config.ffprobePath、环境变量 DSH_FFPROBE_PATH，或安装 ffprobe 到 PATH`,
      'server',
      checked,
    )
  }

  const outputPath = resolveOutputPath(paths, options.outputPath)
  const workdir = await mkdtemp(join(tmpdir(), 'film-studio-export-'))
  const untrackDir = scope.trackDir(workdir)

  const segments = []
  try {
    const listEntries = []
    for (let position = 0; position < checked.internal.length; position += 1) {
      const item = checked.internal[position]
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        return fail(`合成超时（${timeoutMs}ms），已终止`, 'server', checked, { workdir })
      }

      let sourcePath = item.localPath
      if (sourcePath === null) {
        emit('downloading', { label: `下载远程素材（第 ${position + 1}/${checked.internal.length} 个）`, sceneIndex: position + 1, sceneTotal: checked.internal.length })
        const extension = guessExtension(item.remoteUrl) || (item.kind === 'video' ? '.mp4' : '.png')
        const downloaded = join(workdir, `input-${position}${extension}`)
        try {
          await downloadToFile({
            url: item.remoteUrl,
            destination: downloaded,
            timeoutMs: Math.min(remaining, deps.downloadTimeoutMs ?? 180_000),
            maxBytes: deps.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES,
            fetchImpl: deps.fetchImpl ?? globalThis.fetch,
            signal: options.signal,
          })
          sourcePath = downloaded
        } catch (error) {
          return fail(`下载 ${item.sceneId} 的素材失败：${String(error?.message ?? error)}`, 'network', checked, { workdir })
        }
      }

      emit('segment', { label: `正在合成第 ${position + 1}/${checked.internal.length} 段`, sceneIndex: position + 1, sceneTotal: checked.internal.length })
      const segmentPath = join(workdir, `segment-${position}.mp4`)
      const args = item.kind === 'video'
        ? videoSegmentArgs({ input: sourcePath, output: segmentPath, durationSec: item.durationSec ?? 5, width: spec.width, height: spec.height, fps: spec.fps })
        : imageSegmentArgs({ input: sourcePath, output: segmentPath, durationSec: spec.imageDurationSec, kenBurns: spec.kenBurns, kenBurnsDirection: spec.kenBurnsDirection, kenBurnsStrength: spec.kenBurnsStrength, width: spec.width, height: spec.height, fps: spec.fps })

      const result = await runProcess({
        command: ffmpeg,
        args,
        timeoutMs: Math.max(2000, Math.min(deadline - Date.now(), timeoutMs)),
        signal: options.signal,
        scope,
      })
      if (!result.ok) {
        return fail(
          `处理镜头 ${item.sceneId} 失败：${result.timedOut ? 'ffmpeg 超时' : 'ffmpeg 退出码 ' + result.code}${result.spawnError ? '（' + result.spawnError + '）' : ''}${tail(result.stderr)}`,
          'server',
          checked,
          { workdir },
        )
      }

      segments.push({
        sceneId: item.sceneId,
        kind: item.kind,
        source: item.source,
        durationSec: item.kind === 'video' ? (item.durationSec ?? 5) : spec.imageDurationSec,
        ms: result.durationMs,
      })
      listEntries.push(concatListEntry(segmentPath))
    }

    emit('concat', { label: '拼接片段' })
    const listPath = join(workdir, 'concat.txt')
    await writeFile(listPath, `${listEntries.join('\n')}\n`, 'utf8')
    const mergedPath = join(workdir, 'merged.mp4')
    const concatResult = await runProcess({
      command: ffmpeg,
      args: concatArgs({ listPath, output: mergedPath }),
      timeoutMs: Math.max(2000, deadline - Date.now()),
      signal: options.signal,
      scope,
    })
    if (!concatResult.ok) {
      return fail(
        `拼接失败：${concatResult.timedOut ? 'ffmpeg 超时' : 'ffmpeg 退出码 ' + concatResult.code}${tail(concatResult.stderr)}`,
        'server',
        checked,
        { workdir },
      )
    }

    emit('verifying', { label: '校验输出' })
    const probeResult = await runProcess({
      command: ffprobe,
      args: probeArgs(mergedPath),
      timeoutMs: Math.max(2000, deadline - Date.now()),
      signal: options.signal,
      scope,
    })
    if (!probeResult.ok) {
      warnings.push('ffprobe 校验失败，但仍保留输出文件')
    }

    const probed = parseProbe(probeResult.stdout)
    if (probed.width !== null && probed.width !== spec.width) warnings.push(`输出宽度 ${probed.width} 与期望 ${spec.width} 不一致`)
    if (probed.height !== null && probed.height !== spec.height) warnings.push(`输出高度 ${probed.height} 与期望 ${spec.height} 不一致`)

    await mkdir(join(outputPath, '..'), { recursive: true })
    await rename(mergedPath, outputPath).catch(async (error) => {
      // 跨设备时 rename 会失败，退回复制。
      await writeFile(outputPath, await readFile(mergedPath))
      if (!error) throw error
    })
    const info = await stat(outputPath)
    emit('done', { label: '完成' })

    return {
      ok: true,
      projectId,
      storyboardPath: store?.filePath ?? paths.storyboardPath,
      outputPath,
      fileSize: info.size,
      durationSec: probed.durationSec,
      width: probed.width,
      height: probed.height,
      segments,
      spec,
      warnings,
      elapsedMs: Date.now() - startedAt,
      error: null,
      check: publicCheck(checked),
    }
  } finally {
    await scope.cleanup()
    untrackDir()
  }
}

function failure(message, kind, checked, extra = {}) {
  return {
    ok: false,
    projectId: checked.projectId,
    storyboardPath: checked.storyboardPath,
    outputPath: null,
    fileSize: null,
    durationSec: null,
    width: null,
    height: null,
    segments: [],
    spec: null,
    warnings: [],
    elapsedMs: 0,
    error: { kind, message },
    check: publicCheck(checked),
    lastPhase: null,
    lastSceneIndex: null,
    ...extra,
  }
}

function publicCheck(checked) {
  const { internal, ...rest } = checked
  return rest
}

function tail(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return ''
  const lines = trimmed.split('\n')
  return `：${lines.slice(-3).join(' | ')}`
}

/** 解析 ffprobe JSON。 */
export function parseProbe(stdout) {
  try {
    const parsed = JSON.parse(stdout)
    const stream = parsed?.streams?.[0] ?? {}
    const format = parsed?.format ?? {}
    return {
      width: Number.isFinite(stream.width) ? stream.width : null,
      height: Number.isFinite(stream.height) ? stream.height : null,
      codec: stream.codec_name ?? null,
      durationSec: Number.isFinite(Number(format.duration)) ? Number(format.duration) : null,
      size: Number.isFinite(Number(format.size)) ? Number(format.size) : null,
    }
  } catch {
    return { width: null, height: null, codec: null, durationSec: null, size: null }
  }
}

function resolveOutputPath(paths, requested) {
  if (typeof requested === 'string' && requested.trim() !== '') {
    const value = requested.trim()
    return isAbsolute(value) ? value : join(paths.projectDir, value)
  }
  return join(paths.outputDir, 'final.mp4')
}
