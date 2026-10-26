/**
 * 优化会话状态机：单镜头与批量两条线，负责轮次、超时与「何时停止」。
 *
 * 状态机（单镜头）：
 *   start → awaiting_draft(round=1)
 *     ↳ submit：超时 → timeout（本轮不写）
 *     ↳ submit：写 history → 达标或到 maxRounds → done
 *                          ↳ 否则 → awaiting_draft(round+1)
 *
 * 批量：
 *   start → awaiting_draft（列出待优化镜头）
 *     ↳ submit：逐镜头写 history；达标/到轮次上限 → 移出 remaining
 *     ↳ 总提交轮次超过 镜头数×2 或超时 → done/timeout（已完成部分保留）
 *
 * 会话只存在内存里，插件卸载或超时后由调用方忽略；数据本身始终先写入 storyboard.json。
 * @module prompt/sessions
 */

/**
 * 创建会话表。
 * @param {{now?: () => number}} [options]
 */
export function createPromptSessions(options = {}) {
  const now = options.now ?? (() => Date.now())
  const sceneSessions = new Map()
  const batchSessions = new Map()
  let seq = 0

  const makeId = (prefix) => `${prefix}-${now().toString(36)}-${(seq += 1).toString(36)}`

  return {
    now,
    startScene(input) {
      const session = {
        id: makeId('opt'),
        projectId: input.projectId,
        sceneId: input.sceneId,
        style: input.style,
        maxRounds: input.maxRounds,
        round: 1,
        startedAt: now(),
        deadline: now() + input.timeoutMs,
        rounds: [],
      }
      sceneSessions.set(session.id, session)
      return session
    },
    getScene(id) {
      return sceneSessions.get(id) ?? null
    },
    closeScene(id) {
      sceneSessions.delete(id)
    },
    startBatch(input) {
      const session = {
        id: makeId('batch'),
        projectId: input.projectId,
        style: input.style,
        maxRounds: input.maxRounds,
        startedAt: now(),
        deadline: now() + input.timeoutMs,
        total: input.sceneIds.length,
        budget: Math.max(1, input.sceneIds.length * 2),
        roundsUsed: 0,
        remaining: [...input.sceneIds],
        perScene: new Map(),
        rounds: [],
      }
      batchSessions.set(session.id, session)
      return session
    },
    getBatch(id) {
      return batchSessions.get(id) ?? null
    },
    closeBatch(id) {
      batchSessions.delete(id)
    },
    /** 惰性清理过期会话（避免内存里堆着永远不用的 id）。 */
    sweep() {
      const at = now()
      for (const [id, session] of sceneSessions) if (at > session.deadline) sceneSessions.delete(id)
      for (const [id, session] of batchSessions) if (at > session.deadline) batchSessions.delete(id)
    },
    /** 插件卸载时清空。 */
    clear() {
      sceneSessions.clear()
      batchSessions.clear()
    },
    counts() {
      return { scenes: sceneSessions.size, batches: batchSessions.size }
    },
  }
}
