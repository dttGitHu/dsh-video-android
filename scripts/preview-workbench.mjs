/**
 * 本地预览工作台页面（仅开发/验收用，不是生产服务）。
 *
 *   node scripts/preview-workbench.mjs [--port 3099]
 *
 * 起一个只读的本地 HTTP 服务：页面来自 assets/workbench.html，API 返回演示数据，
 * 方便在电脑或手机浏览器里确认窄屏布局、卡片、抽屉，而不用先重启 DSHA。
 * 生产环境请直接用 DSH 的 /film-studio（由插件的 webServer 路由提供）。
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE = join(HERE, '..', 'assets', 'workbench.html')

const portArg = process.argv.indexOf('--port')
const PORT = portArg === -1 ? 3099 : Number(process.argv[portArg + 1])
const HOST = '127.0.0.1'

let previewPolls = 0

const IMAGE_PLACEHOLDER = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1e3a8a"/><stop offset="1" stop-color="#0f172a"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><text x="32" y="300" fill="#93c5fd" font-size="20" font-family="sans-serif">镜头素材预览（示例）</text></svg>',
)}`

function demoBoard() {
  return {
    version: 1,
    title: '雨夜归途',
    updatedAt: new Date().toISOString(),
    scenes: [
      {
        id: 'scene-1',
        index: 1,
        narration: '雨点砸在霓虹灯牌上，像碎玻璃。',
        visualPrompt: '雨夜的旧城区街道，霓虹倒影在积水里，电影感，浅景深',
        imageUrl: IMAGE_PLACEHOLDER,
        videoUrl: null,
        status: 'done',
        assets: { image: null, video: null }, params: { kind: 'image', aspectRatio: '16:9', duration: 5, provider: 'jimeng', model: null, negativePrompt: null },
        switchTrace: [],
        error: null,
        lastGeneratedAt: new Date().toISOString(),
      },
      {
        id: 'scene-2',
        index: 2,
        narration: '他在巷口停下，伞沿在滴水。',
        visualPrompt: '男人撑着黑伞停在巷口，背影，暖色路灯，雨雾',
        imageUrl: null,
        videoUrl: null,
        status: 'draft',
        assets: { image: null, video: null }, params: { kind: 'image', aspectRatio: '9:16', duration: 5, provider: null, model: null, negativePrompt: null },
        switchTrace: [],
        error: null,
        lastGeneratedAt: null,
      },
      {
        id: 'scene-3',
        index: 3,
        narration: '纸箱深处，一只橘猫的眼睛在黑暗里亮了一下。',
        visualPrompt: '湿漉的纸箱里一只橘猫抬头，特写，浅景深',
        imageUrl: null,
        videoUrl: null,
        status: 'failed',
        assets: { image: null, video: null }, params: { kind: 'video', aspectRatio: '16:9', duration: 5, provider: null, model: null, negativePrompt: null },
        switchTrace: [
          { from: 'jimeng', to: 'kling', reason: 'rate_limit', attempt: 2, message: '即梦请求失败（HTTP 429）：rate limit exceeded' },
        ],
        error: '可灵：账号额度不足',
        lastGeneratedAt: new Date().toISOString(),
      },
    ],
  }
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://x').pathname
  if (pathname === '/film-studio') {
    try {
      const html = await readFile(PAGE, 'utf8')
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(html)
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(String(error?.message ?? error))
    }
    return
  }
  if (pathname === '/film-studio/api/providers/status') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: true, requiresRestart: true, providers: [
      { provider: 'jimeng', label: '即梦（火山方舟）', fields: ['apiKey'], env: 'JIMENG_API_KEY', configured: true, source: 'config', hint: 'cordis.patch.yml 已配置' },
      { provider: 'doubaoSeedream', label: '豆包 Seedream（图像）', fields: ['apiKey'], env: 'DOUBAO_SEEDREAM_API_KEY', configured: false, source: 'none', hint: '未配置' },
      { provider: 'doubaoSeedance', label: '豆包 Seedance（视频）', fields: ['apiKey'], env: 'DOUBAO_SEEDANCE_API_KEY', configured: false, source: 'none', hint: '未配置' },
      { provider: 'wanx', label: '通义万相（Wanx）', fields: ['apiKey'], env: 'DASHSCOPE_API_KEY', configured: false, source: 'none', hint: '未配置' },
      { provider: 'tongyiWanx', label: '通义万相（Tongyi-Wanx）', fields: ['apiKey'], env: 'TONGYI_WANX_API_KEY', configured: false, source: 'none', hint: '未配置' },
      { provider: 'kling', label: '可灵（Kling）', fields: ['accessKey','secretKey'], env: 'KLING_ACCESS_KEY', configured: false, source: 'none', hint: '未配置' }
    ] }))
    return
  }
  if (pathname === '/film-studio/api/providers/save' || pathname === '/film-studio/api/providers/remove') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: true, requiresRestart: true, message: '已保存到 providers.json，重启 DSHA 后生效', masked: {} }))
    return
  }
  if (pathname === '/film-studio/api/projects') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: true, projects: [
      { projectId: 'default', title: '雨夜归途', sceneCount: 3, updatedAt: new Date().toISOString(), hasStoryboard: true },
      { projectId: 'ad-2026', title: '咖啡广告', sceneCount: 1, updatedAt: new Date().toISOString(), hasStoryboard: true },
    ] }))
    return
  }
  if (pathname === '/film-studio/api/projects/create') {
    response.writeHead(201, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: true, project: { projectId: 'new-project', title: 'new-project', sceneCount: 0, updatedAt: null, hasStoryboard: true } }))
    return
  }
  if (pathname === '/film-studio/api/export/status') {
    previewPolls += 1
    const running = previewPolls % 4 !== 0
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(running
      ? { ok: true, found: true, exportId: 'exp-preview', projectId: 'default', phase: 'segment', label: '正在合成第 2/3 段', sceneIndex: 2, sceneTotal: 3, status: 'running', error: null }
      : { ok: true, found: true, exportId: 'exp-preview', projectId: 'default', phase: 'done', label: '完成', sceneIndex: 3, sceneTotal: 3, status: 'done', error: null }))
    return
  }
  if (pathname === '/film-studio/api/export') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({
      ok: true,
      projectId: 'default',
      outputPath: '/tmp/film-demo/projects/demo/output/final.mp4',
      width: 1280,
      height: 720,
      durationSec: 8,
      fileSize: 55870,
      segments: [{ sceneId: 'scene-1', kind: 'image', source: 'local', durationSec: 3, ms: 800 }],
      warnings: [],
    }))
    return
  }
  if (pathname === '/film-studio/api/storyboard') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: true, storyboardPath: '(预览)', storyboard: demoBoard() }))
    return
  }
  if (pathname.startsWith('/film-studio/api/')) {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: true, storyboard: demoBoard() }))
    return
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('not found')
})

server.listen(PORT, HOST, () => {
  console.log(`工作台预览：http://${HOST}:${PORT}/film-studio`)
  console.log('（仅用于查看布局；生产入口是 DSH 的 /film-studio）')
})
