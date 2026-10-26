/**
 * 打磨项一验收：工作台项目切换。
 *
 * 覆盖：
 *   1. 两个项目、各自分镜，项目列表元数据正确；
 *   2. 切换 projectId 后读取到对应分镜；
 *   3. 重复创建返回 409，非法 id 返回 400；
 *   4. 页面包含项目选择器、未保存提示、切换后状态重置、URL 编码；
 *   5. 空项目列表时前端回退当前项目（静态检查）。
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSettings } from '../lib/settings.js'
import { createProjectStores } from '../lib/storyboard/projects.js'
import { buildTools } from '../lib/index.js'
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

const workspace = await mkdtemp(join(tmpdir(), 'film-wb-'))
const settings = resolveSettings({ workspaceDir: workspace }, {})
const projects = createProjectStores({ workspaceDir: workspace })
const tools = buildTools(settings, { projects })
const tool = (name) => tools.find((item) => item.name === name)
const sig = () => ({ signal: new AbortController().signal })

/* 两个项目，各放不同分镜 */
await tool('film_create_storyboard').execute(
  { projectId: 'ad-a', title: '咖啡广告', scenes: [{ narration: '清晨的咖啡香。', visualPrompt: '清晨厨房，一杯咖啡冒热气，柔光' }] },
  sig(),
)
await tool('film_create_storyboard').execute(
  { projectId: 'ad-b', title: '露营短片', scenes: [{ narration: '帐篷外的星空。', visualPrompt: '夜晚营地，帐篷灯光，银河' }, { narration: '篝火旁聊天。', visualPrompt: '篝火特写，火星升起，暖橙' }] },
  sig(),
)

const routes = new Map()
const fakeWebCtx = {
  webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) }, port: 45561 },
  get() { return undefined },
  logger: { warn: () => {} },
}
const dispose = registerWorkbench(fakeWebCtx, { projects, tools, settings, logger: { warn: () => {} } })

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
const call = async (url, method = 'GET', body) => {
  const res = mockRes()
  await routes.get('/film-studio/api').handler(mockReq(url, method, body), res)
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null }
}

console.log('\n[1/5] 项目列表')
const listRes = await call('/film-studio/api/projects')
check('列表返回 ok', listRes.status === 200 && listRes.json.ok === true)
const ids = listRes.json.projects.map((item) => item.projectId)
check('列出两个项目', ids.includes('ad-a') && ids.includes('ad-b'), JSON.stringify(ids))
const adA = listRes.json.projects.find((item) => item.projectId === 'ad-a')
check('元数据含标题与镜头数', adA.title === '咖啡广告' && adA.sceneCount === 1, JSON.stringify(adA))
check('元数据含 updatedAt/hasStoryboard', 'updatedAt' in adA && adA.hasStoryboard === true)

console.log('\n[2/5] 切换项目读取分镜')
const storyA = await call('/film-studio/api/storyboard?project=ad-a')
const storyB = await call('/film-studio/api/storyboard?project=ad-b')
check('ad-a 读到自己的分镜', storyA.json.storyboard.title === '咖啡广告' && storyA.json.storyboard.scenes.length === 1)
check('ad-b 读到自己的分镜', storyB.json.storyboard.title === '露营短片' && storyB.json.storyboard.scenes.length === 2)
check('切换后场景不同', storyA.json.storyboard.scenes[0].narration !== storyB.json.storyboard.scenes[0].narration)

console.log('\n[3/5] 创建校验')
const dup = await call('/film-studio/api/projects/create', 'POST', { projectId: 'ad-a' })
check('重复创建返回 409', dup.status === 409 && /已存在/.test(dup.json.error.message), `${dup.status}`)
const invalid = await call('/film-studio/api/projects/create', 'POST', { projectId: '../evil' })
check('非法 id 返回 400 且说明原因', invalid.status === 400 && /不能以 \. 开头|只允许/.test(invalid.json.error.message), invalid.json?.error?.message)
const tooLong = await call('/film-studio/api/projects/create', 'POST', { projectId: 'x'.repeat(65) })
check('超长 id 返回 400', tooLong.status === 400 && /64/.test(tooLong.json.error.message))
const created = await call('/film-studio/api/projects/create', 'POST', { projectId: 'ad-c' })
check('创建新项目成功', created.status === 201 && created.json.project.projectId === 'ad-c')
check('新项目含空分镜', created.json.project.sceneCount === 0 && created.json.project.hasStoryboard === true)

console.log('\n[4/5] 页面静态检查')
const pageRes = mockRes()
await routes.get('/film-studio').handler(mockReq('/film-studio?project=ad-a', 'GET'), pageRes)
const html = pageRes.body
check('顶部项目按钮', /id="projectBtn"/.test(html))
check('项目抽屉与列表', /id="projectDrawer"/.test(html) && /id="projectList"/.test(html))
check('未保存提示 confirm', /有未保存的编辑，确定切换项目/.test(html))
check('切换后状态重置', /function resetUnsaved/.test(html) && /resetUnsaved\(\)/.test(html))
check('URL 编码 projectId', /encodeURIComponent\(projectId\)/.test(html))
check('项目列表项 44px 触控', /--tap:44px/.test(html) && /\.project-item[^}]*min-height:var\(--tap\)/.test(html))
check('新建后自动切换', /closeDrawer\('projectDrawer'\);\s*switchProject\(nextId\);/.test(html))
check('空列表回退当前项目', /if \(!hasCurrent\) state\.projects\.unshift/.test(html))
check('切换前检查未保存', /if \(hasUnsavedEdits\(\) && !window\.confirm/.test(html))

console.log('\n[5/5] 清理')
dispose()
check('路由注销', routes.size === 0)

console.log(`\n结果：${checks - failures.length}/${checks} 项通过`)
if (failures.length > 0) {
  console.log('\n失败项：')
  for (const item of failures) console.log(`  - ${item}`)
  process.exitCode = 1
} else {
  console.log('打磨项一通过：列表 → 切换 → 创建校验 → 页面状态重置。\n')
}
