/**
 * 模块 5 的工具：提示词自优化。
 *
 * 插件不调用第二个 LLM——优化由当前会话模型完成：
 *   1) 工具返回「改什么 + 按什么标准改 + 提交什么格式」；
 *   2) 模型生成改进版后通过 submit 回传；
 *   3) 工具做规则检查、合并模型自评、写 history，并决定继续还是停止。
 *
 * 稳定性要点：
 * - 单镜头最多 3 轮；批量总提交轮次 ≤ 镜头数 × 2；
 * - 单次会话总超时默认 90 秒，超时后返回已完成部分，当前轮不写入；
 * - history 只保留第 0 轮 + 最近 5 轮；
 * - 原始文本永远在 history[0]，currentPrompt 单独存当前版本。
 * @module tools/prompt
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { normalizeScene, PROMPT_STYLES, trimPromptHistory } from '../storyboard/model.js'
import { sanitizeProjectId } from '../settings.js'
import {
  analyzePrompt,
  buildBatchInstruction,
  buildSceneInstruction,
  mergeScores,
  needsAnotherRound,
  styleNames,
} from '../prompt/rules.js'

const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] }
const NULLABLE_INTEGER = { oneOf: [{ type: 'integer' }, { type: 'null' }] }

const ERROR_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true },
        message: { type: 'string', required: true },
      },
    },
    { type: 'null' },
  ],
}

const SCORES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    specificity: { type: 'integer', required: true },
    visual: { type: 'integer', required: true },
    emotion: { type: 'integer', required: true },
  },
}

const ELEMENTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    subject: { type: 'boolean', required: true },
    action: { type: 'boolean', required: true },
    scene: { type: 'boolean', required: true },
    light: { type: 'boolean', required: true },
  },
}

const PROMPT_TEXT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    narration: { type: 'string', required: true },
    visualPrompt: { type: 'string', required: true },
  },
}

const ROUND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    round: { type: 'integer', required: true },
    scores: { oneOf: [SCORES_SCHEMA, { type: 'null' }], required: true },
    passed: { type: 'boolean', required: true },
    reason: { ...NULLABLE_STRING, required: true },
  },
}

const EVALUATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    projectId: { type: 'string', required: true },
    sceneId: { type: 'string', required: true },
    style: { type: 'string', required: true },
    current: PROMPT_TEXT_SCHEMA,
    elements: ELEMENTS_SCHEMA,
    narrationLength: { type: 'integer', required: true },
    vagueWords: { type: 'array', items: { type: 'string' }, required: true },
    scores: SCORES_SCHEMA,
    suggestions: { type: 'array', items: { type: 'string' }, required: true },
    passed: { type: 'boolean', required: true },
    error: { ...ERROR_SCHEMA, required: true },
  },
}

const OPTIMIZE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    phase: { type: 'string', enum: ['awaiting_draft', 'done', 'timeout', 'error'], required: true },
    optimizationId: { ...NULLABLE_STRING, required: true },
    projectId: { type: 'string', required: true },
    sceneId: { type: 'string', required: true },
    style: { type: 'string', required: true },
    round: { type: 'integer', required: true },
    maxRounds: { type: 'integer', required: true },
    instruction: { ...NULLABLE_STRING, required: true },
    current: { oneOf: [PROMPT_TEXT_SCHEMA, { type: 'null' }], required: true },
    applied: { type: 'boolean', required: true },
    rounds: { type: 'array', items: ROUND_SCHEMA, required: true },
    finalScores: { oneOf: [SCORES_SCHEMA, { type: 'null' }], required: true },
    finalPassed: { type: 'boolean', required: true },
    error: { ...ERROR_SCHEMA, required: true },
  },
}

const SKIPPED_SCENE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sceneId: { type: 'string', required: true },
    reason: { type: 'string', required: true },
  },
}

const BATCH_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sceneId: { type: 'string', required: true },
    ok: { type: 'boolean', required: true },
    round: { type: 'integer', required: true },
    scores: { oneOf: [SCORES_SCHEMA, { type: 'null' }], required: true },
    passed: { type: 'boolean', required: true },
    error: { ...ERROR_SCHEMA, required: true },
  },
}

const BATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    phase: { type: 'string', enum: ['awaiting_draft', 'done', 'timeout', 'error'], required: true },
    batchId: { ...NULLABLE_STRING, required: true },
    projectId: { type: 'string', required: true },
    style: { type: 'string', required: true },
    maxRounds: { type: 'integer', required: true },
    total: { type: 'integer', required: true },
    done: { type: 'integer', required: true },
    remaining: { type: 'array', items: { type: 'string' }, required: true },
    skippedScenes: { type: 'array', items: SKIPPED_SCENE_SCHEMA, required: true },
    percent: { type: 'number', required: true },
    instruction: { ...NULLABLE_STRING, required: true },
    results: { type: 'array', items: BATCH_RESULT_SCHEMA, required: true },
    message: { ...NULLABLE_STRING, required: true },
    error: { ...ERROR_SCHEMA, required: true },
  },
}

const STYLE_ENUM = [...PROMPT_STYLES]

function clampRounds(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 1
  return Math.min(3, Math.max(1, Math.round(numeric)))
}

function clampTimeout(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 90_000
  return Math.min(600_000, Math.max(100, Math.round(numeric)))
}

function errorOf(message, kind = 'server') {
  return { kind, message: String(message) }
}

function compact(input) {
  const output = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value
  }
  return output
}

/**
 * 构建提示词优化工具。
 * @param {{
 *   projects: any,
 *   settings: any,
 *   sessions: ReturnType<import('../prompt/sessions.js').createPromptSessions>,
 * }} input
 */
export function buildPromptTools(input) {
  const { projects, sessions } = input

  async function load(projectId) {
    const paths = await projects.ensure(projectId)
    const store = projects.store(projectId)
    const current = await store.read()
    return { paths, store, storyboard: current.storyboard }
  }

  async function findScene(projectId, sceneId) {
    const context = await load(projectId)
    const scene = context.storyboard.scenes.find((item) => item.id === sceneId) ?? null
    return { ...context, scene }
  }

  /** 写入一轮优化结果（history + currentPrompt），并裁剪历史。 */
  async function applyRound(store, sceneId, record) {
    return store.mutate((board) => {
      const index = board.scenes.findIndex((item) => item.id === sceneId)
      if (index === -1) return board
      const scene = normalizeScene(board.scenes[index], board.scenes[index].index)
      const entry = {
        round: record.round,
        narration: record.narration,
        visualPrompt: record.visualPrompt,
        scores: record.scores,
        reason: record.reason ?? null,
        timestamp: new Date().toISOString(),
      }
      const nextHistory = trimPromptHistory(
        [...scene.promptHistory.filter((item) => item.round !== record.round), entry].sort((a, b) => a.round - b.round),
      )
      const scenes = [...board.scenes]
      scenes[index] = {
        ...scene,
        narration: record.narration,
        visualPrompt: record.visualPrompt,
        currentPrompt: { narration: record.narration, visualPrompt: record.visualPrompt },
        promptHistory: nextHistory,
        promptStyle: record.style,
        status: scene.status === 'done' ? 'draft' : scene.status,
      }
      return { ...board, scenes, updatedAt: new Date().toISOString() }
    })
  }

  return [
    defineTool({
      name: 'film_evaluate_scene_prompt',
      description:
        '评估一个镜头的旁白与画面描述（不修改数据）：检查画面四要素（主体/动作/场景/光线氛围）、旁白长度（10–60 字）、空泛词，' +
        '给出规则侧三维评分（具体性/可视化/情绪，1–5）与改进建议。用于优化前诊断，或复述「这个提示词哪里不够好」。',
      parameters: {
        projectId: { type: 'string', description: '项目 id，默认 default' },
        sceneId: { type: 'string', required: true, description: '镜头 id，如 scene-3' },
        style: { type: 'string', enum: STYLE_ENUM, description: '按哪个风格评估，默认取镜头当前风格' },
      },
      output: { schema: EVALUATE_SCHEMA, render: (_args, value) => renderEvaluate(value) },
      isConcurrencySafe: true,
      execute: async (args) => {
        const projectId = sanitizeProjectId(args.projectId)
        const found = await findScene(projectId, args.sceneId)
        if (found.scene === null) {
          return evaluateError(projectId, args.sceneId, args.style ?? '', '找不到镜头 ' + args.sceneId)
        }
        const scene = found.scene
        const style = args.style ?? scene.promptStyle
        const analysis = analyzePrompt({ narration: scene.currentPrompt.narration, visualPrompt: scene.currentPrompt.visualPrompt, style })
        return {
          ok: true,
          projectId,
          sceneId: scene.id,
          style,
          current: scene.currentPrompt,
          elements: analysis.elements,
          narrationLength: analysis.narrationLength,
          vagueWords: analysis.vagueWords,
          scores: analysis.scores,
          suggestions: analysis.suggestions,
          passed: analysis.passed,
          error: null,
        }
      },
    }),

    defineTool({
      name: 'film_optimize_scene_prompt',
      description:
        '优化单个镜头的旁白与画面描述。两步式：action=start 返回改进指令与提交格式；模型生成改进版后 action=submit 回传。' +
        '插件做规则检查并合并模型自评（取较低值），写 promptHistory 与 currentPrompt；未达标则返回下一轮指令。' +
        '轮次上限 3，单次会话超时默认 90 秒（超时后已完成的轮次保留、当前轮不写入）。四种风格：写实电影感 / 动画漫剧 / 悬疑 / 治愈。',
      parameters: {
        action: { type: 'string', enum: ['start', 'submit', 'cancel'], description: 'start 开始；submit 提交改进版；cancel 放弃' },
        projectId: { type: 'string', description: '项目 id，默认 default' },
        sceneId: { type: 'string', description: '镜头 id；start 时必填' },
        optimizationId: { type: 'string', description: 'submit/cancel 时填 start 返回的 id' },
        style: { type: 'string', enum: STYLE_ENUM, description: '风格预设，默认取镜头当前风格' },
        maxRounds: { type: 'integer', description: '最大轮次 1–3，默认 1' },
        timeoutMs: { type: 'integer', description: '本次优化会话总超时（毫秒），默认 90000' },
        round: { type: 'integer', description: 'submit 时填当前轮次' },
        draft: {
          type: 'object',
          additionalProperties: false,
          description: 'submit 时提交的改进版',
          properties: {
            narration: { type: 'string', required: true },
            visualPrompt: { type: 'string', required: true },
          },
        },
        selfScores: {
          type: 'object',
          additionalProperties: false,
          description: '模型自评，1–5',
          properties: {
            specificity: { type: 'integer', required: true },
            visual: { type: 'integer', required: true },
            emotion: { type: 'integer', required: true },
          },
        },
        reason: { type: 'string', description: '改进理由（一句话）' },
      },
      output: { schema: OPTIMIZE_SCHEMA, render: (_args, value) => renderOptimize(value) },
      execute: async (args) => {
        const action = args.action ?? 'start'
        if (action === 'cancel') {
          const session = args.optimizationId ? sessions.getScene(args.optimizationId) : null
          if (session) sessions.closeScene(session.id)
          return {
            ok: true,
            phase: 'done',
            optimizationId: args.optimizationId ?? null,
            projectId: sanitizeProjectId(args.projectId),
            sceneId: args.sceneId ?? session?.sceneId ?? '',
            style: args.style ?? session?.style ?? '写实电影感',
            round: session?.round ?? 0,
            maxRounds: session?.maxRounds ?? 1,
            instruction: null,
            current: null,
            applied: false,
            rounds: [],
            finalScores: null,
            finalPassed: false,
            error: null,
          }
        }

        const projectId = sanitizeProjectId(args.projectId)
        if (action === 'start') {
          if (!args.sceneId) return optimizeError(projectId, '', 'start 需要 sceneId')
          const found = await findScene(projectId, args.sceneId)
          if (found.scene === null) return optimizeError(projectId, args.sceneId, '找不到镜头 ' + args.sceneId)
          const scene = found.scene
          const style = args.style ?? scene.promptStyle
          const maxRounds = clampRounds(args.maxRounds)
          const timeoutMs = clampTimeout(args.timeoutMs)
          const session = sessions.startScene({ projectId, sceneId: scene.id, style, maxRounds, timeoutMs })
          const analysis = analyzePrompt({ narration: scene.currentPrompt.narration, visualPrompt: scene.currentPrompt.visualPrompt, style })
          const instruction = buildSceneInstruction({
            projectId,
            sceneId: scene.id,
            optimizationId: session.id,
            round: 1,
            maxRounds,
            style,
            current: scene.currentPrompt,
            analysis,
          })
          return {
            ok: true,
            phase: 'awaiting_draft',
            optimizationId: session.id,
            projectId,
            sceneId: scene.id,
            style,
            round: 1,
            maxRounds,
            instruction,
            current: scene.currentPrompt,
            applied: false,
            rounds: [],
            finalScores: null,
            finalPassed: false,
            error: null,
          }
        }

        // submit
        const session = args.optimizationId ? sessions.getScene(args.optimizationId) : null
        if (session === null) return optimizeError(projectId, args.sceneId ?? '', '优化会话不存在或已过期，请重新 start')
        if (Date.now() > session.deadline) {
          const rounds = session.rounds.map(roundRecord)
          sessions.closeScene(session.id)
          return {
            ok: true,
            phase: 'timeout',
            optimizationId: session.id,
            projectId: session.projectId,
            sceneId: session.sceneId,
            style: session.style,
            round: session.round,
            maxRounds: session.maxRounds,
            instruction: null,
            current: null,
            applied: false,
            rounds,
            finalScores: rounds.length > 0 ? rounds[rounds.length - 1].scores : null,
            finalPassed: false,
            error: errorOf(`优化超时（${Math.round((Date.now() - session.startedAt) / 1000)}s），已保留完成的轮次`, 'network'),
          }
        }
        if (args.round !== undefined && Number(args.round) !== session.round) {
          return optimizeError(session.projectId, session.sceneId, `轮次不匹配：当前应为第 ${session.round} 轮`)
        }
        const draft = args.draft ?? {}
        if (String(draft.narration ?? '').trim() === '' && String(draft.visualPrompt ?? '').trim() === '') {
          return optimizeError(session.projectId, session.sceneId, 'submit 需要 draft.narration 或 draft.visualPrompt')
        }

        const found = await findScene(session.projectId, session.sceneId)
        if (found.scene === null) {
          sessions.closeScene(session.id)
          return optimizeError(session.projectId, session.sceneId, '找不到镜头')
        }
        const analysis = analyzePrompt({
          narration: draft.narration ?? '',
          visualPrompt: draft.visualPrompt ?? '',
          style: session.style,
        })
        const scores = mergeScores(analysis.scores, args.selfScores ?? {})
        const passed = analysis.passed && !needsAnotherRound(scores, true)
        const roundNumber = session.round

        await applyRound(found.store, session.sceneId, {
          round: roundNumber,
          narration: String(draft.narration ?? ''),
          visualPrompt: String(draft.visualPrompt ?? ''),
          scores,
          reason: args.reason ?? null,
          style: session.style,
        })

        session.rounds.push({ round: roundNumber, scores, passed, reason: args.reason ?? null })

        const shouldStop = passed || roundNumber >= session.maxRounds
        if (shouldStop) {
          sessions.closeScene(session.id)
          return {
            ok: true,
            phase: 'done',
            optimizationId: session.id,
            projectId: session.projectId,
            sceneId: session.sceneId,
            style: session.style,
            round: roundNumber,
            maxRounds: session.maxRounds,
            instruction: null,
            current: { narration: String(draft.narration ?? ''), visualPrompt: String(draft.visualPrompt ?? '') },
            applied: true,
            rounds: session.rounds.map(roundRecord),
            finalScores: scores,
            finalPassed: passed,
            error: null,
          }
        }

        session.round += 1
        const nextAnalysis = analyzePrompt({
          narration: draft.narration ?? '',
          visualPrompt: draft.visualPrompt ?? '',
          style: session.style,
        })
        const instruction = buildSceneInstruction({
          projectId: session.projectId,
          sceneId: session.sceneId,
          optimizationId: session.id,
          round: session.round,
          maxRounds: session.maxRounds,
          style: session.style,
          current: { narration: String(draft.narration ?? ''), visualPrompt: String(draft.visualPrompt ?? '') },
          analysis: nextAnalysis,
        })
        return {
          ok: true,
          phase: 'awaiting_draft',
          optimizationId: session.id,
          projectId: session.projectId,
          sceneId: session.sceneId,
          style: session.style,
          round: session.round,
          maxRounds: session.maxRounds,
          instruction,
          current: { narration: String(draft.narration ?? ''), visualPrompt: String(draft.visualPrompt ?? '') },
          applied: true,
          rounds: session.rounds.map(roundRecord),
          finalScores: scores,
          finalPassed: passed,
          error: null,
        }
      },
    }),

    defineTool({
      name: 'film_optimize_all_prompts',
      description:
        '批量优化一个项目里所有 draft 镜头的提示词，逐镜头返回进度，单个镜头失败不阻断其他镜头。' +
        '两步式：action=start 返回待优化清单与提交格式；模型为每个镜头生成改进版后 action=submit 提交（results 数组）。' +
        '批量总提交轮次不超过 镜头数×2，单次会话超时默认 90 秒；超时或预算用尽时返回已完成部分。',
      parameters: {
        action: { type: 'string', enum: ['start', 'submit'], description: 'start 或 submit' },
        projectId: { type: 'string', description: '项目 id，默认 default' },
        batchId: { type: 'string', description: 'submit 时填 start 返回的 id' },
        style: { type: 'string', enum: STYLE_ENUM, description: '风格预设' },
        maxRounds: { type: 'integer', description: '每个镜头最大轮次 1–3，默认 1' },
        timeoutMs: { type: 'integer', description: '本次批量会话总超时（毫秒），默认 90000' },
        results: {
          type: 'array',
          description: '每个镜头的改进版',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sceneId: { type: 'string', required: true },
              narration: { type: 'string', required: true },
              visualPrompt: { type: 'string', required: true },
              selfScores: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  specificity: { type: 'integer', required: true },
                  visual: { type: 'integer', required: true },
                  emotion: { type: 'integer', required: true },
                },
              },
              reason: { type: 'string' },
            },
          },
        },
      },
      output: { schema: BATCH_SCHEMA, render: (_args, value) => renderBatch(value) },
      execute: async (args) => {
        const projectId = sanitizeProjectId(args.projectId)
        const action = args.action ?? 'start'

        if (action === 'start') {
          const context = await load(projectId)
          const targets = context.storyboard.scenes.filter((scene) => scene.status === 'draft')
          if (targets.length === 0) {
            return batchError(projectId, '没有 draft 状态的镜头；先创建分镜或重置镜头状态')
          }
          const style = args.style ?? targets[0].promptStyle
          const maxRounds = clampRounds(args.maxRounds)
          const session = sessions.startBatch({
            projectId,
            style,
            maxRounds,
            timeoutMs: clampTimeout(args.timeoutMs),
            sceneIds: targets.map((scene) => scene.id),
          })
          const scenes = targets.map((scene) => ({
            sceneId: scene.id,
            current: scene.currentPrompt,
            analysis: analyzePrompt({ narration: scene.currentPrompt.narration, visualPrompt: scene.currentPrompt.visualPrompt, style }),
          }))
          return {
            ok: true,
            phase: 'awaiting_draft',
            batchId: session.id,
            projectId,
            style,
            maxRounds,
            total: targets.length,
            done: 0,
            remaining: targets.map((scene) => scene.id),
            percent: 0,
            instruction: buildBatchInstruction({ projectId, batchId: session.id, style, round: 1, maxRounds, scenes }),
            results: [],
            error: null,
          }
        }

        const session = args.batchId ? sessions.getBatch(args.batchId) : null
        if (session === null) return batchError(projectId, '批量会话不存在或已过期，请重新 start')
        if (Date.now() > session.deadline) {
          const payload = batchPayload(session, sessions, 'timeout', [], {
            skippedScenes: session.remaining.map((sceneId) => ({ sceneId, reason: '批量优化超时，未处理' })),
            message: `批量优化超时（${Math.round((Date.now() - session.startedAt) / 1000)}s），${session.remaining.length} 个镜头被跳过`,
          })
          sessions.closeBatch(session.id)
          return {
            ...payload,
            ok: true,
            error: errorOf(`批量优化超时（${Math.round((Date.now() - session.startedAt) / 1000)}s），已保留完成的镜头`, 'network'),
          }
        }

        const submitted = Array.isArray(args.results) ? args.results : []
        if (submitted.length === 0) {
          return batchError(projectId, 'submit 需要至少一个 results 项')
        }

        const context = await load(session.projectId)
        const results = []
        let budgetExhausted = false

        for (const item of submitted) {
          const sceneId = String(item?.sceneId ?? '')
          const scene = context.storyboard.scenes.find((candidate) => candidate.id === sceneId) ?? null
          if (scene === null || !session.remaining.includes(sceneId)) {
            results.push({ sceneId, ok: false, round: 0, scores: null, passed: false, error: errorOf('镜头不在待优化列表里') })
            continue
          }
          const roundNumber = (session.perScene.get(sceneId)?.round ?? 0) + 1
          if (roundNumber > session.maxRounds) {
            results.push({ sceneId, ok: false, round: roundNumber, scores: null, passed: false, error: errorOf('已达最大轮次') })
            continue
          }
          if (session.roundsUsed >= session.budget) {
            budgetExhausted = true
            break
          }
          try {
            const analysis = analyzePrompt({
              narration: item.narration ?? '',
              visualPrompt: item.visualPrompt ?? '',
              style: session.style,
            })
            const scores = mergeScores(analysis.scores, item.selfScores ?? {})
            const passed = analysis.passed && !needsAnotherRound(scores, true)
            await applyRound(context.store, sceneId, {
              round: roundNumber,
              narration: String(item.narration ?? ''),
              visualPrompt: String(item.visualPrompt ?? ''),
              scores,
              reason: item.reason ?? null,
              style: session.style,
            })
            session.roundsUsed += 1
            session.perScene.set(sceneId, { round: roundNumber })
            const done = passed || roundNumber >= session.maxRounds
            if (done) session.remaining = session.remaining.filter((id) => id !== sceneId)
            results.push({ sceneId, ok: true, round: roundNumber, scores, passed, error: null })
          } catch (error) {
            results.push({ sceneId, ok: false, round: roundNumber, scores: null, passed: false, error: errorOf(String(error?.message ?? error)) })
          }
        }

        const finished = session.remaining.length === 0 || budgetExhausted
        const skippedScenes = budgetExhausted
          ? session.remaining.map((sceneId) => ({ sceneId, reason: '批量轮次预算已用尽（镜头数×2），未处理' }))
          : []
        const message = budgetExhausted
          ? `批量轮次预算已用尽（镜头数×2），${skippedScenes.length} 个镜头被跳过`
          : null
        const payload = {
          ...batchPayload(session, sessions, finished ? 'done' : 'awaiting_draft', results, { skippedScenes, message }),
          projectId: session.projectId,
        }
        if (finished) {
          sessions.closeBatch(session.id)
          return payload
        }
        // 继续：给剩余镜头生成下一轮指令。
        const nextRound = Math.min(...session.remaining.map((id) => (session.perScene.get(id)?.round ?? 0) + 1))
        const scenes = session.remaining
          .map((id) => context.storyboard.scenes.find((candidate) => candidate.id === id))
          .filter(Boolean)
          .map((scene) => ({
            sceneId: scene.id,
            current: scene.currentPrompt,
            analysis: analyzePrompt({ narration: scene.currentPrompt.narration, visualPrompt: scene.currentPrompt.visualPrompt, style: session.style }),
          }))
        return {
          ...payload,
          instruction: buildBatchInstruction({ projectId: session.projectId, batchId: session.id, style: session.style, round: nextRound, maxRounds: session.maxRounds, scenes }),
        }
      },
    }),
  ]
}

function roundRecord(round) {
  return { round: round.round, scores: round.scores ?? null, passed: round.passed === true, reason: round.reason ?? null }
}

function evaluateError(projectId, sceneId, style, message) {
  return {
    ok: false,
    projectId,
    sceneId,
    style,
    current: { narration: '', visualPrompt: '' },
    elements: { subject: false, action: false, scene: false, light: false },
    narrationLength: 0,
    vagueWords: [],
    scores: { specificity: 1, visual: 1, emotion: 1 },
    suggestions: [],
    passed: false,
    error: errorOf(message),
  }
}

function optimizeError(projectId, sceneId, message) {
  return {
    ok: false,
    phase: 'error',
    optimizationId: null,
    projectId,
    sceneId,
    style: '写实电影感',
    round: 0,
    maxRounds: 1,
    instruction: null,
    current: null,
    applied: false,
    rounds: [],
    finalScores: null,
    finalPassed: false,
    error: errorOf(message),
  }
}

function batchError(projectId, message) {
  return {
    ok: false,
    phase: 'error',
    batchId: null,
    projectId,
    style: '写实电影感',
    maxRounds: 1,
    total: 0,
    done: 0,
    remaining: [],
    skippedScenes: [],
    percent: 0,
    instruction: null,
    results: [],
    message: null,
    error: errorOf(message),
  }
}

function batchPayload(session, sessions, phase, results = [], extra = {}) {
  const total = session.total ?? session.perScene.size + session.remaining.length
  const completed = Math.max(0, total - session.remaining.length)
  return {
    ok: true,
    phase,
    batchId: session.id,
    projectId: session.projectId,
    style: session.style,
    maxRounds: session.maxRounds,
    total,
    done: completed,
    remaining: [...session.remaining],
    skippedScenes: extra.skippedScenes ?? [],
    percent: total === 0 ? 100 : Math.round((completed / total) * 100),
    instruction: null,
    results,
    message: extra.message ?? null,
    error: null,
  }
}

function renderEvaluate(value) {
  if (!value.ok) return [{ type: 'text', text: `✗ 评估失败：${value.error?.message ?? ''}` }]
  const lines = [
    `镜头 ${value.sceneId}（风格 ${value.style}）：${value.passed ? '规则通过' : '规则未通过'}`,
    `旁白 ${value.narrationLength} 字 · 空泛词 ${value.vagueWords.length === 0 ? '无' : value.vagueWords.join('、')}`,
    `四要素：主体${value.elements.subject ? '✓' : '✗'} 动作${value.elements.action ? '✓' : '✗'} 场景${value.elements.scene ? '✓' : '✗'} 光线${value.elements.light ? '✓' : '✗'}`,
    `评分：具体性 ${value.scores.specificity}/5 · 可视化 ${value.scores.visual}/5 · 情绪 ${value.scores.emotion}/5`,
    '建议：',
    ...value.suggestions.map((item) => `  - ${item}`),
  ]
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderOptimize(value) {
  if (value.phase === 'error') return [{ type: 'text', text: `✗ ${value.error?.message ?? '优化失败'}` }]
  if (value.phase === 'timeout') {
    return [{ type: 'text', text: `⏱ 优化超时：已完成 ${value.rounds.length} 轮，已写入的数据保留（${value.error?.message ?? ''}）` }]
  }
  const lines = [`镜头 ${value.sceneId} · ${value.style} · 第 ${value.round}/${value.maxRounds} 轮`]
  if (value.applied && value.finalScores) {
    lines.push(`已写入：具体性 ${value.finalScores.specificity}/5 · 可视化 ${value.finalScores.visual}/5 · 情绪 ${value.finalScores.emotion}/5 · ${value.finalPassed ? '达标' : '未达标'}`)
  }
  if (value.phase === 'awaiting_draft') lines.push('下一步：按 instruction 生成改进版，再调用 film_optimize_scene_prompt({action:"submit", …})。')
  if (value.phase === 'done') lines.push('优化结束（达标或达到最大轮次）。')
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderBatch(value) {
  if (value.phase === 'error') return [{ type: 'text', text: `✗ ${value.error?.message ?? '批量优化失败'}` }]
  const lines = [`批量优化（${value.style}）：${value.done}/${value.total}，${value.percent}%（${value.phase}）`]
  for (const item of value.results) {
    lines.push(`  ${item.ok ? '✓' : '✗'} ${item.sceneId} · 第 ${item.round} 轮${item.passed ? ' · 达标' : ''}${item.error ? ' · ' + item.error.message : ''}`)
  }
  if (value.remaining.length > 0) lines.push(`待继续：${value.remaining.join('、')}`)
  return [{ type: 'text', text: lines.join('\n') }]
}
