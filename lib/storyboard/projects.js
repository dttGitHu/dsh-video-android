/**
 * 按 projectId 管理项目：路径解析 + 迁移 + store 缓存。
 *
 * 布局（模块 3 修正后）：
 *   workspace/projects/<projectId>/storyboard.json
 *   workspace/projects/<projectId>/assets/      素材
 *   workspace/projects/<projectId>/output/      导出
 *
 * 兼容旧布局：workspace/storyboard.json 会被迁移到 projects/default/ 下，
 * 旧的 workspace/assets/ 一并迁移。迁移只做一次，失败不阻断使用。
 * @module storyboard/projects
 */
import { access, copyFile, mkdir, readFile, rename, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DEFAULT_PROJECT_ID, resolveProjectPaths } from '../settings.js'
import { createStoryboardStore } from './store.js'

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** 移动目录；跨设备时退化为逐文件复制。 */
async function movePath(from, to) {
  await mkdir(dirname(to), { recursive: true })
  try {
    await rename(from, to)
    return 'moved'
  } catch {
    try {
      const entries = await readdir(from, { withFileTypes: true })
      for (const entry of entries) {
        const source = join(from, entry.name)
        const target = join(to, entry.name)
        if (entry.isDirectory()) await movePath(source, target)
        else await copyFile(source, target)
      }
      return 'copied'
    } catch {
      return 'skipped'
    }
  }
}

/**
 * 创建项目存储工厂。
 * @param {{workspaceDir: string, explicitStoryboardPath?: string}} options
 */
export function createProjectStores(options) {
  const workspaceDir = String(options.workspaceDir)
  const explicitStoryboardPath = String(options.explicitStoryboardPath ?? '')
  const stores = new Map()
  const ensured = new Set()

  function paths(projectId) {
    return resolveProjectPaths(workspaceDir, projectId, explicitStoryboardPath)
  }

  function store(projectId) {
    const resolved = paths(projectId)
    if (!stores.has(resolved.projectId)) {
      stores.set(resolved.projectId, createStoryboardStore({ filePath: resolved.storyboardPath }))
    }
    return stores.get(resolved.projectId)
  }

  /**
   * 准备项目目录，并做一次旧布局迁移（仅 default 项目）。
   * @param {string} [projectId]
   * @returns {Promise<{projectId: string, projectDir: string, storyboardPath: string, assetsDir: string, outputDir: string, migrated: boolean}>}
   */
  async function ensure(projectId = DEFAULT_PROJECT_ID) {
    const resolved = paths(projectId)
    let migrated = false
    if (!ensured.has(resolved.projectId)) {
      ensured.add(resolved.projectId)
      await mkdir(resolved.projectDir, { recursive: true })
      if (resolved.projectId === DEFAULT_PROJECT_ID) {
        const legacyStoryboard = join(workspaceDir, 'storyboard.json')
        if (!(await exists(resolved.storyboardPath)) && (await exists(legacyStoryboard))) {
          const result = await movePath(legacyStoryboard, resolved.storyboardPath)
          migrated = result !== 'skipped'
        }
        const legacyAssets = join(workspaceDir, 'assets')
        if (!(await exists(resolved.assetsDir)) && (await exists(legacyAssets))) {
          const result = await movePath(legacyAssets, resolved.assetsDir)
          migrated = migrated || result !== 'skipped'
        }
      }
    }
    await mkdir(resolved.assetsDir, { recursive: true })
    return { ...resolved, migrated }
  }

  /** 项目元信息：读失败降级为「无分镜」。 */
  async function info(projectId) {
    const resolved = resolveProjectPaths(workspaceDir, projectId, '')
    try {
      const raw = JSON.parse(await readFile(resolved.storyboardPath, 'utf8'))
      const board = raw !== null && typeof raw === 'object' && raw.storyboard !== undefined ? raw.storyboard : raw
      return {
        projectId,
        title: typeof board?.title === 'string' && board.title !== '' ? board.title : projectId,
        sceneCount: Array.isArray(board?.scenes) ? board.scenes.length : 0,
        updatedAt: typeof board?.updatedAt === 'string' ? board.updatedAt : null,
        hasStoryboard: true,
      }
    } catch {
      return { projectId, title: projectId, sceneCount: 0, updatedAt: null, hasStoryboard: false }
    }
  }

  /**
   * 列出项目：只保留目录、过滤隐藏与非安全名；手写信号量控制并发（默认 8）。
   * @param {{concurrency?: number}} [options]
   */
  async function list(options = {}) {
    const concurrency = Math.max(1, Math.min(8, Math.round(Number(options.concurrency) || 8)))
    let entries = []
    try {
      entries = await readdir(join(workspaceDir, 'projects'), { withFileTypes: true })
    } catch {
      return []
    }
    const ids = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .filter((name) => /^[A-Za-z0-9._-]+$/.test(name))
    const results = []
    const queue = [...ids]
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const name = queue.shift()
        results.push(await info(name))
      }
    })
    await Promise.all(workers)
    results.sort((left, right) => left.projectId.localeCompare(right.projectId))
    return results
  }

  /**
   * 创建项目：严格校验 id（不静默改写），已存在返回 exists。
   * @param {string} rawId
   */
  async function create(rawId) {
    const validation = validateProjectId(rawId)
    if (!validation.ok) return { ok: false, code: 'invalid-id', reason: validation.reason }
    const projectId = validation.value
    const resolved = resolveProjectPaths(workspaceDir, projectId, '')
    if (await exists(resolved.storyboardPath)) {
      return { ok: false, code: 'exists', reason: '项目已存在' }
    }
    await mkdir(resolved.assetsDir, { recursive: true })
    await mkdir(resolved.outputDir, { recursive: true })
    const board = { fileVersion: 1, storyboard: { version: 1, title: projectId, updatedAt: null, scenes: [] } }
    await writeFile(resolved.storyboardPath, `${JSON.stringify(board, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    return { ok: true, project: await info(projectId) }
  }

  return { workspaceDir, paths, store, ensure, list, create, info }
}

/**
 * 严格校验 projectId：长度 1–64、不以 . 开头、只允许字母数字点下划线短横线。
 * 不静默改写，避免用户以为创建了别的 id。
 * @param {unknown} raw
 */
export function validateProjectId(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text.length === 0) return { ok: false, reason: 'projectId 不能为空' }
  if (text.length > 64) return { ok: false, reason: 'projectId 最长 64 个字符' }
  if (text.startsWith('.')) return { ok: false, reason: 'projectId 不能以 . 开头' }
  if (!/^[A-Za-z0-9._-]+$/.test(text)) return { ok: false, reason: 'projectId 只允许字母、数字、点、下划线、短横线' }
  if (text === '.' || text === '..') return { ok: false, reason: 'projectId 非法' }
  return { ok: true, value: text }
}
