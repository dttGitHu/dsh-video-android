/**
 * FFmpeg 命令构造：纯函数，便于单测与排查。
 *
 * 统一输出规格：1280x720、30fps、H.264(yuv420p) + AAC。
 * 所有素材先 scale + pad 到目标尺寸再拼接，避免分辨率不一致导致花屏。
 * @module export/command
 */

/** 默认输出规格。 */
export const DEFAULT_SPEC = Object.freeze({
  width: 1280,
  height: 720,
  fps: 30,
  imageDurationSec: 3,
})

/** H.264 编码参数（手机端用 veryfast 控制耗时）。 */
export const VIDEO_CODEC_ARGS = Object.freeze([
  '-c:v', 'libx264',
  '-preset', 'veryfast',
  '-crf', '23',
  '-pix_fmt', 'yuv420p',
])

/** scale + pad 到统一尺寸（不变形、留黑边）。 */
export function scalePadFilter(width, height) {
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`
}

/** Ken Burns 方向与幅度映射。 */
export const KEN_BURNS_DIRECTIONS = Object.freeze(['in', 'out'])
export const KEN_BURNS_STRENGTHS = Object.freeze(['light', 'medium'])

/** 幅度 → 最大缩放增量。 */
export function kenBurnsAmount(strength) {
  return strength === 'medium' ? 0.18 : 0.10
}

/**
 * Ken Burns：先放大裁切，再 zoompan 推近/拉远。
 * @param {{direction?: 'in'|'out', strength?: 'light'|'medium', durationSec?: number}} [options]
 */
export function kenBurnsFilter(width, height, fps, options = {}) {
  const direction = options.direction === 'out' ? 'out' : 'in'
  const amount = kenBurnsAmount(options.strength)
  const frames = Math.max(1, Math.round((Number(options.durationSec) || 3) * fps))
  const step = amount / frames
  const maxZoom = (1 + amount).toFixed(4)
  // 用输出帧号 on 做线性缩放：比 zoom 自增在不同 ffmpeg 版本上更稳定
  // （实测 zoom 自增在部分参数组合下会被重置，导致整段静止）。
  const zoomExpr = direction === 'out'
    ? `max(${maxZoom}-${step.toFixed(6)}*on,1)`
    : `min(1+${step.toFixed(6)}*on,${maxZoom})`
  return [
    `scale=${Math.round(width * 1.2)}:${Math.round(height * 1.2)}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    `zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${fps}`,
    'setsar=1',
  ].join(',')
}

/**
 * 图片 → 视频片段。
 * @param {{input: string, output: string, durationSec: number, kenBurns: boolean, width: number, height: number, fps: number}} input
 */
export function imageSegmentArgs(input) {
  const { input: inputPath, output, durationSec, kenBurns, width, height, fps } = input
  const vf = kenBurns
    ? kenBurnsFilter(width, height, fps, { direction: input.kenBurnsDirection, strength: input.kenBurnsStrength, durationSec })
    : `${scalePadFilter(width, height)},fps=${fps}`
  return [
    '-y',
    '-loop', '1',
    '-framerate', String(fps),
    '-i', inputPath,
    '-t', String(durationSec),
    '-vf', vf,
    '-r', String(fps),
    '-an',
    ...VIDEO_CODEC_ARGS,
    output,
  ]
}

/**
 * 视频 → 裁剪片段（统一尺寸与帧率）。
 * @param {{input: string, output: string, durationSec: number, width: number, height: number, fps: number}} input
 */
export function videoSegmentArgs(input) {
  const { input: inputPath, output, durationSec, width, height, fps } = input
  return [
    '-y',
    '-i', inputPath,
    '-t', String(durationSec),
    '-vf', `${scalePadFilter(width, height)},fps=${fps}`,
    '-r', String(fps),
    '-an',
    ...VIDEO_CODEC_ARGS,
    output,
  ]
}

/**
 * concat demuxer 拼接 + 加一条静音 AAC 轨（统一规格要求 H.264 + AAC）。
 * @param {{listPath: string, output: string}} input
 */
export function concatArgs(input) {
  return [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', input.listPath,
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-shortest',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    input.output,
  ]
}

/** ffprobe 参数：读视频宽高/编码/时长。 */
export function probeArgs(file) {
  return [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,codec_name,duration',
    '-show_entries', 'format=duration,size',
    '-of', 'json',
    file,
  ]
}

/** 把一段字幕/文件路径转成 concat 列表里安全的写法。 */
export function concatListEntry(path) {
  return `file '${String(path).replaceAll("'", "'\\''")}'`
}
