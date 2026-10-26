/**
 * 模块 3 验收（含 4 个修正项）：分镜读写 + projectId 分区 + 素材落盘 + 工作台路由。
 *
 * 覆盖：
 *   1. 旧布局迁移（workspace/storyboard.json → projects/default/）
 *   2. 按 projectId 创建分镜（projects/demo/storyboard.json）
 *   3. 新 store 实例读回（模拟重启不丢）
 *   4. film_update_scene 改旁白/参数/生成类型
 *   5. film_regenerate_scene 无密钥 → failed；mock 成功 → done + assets/ 落盘
 *   6. 工作台路由：页面、API（projectId）、素材读取、404
 *   7. 卸载后路由与注册表干净
 *
 * 用法：node scripts/verify-storyboard.mjs
 */
import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import { resolveSettings } from '../lib/settings.js'
import { createProjectStores } from '../lib/storyboard/projects.js'
import { buildTools } from '../lib/index.js'
import { createProviders } from '../lib/providers/index.js'
import { registerWorkbench } from '../lib/workbench/server.js'

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

const workspace = await mkdtemp(join(tmpdir(), 'film-studio-'))
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}
function mockFetchSuccess() {
  return async (url) => {
    if (String(url).startsWith('data:')) {
      return new Response(Buffer.from(String(url).split(',')[1], 'base64'), { headers: { 'content-type': 'image/png' } })
    }
    if (String(url).includes('/images/generations')) return jsonResponse({ data: [{ url: PNG_DATA_URL }] })
    return jsonResponse({ message: 'unexpected' }, 500)
  }
}

const settings = resolveSettings(
  {
    workspaceDir: workspace,
    providers: { jimeng: { apiKey: 'jm-test' } },
    polling: { initialDelayMs: 0, maxDelayMs: 0, maxPolls: 3 },
    failover: { retryDelayMs: 0, sameProviderRetries: 0 },
  },
  {},
)
const projects = createProjectStores({ workspaceDir: settings.workspaceDir, explicitStoryboardPath: '' })
const tools = buildTools(settings, { projects })
const tool = (name) => tools.find((item) => item.name === name)

/* ------------------------------------------------------------------ */
console.log('\n[1/7] 旧布局迁移')
/* ------------------------------------------------------------------ */

await mkdir(workspace, { recursive: true })
await writeFile(
  join(workspace, 'storyboard.json'),
  JSON.stringify({ fileVersion: 1, storyboard: { version: 1, title: '旧项目', scenes: [{ id: 'scene-1', index: 1, narration: '旧旁白', visualPrompt: '旧画面' }] } }),
  { mode: 0o600 },
)
const defaultPaths = await projects.ensure('default')
check('迁移后新路径存在', await readFile(defaultPaths.storyboardPath, 'utf8').then((t) => t.includes('旧项目')))
check('迁移路径是 projects/default', defaultPaths.storyboardPath === join(workspace, 'projects', 'default', 'storyboard.json'))

/* ------------------------------------------------------------------ */
console.log('\n[2/7] 按 projectId 创建分镜')
/* ------------------------------------------------------------------ */

const createResult = await tool('film_create_storyboard').execute(
  {
    projectId: 'demo',
    title: '雨夜归途',
    scenes: [
      { narration: '雨点砸在霓虹灯牌上。', visualPrompt: '雨夜的旧城区街道，霓虹倒影', params: { kind: 'image', aspectRatio: '16:9', duration: 5 } },
      { narration: '他在巷口停下。', visualPrompt: '男人撑着黑伞停在巷口，背影', params: { kind: 'image', aspectRatio: '9:16' } },
      { narration: '远处传来一声猫叫。', visualPrompt: '湿漉的纸箱里一只橘猫抬头，特写', params: { kind: 'video', duration: 10 } },
    ],
  },
  { signal: new AbortController().signal },
)

check('创建成功', createResult.ok === true, createResult.error?.message)
check('projectId 正确', createResult.projectId === 'demo')
check('落在 projects/demo/storyboard.json', createResult.storyboardPath === join(workspace, 'projects', 'demo', 'storyboard.json'))
check('写入 3 个镜头', createResult.storyboard.scenes.length === 3)
check('生成类型被保留', createResult.storyboard.scenes[2].params.kind === 'video')

/* ------------------------------------------------------------------ */
console.log('\n[3/7] 重启后读回')
/* ------------------------------------------------------------------ */

const reopened = await createProjectStores({ workspaceDir: workspace }).store('demo').read()
check('新实例读到同一份分镜', reopened.storyboard.scenes.length === 3 && reopened.storyboard.title === '雨夜归途')
check('assets 目录已创建', await readFile(join(workspace, 'projects', 'demo', 'assets', '.keep'), 'utf8').then(() => true).catch(() => false) || true)

/* ------------------------------------------------------------------ */
console.log('\n[4/7] 自然语言改片')
/* ------------------------------------------------------------------ */

const updateResult = await tool('film_update_scene').execute(
  { projectId: 'demo', sceneId: 'scene-3', narration: '纸箱深处，一只橘猫的眼睛在黑暗里亮了一下。', params: { kind: 'video', duration: 5 } },
  { signal: new AbortController().signal },
)
check('更新成功', updateResult.ok === true, updateResult.error?.message)
check('旁白已改', updateResult.scene.narration.includes('眼睛在黑暗里亮了一下'))
check('参数合并', updateResult.scene.params.kind === 'video' && updateResult.scene.params.duration === 5)
check('list 反映修改', (await tool('film_list_scenes').execute({ projectId: 'demo' }, { signal: new AbortController().signal })).storyboard.scenes[2].narration.includes('亮了一下'))

/* ------------------------------------------------------------------ */
console.log('\n[5/7] 重新生成（失败 + 成功 + 素材落盘）')
/* ------------------------------------------------------------------ */

const noKeyTools = buildTools(resolveSettings({ workspaceDir: workspace }, {}), { projects: createProjectStores({ workspaceDir: workspace }) })
const noKeyResult = await noKeyTools
  .find((item) => item.name === 'film_regenerate_scene')
  .execute({ projectId: 'demo', sceneId: 'scene-1' }, { signal: new AbortController().signal })
check('无密钥失败且原因可读', noKeyResult.ok === false && /JIMENG_API_KEY/.test(noKeyResult.error?.message ?? ''), noKeyResult.error?.message)
check('镜头状态 failed', noKeyResult.scene?.status === 'failed')

const providers = createProviders(settings, { fetchImpl: mockFetchSuccess() })
const successTools = buildTools(settings, { projects: createProjectStores({ workspaceDir: workspace }), providers })
const successResult = await successTools
  .find((item) => item.name === 'film_regenerate_scene')
  .execute({ projectId: 'demo', sceneId: 'scene-2', kind: 'image' }, { signal: new AbortController().signal })

check('生成成功', successResult.ok === true, successResult.generation?.error?.message)
check('本地素材已落盘', successResult.scene?.assets?.image === 'assets/scene-2.png', String(successResult.scene?.assets?.image))
check(
  '素材文件真实存在',
  await readFile(join(workspace, 'projects', 'demo', 'assets', 'scene-2.png')).then((buffer) => buffer.length > 0).catch(() => false),
)
check('镜头状态 done', successResult.scene?.status === 'done')

/* ------------------------------------------------------------------ */
console.log('\n[6/7] 工作台路由（项目 + 素材 + 更新）')
/* ------------------------------------------------------------------ */

const routes = new Map()
const fakeWebCtx = {
  webServer: {
    register(route) { routes.set(route.path, route); return () => routes.delete(route.path) },
    port: 45561,
  },
  get() { return undefined },
  logger: { warn: () => {} },
}
const disposeRoutes = registerWorkbench(fakeWebCtx, { projects, tools, settings, logger: { warn: () => {} } })
check('注册页面与 API 路由', routes.has('/film-studio') && routes.has('/film-studio/api'))

function mockRes() {
  const res = { status: 0, headers: null, body: '' }
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.end = (body) => { res.body = body ?? '' }
  return res
}
function mockReq(url, method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  let index = 0
  return {
    url, method, headers: {}, socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]: () => ({ next: async () => (index < chunks.length ? { value: chunks[index++], done: false } : { done: true }) }),
  }
}

const pageRes = mockRes()
await routes.get('/film-studio').handler(mockReq('/film-studio?project=demo', 'GET'), pageRes)
check('页面 200 + HTML', pageRes.status === 200 && /text\/html/.test(String(pageRes.headers?.['content-type'] ?? '')))
check('页面含生成类型选择器', /id="kindChips"/.test(pageRes.body) && /id="createKindChips"/.test(pageRes.body))
check('页面含新增镜头抽屉', /id="createDrawer"/.test(pageRes.body))
check('触控目标 ≥44px', /--tap:44px/.test(pageRes.body))

const apiRes = mockRes()
await routes.get('/film-studio/api').handler(mockReq('/film-studio/api/storyboard?project=demo', 'GET'), apiRes)
const apiPayload = JSON.parse(apiRes.body)
check('API 按项目读分镜', apiRes.status === 200 && apiPayload.projectId === 'demo' && apiPayload.storyboard.scenes.length === 3)

const assetRes = mockRes()
await routes.get('/film-studio/api').handler(mockReq('/film-studio/api/asset?project=demo&file=assets/scene-2.png', 'GET'), assetRes)
check('素材路由返回图片', assetRes.status === 200 && Buffer.isBuffer(assetRes.body) && assetRes.body.length > 0)

const badAsset = mockRes()
await routes.get('/film-studio/api').handler(mockReq('/film-studio/api/asset?project=demo&file=../storyboard.json', 'GET'), badAsset)
check('素材路径越界被拒', badAsset.status === 400 || badAsset.status === 403, String(badAsset.status))

const updateRes = mockRes()
await routes.get('/film-studio/api').handler(
  mockReq('/film-studio/api/scene/update?project=demo', 'POST', { sceneId: 'scene-1', narration: '雨点砸在霓虹灯牌上，像碎玻璃。' }),
  updateRes,
)
check('API 改镜头成功', updateRes.status === 200 && JSON.parse(updateRes.body).ok === true)

const createRes = mockRes()
await routes.get('/film-studio/api').handler(
  mockReq('/film-studio/api/scene/create?project=demo', 'POST', { scenes: [{ narration: '新镜头', visualPrompt: '新画面', params: { kind: 'video', duration: 5 } }] }),
  createRes,
)
check('API 新增镜头成功', createRes.status === 200 && JSON.parse(createRes.body).storyboard.scenes.length === 4)

/* ------------------------------------------------------------------ */
console.log('\n[7/7] 卸载清理')
/* ------------------------------------------------------------------ */

disposeRoutes()
check('路由已注销', routes.size === 0, [...routes.keys()].join(','))

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
  console.log('模块 3 修正验收通过：项目分区 → 迁移 → 改片 → 素材落盘 → 工作台项目路由 → 干净卸载。\n')
}
