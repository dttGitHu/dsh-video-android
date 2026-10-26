/**
 * 端到端串联：创建分镜 → 优化提示词 → 生成素材 → 导出 MP4。
 *
 * 供应商部分用本地生成的 mock 素材替代（真实账号未开通模型），
 * 其余链路（分镜写入、优化历史、素材预检、FFmpeg 合成、ffprobe 校验）全部真实执行。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSettings } from '../lib/settings.js'
import { createProjectStores } from '../lib/storyboard/projects.js'
import { buildTools } from '../lib/index.js'

const execFileAsync = promisify(execFile)
const workspace = await mkdtemp(join(tmpdir(), 'film-e2e-'))
const settings = resolveSettings({ workspaceDir: workspace })
const projects = createProjectStores({ workspaceDir: workspace })
const tools = buildTools(settings, { projects })
const tool = (name) => tools.find((item) => item.name === name)
const sig = () => ({ signal: new AbortController().signal })

const projectId = 'e2e'
const created = await tool('film_create_storyboard').execute(
  {
    projectId,
    title: '端到端串联',
    scenes: [
      { narration: '好看', visualPrompt: '很好看' },
      { narration: '他在巷口停下。', visualPrompt: '男人停在巷口，暖色路灯' },
      { narration: '猫叫了一声。', visualPrompt: '纸箱里橘猫抬头' },
    ],
  },
  sig(),
)
console.log('创建分镜:', created.ok, created.storyboard.scenes.length, '镜头')

const batch = await tool('film_optimize_all_prompts').execute({ action: 'start', projectId, style: '悬疑', maxRounds: 1 }, sig())
const submitted = await tool('film_optimize_all_prompts').execute(
  {
    action: 'submit',
    batchId: batch.batchId,
    results: ['scene-1', 'scene-2', 'scene-3'].map((sceneId) => ({
      sceneId,
      narration: `${sceneId}：雨夜里他停下脚步。`,
      visualPrompt: '雨夜巷道，男人撑伞停下，霓虹倒影，冷蓝与暖橙对比，低机位，浅景深',
      selfScores: { specificity: 4, visual: 4, emotion: 4 },
      reason: '补齐四要素并统一风格',
    })),
  },
  sig(),
)
console.log('批量优化:', submitted.phase, submitted.done + '/' + submitted.total)

// 生成 mock 素材（真实素材需供应商开通后由 film_regenerate_scene 产出）
const paths = await projects.ensure(projectId)
await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=#1e3a8a:s=640x360', '-frames:v', '1', join(paths.assetsDir, 'scene-1.png')])
await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=#7c2d12:s=640x360', '-frames:v', '1', join(paths.assetsDir, 'scene-2.png')])
await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', join(paths.assetsDir, 'scene-3.mp4')])

// 把素材与完成状态写回分镜（模拟 film_regenerate_scene 成功）
await projects.store(projectId).mutate((board) => ({
  ...board,
  scenes: board.scenes.map((scene, index) => ({
    ...scene,
    status: 'done',
    assets: index < 2 ? { image: `assets/scene-${index + 1}.png`, video: null } : { image: null, video: 'assets/scene-3.mp4' },
    params: { ...scene.params, kind: index < 2 ? 'image' : 'video', duration: index < 2 ? 3 : 2 },
  })),
}))

const check = await tool('film_check_assets').execute({ projectId }, sig())
console.log('素材预检:', check.ok, check.ready + '/' + check.total)

const exported = await tool('film_export_mp4').execute({ projectId, imageDurationSec: 3 }, sig())
console.log('导出:', exported.ok, exported.outputPath, exported.width + 'x' + exported.height, exported.durationSec + 's')

const listed = await tool('film_list_scenes').execute({ projectId }, sig())
const scene1 = listed.storyboard.scenes[0]
console.log('优化后文本:', scene1.currentPrompt.narration)
console.log('第 0 轮原始:', scene1.promptHistory[0].narration, '| 历史轮次:', scene1.promptHistory.map((item) => item.round).join(','))

const ok = created.ok && submitted.done === 3 && check.ok && exported.ok && exported.width === 1280 && Math.abs((exported.durationSec ?? 0) - 8) < 1.5 && scene1.promptHistory[0].narration === '好看' && scene1.currentPrompt.narration.includes('雨夜里')
import { stat } from 'node:fs/promises'
const info = await stat(exported.outputPath).catch(() => null)
console.log('文件大小:', info ? info.size : 0, '字节')
console.log(ok ? '\n端到端串联通过：分镜 → 优化 → 素材 → 导出，优化后链路正常产出视频。\n' : '\n端到端串联失败。\n')
process.exitCode = ok ? 0 : 1
