/**
 * 分镜数据模型：一个 storyboard.json 的形状、规范化与增量更新。
 *
 * 设计原则：
 * - 文件即真相：工作台与工具读写同一份 JSON，重启后原样读回；
 * - 宽容读取：字段缺失/多余都尽量修复而不是整份丢弃，保护用户已编辑内容；
 * - 生成参数与镜头绑定：重新生成时不用再问一遍。
 * @module storyboard/model
 */

/** 镜头状态。 */
export const SCENE_STATUSES = Object.freeze(['draft', 'generating', 'done', 'failed'])

/** 分镜文件格式版本。 */
export const STORYBOARD_VERSION = 1

/** 每个镜头最多保留的优化轮次（第 0 轮原始版本始终保留，不参与裁剪）。 */
export const PROMPT_HISTORY_LIMIT = 5

/** 支持的提示词风格预设。 */
export const PROMPT_STYLES = Object.freeze(['写实电影感', '动画漫剧', '悬疑', '治愈'])

/** 默认风格。 */
export const DEFAULT_PROMPT_STYLE = '写实电影感'

/** 只保留第 0 轮 + 最近 N 轮优化。 */
export function trimPromptHistory(history) {
  if (!Array.isArray(history)) return []
  const base = history.find((item) => item && item.round === 0) ?? null
  const optimized = history.filter((item) => item && item.round !== 0)
  const kept = optimized.slice(-PROMPT_HISTORY_LIMIT)
  return base ? [base, ...kept] : kept
}

/** 默认生成参数（可被镜头级 params 覆盖）。 */
export const DEFAULT_SCENE_PARAMS = Object.freeze({
  kind: 'image',
  aspectRatio: '16:9',
  duration: 5,
  provider: null,
  model: null,
  negativePrompt: null,
})

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function asNullableString(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function asPositiveInt(value, fallback) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 1) return fallback
  return Math.round(numeric)
}

/**
 * 规范化一个镜头：保留已知字段、丢弃未知字段、补齐默认值。
 * @param {Record<string, unknown>} input
 * @param {number} index 从 1 开始
 */
export function normalizeScene(input, index) {
  const raw = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const paramsInput = raw.params !== null && typeof raw.params === 'object' && !Array.isArray(raw.params) ? raw.params : {}
  const status = SCENE_STATUSES.includes(raw.status) ? raw.status : 'draft'
  const narration = asString(raw.narration)
  const visualPrompt = asString(raw.visualPrompt)
  const history = trimPromptHistory(
    Array.isArray(raw.promptHistory)
      ? raw.promptHistory.map(normalizePromptHistory).filter(Boolean)
      : [],
  )
  const current = raw.currentPrompt !== null && typeof raw.currentPrompt === 'object'
    ? {
        narration: asString(raw.currentPrompt.narration, narration),
        visualPrompt: asString(raw.currentPrompt.visualPrompt, visualPrompt),
      }
    : { narration, visualPrompt }
  // 没有历史时，把原始版本作为第 0 轮补进去（评审可回溯到最初文本）。
  const withOriginal = history.some((item) => item.round === 0)
    ? history
    : [{ round: 0, narration, visualPrompt, scores: null, reason: '原始版本', timestamp: null }, ...history]
  return {
    id: asString(raw.id, '') || `scene-${index}`,
    index,
    narration,
    visualPrompt,
    imageUrl: asNullableString(raw.imageUrl),
    videoUrl: asNullableString(raw.videoUrl),
    status,
    currentPrompt: current,
    promptHistory: trimPromptHistory(withOriginal),
    promptStyle: PROMPT_STYLES.includes(raw.promptStyle) ? raw.promptStyle : DEFAULT_PROMPT_STYLE,
    assets: {
      image: asNullableString(raw.assets?.image),
      video: asNullableString(raw.assets?.video),
    },
    params: {
      kind: paramsInput.kind === 'video' ? 'video' : 'image',
      aspectRatio: asNullableString(paramsInput.aspectRatio) ?? DEFAULT_SCENE_PARAMS.aspectRatio,
      duration: asPositiveInt(paramsInput.duration, DEFAULT_SCENE_PARAMS.duration),
      provider: asNullableString(paramsInput.provider),
      model: asNullableString(paramsInput.model),
      negativePrompt: asNullableString(paramsInput.negativePrompt),
    },
    switchTrace: Array.isArray(raw.switchTrace) ? raw.switchTrace.map(normalizeSwitch).filter(Boolean) : [],
    error: asNullableString(raw.error),
    lastGeneratedAt: asNullableString(raw.lastGeneratedAt),
  }
}

/** 优化历史项：轮次、文本、三维评分、理由、时间。 */
export function normalizePromptHistory(item) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return null
  const round = Number.isFinite(Number(item.round)) ? Math.max(0, Math.round(Number(item.round))) : 0
  const scores = item.scores !== null && typeof item.scores === 'object'
    ? {
        specificity: clampScore(item.scores.specificity),
        visual: clampScore(item.scores.visual),
        emotion: clampScore(item.scores.emotion),
      }
    : null
  return {
    round,
    narration: asString(item.narration),
    visualPrompt: asString(item.visualPrompt),
    scores,
    reason: asNullableString(item.reason),
    timestamp: asNullableString(item.timestamp),
  }
}

function clampScore(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 1
  return Math.min(5, Math.max(1, Math.round(numeric)))
}

/** 切换记录：只保留约定的字段。 */
export function normalizeSwitch(item) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return null
  return {
    from: asString(item.from),
    to: asString(item.to),
    reason: asString(item.reason),
    attempt: asPositiveInt(item.attempt, 1),
    message: asNullableString(item.message),
  }
}

/**
 * 规范化整份分镜。
 * @param {Record<string, unknown>} raw
 */
export function normalizeStoryboard(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const scenes = Array.isArray(input.scenes) ? input.scenes.map((scene, index) => normalizeScene(scene, index + 1)) : []
  return {
    version: STORYBOARD_VERSION,
    title: asString(input.title, '未命名影片'),
    updatedAt: asNullableString(input.updatedAt),
    scenes,
  }
}

/** 空分镜。 */
export function emptyStoryboard(title = '未命名影片') {
  return { version: STORYBOARD_VERSION, title, updatedAt: null, scenes: [] }
}

/**
 * 从工具输入创建分镜：分配 id/index，状态归零。
 * @param {{title?: string, scenes?: Array<Record<string, unknown>>}} input
 * @param {{existingCount?: number}} [options]
 */
export function createStoryboardFromInput(input, options = {}) {
  const raw = input ?? {}
  const scenes = Array.isArray(raw.scenes) ? raw.scenes : []
  const base = options.existingCount ?? 0
  const normalized = scenes.map((scene, offset) => {
    const normalizedScene = normalizeScene(scene, base + offset + 1)
    return {
      ...normalizedScene,
      id: `scene-${base + offset + 1}`,
      index: base + offset + 1,
      status: 'draft',
      imageUrl: null,
      videoUrl: null,
      switchTrace: [],
      error: null,
      lastGeneratedAt: null,
      currentPrompt: { narration: normalizedScene.narration, visualPrompt: normalizedScene.visualPrompt },
      promptHistory: [{ round: 0, narration: normalizedScene.narration, visualPrompt: normalizedScene.visualPrompt, scores: null, reason: '原始版本', timestamp: new Date().toISOString() }],
      promptStyle: DEFAULT_PROMPT_STYLE,
    }
  })
  return {
    version: STORYBOARD_VERSION,
    title: asString(raw.title, '未命名影片') || '未命名影片',
    updatedAt: null,
    scenes: normalized,
  }
}

/**
 * 在现有分镜里合并一批新镜头（追加）。
 * @param {ReturnType<typeof normalizeStoryboard>} storyboard
 * @param {Array<Record<string, unknown>>} scenes
 */
export function appendScenes(storyboard, scenes) {
  const current = normalizeStoryboard(storyboard)
  const start = current.scenes.length + 1
  const added = scenes.map((scene, offset) => {
    const normalized = normalizeScene(scene, start + offset)
    return {
      ...normalized,
      id: `scene-${start + offset}`,
      index: start + offset,
      status: 'draft',
      imageUrl: null,
      videoUrl: null,
      switchTrace: [],
      error: null,
      lastGeneratedAt: null,
      currentPrompt: { narration: normalized.narration, visualPrompt: normalized.visualPrompt },
      promptHistory: [{ round: 0, narration: normalized.narration, visualPrompt: normalized.visualPrompt, scores: null, reason: '原始版本', timestamp: new Date().toISOString() }],
      promptStyle: DEFAULT_PROMPT_STYLE,
    }
  })
  return { ...current, scenes: [...current.scenes, ...added], updatedAt: new Date().toISOString() }
}

/**
 * 更新一个镜头的字段。
 * @param {ReturnType<typeof normalizeStoryboard>} storyboard
 * @param {string} sceneId
 * @param {{narration?: string, visualPrompt?: string, params?: Record<string, unknown>}} patch
 * @returns {{storyboard: any, scene: any} | null} null 表示找不到镜头
 */
export function updateScene(storyboard, sceneId, patch = {}) {
  const current = normalizeStoryboard(storyboard)
  const targetIndex = current.scenes.findIndex((scene) => scene.id === sceneId)
  if (targetIndex === -1) return null

  const target = current.scenes[targetIndex]
  const nextParams = { ...target.params }
  if (patch.params !== null && typeof patch.params === 'object' && !Array.isArray(patch.params)) {
    for (const key of ['kind', 'aspectRatio', 'duration', 'provider', 'model', 'negativePrompt']) {
      if (!(key in patch.params)) continue
      const value = patch.params[key]
      if (key === 'kind') nextParams.kind = value === 'video' ? 'video' : 'image'
      else if (key === 'duration') nextParams.duration = asPositiveInt(value, nextParams.duration)
      else nextParams[key] = asNullableString(value)
    }
  }

  const nextNarration = patch.narration === undefined ? target.narration : asString(patch.narration, target.narration)
  const nextVisual = patch.visualPrompt === undefined ? target.visualPrompt : asString(patch.visualPrompt, target.visualPrompt)
  const updated = {
    ...target,
    narration: nextNarration,
    visualPrompt: nextVisual,
    currentPrompt: { narration: nextNarration, visualPrompt: nextVisual },
    params: nextParams,
  }
  // 文案或画面变了，已经生成的素材就不再对应当前描述，退回 draft。
  if ((patch.narration !== undefined || patch.visualPrompt !== undefined) && updated.status === 'done') {
    updated.status = 'draft'
  }

  const scenes = [...current.scenes]
  scenes[targetIndex] = updated
  return {
    storyboard: { ...current, scenes, updatedAt: new Date().toISOString() },
    scene: updated,
  }
}

/**
 * 记录一次生成结果。
 * @param {ReturnType<typeof normalizeStoryboard>} storyboard
 * @param {string} sceneId
 * @param {{status?: string, imageUrl?: string|null, videoUrl?: string|null, error?: string|null, switchTrace?: Array<any>}} result
 */
export function markGeneration(storyboard, sceneId, result = {}) {
  const current = normalizeStoryboard(storyboard)
  const targetIndex = current.scenes.findIndex((scene) => scene.id === sceneId)
  if (targetIndex === -1) return null
  const target = current.scenes[targetIndex]
  const updated = {
    ...target,
    status: SCENE_STATUSES.includes(result.status) ? result.status : target.status,
    imageUrl: result.imageUrl === undefined ? target.imageUrl : asNullableString(result.imageUrl),
    videoUrl: result.videoUrl === undefined ? target.videoUrl : asNullableString(result.videoUrl),
    assets: {
      image: result.assets?.image === undefined ? target.assets?.image ?? null : asNullableString(result.assets.image),
      video: result.assets?.video === undefined ? target.assets?.video ?? null : asNullableString(result.assets.video),
    },
    error: result.error === undefined ? target.error : asNullableString(result.error),
    switchTrace: Array.isArray(result.switchTrace) ? result.switchTrace.map(normalizeSwitch).filter(Boolean) : target.switchTrace,
    lastGeneratedAt: new Date().toISOString(),
  }
  const scenes = [...current.scenes]
  scenes[targetIndex] = updated
  return { storyboard: { ...current, scenes, updatedAt: new Date().toISOString() }, scene: updated }
}
