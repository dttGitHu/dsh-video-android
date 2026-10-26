/**
 * 模块 4 验收：FFmpeg 合成导出。
 *
 * 覆盖：
 *   1. 用 2 张图片 + 1 段短视频合成 MP4，ffprobe 校验时长/分辨率；
 *   2. 缺素材时 film_check_assets 准确报出、film_export_mp4 拒绝执行；
 *   3. ffmpeg 路径配错 → 明确错误（不是裸 spawn 报错）；
 *   4. 模拟合成超时（FIFO 素材让 ffmpeg 卡住）→ 进程被 SIGKILL、临时目录被清理；
 *   5. 卸载时 scope 清理干净。
 *
 * 用法：node scripts/verify-export.mjs
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import { resolveSettings } from '../lib/settings.js'
import { createProjectStores } from '../lib/storyboard/projects.js'
import { buildTools } from '../lib/index.js'
import { createExportScope } from '../lib/export/scope.js'
import { parseProbe } from '../lib/export/exporter.js'

const execFileAsync = promisify(execFile)

let checks = 0
const failures = []
function check(label, condition, detail = '') {
  checks += 1
  if (condition) console.log(`  ✓ ${label}`)
  else {
    failures.push(`${label}${detail ? ` —— ${detail}` : ''}`)
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const workspace = await mkdtemp(join(tmpdir(), 'film-export-'))
const projectId = 'demo'
const projects = createProjectStores({ workspaceDir: workspace })
const paths = await projects.ensure(projectId)
await mkdir(paths.assetsDir, { recursive: true })

// ---- 生成 mock 素材：2 张图 + 1 段 2 秒视频
const imageA = join(paths.assetsDir, 'frame-a.png')
const imageB = join(paths.assetsDir, 'frame-b.png')
const clip = join(paths.assetsDir, 'clip-c.mp4')
await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=800x600', '-frames:v', '1', imageA])
await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'mandelbrot=size=800x600', '-frames:v', '1', imageB])
await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', clip])

const storyboard = {
  version: 1,
  title: '导出测试',
  updatedAt: new Date().toISOString(),
  scenes: [
    { id: 'scene-1', index: 1, narration: '红', visualPrompt: '红', imageUrl: null, videoUrl: null, status: 'done', assets: { image: 'assets/frame-a.png', video: null }, params: { kind: 'image', aspectRatio: '16:9', duration: 3, provider: null, model: null, negativePrompt: null }, switchTrace: [], error: null, lastGeneratedAt: null },
    { id: 'scene-2', index: 2, narration: '蓝', visualPrompt: '蓝', imageUrl: null, videoUrl: null, status: 'done', assets: { image: 'assets/frame-b.png', video: null }, params: { kind: 'image', aspectRatio: '9:16', duration: 3, provider: null, model: null, negativePrompt: null }, switchTrace: [], error: null, lastGeneratedAt: null },
    { id: 'scene-3', index: 3, narration: '测试图', visualPrompt: '测试图', imageUrl: null, videoUrl: null, status: 'done', assets: { image: null, video: 'assets/clip-c.mp4' }, params: { kind: 'video', aspectRatio: '16:9', duration: 2, provider: null, model: null, negativePrompt: null }, switchTrace: [], error: null, lastGeneratedAt: null },
  ],
}
await writeFile(paths.storyboardPath, JSON.stringify({ fileVersion: 1, storyboard }), { mode: 0o600 })

const settings = resolveSettings({ workspaceDir: workspace, ffmpegPath: '/usr/bin/ffmpeg', ffprobePath: '/usr/bin/ffprobe' }, {})
const scope = createExportScope()
const tools = buildTools(settings, { projects, scope })
const tool = (name) => tools.find((item) => item.name === name)

/* ------------------------------------------------------------------ */
console.log('\n[1/5] 素材预检 + 合成 MP4')
/* ------------------------------------------------------------------ */

const checkResult = await tool('film_check_assets').execute({ projectId }, { signal: new AbortController().signal })
check('3 个镜头全部就绪', checkResult.ok === true && checkResult.ready === 3, JSON.stringify(checkResult.missingScenes))
check('本地素材来源正确', checkResult.scenes.every((scene) => scene.source === 'local'))

const exportResult = await tool('film_export_mp4').execute(
  { projectId, imageDurationSec: 3, height: 720, width: 1280, fps: 30 },
  { signal: new AbortController().signal },
)
check('导出成功', exportResult.ok === true, exportResult.error?.message)
check('输出文件存在', exportResult.outputPath ? await exists(exportResult.outputPath) : false)
check('片段数 = 3', exportResult.segments?.length === 3, JSON.stringify(exportResult.segments))
check('分辨率 1280x720', exportResult.width === 1280 && exportResult.height === 720, `${exportResult.width}x${exportResult.height}`)
check('时长约 8 秒（3+3+2）', Math.abs((exportResult.durationSec ?? 0) - 8) < 1.5, String(exportResult.durationSec))
check('文件大小 > 0', (exportResult.fileSize ?? 0) > 0)

const probe = await execFileAsync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-show_entries', 'format=duration', '-of', 'json', exportResult.outputPath])
const probed = parseProbe(probe.stdout)
check('ffprobe 复核分辨率', probed.width === 1280 && probed.height === 720)
check('ffprobe 复核时长', Math.abs((probed.durationSec ?? 0) - 8) < 1.5)

/* ------------------------------------------------------------------ */
console.log('\n[2/5] 缺素材：预检报出 + 导出拒绝')
/* ------------------------------------------------------------------ */

const missingStoryboard = JSON.parse(JSON.stringify(storyboard))
missingStoryboard.scenes[1].status = 'failed'
missingStoryboard.scenes[1].assets = { image: null, video: null }
missingStoryboard.scenes[1].imageUrl = null
await writeFile(paths.storyboardPath, JSON.stringify({ fileVersion: 1, storyboard: missingStoryboard }), { mode: 0o600 })

const missingCheck = await tool('film_check_assets').execute({ projectId }, { signal: new AbortController().signal })
check('预检报出缺失镜头', missingCheck.ok === false && missingCheck.missingScenes.length === 1, JSON.stringify(missingCheck.missingScenes))
check('缺失原因可读', /不是 done|没有素材/.test(missingCheck.missingScenes[0]?.reason ?? ''), missingCheck.missingScenes[0]?.reason)

const missingExport = await tool('film_export_mp4').execute({ projectId }, { signal: new AbortController().signal })
check('缺素材时拒绝导出', missingExport.ok === false && /未就绪/.test(missingExport.error?.message ?? ''), missingExport.error?.message)

// 恢复
await writeFile(paths.storyboardPath, JSON.stringify({ fileVersion: 1, storyboard }), { mode: 0o600 })

/* ------------------------------------------------------------------ */
console.log('\n[3/5] ffmpeg 路径配错')
/* ------------------------------------------------------------------ */

const badSettings = resolveSettings({ workspaceDir: workspace, ffmpegPath: '/nonexistent/ffmpeg-binary', ffprobePath: '/nonexistent/ffprobe-binary' }, {})
const badTools = buildTools(badSettings, { projects, scope: createExportScope() })
const badResult = await badTools.find((item) => item.name === 'film_export_mp4').execute({ projectId }, { signal: new AbortController().signal })
check('明确提示找不到 ffmpeg', badResult.ok === false && /找不到 ffmpeg/.test(badResult.error?.message ?? ''), badResult.error?.message)
check('提示里给出配置方式', /DSH_FFMPEG_PATH|config\.ffmpegPath/.test(badResult.error?.message ?? ''))

/* ------------------------------------------------------------------ */
console.log('\n[4/5] 合成超时：SIGKILL + 临时目录清理')
/* ------------------------------------------------------------------ */

const fifoPath = join(paths.assetsDir, 'slow.fifo')
await execFileAsync('mkfifo', [fifoPath])
const slowStoryboard = JSON.parse(JSON.stringify(storyboard))
slowStoryboard.scenes = [{ id: 'scene-slow', index: 1, narration: '慢', visualPrompt: '慢', imageUrl: null, videoUrl: null, status: 'done', assets: { image: 'assets/slow.fifo', video: null }, params: { kind: 'image', aspectRatio: '16:9', duration: 3, provider: null, model: null, negativePrompt: null }, switchTrace: [], error: null, lastGeneratedAt: null }]
await writeFile(paths.storyboardPath, JSON.stringify({ fileVersion: 1, storyboard: slowStoryboard }), { mode: 0o600 })

const slowScope = createExportScope()
const slowTools = buildTools(settings, { projects, scope: slowScope })
const slowStarted = Date.now()
const slowResult = await slowTools.find((item) => item.name === 'film_export_mp4').execute(
  { projectId, timeoutMs: 5000 },
  { signal: new AbortController().signal },
)
const slowElapsed = Date.now() - slowStarted
check('超时返回失败', slowResult.ok === false, slowResult.error?.message)
check('错误提到超时', /超时/.test(slowResult.error?.message ?? ''), slowResult.error?.message)
check('5 秒内结束（进程被终止）', slowElapsed < 15000, `${slowElapsed}ms`)
check('作用域子进程已清空', slowScope.childCount() === 0, String(slowScope.childCount()))
check('作用域临时目录已清空', slowScope.dirCount() === 0, String(slowScope.dirCount()))
const leftovers = await execFileAsync('sh', ['-c', `ls -d /tmp/film-studio-export-* 2>/dev/null | wc -l`])
check('没有残留临时目录', leftovers.stdout.trim() === '0', leftovers.stdout.trim())

await rm(fifoPath, { force: true })
await writeFile(paths.storyboardPath, JSON.stringify({ fileVersion: 1, storyboard }), { mode: 0o600 })

/* ------------------------------------------------------------------ */
console.log('\n[5/5] 卸载清理')
/* ------------------------------------------------------------------ */

await scope.cleanup()
check('正常清理后临时目录为 0', scope.dirCount() === 0)

const registry = new Map()
const ctx = new Context()
ctx.provide('tools', { register(item) { registry.set(item.name, item); return () => registry.delete(item.name) } })
const fiber = ctx.plugin(plugin, { workspaceDir: workspace })
await fiber.await()
check('插件注册 13 个工具', registry.size === 13, [...registry.keys()].join(','))
await fiber.dispose()
check('卸载后注册表为空', registry.size === 0)
await ctx.fiber.dispose()

/* ------------------------------------------------------------------ */
console.log('\n[6/7] 导出进度：阶段事件序列')
/* ------------------------------------------------------------------ */

// 恢复 3 镜头正常状态
await writeFile(paths.storyboardPath, JSON.stringify({ fileVersion: 1, storyboard }), { mode: 0o600 })
const { exportProject } = await import('../lib/export/exporter.js')
const { createExportProgress } = await import('../lib/export/progress.js')
const events = []
const seqResult = await exportProject({
  projectId,
  paths,
  storyboard,
  settings,
  scope: createExportScope(),
  store: projects.store(projectId),
  onProgress: (event) => events.push(event),
})
const phaseList = events.map((item) => item.phase)
check('阶段顺序：checking → segment×3 → concat → verifying → done',
  phaseList[0] === 'checking' &&
    phaseList.filter((phase) => phase === 'segment').length === 3 &&
    phaseList.indexOf('concat') > phaseList.lastIndexOf('segment') &&
    phaseList.indexOf('verifying') > phaseList.indexOf('concat') &&
    phaseList[phaseList.length - 1] === 'done',
  phaseList.join(' → '))
const segmentIndexes = events.filter((item) => item.phase === 'segment').map((item) => item.sceneIndex)
check('每段给出第 N/M 段序号', JSON.stringify(segmentIndexes) === '[1,2,3]', JSON.stringify(segmentIndexes))
check('阶段事件带 label', events.some((item) => typeof item.label === 'string' && /第 1\/3 段/.test(item.label)))
check('导出结果正常', seqResult.ok === true)

/* ------------------------------------------------------------------ */
console.log('\n[7/7] 导出失败：lastPhase 与进度 TTL')
/* ------------------------------------------------------------------ */

const fifo2 = join(paths.assetsDir, 'slow2.fifo')
await execFileAsync('mkfifo', [fifo2])
const slowBoard2 = JSON.parse(JSON.stringify(storyboard))
slowBoard2.scenes = [{ id: 'scene-slow2', index: 1, narration: '慢', visualPrompt: '慢', imageUrl: null, videoUrl: null, status: 'done', assets: { image: 'assets/slow2.fifo', video: null }, params: { kind: 'image', aspectRatio: '16:9', duration: 3, provider: null, model: null, negativePrompt: null }, switchTrace: [], error: null, lastGeneratedAt: null }]
await writeFile(paths.storyboardPath, JSON.stringify({ fileVersion: 1, storyboard: slowBoard2 }), { mode: 0o600 })

const failProgress = createExportProgress()
const failTools = buildTools(settings, { projects, scope: createExportScope(), progress: failProgress })
const failResult = await failTools.find((item) => item.name === 'film_export_mp4').execute(
  { projectId, timeoutMs: 5000 },
  { signal: new AbortController().signal },
)
check('失败返回 lastPhase=segment', failResult.ok === false && failResult.lastPhase === 'segment', String(failResult.lastPhase))
check('失败返回 lastSceneIndex=1', failResult.lastSceneIndex === 1, String(failResult.lastSceneIndex))
const failEntry = failProgress.get(failResult.exportId)
check('进度表记录 failed 终态', failEntry?.phase === 'failed' && failEntry?.ok === false)

const ttlProgress = createExportProgress({ ttlMs: 30 })
const ttlId = ttlProgress.start({ projectId: 'ttl', sceneTotal: 1 })
ttlProgress.finish(ttlId, { ok: true })
await sleep(80)
check('终态超过 TTL 后惰性清理', ttlProgress.get(ttlId) === null && ttlProgress.size() === 0)

await rm(fifo2, { force: true })
await writeFile(paths.storyboardPath, JSON.stringify({ fileVersion: 1, storyboard }), { mode: 0o600 })

/* ------------------------------------------------------------------ */
console.log('\n[8/8] Ken Burns 四组合（推近/拉远 × 轻微/中等）')
/* ------------------------------------------------------------------ */

await writeFile(paths.storyboardPath, JSON.stringify({ fileVersion: 1, storyboard }), { mode: 0o600 })
const kbFrames = {}
for (const [direction, strength] of [['in', 'light'], ['in', 'medium'], ['out', 'light'], ['out', 'medium']]) {
  const output = join(workspace, `kb-${direction}-${strength}.mp4`)
  const kbResult = await exportProject({
    projectId,
    paths,
    storyboard,
    settings,
    scope: createExportScope(),
    store: projects.store(projectId),
    options: { outputPath: output, imageDurationSec: 3, kenBurns: true, kenBurnsDirection: direction, kenBurnsStrength: strength },
  })
  check(`${direction}/${strength} 导出成功`, kbResult.ok === true, kbResult.error?.message)
  const probeOne = JSON.parse((await execFileAsync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', output])).stdout)
  check(`${direction}/${strength} 分辨率仍为 1280x720`, probeOne.streams[0].width === 1280 && probeOne.streams[0].height === 720)

  const firstFrame = join(workspace, `kb-${direction}-${strength}-first.png`)
  const lastFrame = join(workspace, `kb-${direction}-${strength}-last.png`)
  await execFileAsync('ffmpeg', ['-y', '-i', output, '-ss', '0.2', '-frames:v', '1', firstFrame, '-loglevel', 'error'])
  await execFileAsync('ffmpeg', ['-y', '-i', output, '-ss', '2.7', '-frames:v', '1', lastFrame, '-loglevel', 'error'])
  const [firstBuffer, lastBuffer] = await Promise.all([readFile(firstFrame), readFile(lastFrame)])
  check(`${direction}/${strength} 首尾帧不同（缩放可见）`, !firstBuffer.equals(lastBuffer))
  kbFrames[`${direction}-${strength}`] = firstBuffer
}
check('推近与拉远首帧不同（方向相反）', !kbFrames['in-light'].equals(kbFrames['out-light']))
check('轻微与中等首帧不同（幅度不同）', !kbFrames['in-light'].equals(kbFrames['in-medium']))

console.log(`\n结果：${checks - failures.length}/${checks} 项通过`)
if (failures.length > 0) {
  console.log('\n失败项：')
  for (const item of failures) console.log(`  - ${item}`)
  process.exitCode = 1
} else {
  console.log('模块 4 验收通过：预检 → 合成 → ffprobe 校验 → 缺素材拒绝 → 路径错误可读 → 超时终止并清理。\n')
}
