/**
 * 模块 1 的本地验收脚本：不启动整个 DSH，只用 Cordis 拉起插件的一个 fiber，
 * 验证四件事：
 *
 *   1. 插件能被 Cordis 加载（name / inject / Config 声明正确）；
 *   2. 工具通过 ctx.effect 注册成功，schema 通过 defineTool 的严格校验；
 *   3. 工具真的能在当前容器里 spawn `ffmpeg -version`（proot 链路）；
 *   4. 插件卸载后注册表干净（ctx.effect 回收）。
 *
 * 用法：node scripts/verify.mjs
 * 退出码：0 全部通过；1 有断言失败。
 */
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import { resolveSettings } from '../lib/settings.js'

const failures = []
let checks = 0

function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    failures.push(`${label}${detail === '' ? '' : ` —— ${detail}`}`)
    console.log(`  ✗ ${label}${detail === '' ? '' : ` —— ${detail}`}`)
  }
}

console.log('\n[1/4] 加载插件（Cordis fiber）')

const registry = new Map()
const ctx = new Context()
const toolsService = {
  register(tool) {
    if (registry.has(tool.name)) throw new Error(`工具重复注册：${tool.name}`)
    registry.set(tool.name, tool)
    return () => {
      registry.delete(tool.name)
    }
  },
}
ctx.provide('tools', toolsService)

const fiber = ctx.plugin(plugin, {})
await fiber.await()

check('插件名正确', plugin.name === 'dsh-video-android', `实际 ${plugin.name}`)
check('inject 只声明 tools', Array.isArray(plugin.inject) && plugin.inject.join(',') === 'tools', JSON.stringify(plugin.inject))
check('工具注册数为 13（探测 + 生成 x2 + 分镜 x4 + 导出 x3 + 提示词 x3）', registry.size === 13, `实际 ${registry.size}`)
check('注册了 film_probe_ffmpeg', registry.has('film_probe_ffmpeg'))
check('注册了 film_generate_image / film_generate_video', registry.has('film_generate_image') && registry.has('film_generate_video'))

const tool = registry.get('film_probe_ffmpeg')
check('工具带 output.schema', Boolean(tool?.output?.schema))
check('工具带 render', typeof tool?.output?.render === 'function')
check('parameters 是 JSON Schema 对象', tool?.parameters?.type === 'object')

console.log('\n[2/4] 执行探测（真实 spawn ffmpeg -version）')

const controller = new AbortController()
const startedAt = Date.now()
let result
try {
  result = await tool.execute({}, { signal: controller.signal })
} catch (error) {
  check('execute 不抛异常', false, String(error?.message ?? error))
  result = null
}
const elapsed = Date.now() - startedAt

if (result) {
  console.log(`  耗时 ${elapsed}ms，ok=${result.ok}`)
  check('ffmpeg 可用', result.ffmpeg.ok === true, result.ffmpeg.error?.message ?? '')
  check('ffmpeg 有版本号', typeof result.ffmpeg.version === 'string' && result.ffmpeg.version.length > 0)
  check('ffmpeg 有解析后的绝对路径', typeof result.ffmpeg.resolvedPath === 'string' && result.ffmpeg.resolvedPath.startsWith('/'))
  check('默认不返回 banner', result.ffmpeg.banner === '')
  check('平台是 arm64 Linux', result.env.platform === 'linux' && result.env.arch === 'arm64', `${result.env.platform}/${result.env.arch}`)
  check('配置来源可追溯', typeof result.settings.sources.ffmpegPath === 'string')

  const rendered = tool.output.render({}, result)
  check('render 返回文本块', Array.isArray(rendered) && rendered[0]?.type === 'text' && rendered[0].text.length > 0)

  console.log('\n  渲染给模型的效果：')
  for (const line of rendered[0].text.split('\n')) console.log(`    │ ${line}`)
}

console.log('\n[3/4] 失败路径与参数校验')

const badResult = await tool.execute({ ffmpegPath: '/nonexistent/definitely-not-ffmpeg' }, { signal: new AbortController().signal })
check('错误路径被归类为 not-found', badResult.ffmpeg.ok === false && badResult.ffmpeg.error?.kind === 'not-found', badResult.ffmpeg.error?.kind)
check('错误结果带可执行提示', typeof badResult.hint === 'string' && badResult.hint.length > 0)

let rejected = false
try {
  await tool.execute({ ffmpegPath: 123 }, { signal: new AbortController().signal })
} catch {
  rejected = true
}
check('非法参数被 defineTool 拒绝', rejected === true)

const envSettings = resolveSettings({ ffmpegPath: '/from/patch' }, { FILM_STUDIO_FFMPEG: '/from/env', PATH: '' })
check('patch 配置优先于环境变量（模块 4 约定）', envSettings.ffmpegPath === '/from/patch', envSettings.ffmpegPath)
check('配置来源标记为 config', envSettings.sources.ffmpegPath === 'config:ffmpegPath', envSettings.sources.ffmpegPath)

console.log('\n[4/4] 卸载回收（ctx.effect）')

await fiber.dispose()
check('卸载后注册表为空', registry.size === 0, `残留 ${[...registry.keys()].join(',')}`)
await ctx.fiber.dispose()

console.log(`\n结果：${checks - failures.length}/${checks} 项通过`)
if (failures.length > 0) {
  console.log('\n失败项：')
  for (const item of failures) console.log(`  - ${item}`)
  process.exitCode = 1
} else {
  console.log('模块 1 验证通过：Cordis 加载 → ctx.effect 注册 → proot 子进程 → 结构化结果 → 干净卸载。\n')
}
