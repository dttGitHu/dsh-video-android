/**
 * 提示词规则检查 + 风格预设 + 给模型的优化指令。
 *
 * 插件不调用第二个 LLM：优化由当前会话模型完成，这里只负责
 * 「指出问题 → 给标准 → 告诉模型提交什么格式」。
 * @module prompt/rules
 */
import { DEFAULT_PROMPT_STYLE, PROMPT_STYLES } from '../storyboard/model.js'

/** 动作词表。 */
const ACTION_WORDS = /走|跑|坐|站|看|望|转身|回头|伸手|挥|笑|低头|抬头|推|拉|抱|举|停|蹲|躺|靠|冲|追|躲|敲|打开|关上|拿起|放下|凝视|眺望|喃喃|呼吸|颤抖|穿梭|走过|停下/

/** 场景词表。 */
const SCENE_WORDS = /街|巷|房间|室内|窗外|森林|海边|天空|城市|楼|窗台|屋顶|地下|车站|雨|雪|夜|清晨|黄昏|走廊|厨房|卧室|办公室|桥|河|山|田|市集|车内|地铁|广场|码头|废墟/

/** 光线 / 氛围词表。 */
const LIGHT_WORDS = /光|影|阳光|月光|霓虹|台灯|灯|逆光|侧光|暖色|冷色|暗|亮|阴影|雾|烟|烛|反光|高光|昏暗|朦胧|氛围|色调|余晖|晨光|暮色/

/** 情绪词表。 */
const EMOTION_WORDS = /孤|孤独|温暖|温柔|紧张|悬疑|恐惧|害怕|不安|平静|安静|怅|忧伤|喜悦|治愈|压抑|冷清|柔软|沉|暖|寒|疲惫|期待|失落|克制/

/** 空泛词表：只写「好看」而不给信息。 */
const VAGUE_WORDS = ['很好看', '很棒', '很美', '非常漂亮', '效果好', '不错', '唯美', '震撼', '完美', '精彩', '高级感', '大片感']

/** 风格预设：不同风格的侧重与指令。 */
export const STYLE_PRESETS = Object.freeze({
  写实电影感: {
    label: '写实电影感',
    focus: ['镜头规格', '景别与构图', '光线层次', '真实材质'],
    emotionBoost: true,
    instruction:
      '写实电影感：强调镜头语言（焦段/景别/机位）、自然光与人工光的层次、真实材质与颗粒感；避免夸张形容。',
  },
  动画漫剧: {
    label: '动画漫剧',
    focus: ['线条与色块', '夸张表情', '分镜张力', '赛璐璐质感'],
    emotionBoost: true,
    instruction:
      '动画漫剧：强调线稿粗细、赛璐璐/厚涂质感、角色表情与动作幅度、分镜框与速度线；画面可更风格化。',
  },
  悬疑: {
    label: '悬疑',
    focus: ['阴影占比', '构图张力', '冷暖对比', '留白暗示'],
    emotionBoost: true,
    instruction:
      '悬疑：让画面充满未说出口的信息——大面积阴影、被遮挡的主体、偏冷色调与局部暖光对比、不稳定构图与留白暗示危险。',
  },
  治愈: {
    label: '治愈',
    focus: ['柔和光线', '自然元素', '温暖色调', '松弛姿态'],
    emotionBoost: true,
    instruction:
      '治愈：柔和漫射光、绿色/木色等自然元素、温暖低饱和色调、人物姿态松弛；避免尖锐阴影与强对比。',
  },
})

/** 取一个风格预设，非法值回退默认。 */
export function stylePreset(style) {
  return STYLE_PRESETS[style] ?? STYLE_PRESETS[DEFAULT_PROMPT_STYLE]
}

/** 当前支持的风格名。 */
export function styleNames() {
  return [...PROMPT_STYLES]
}

function clampScore(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 1
  return Math.min(5, Math.max(1, Math.round(numeric)))
}

/** 旁白长度（按字符数，中文按字）。 */
export function countChars(text) {
  return [...String(text ?? '')].length
}

/**
 * 规则检查：四要素、旁白长度、空泛词，并给出规则侧三维评分与改进建议。
 * @param {{narration?: string, visualPrompt?: string, style?: string}} input
 */
export function analyzePrompt(input = {}) {
  const narration = String(input.narration ?? '')
  const visualPrompt = String(input.visualPrompt ?? '')
  const style = input.style ?? DEFAULT_PROMPT_STYLE
  const preset = stylePreset(style)

  const elements = {
    subject: visualPrompt.trim().length >= 4,
    action: ACTION_WORDS.test(visualPrompt),
    scene: SCENE_WORDS.test(visualPrompt),
    light: LIGHT_WORDS.test(visualPrompt),
  }
  const narrationLength = countChars(narration)
  const narrationOk = narrationLength >= 10 && narrationLength <= 60
  const vagueWords = VAGUE_WORDS.filter((word) => visualPrompt.includes(word) || narration.includes(word))

  const ruleScores = {
    specificity: clampScore(1 + (elements.subject ? 1 : 0) + (elements.action ? 1 : 0) + (elements.scene ? 1 : 0) + (visualPrompt.length > 18 ? 1 : 0)),
    visual: clampScore(1 + (elements.scene ? 1 : 0) + (elements.light ? 1 : 0) + (visualPrompt.length > 24 ? 1 : 0) + (vagueWords.length === 0 ? 1 : 0)),
    emotion: clampScore(1 + (EMOTION_WORDS.test(visualPrompt) ? 1 : 0) + (elements.light ? 1 : 0) + (preset.emotionBoost ? 1 : 0) + (narrationOk ? 1 : 0)),
  }

  const suggestions = []
  if (!elements.subject) suggestions.push('画面描述缺少明确主体：写清楚「谁/什么」在画面里。')
  if (!elements.action) suggestions.push('缺少动作：主体在做什么（走、看、回头、伸手…）。')
  if (!elements.scene) suggestions.push('缺少场景：交代空间与环境（街巷、房间、雨夜、森林…）。')
  if (!elements.light) suggestions.push('缺少光线/氛围：补充光源、影调或天气（逆光、霓虹、晨雾…）。')
  if (!narrationOk) suggestions.push(`旁白长度 ${narrationLength} 字，建议控制在 10–60 字。`)
  if (vagueWords.length > 0) suggestions.push(`去掉空泛词：${vagueWords.join('、')}；用可拍摄的细节替代。`)
  if (suggestions.length === 0) suggestions.push('规则检查通过；仍可让画面更具体、情绪更贴合风格。')

  const passed = elements.subject && elements.action && elements.scene && elements.light && narrationOk && vagueWords.length === 0

  return {
    style,
    elements,
    narrationLength,
    narrationOk,
    vagueWords,
    scores: ruleScores,
    suggestions,
    passed,
  }
}

/**
 * 合并规则评分与模型自评：取较低值，避免自评虚高掩盖规则问题。
 * @param {{specificity:number, visual:number, emotion:number}} ruleScores
 * @param {{specificity?:number, visual?:number, emotion?:number}} selfScores
 */
export function mergeScores(ruleScores, selfScores = {}) {
  const pick = (key) => {
    const self = Number(selfScores?.[key])
    const hasSelf = Number.isFinite(self)
    const rule = Number(ruleScores?.[key] ?? 1)
    return clampScore(hasSelf ? Math.min(self, rule) : rule)
  }
  return { specificity: pick('specificity'), visual: pick('visual'), emotion: pick('emotion') }
}

/** 是否还需要下一轮：任一维度 < 3 或规则未通过。 */
export function needsAnotherRound(scores, passed) {
  if (!passed) return true
  return ['specificity', 'visual', 'emotion'].some((key) => (scores?.[key] ?? 0) < 3)
}

/**
 * 单镜头优化指令：告诉模型要改什么、按什么标准改、返回什么格式。
 * @param {{
 *   projectId: string, sceneId: string, optimizationId: string, round: number, maxRounds: number,
 *   style: string, current: {narration: string, visualPrompt: string}, analysis: ReturnType<typeof analyzePrompt>,
 * }} input
 */
export function buildSceneInstruction(input) {
  const { projectId, sceneId, optimizationId, round, maxRounds, style, current, analysis } = input
  const preset = stylePreset(style)
  return [
    `【第 ${round}/${maxRounds} 轮】优化镜头 ${sceneId}（项目 ${projectId}）。`,
    `风格：${style} —— ${preset.instruction}`,
    '',
    '当前文本：',
    `  旁白：${current.narration || '（空）'}`,
    `  画面：${current.visualPrompt || '（空）'}`,
    '',
    '规则检查：',
    `  主体 ${analysis.elements.subject ? '✓' : '✗'} · 动作 ${analysis.elements.action ? '✓' : '✗'} · 场景 ${analysis.elements.scene ? '✓' : '✗'} · 光线/氛围 ${analysis.elements.light ? '✓' : '✗'}`,
    `  旁白 ${analysis.narrationLength} 字（要求 10–60）· 空泛词 ${analysis.vagueWords.length === 0 ? '无' : analysis.vagueWords.join('、')}`,
    `  规则评分：具体性 ${analysis.scores.specificity}/5 · 可视化 ${analysis.scores.visual}/5 · 情绪 ${analysis.scores.emotion}/5`,
    '改进建议：',
    ...analysis.suggestions.map((item) => `  - ${item}`),
    '',
    '请输出改进版，并严格按下面 JSON 结构回传（只回传这个 JSON 的字段，不要解释）：',
    '{',
    '  "narration": "改进后的旁白（10–60 字）",',
    '  "visualPrompt": "改进后的画面描述（主体+动作+场景+光线/氛围）",',
    '  "selfScores": { "specificity": 1-5, "visual": 1-5, "emotion": 1-5 },',
    '  "reason": "为什么这样改（一句话）"',
    '}',
    '',
    '回传方式：调用 film_optimize_scene_prompt，参数：',
    `  { "action": "submit", "optimizationId": "${optimizationId}", "round": ${round}, "draft": { "narration": "…", "visualPrompt": "…" }, "selfScores": { "specificity": 4, "visual": 4, "emotion": 4 }, "reason": "…" }`,
  ].join('\n')
}

/**
 * 批量优化指令：列出待优化镜头与提交格式。
 * @param {{
 *   projectId: string, batchId: string, style: string, round: number, maxRounds: number,
 *   scenes: Array<{sceneId: string, current: {narration: string, visualPrompt: string}, analysis: ReturnType<typeof analyzePrompt>}>,
 * }} input
 */
export function buildBatchInstruction(input) {
  const { projectId, batchId, style, round, maxRounds, scenes } = input
  const preset = stylePreset(style)
  const lines = [
    `【批量优化 · 第 ${round} 轮】项目 ${projectId}，共 ${scenes.length} 个待优化镜头。`,
    `风格：${style} —— ${preset.instruction}`,
    '',
    '待优化镜头：',
  ]
  for (const scene of scenes) {
    lines.push(`- ${scene.sceneId}`)
    lines.push(`    旁白：${scene.current.narration || '（空）'}`)
    lines.push(`    画面：${scene.current.visualPrompt || '（空）'}`)
    lines.push(`    规则：主体${scene.analysis.elements.subject ? '✓' : '✗'} 动作${scene.analysis.elements.action ? '✓' : '✗'} 场景${scene.analysis.elements.scene ? '✓' : '✗'} 光线${scene.analysis.elements.light ? '✓' : '✗'}；建议：${scene.analysis.suggestions.join('；')}`)
  }
  lines.push(
    '',
    '请为每个镜头输出改进版，并调用 film_optimize_all_prompts 提交：',
    '{',
    `  "action": "submit",`,
    `  "batchId": "${batchId}",`,
    '  "results": [',
    '    { "sceneId": "…", "narration": "…", "visualPrompt": "…", "selfScores": { "specificity": 1-5, "visual": 1-5, "emotion": 1-5 }, "reason": "…" }',
    '  ]',
    '}',
    '',
    `剩余轮次预算：每个镜头最多 ${maxRounds} 轮；批量总提交轮次不超过镜头数 × 2。`,
  )
  return lines.join('\n')
}
