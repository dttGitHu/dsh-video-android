/**
 * 导出进度：阶段式内存状态，不落盘。
 *
 * 只在插件运行时有意义：插件卸载时 clear()；终态保留 30 秒供轮询读到，
 * 之后惰性清理（只检查当前查询的那一条，不遍历整个 Map）。
 * @module export/progress
 */
import { randomUUID } from 'node:crypto'

/** 终态保留时长。 */
export const FINISHED_TTL_MS = 30_000

/** 阶段顺序（固定，不解析 ffmpeg stderr）。 */
export const EXPORT_PHASES = Object.freeze(['checking', 'downloading', 'segment', 'concat', 'verifying', 'done', 'failed'])

/**
 * 创建进度表。
 * @param {{ttlMs?: number, now?: () => number}} [options]
 */
export function createExportProgress(options = {}) {
  const ttl = Number(options.ttlMs ?? FINISHED_TTL_MS)
  const now = options.now ?? (() => Date.now())
  const entries = new Map()
  const latestByProject = new Map()

  return {
    start({ projectId, sceneTotal = 0 }) {
      const exportId = `exp-${randomUUID()}`
      const entry = {
        exportId,
        projectId,
        phase: 'checking',
        label: '检查素材',
        sceneIndex: null,
        sceneTotal: Math.max(0, Math.round(Number(sceneTotal) || 0)),
        startedAt: now(),
        updatedAt: now(),
        ok: null,
        error: null,
        finishedAt: null,
      }
      entries.set(exportId, entry)
      latestByProject.set(projectId, exportId)
      return exportId
    },
    update(exportId, patch) {
      const entry = entries.get(exportId)
      if (!entry) return null
      if (patch.phase !== undefined) entry.phase = patch.phase
      if (patch.label !== undefined) entry.label = patch.label
      if (patch.sceneIndex !== undefined) entry.sceneIndex = patch.sceneIndex
      if (patch.sceneTotal !== undefined) entry.sceneTotal = patch.sceneTotal
      if (patch.error !== undefined) entry.error = patch.error
      entry.updatedAt = now()
      return entry
    },
    finish(exportId, { ok, error = null, label }) {
      const entry = entries.get(exportId)
      if (!entry) return null
      entry.ok = ok === true
      entry.error = error ?? null
      if (label !== undefined) entry.label = label
      entry.phase = ok === true ? 'done' : 'failed'
      entry.updatedAt = now()
      entry.finishedAt = now()
      return entry
    },
    /** 按 exportId 或 projectId 查询；终态过期后删除并返回 null（只查这一条）。 */
    get(key) {
      let exportId = key
      if (!entries.has(key)) exportId = latestByProject.get(key)
      if (!exportId) return null
      const entry = entries.get(exportId)
      if (!entry) return null
      if (entry.finishedAt !== null && now() - entry.finishedAt > ttl) {
        entries.delete(exportId)
        return null
      }
      return entry
    },
    clear() {
      entries.clear()
      latestByProject.clear()
    },
    size() {
      return entries.size
    },
  }
}
