/**
 * 模块 5 验收：提示词自优化（纯文本，不联网）。
 *
 * 覆盖：
 *   1. 规则检查：空泛词、缺失要素、评分与建议一致；
 *   2. 单镜头「永不达标」：连续 3 轮 2 分 → 到上限停止，history 与 currentPrompt 正确；
 *   3. 单镜头「中途超时」：第 1 轮写入、第 2 轮不写入、数据不丢；
 *   4. 批量优化 3 镜头：每镜头 history + currentPrompt，原始版本留在第 0 轮；
 *   5. 风格差异：悬疑 vs 治愈 的指令方向不同；
 *   6. 历史裁剪：第 0 轮 + 最近 5 轮；
 *   7. 批量轮次预算：镜头数 × 2。
 *
 * 用法：node scripts/verify-prompt.mjs
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import { resolveSettings } from '../lib/settings.js'
import { createProjectStores } from '../lib/storyboard/projects.js'
import { buildTools } from '../lib/index.js'
import { normalizeScene } from '../lib/storyboard/model.js'

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

const workspace = await mkdtemp(join(tmpdir(), 'film-prompt-'))
const projectId = 'prompt-demo'
const settings = resolveSettings({ workspaceDir: workspace }, {})
const projects = createProjectStores({ workspaceDir: workspace })
const tools = buildTools(settings, { projects })
const tool = (name) => tools.find((item) => item.name === name)

const created = await tool('film_create_storyboard').execute(
  {
    projectId,
    title: '提示词优化测试',
    scenes: [
      { narration: '好看', visualPrompt: '很好看' },
      { narration: '雨点砸在霓虹灯牌上，像碎玻璃。', visualPrompt: '雨夜旧城区街道，一只黑猫走过积水，霓虹倒影，冷蓝色调' },
      { narration: '他在巷口停下，伞沿在滴水。', visualPrompt: '男人撑着黑伞停在巷口，背影，暖色路灯，雨雾' },
    ],
  },
  { signal: new AbortController().signal },
)

/* ------------------------------------------------------------------ */
console.log('\n[1/7] 规则检查')
/* ------------------------------------------------------------------ */

const badEval = await tool('film_evaluate_scene_prompt').execute({ projectId, sceneId: 'scene-1' }, { signal: new AbortController().signal })
check('空泛词被识别', badEval.vagueWords.includes('很好看'), JSON.stringify(badEval.vagueWords))
check('缺失要素被识别', badEval.elements.action === false || badEval.elements.scene === false || badEval.elements.light === false)
check('规则未通过', badEval.passed === false)
check('评分与建议一致（低分 + 有建议）', badEval.scores.specificity <= 3 && badEval.suggestions.length > 0)

const goodEval = await tool('film_evaluate_scene_prompt').execute({ projectId, sceneId: 'scene-2' }, { signal: new AbortController().signal })
check('完整画面通过规则', goodEval.passed === true, JSON.stringify(goodEval.elements))

/* ------------------------------------------------------------------ */
console.log('\n[2/7] 单镜头「永不达标」：3 轮后停止')
/* ------------------------------------------------------------------ */

const start = await tool('film_optimize_scene_prompt').execute({ action: 'start', projectId, sceneId: 'scene-1', style: '悬疑', maxRounds: 3 }, { signal: new AbortController().signal })
check('start 返回待提交指令', start.phase === 'awaiting_draft' && typeof start.instruction === 'string' && start.optimizationId)

const weakDraft = (round) => ({
  action: 'submit',
  optimizationId: start.optimizationId,
  round,
  draft: { narration: `第${round}轮旁白`, visualPrompt: '很好看' },
  selfScores: { specificity: 2, visual: 2, emotion: 2 },
  reason: `第${round}轮改法`,
})

const r1 = await tool('film_optimize_scene_prompt').execute(weakDraft(1), { signal: new AbortController().signal })
check('第 1 轮写入并继续', r1.applied === true && r1.phase === 'awaiting_draft' && r1.round === 2)
const r2 = await tool('film_optimize_scene_prompt').execute(weakDraft(2), { signal: new AbortController().signal })
check('第 2 轮写入并继续', r2.applied === true && r2.phase === 'awaiting_draft' && r2.round === 3)
const r3 = await tool('film_optimize_scene_prompt').execute(weakDraft(3), { signal: new AbortController().signal })
check('第 3 轮到达上限后停止', r3.phase === 'done' && r3.applied === true)
check('不会无限循环（最终 done）', r3.round === 3 && r3.finalPassed === false)

const scene1After = (await tool('film_list_scenes').execute({ projectId }, { signal: new AbortController().signal })).storyboard.scenes[0]
const optimizedRounds = scene1After.promptHistory.filter((item) => item.round > 0)
check('promptHistory 有 3 条优化记录', optimizedRounds.length === 3, JSON.stringify(scene1After.promptHistory.map((item) => item.round)))
check('原始版本仍在第 0 轮', scene1After.promptHistory[0].round === 0 && scene1After.promptHistory[0].narration === '好看')
check('currentPrompt 是第 3 轮结果', scene1After.currentPrompt.narration === '第3轮旁白', scene1After.currentPrompt.narration)
check('当前文本与 currentPrompt 同步', scene1After.narration === '第3轮旁白')

/* ------------------------------------------------------------------ */
console.log('\n[3/7] 单镜头「中途超时」：已完成轮次保留')
/* ------------------------------------------------------------------ */

const timeoutStart = await tool('film_optimize_scene_prompt').execute(
  { action: 'start', projectId, sceneId: 'scene-1', style: '治愈', maxRounds: 3, timeoutMs: 400 },
  { signal: new AbortController().signal },
)
const t1 = await tool('film_optimize_scene_prompt').execute(
  { action: 'submit', optimizationId: timeoutStart.optimizationId, round: 1, draft: { narration: '超时前第1轮', visualPrompt: '很好看' }, selfScores: { specificity: 2, visual: 2, emotion: 2 } },
  { signal: new AbortController().signal },
)
check('超时前第 1 轮已写入', t1.applied === true)
await sleep(600)
const t2 = await tool('film_optimize_scene_prompt').execute(
  { action: 'submit', optimizationId: timeoutStart.optimizationId, round: 2, draft: { narration: '超时后第2轮', visualPrompt: '很好看' }, selfScores: { specificity: 2, visual: 2, emotion: 2 } },
  { signal: new AbortController().signal },
)
check('超时后返回 timeout', t2.phase === 'timeout', t2.phase)
const afterTimeout = (await tool('film_list_scenes').execute({ projectId }, { signal: new AbortController().signal })).storyboard.scenes[0]
check('第 1 轮结果仍在文件里', afterTimeout.promptHistory.some((item) => item.narration === '超时前第1轮'))
check('第 2 轮不完整记录未写入', !afterTimeout.promptHistory.some((item) => item.narration === '超时后第2轮'))

/* ------------------------------------------------------------------ */
console.log('\n[4/7] 风格差异（悬疑 vs 治愈）')
/* ------------------------------------------------------------------ */

const suspense = await tool('film_optimize_scene_prompt').execute(
  { action: 'start', projectId, sceneId: 'scene-2', style: '悬疑', maxRounds: 1 },
  { signal: new AbortController().signal },
)
const healing = await tool('film_optimize_scene_prompt').execute(
  { action: 'start', projectId, sceneId: 'scene-2', style: '治愈', maxRounds: 1 },
  { signal: new AbortController().signal },
)
check('悬疑指令强调阴影/对比', /阴影|冷暖对比|留白/.test(suspense.instruction ?? ''))
check('治愈指令强调柔和/自然/暖色', /柔和|自然元素|温暖/.test(healing.instruction ?? ''))
check('同一镜头两种风格指令不同', suspense.instruction !== healing.instruction)
await tool('film_optimize_scene_prompt').execute({ action: 'cancel', optimizationId: suspense.optimizationId, projectId }, { signal: new AbortController().signal })
await tool('film_optimize_scene_prompt').execute({ action: 'cancel', optimizationId: healing.optimizationId, projectId }, { signal: new AbortController().signal })

/* ------------------------------------------------------------------ */
console.log('\n[5/7] 批量优化 3 镜头')
/* ------------------------------------------------------------------ */

// 让三个镜头都回到 draft
for (const sceneId of ['scene-1', 'scene-2', 'scene-3']) {
  await tool('film_update_scene').execute({ projectId, sceneId, narration: `批量前-${sceneId}` }, { signal: new AbortController().signal })
}
const batchStart = await tool('film_optimize_all_prompts').execute({ action: 'start', projectId, style: '悬疑', maxRounds: 2 }, { signal: new AbortController().signal })
check('批量 start 列出待优化镜头', batchStart.phase === 'awaiting_draft' && batchStart.total === 3, `${batchStart.total}`)
check('批量返回指令', typeof batchStart.instruction === 'string' && batchStart.instruction.includes('批量优化'))

const goodDraft = (sceneId) => ({
  sceneId,
  narration: `${sceneId} 的旁白：雨夜里他停下脚步。`,
  visualPrompt: '雨夜旧城区巷道，男人撑伞停下，霓虹倒影，冷蓝色调，低机位',
  selfScores: { specificity: 4, visual: 4, emotion: 4 },
  reason: '补齐四要素',
})
const batchSubmit = await tool('film_optimize_all_prompts').execute(
  { action: 'submit', batchId: batchStart.batchId, results: ['scene-1', 'scene-2', 'scene-3'].map(goodDraft) },
  { signal: new AbortController().signal },
)
check('批量提交后 3/3 完成', batchSubmit.done === 3 && batchSubmit.remaining.length === 0 && batchSubmit.phase === 'done', JSON.stringify(batchSubmit.results))

const afterBatch = (await tool('film_list_scenes').execute({ projectId }, { signal: new AbortController().signal })).storyboard.scenes
check('每个镜头都有优化记录', afterBatch.every((scene) => scene.promptHistory.some((item) => item.round > 0)))
check('每个镜头 currentPrompt 已更新', afterBatch.every((scene) => scene.currentPrompt.narration.includes('雨夜里')))
check('原始版本都还在第 0 轮', afterBatch.every((scene) => scene.promptHistory[0].round === 0))

/* ------------------------------------------------------------------ */
console.log('\n[6/7] 历史裁剪（第 0 轮 + 最近 5 轮）')
/* ------------------------------------------------------------------ */

const trimmed = normalizeScene({
  narration: 'n',
  visualPrompt: 'v',
  promptHistory: [0, 1, 2, 3, 4, 5, 6, 7].map((round) => ({ round, narration: `r${round}`, visualPrompt: `v${round}` })),
}, 1)
check('保留第 0 轮', trimmed.promptHistory[0].round === 0)
check('只保留最近 5 轮', trimmed.promptHistory.length === 6, String(trimmed.promptHistory.length))
check('是的确实是最近的', trimmed.promptHistory.map((item) => item.round).join(',') === '0,3,4,5,6,7', trimmed.promptHistory.map((item) => item.round).join(','))

/* ------------------------------------------------------------------ */
console.log('\n[7/7] 批量轮次预算 + 卸载清理')
/* ------------------------------------------------------------------ */

await tool('film_create_storyboard').execute(
  { projectId: 'budget-demo', title: '预算', scenes: [{ narration: '好看', visualPrompt: '很好看' }, { narration: '好看', visualPrompt: '很好看' }] },
  { signal: new AbortController().signal },
)
const budgetStart = await tool('film_optimize_all_prompts').execute({ action: 'start', projectId: 'budget-demo', style: '悬疑', maxRounds: 3 }, { signal: new AbortController().signal })
check('2 镜头批量预算 = 4 轮（镜头数×2）', budgetStart.total === 2)
let last = null
for (let round = 1; round <= 4; round += 1) {
  last = await tool('film_optimize_all_prompts').execute(
    {
      action: 'submit',
      batchId: budgetStart.batchId,
      results: [
        { sceneId: 'scene-1', narration: `预算第${round}轮`, visualPrompt: '很好看', selfScores: { specificity: 2, visual: 2, emotion: 2 } },
        { sceneId: 'scene-2', narration: `预算第${round}轮`, visualPrompt: '很好看', selfScores: { specificity: 2, visual: 2, emotion: 2 } },
      ],
    },
    { signal: new AbortController().signal },
  )
  if (last.phase !== 'awaiting_draft') break
}
check('预算用尽后停止', last.phase === 'done' && last.remaining.length > 0, JSON.stringify({ phase: last.phase, remaining: last.remaining }))
check(
  '预算截断明确告知被跳过的镜头',
  last.skippedScenes.length === last.remaining.length &&
    last.skippedScenes.every((item) => /预算/.test(item.reason)),
  JSON.stringify(last.skippedScenes),
)
check('预算截断有可读说明', typeof last.message === 'string' && /跳过/.test(last.message), String(last.message))

const registry = new Map()
const ctx = new Context()
ctx.provide('tools', { register(item) { registry.set(item.name, item); return () => registry.delete(item.name) } })
const fiber = ctx.plugin(plugin, { workspaceDir: workspace })
await fiber.await()
check('插件注册 13 个工具', registry.size === 13, [...registry.keys()].join(','))
await fiber.dispose()
check('卸载后注册表为空', registry.size === 0)
await ctx.fiber.dispose()

console.log(`\n结果：${checks - failures.length}/${checks} 项通过`)
if (failures.length > 0) {
  console.log('\n失败项：')
  for (const item of failures) console.log(`  - ${item}`)
  process.exitCode = 1
} else {
  console.log('模块 5 验收通过：规则检查 → 永不达标 3 轮停止 → 中途超时保留数据 → 风格差异 → 批量进度 → 历史裁剪 → 预算上限。\n')
}
