/**
 * 打磨验收：供应商设置面板（providers.json + 工作台抽屉）。
 *
 * 覆盖：
 *   1. 保存密钥 → providers.json（600）、返回掩码、不回显完整 Key；
 *   2. 合并写入（保存第二家不影响第一家）；
 *   3. 状态接口：保存后立即显示已配置（source=file，待重启）；
 *   4. 重启模拟：resolveSettings 读取文件；优先级 config > env > file；
 *   5. 清除某家；非法供应商返回 400；
 *   6. 页面静态检查：设置按钮/抽屉/密码框/重启提示。
 */
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSettings } from '../lib/settings.js'
import { createProjectStores } from '../lib/storyboard/projects.js'
import { buildTools } from '../lib/index.js'
import { registerWorkbench } from '../lib/workbench/server.js'
import { readProvidersFile, providersFilePath } from '../lib/providers/file-store.js'

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

const workspace = await mkdtemp(join(tmpdir(), 'film-providers-'))
const settings = resolveSettings({ workspaceDir: workspace }, {})
const projects = createProjectStores({ workspaceDir: workspace })
const tools = buildTools(settings, { projects })
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

console.log('\n[1/6] 保存密钥')
const secret = 'ark-test-0123456789abcdef'
const saved = await call('/film-studio/api/providers/save', 'POST', { provider: 'jimeng', fields: { apiKey: secret } })
check('保存返回 200', saved.status === 200 && saved.json.ok === true)
check('返回掩码而不是完整 Key', saved.json.masked?.apiKey === 'ark-…cdef', String(saved.json.masked?.apiKey))
check('响应里不含完整 Key', !JSON.stringify(saved.json).includes(secret))
const filePath = providersFilePath(workspace)
const info = await stat(filePath)
check('providers.json 权限 600', (info.mode & 0o777) === 0o600, (info.mode & 0o777).toString(8))
check('文件内容正确', JSON.parse(await readFile(filePath, 'utf8')).jimeng.apiKey === secret)
check('响应提示需要重启', saved.json.requiresRestart === true)

console.log('\n[2/6] 合并写入与状态')
await call('/film-studio/api/providers/save', 'POST', { provider: 'wanx', fields: { apiKey: 'sk-wanx-99887766' } })
const merged = readProvidersFile(workspace)
check('保存第二家不影响第一家', merged.jimeng?.apiKey === secret && merged.wanx?.apiKey === 'sk-wanx-99887766')
const status = await call('/film-studio/api/providers/status')
const jimengStatus = status.json.providers.find((item) => item.provider === 'jimeng')
check('状态显示已配置（待重启，source=file）', jimengStatus.configured === true && jimengStatus.source === 'file', JSON.stringify(jimengStatus))
check('未配置的供应商显示未配置', status.json.providers.find((item) => item.provider === 'kling').configured === false)
check('状态接口不返回密钥', !JSON.stringify(status.json).includes(secret))

console.log('\n[3/6] 重启模拟与优先级')
const restarted = resolveSettings({ workspaceDir: workspace }, {}, readProvidersFile(workspace))
check('重启后从文件读到 Key', restarted.providers.jimeng.apiKey === secret && restarted.providers.jimeng.apiKeySource === 'file')
const overridden = resolveSettings(
  { workspaceDir: workspace, providers: { jimeng: { apiKey: 'from-config' } } },
  { JIMENG_API_KEY: 'from-env' },
  readProvidersFile(workspace),
)
check('config 优先于 env 与文件', overridden.providers.jimeng.apiKey === 'from-config')
const envFirst = resolveSettings({ workspaceDir: workspace }, { JIMENG_API_KEY: 'from-env' }, readProvidersFile(workspace))
check('env 优先于文件', envFirst.providers.jimeng.apiKey === 'from-env' && envFirst.providers.jimeng.apiKeySource === 'env')

console.log('\n[4/6] 清除与非法输入')
const removed = await call('/film-studio/api/providers/remove', 'POST', { provider: 'jimeng' })
check('清除返回 200', removed.status === 200 && removed.json.ok === true)
check('文件里已无该家', readProvidersFile(workspace).jimeng === undefined)
check('另一家仍在', readProvidersFile(workspace).wanx?.apiKey === 'sk-wanx-99887766')
const bad = await call('/film-studio/api/providers/save', 'POST', { provider: 'hack', fields: { apiKey: 'x' } })
check('非法供应商返回 400', bad.status === 400 && /未知供应商/.test(bad.json.error.message))

console.log('\n[5/6] 页面静态检查')
const pageRes = mockRes()
await routes.get('/film-studio').handler(mockReq('/film-studio', 'GET'), pageRes)
const html = pageRes.body
check('顶部设置按钮', /id="settingsBtn"/.test(html))
check('设置抽屉', /id="settingsDrawer"/.test(html))
check('密码输入框', /input\.type = 'password'/.test(html))
check('保存/清除按钮', /save-provider/.test(html) && /remove-provider/.test(html))
check('重启生效提示', /重启 DSHA 生效/.test(html))
check('设置按钮 44px 触控', /\.icon-btn[^}]*min-height:var\(--tap\)/.test(html))

console.log('\n[6/6] 清理')
dispose()
check('路由注销', routes.size === 0)

console.log(`\n结果：${checks - failures.length}/${checks} 项通过`)
if (failures.length > 0) {
  console.log('\n失败项：')
  for (const item of failures) console.log(`  - ${item}`)
  process.exitCode = 1
} else {
  console.log('供应商设置面板通过：保存 → 掩码 → 状态 → 重启读取 → 优先级 → 清除。\n')
}
