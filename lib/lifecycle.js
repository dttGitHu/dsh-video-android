/**
 * 任务作用域：把「进行中的生成任务」登记起来，插件卸载时统一中断。
 *
 * 约束 6 要求定时器 / AbortController / 监听器都由 ctx.effect 管理。
 * 这里的分工是：
 * - 插件级：apply() 里用 ctx.effect 注册一个「卸载时 abortAll」的兜底；
 * - 调用级：每次工具执行在 ctx.effect 里登记自己的 AbortController 与
 *   exec.signal 监听器，执行结束手动释放；插件若在任务中途卸载，
 *   Cordis 会执行同一个清理函数，轮询随即中断。
 * @module lifecycle
 */

/**
 * 创建任务作用域。
 * @returns {{
 *   track: (controller: AbortController) => () => void,
 *   abortAll: (reason?: unknown) => void,
 *   size: () => number,
 * }}
 */
export function createTaskScope() {
  /** @type {Set<AbortController>} */
  const controllers = new Set()
  return {
    track(controller) {
      controllers.add(controller)
      return () => {
        controllers.delete(controller)
      }
    },
    abortAll(reason = new Error('插件已卸载，进行中的生成任务已中断')) {
      for (const controller of [...controllers]) {
        try {
          controller.abort(reason)
        } catch {
          /* 已中止 */
        }
      }
      controllers.clear()
    },
    size() {
      return controllers.size
    },
  }
}

/**
 * 在给定 ctx 上登记一次工具调用的资源，返回释放函数。
 *
 * 优先走 ctx.effect（插件卸载时自动清理）；若插件 fiber 已经不可用，
 * 退化为「只用任务作用域兜底」，仍能保证 abortAll 时中断。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof createTaskScope>} scope
 * @param {{controller: AbortController, outerSignal?: AbortSignal, label: string}} input
 * @returns {() => void}
 */
export function trackCall(ctx, scope, input) {
  const { controller, outerSignal, label } = input

  const onOuterAbort = () => {
    try {
      controller.abort(outerSignal?.reason ?? new Error('会话取消'))
    } catch {
      /* 已中止 */
    }
  }

  const attach = () => {
    const untrack = scope.track(controller)
    outerSignal?.addEventListener?.('abort', onOuterAbort, { once: true })
    if (outerSignal?.aborted) onOuterAbort()
    return () => {
      outerSignal?.removeEventListener?.('abort', onOuterAbort)
      untrack()
      // 调用结束或插件卸载：确保这次调用的控制器一定被中止，
      // 这样即使任务作用域的 abortAll 没有被走到，轮询也不会留在后台。
      try {
        if (!controller.signal.aborted) controller.abort(new Error(`${label} 已结束`))
      } catch {
        /* 已中止 */
      }
    }
  }

  try {
    const release = ctx.effect(attach, label)
    if (typeof release === 'function') return release
  } catch {
    /* 插件已卸载或 ctx 不可用，退回直接登记 */
  }

  return scope.track(controller)
}
