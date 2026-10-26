/**
 * 分镜持久化：纯 JSON 文件 + 原子写 + 串行化，不依赖数据库。
 *
 * - 写临时文件再 rename，断电/中断不会留下半份 JSON；
 * - 所有读改写走同一条串行队列，工具与工作台并发改同一镜头不会互相覆盖；
 * - 文件权限 600（分镜里可能有未公开的创意内容）。
 * @module storyboard/store
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { emptyStoryboard, normalizeStoryboard } from './model.js'

/** 文件格式：外层带 schema 标记，便于未来迁移。 */
export const STORYBOARD_FILE_VERSION = 1

/**
 * 创建分镜存储。
 * @param {{filePath: string}} options
 */
export function createStoryboardStore(options) {
  const filePath = String(options.filePath)
  let queue = Promise.resolve()

  /** 串行执行，保证读改写不交错。 */
  function serialize(task) {
    const run = queue.then(task, task)
    queue = run.catch(() => {})
    return run
  }

  /**
   * 读取分镜。文件不存在或损坏时返回空分镜（不抛错，保护工作台可用）。
   * @returns {Promise<{storyboard: any, exists: boolean, error: string|null}>}
   */
  async function read() {
    try {
      const text = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(text)
      // 兼容两种落盘形状：带 {storyboard} 包装的当前格式，以及直接是分镜对象的旧格式。
      const board = parsed !== null && typeof parsed === 'object' && parsed.storyboard !== undefined
        ? parsed.storyboard
        : parsed
      return { storyboard: normalizeStoryboard(board), exists: true, error: null }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { storyboard: emptyStoryboard(), exists: false, error: null }
      }
      return {
        storyboard: emptyStoryboard(),
        exists: true,
        error: `分镜文件无法解析（${String(error?.message ?? error)}），已按空分镜处理`,
      }
    }
  }

  /**
   * 原子写入。
   * @param {ReturnType<typeof normalizeStoryboard>} storyboard
   * @param {{agentCwd?: string|null}} [meta]
   */
  async function write(storyboard, meta = {}) {
    const normalized = normalizeStoryboard(storyboard)
    const payload = {
      fileVersion: STORYBOARD_FILE_VERSION,
      workspaceDir: meta.agentCwd ?? process.cwd(),
      updatedAt: new Date().toISOString(),
      storyboard: normalized,
    }
    await mkdir(dirname(filePath), { recursive: true })
    const temporary = join(dirname(filePath), `.${randomUUID()}.storyboard.tmp`)
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, filePath)
    return { storyboard: normalized, updatedAt: payload.updatedAt }
  }

  /**
   * 读 → 改 → 写：所有变更走这里。
   * @param {(storyboard: any) => any|Promise<any>} mutator 返回新分镜；抛错则不写
   * @param {{agentCwd?: string|null}} [meta]
   */
  function mutate(mutator, meta = {}) {
    return serialize(async () => {
      const current = await read()
      const next = await mutator(current.storyboard)
      return write(next, meta)
    })
  }

  return { filePath, read, write, mutate }
}
