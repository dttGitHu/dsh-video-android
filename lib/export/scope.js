/**
 * 导出作用域：管理合成期间的全部子进程与临时目录。
 *
 * 手机环境里残留的 ffmpeg 进程与临时目录比桌面端更难排查，
 * 所以插件卸载、调用取消、正常结束三条路径走同一份清理逻辑：
 *   kill 所有子进程 → 递归删除临时目录。
 * @module export/scope
 */
import { rm } from 'node:fs/promises'

/**
 * 创建导出作用域。
 * @returns {{
 *   trackChild: (child: any) => () => void,
 *   trackDir: (dir: string) => () => void,
 *   childCount: () => number,
 *   dirCount: () => number,
 *   cleanup: () => Promise<void>,
 * }}
 */
export function createExportScope() {
  const children = new Set()
  const directories = new Set()

  function killChildren() {
    for (const child of [...children]) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
    }
    children.clear()
  }

  return {
    trackChild(child) {
      children.add(child)
      return () => {
        children.delete(child)
      }
    },
    trackDir(dir) {
      directories.add(dir)
      return () => {
        directories.delete(dir)
      }
    },
    childCount() {
      return children.size
    },
    dirCount() {
      return directories.size
    },
    async cleanup() {
      killChildren()
      for (const dir of [...directories]) {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
      directories.clear()
    },
  }
}
