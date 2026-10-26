/**
 * 工作台 HTTP 路由：挂到 DSH 自己的 WebServer 上，与 DSH 同源同鉴权。
 *
 *   GET  /film-studio                      手机窄屏工作台页面（?project=<id>）
 *   GET  /film-studio/api/storyboard       读分镜（?project=<id>）
 *   GET  /film-studio/api/projects         列出已有项目
 *   GET  /film-studio/api/asset            读取项目素材（?project=&file=assets/x.png）
 *   POST /film-studio/api/scene/update     改镜头（旁白/画面/参数/生成类型）
 *   POST /film-studio/api/scene/regenerate 重新生成（复用模块 2 调度器）
 *   POST /film-studio/api/scene/create     新增镜头
 *
 * 不引额外 HTTP 服务、不跨域：页面里 fetch 同源，DSH 的浏览器会话 cookie
 * 就是鉴权凭据，handler 里再用 connection.requestRejection 复核一次。
 * @module workbench/server
 */
import { readFile } from 'node:fs/promises'
import { maskSecret, readProvidersFile, removeProviderSecret, saveProviderSecret } from '../providers/file-store.js'
import { dirname, join, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE_FILE = join(HERE, '..', '..', 'assets', 'workbench.html')

const API_PREFIX = '/film-studio/api'
const MAX_BODY_BYTES = 1_000_000

/** 素材文件名白名单：只允许 assets/ 下一层文件。 */
const ASSET_PATTERN = /^assets\/[A-Za-z0-9._-]+$/

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4v': 'video/mp4',
}

function compact(input) {
  const output = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value
  }
  return output
}

function isLoopback(request) {
  const remote = String(request?.socket?.remoteAddress ?? '')
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

function sendJson(res, status, payload) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(payload))
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是对象')
  return parsed
}

/**
 * 创建路由处理器。
 * @param {{
 *   projects: ReturnType<import('../storyboard/projects.js').createProjectStores>,
 *   tools: Array<any>,
 *   settings: object,
 *   progress?: ReturnType<typeof import('../export/progress.js').createExportProgress>,
 *   logger?: {warn: Function},
 * }} options
 */
export function createWorkbench(options) {
  const { projects, tools, progress } = options
  const logger = options.logger ?? { warn: () => {} }
  const toolMap = new Map((Array.isArray(tools) ? tools : []).map((tool) => [tool.name, tool]))

  function rejected(request, response, ctx) {
    try {
      const connection = ctx?.get?.('connection')
      if (connection && typeof connection.requestRejection === 'function') {
        const status = connection.requestRejection(request)
        if (status !== undefined) {
          sendJson(response, status, { ok: false, error: { message: '需要先登录 DSH Web（同源会话）' } })
          return true
        }
        return false
      }
    } catch (error) {
      logger.warn?.(error)
    }
    if (isLoopback(request)) return false
    sendJson(response, 403, { ok: false, error: { message: '仅允许本机访问' } })
    return true
  }

  async function page(request, response, ctx) {
    if (rejected(request, response, ctx)) return
    try {
      const html = await readFile(PAGE_FILE, 'utf8')
      send(response, 200, 'text/html; charset=utf-8', html)
    } catch (error) {
      send(response, 500, 'text/plain; charset=utf-8', `工作台页面缺失：${String(error?.message ?? error)}`)
    }
  }

  /** 列出项目（带标题/镜头数，单项目失败降级）。 */
  async function listProjects() {
    return projects.list({ concurrency: 8 })
  }

  /** 读取素材文件，防止路径穿越。 */
  async function asset(request, response, url) {
    const projectId = url.searchParams.get('project') ?? 'default'
    const file = url.searchParams.get('file') ?? ''
    if (!ASSET_PATTERN.test(file)) {
      sendJson(response, 400, { ok: false, error: { message: '非法素材路径' } })
      return
    }
    const paths = await projects.ensure(projectId)
    const target = resolvePath(paths.assetsDir, '..', file)
    if (!target.startsWith(paths.projectDir + sep)) {
      sendJson(response, 403, { ok: false, error: { message: '素材路径越界' } })
      return
    }
    try {
      const buffer = await readFile(target)
      const extension = file.slice(file.lastIndexOf('.')).toLowerCase()
      send(response, 200, MIME_BY_EXT[extension] ?? 'application/octet-stream', buffer)
    } catch {
      sendJson(response, 404, { ok: false, error: { message: '素材不存在' } })
    }
  }

  /** 供应商设置面板的元信息。 */
  const PROVIDER_META = [
    { provider: 'jimeng', label: '即梦（火山方舟）', fields: ['apiKey'], env: 'JIMENG_API_KEY' },
    { provider: 'doubaoSeedream', label: '豆包 Seedream（图像）', fields: ['apiKey'], env: 'DOUBAO_SEEDREAM_API_KEY' },
    { provider: 'doubaoSeedance', label: '豆包 Seedance（视频）', fields: ['apiKey'], env: 'DOUBAO_SEEDANCE_API_KEY' },
    { provider: 'wanx', label: '通义万相（Wanx）', fields: ['apiKey'], env: 'DASHSCOPE_API_KEY' },
    { provider: 'tongyiWanx', label: '通义万相（Tongyi-Wanx）', fields: ['apiKey'], env: 'TONGYI_WANX_API_KEY' },
    { provider: 'kling', label: '可灵（Kling）', fields: ['accessKey', 'secretKey'], env: 'KLING_ACCESS_KEY' },
  ]

  const SETTINGS_SOURCE = {
    jimeng: 'jimeng',
    doubaoSeedream: 'doubaoSeedream',
    doubaoSeedance: 'doubaoSeedance',
    wanx: 'wanx',
    tongyiWanx: 'tongyiWanx',
    kling: 'kling',
  }

  /** 合并「启动时解析的 settings 来源」与「当前 providers.json 内容」。 */
  async function providerStatus() {
    const file = readProvidersFile(projects.workspaceDir)
    const settingsProviders = options.settings?.providers ?? {}
    return PROVIDER_META.map((meta) => {
      const configuredInSettings = (() => {
        const entry = settingsProviders[SETTINGS_SOURCE[meta.provider]]
        if (!entry) return { configured: false, source: 'none' }
        if (meta.provider === 'kling') {
          const source = entry.accessKeySource ?? 'none'
          return { configured: source !== 'none' && String(entry.accessKey ?? '') !== '', source }
        }
        const source = entry.apiKeySource ?? 'none'
        return { configured: source !== 'none' && String(entry.apiKey ?? '') !== '', source }
      })()
      const fileEntry = file?.[meta.provider] ?? {}
      const fileConfigured = meta.fields.every((field) => typeof fileEntry[field] === 'string' && fileEntry[field].trim() !== '')
      const effectiveSource = configuredInSettings.configured ? configuredInSettings.source : fileConfigured ? 'file' : 'none'
      return {
        provider: meta.provider,
        label: meta.label,
        fields: meta.fields,
        env: meta.env,
        configured: configuredInSettings.configured || fileConfigured,
        source: effectiveSource,
        hint: configuredInSettings.configured
          ? `${configuredInSettings.source === 'config' ? 'cordis.patch.yml' : '环境变量'} 已配置`
          : fileConfigured ? '已保存到 providers.json（重启后生效）' : '未配置',
      }
    })
  }

  async function api(request, response, ctx) {
    if (rejected(request, response, ctx)) return
    const url = new URL(request.url ?? '/', 'http://x')
    const pathname = url.pathname
    const route = pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) : pathname
    const method = (request.method ?? 'GET').toUpperCase()
    const queryProject = url.searchParams.get('project') ?? 'default'

    try {
      if (route === '/storyboard' && method === 'GET') {
        const paths = await projects.ensure(queryProject)
        const store = projects.store(queryProject)
        const current = await store.read()
        sendJson(response, 200, {
          ok: true,
          projectId: paths.projectId,
          storyboardPath: store.filePath,
          assetsDir: paths.assetsDir,
          storyboard: current.storyboard,
          fileError: current.error,
        })
        return
      }

      if (route === '/projects' && method === 'GET') {
        sendJson(response, 200, { ok: true, projects: await listProjects() })
        return
      }

      if (route === '/projects/create' && method === 'POST') {
        const body = await readJson(request)
        const created = await projects.create(body.projectId)
        if (!created.ok) {
          const status = created.code === 'exists' ? 409 : 400
          sendJson(response, status, { ok: false, error: { code: created.code, message: created.reason } })
          return
        }
        sendJson(response, 201, { ok: true, project: created.project })
        return
      }

      if (route === '/export/status' && method === 'GET') {
        const key = url.searchParams.get('exportId') ?? url.searchParams.get('project') ?? ''
        const entry = progress ? progress.get(key) : null
        if (!entry) {
          sendJson(response, 200, {
            ok: true,
            found: false,
            phase: 'unknown',
            label: '导出已结束或 id 不存在',
            exportId: null,
            projectId: null,
            sceneIndex: null,
            sceneTotal: 0,
            status: null,
            error: null,
          })
          return
        }
        sendJson(response, 200, {
          ok: true,
          found: true,
          exportId: entry.exportId,
          projectId: entry.projectId,
          phase: entry.phase,
          label: entry.label,
          sceneIndex: entry.sceneIndex,
          sceneTotal: entry.sceneTotal,
          status: entry.ok === null ? 'running' : entry.ok ? 'done' : 'failed',
          startedAt: entry.startedAt,
          updatedAt: entry.updatedAt,
          error: entry.error ?? null,
        })
        return
      }

      if (route === '/export' && method === 'POST') {
        const body = await readJson(request)
        const tool = toolMap.get('film_export_mp4')
        if (!tool) throw new Error('film_export_mp4 未注册')
        const result = await tool.execute(
          compact({
            projectId: body.projectId ?? queryProject,
            imageDurationSec: body.imageDurationSec,
            kenBurns: body.kenBurns,
            width: body.width,
            height: body.height,
            fps: body.fps,
            timeoutMs: body.timeoutMs,
          }),
          { signal: new AbortController().signal },
        )
        sendJson(response, 200, result)
        return
      }

      if (route === '/providers/status' && method === 'GET') {
        sendJson(response, 200, { ok: true, providers: await providerStatus(), requiresRestart: true })
        return
      }

      if (route === '/providers/save' && method === 'POST') {
        const body = await readJson(request)
        const provider = String(body.provider ?? '')
        const fields = body.fields !== null && typeof body.fields === 'object' ? body.fields : {}
        try {
          saveProviderSecret(projects.workspaceDir, provider, fields)
        } catch (error) {
          sendJson(response, 400, { ok: false, error: { message: String(error?.message ?? error) } })
          return
        }
        sendJson(response, 200, {
          ok: true,
          provider,
          requiresRestart: true,
          message: '已保存到 providers.json，重启 DSHA 后生效',
          masked: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, maskSecret(value)])),
        })
        return
      }

      if (route === '/providers/remove' && method === 'POST') {
        const body = await readJson(request)
        const provider = String(body.provider ?? '')
        try {
          removeProviderSecret(projects.workspaceDir, provider)
        } catch (error) {
          sendJson(response, 400, { ok: false, error: { message: String(error?.message ?? error) } })
          return
        }
        sendJson(response, 200, { ok: true, provider, requiresRestart: true, message: '已从 providers.json 移除，重启 DSHA 后生效' })
        return
      }

      if (route === '/asset' && method === 'GET') {
        await asset(request, response, url)
        return
      }

      if (route === '/scene/update' && method === 'POST') {
        const body = await readJson(request)
        const tool = toolMap.get('film_update_scene')
        if (!tool) throw new Error('film_update_scene 未注册')
        const result = await tool.execute(
          compact({
            projectId: body.projectId ?? queryProject,
            sceneId: String(body.sceneId ?? ''),
            narration: body.narration,
            visualPrompt: body.visualPrompt,
            params: body.params,
          }),
          { signal: new AbortController().signal },
        )
        sendJson(response, 200, result)
        return
      }

      if (route === '/scene/regenerate' && method === 'POST') {
        const body = await readJson(request)
        const tool = toolMap.get('film_regenerate_scene')
        if (!tool) throw new Error('film_regenerate_scene 未注册')
        const result = await tool.execute(
          compact({
            projectId: body.projectId ?? queryProject,
            sceneId: String(body.sceneId ?? ''),
            kind: body.kind === 'image' || body.kind === 'video' ? body.kind : undefined,
          }),
          { signal: new AbortController().signal },
        )
        sendJson(response, 200, result)
        return
      }

      if (route === '/scene/create' && method === 'POST') {
        const body = await readJson(request)
        const tool = toolMap.get('film_create_storyboard')
        if (!tool) throw new Error('film_create_storyboard 未注册')
        const result = await tool.execute(
          compact({
            projectId: body.projectId ?? queryProject,
            title: body.title,
            scenes: Array.isArray(body.scenes) ? body.scenes : [],
            append: true,
          }),
          { signal: new AbortController().signal },
        )
        sendJson(response, 200, result)
        return
      }

      sendJson(response, 404, { ok: false, error: { message: `未知接口 ${method} ${route}` } })
    } catch (error) {
      logger.warn?.(error)
      sendJson(response, 400, { ok: false, error: { message: String(error?.message ?? error) } })
    }
  }

  return { page, api }
}

/**
 * 把工作台挂到 DSH WebServer（调用方负责把返回的 disposer 交给 ctx.effect）。
 * @param {any} ctx webServer 所在的上下文
 * @param {Parameters<typeof createWorkbench>[0]} options
 */
export function registerWorkbench(ctx, options) {
  const workbench = createWorkbench(options)
  const disposers = [
    ctx.webServer.register({ kind: 'exact', path: '/film-studio', handler: (req, res) => workbench.page(req, res, ctx) }),
    ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: (req, res) => workbench.api(req, res, ctx) }),
  ]
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 已注销 */
      }
    }
  }
}
