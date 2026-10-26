/**
 * 配置解析：环境变量 > cordis.patch.yml（插件 config） > 内置默认值。
 *
 * 这里刻意不依赖任何「设置保存接口」：手机端 DSHA 的 WebView 设置面板不是
 * 稳定契约，配置走 patch 文件与环境变量，重启即生效，卸载即消失。
 *
 * 命名空间前缀 FILM_STUDIO_，避免和别的插件抢环境变量。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 环境变量前缀。 */
export const ENV_PREFIX = 'FILM_STUDIO_'

/** 探测子进程的超时下限 / 上限（毫秒）。 */
const TIMEOUT_FLOOR_MS = 1000
const TIMEOUT_CEIL_MS = 120_000

/** 取第一个非空字符串。 */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/** 把任意输入收敛成 [floor, ceil] 区间内的整数毫秒。 */
function clampTimeout(value, fallback) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  return Math.min(TIMEOUT_CEIL_MS, Math.max(TIMEOUT_FLOOR_MS, Math.round(numeric)))
}

/**
 * 默认输出目录：优先跟 DSHA 的文档根（/root/Documents），退到当前工作目录。
 * 不写死任何平台路径；容器里就是 Linux 目录。
 */
export function defaultOutputDir(env = process.env) {
  const documents = firstNonEmpty(env.DSH_WORKSPACE_DOCUMENTS)
  if (documents) return join(documents, 'film-studio')
  const xdg = firstNonEmpty(env.XDG_DOCUMENTS_DIR)
  if (xdg) return join(xdg, 'film-studio')
  return join(homedir() || process.cwd(), 'Documents', 'film-studio')
}

/**
 * 合并三层配置。
 * @param {Record<string, unknown>} [config] cordis.patch.yml 里该条目的 config。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ffmpegPath: string, ffprobePath: string, outputDir: string, timeoutMs: number, sources: Record<string, string>}}
 */
export function resolveSettings(config = {}, env = process.env, providersFile = {}) {
  const cfg = config !== null && typeof config === 'object' ? config : {}
  const sources = {}

  const pick = (envKey, cfgKey, fallback, label) => {
    const fromEnv = firstNonEmpty(env[envKey])
    if (fromEnv) {
      sources[label] = `env:${envKey}`
      return fromEnv
    }
    const fromConfig = firstNonEmpty(cfg[cfgKey])
    if (fromConfig) {
      sources[label] = `config:${cfgKey}`
      return fromConfig
    }
    sources[label] = 'default'
    return fallback
  }

  const timeoutFromEnv = env[`${ENV_PREFIX}TIMEOUT_MS`]
  const timeoutRaw = timeoutFromEnv !== undefined && timeoutFromEnv !== '' ? timeoutFromEnv : cfg.timeoutMs
  const timeoutMs = clampTimeout(timeoutRaw, 20_000)
  sources.timeoutMs = timeoutFromEnv ? `env:${ENV_PREFIX}TIMEOUT_MS` : cfg.timeoutMs !== undefined ? 'config:timeoutMs' : 'default'

  // 模块 4 约定：ctx.config.ffmpegPath 优先 → DSH_FFMPEG_PATH → FILM_STUDIO_FFMPEG → PATH。
  const ffmpegFromConfig = firstNonEmpty(cfg.ffmpegPath)
  const ffmpegFromDsh = firstNonEmpty(env.DSH_FFMPEG_PATH)
  const ffmpegFromFilm = firstNonEmpty(env[`${ENV_PREFIX}FFMPEG`])
  const ffprobeFromConfig = firstNonEmpty(cfg.ffprobePath)
  const ffprobeFromDsh = firstNonEmpty(env.DSH_FFPROBE_PATH)
  const ffprobeFromFilm = firstNonEmpty(env[`${ENV_PREFIX}FFPROBE`])
  const ffmpegPath = ffmpegFromConfig || ffmpegFromDsh || ffmpegFromFilm || 'ffmpeg'
  const ffprobePath = ffprobeFromConfig || ffprobeFromDsh || ffprobeFromFilm || 'ffprobe'
  sources.ffmpegPath = ffmpegFromConfig ? 'config:ffmpegPath'
    : ffmpegFromDsh ? 'env:DSH_FFMPEG_PATH'
    : ffmpegFromFilm ? `env:${ENV_PREFIX}FFMPEG`
    : 'default'
  sources.ffprobePath = ffprobeFromConfig ? 'config:ffprobePath'
    : ffprobeFromDsh ? 'env:DSH_FFPROBE_PATH'
    : ffprobeFromFilm ? `env:${ENV_PREFIX}FFPROBE`
    : 'default'

  return {
    // 约束 4：FFmpeg / ffprobe 的路径必须可配置，不能假设在 PATH 里。
    ffmpegPath,
    ffprobePath,
    outputDir: pick(`${ENV_PREFIX}OUTPUT_DIR`, 'outputDir', defaultOutputDir(env), 'outputDir'),
    timeoutMs,
    sources,
    // 模块 2：供应商池、轮询节奏、失败切换节奏。
    providers: resolveProviders(cfg, env, providersFile),
    polling: resolvePolling(cfg, env),
    failover: resolveFailover(cfg, env),
    // 模块 3：分镜工作区。
    workspaceDir: pick(`${ENV_PREFIX}WORKSPACE`, 'workspaceDir', defaultWorkspaceDir(env), 'workspaceDir'),
    storyboardPath: resolveStoryboardPath(cfg, env),
  }
}


/* ------------------------------------------------------------------ */
/* 模块 2：供应商池 / 轮询 / 失败切换                                   */
/* ------------------------------------------------------------------ */

/** 默认供应商尝试顺序。 */
export const DEFAULT_PROVIDER_ORDER = Object.freeze(['jimeng', 'doubao-seedream', 'doubao-seedance', 'wanx', 'tongyi-wanx', 'kling'])

/** 默认轮询节奏：60 次上限，5s 起步，20s 封顶。 */
export const DEFAULT_POLLING = Object.freeze({
  maxPolls: 60,
  initialDelayMs: 5_000,
  maxDelayMs: 20_000,
})

/** 默认失败切换节奏：同供应商重试 1 次，退避 800ms。 */
export const DEFAULT_FAILOVER = Object.freeze({
  sameProviderRetries: 1,
  retryDelayMs: 800,
})

const DEFAULT_JIMENG_BASE = 'https://ark.cn-beijing.volces.com/api/v3'
const DEFAULT_KLING_BASE = 'https://api.klingai.com'
const DEFAULT_WANX_BASE = 'https://dashscope.aliyuncs.com/api/v1'

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function clampInt(value, fallback, min, max) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

/**
 * 供应商配置：密钥优先级 ctx.config → 环境变量 → 空（由适配器报明确的「未配置」）。
 * 每个凭据额外记录来源，方便排查「为什么没读到 Key」。
 */
export function resolveProviders(config = {}, env = process.env, providersFile = {}) {
  const providers = asObject(config.providers)
  const file = asObject(providersFile)
  const jimeng = asObject(providers.jimeng)
  const kling = asObject(providers.kling)

  const order = Array.isArray(providers.order) && providers.order.length > 0
    ? providers.order.filter((name) => typeof name === 'string' && name !== '')
    : [...DEFAULT_PROVIDER_ORDER]

  const pickWithSource = (fromConfig, envValue, fromFile) => {
    const configValue = firstNonEmpty(fromConfig)
    if (configValue !== '') return { value: configValue, source: 'config' }
    const envResolved = firstNonEmpty(envValue)
    if (envResolved !== '') return { value: envResolved, source: 'env' }
    const fileValue = firstNonEmpty(fromFile)
    if (fileValue !== '') return { value: fileValue, source: 'file' }
    return { value: '', source: 'none' }
  }

  const jimengKey = pickWithSource(jimeng.apiKey, env.JIMENG_API_KEY, asObject(file.jimeng).apiKey)
  const doubaoSeedream = asObject(providers.doubaoSeedream)
  const doubaoSeedance = asObject(providers.doubaoSeedance)
  const wanx = asObject(providers.wanx)
  const tongyiWanx = asObject(providers.tongyiWanx)
  const seedreamKey = pickWithSource(doubaoSeedream.apiKey, env.DOUBAO_SEEDREAM_API_KEY || env.JIMENG_API_KEY, asObject(file.doubaoSeedream).apiKey)
  const seedanceKey = pickWithSource(doubaoSeedance.apiKey, env.DOUBAO_SEEDANCE_API_KEY || env.JIMENG_API_KEY, asObject(file.doubaoSeedance).apiKey)
  const wanxKey = pickWithSource(wanx.apiKey, env.DASHSCOPE_API_KEY, asObject(file.wanx).apiKey)
  const tongyiKey = pickWithSource(tongyiWanx.apiKey, env.TONGYI_WANX_API_KEY || env.DASHSCOPE_API_KEY, asObject(file.tongyiWanx).apiKey)

  return {
    order,
    jimeng: {
      apiKey: jimengKey.value,
      apiKeySource: jimengKey.source,
      baseURL: firstNonEmpty(jimeng.baseURL, env.JIMENG_BASE_URL, DEFAULT_JIMENG_BASE),
      imageModel: firstNonEmpty(jimeng.imageModel, env.JIMENG_IMAGE_MODEL, 'doubao-seedream-4-0-20260415'),
      videoModel: firstNonEmpty(jimeng.videoModel, env.JIMENG_VIDEO_MODEL, 'doubao-seedance-2-0-260128'),
    },
    doubaoSeedream: {
      apiKey: seedreamKey.value,
      apiKeySource: seedreamKey.source,
      envName: 'DOUBAO_SEEDREAM_API_KEY',
      baseURL: firstNonEmpty(doubaoSeedream.baseURL, env.DOUBAO_SEEDREAM_BASE_URL, DEFAULT_JIMENG_BASE),
      imageModel: firstNonEmpty(doubaoSeedream.imageModel, env.DOUBAO_SEEDREAM_MODEL, 'doubao-seedream-4-0-20260415'),
    },
    doubaoSeedance: {
      apiKey: seedanceKey.value,
      apiKeySource: seedanceKey.source,
      envName: 'DOUBAO_SEEDANCE_API_KEY',
      baseURL: firstNonEmpty(doubaoSeedance.baseURL, env.DOUBAO_SEEDANCE_BASE_URL, DEFAULT_JIMENG_BASE),
      videoModel: firstNonEmpty(doubaoSeedance.videoModel, env.DOUBAO_SEEDANCE_MODEL, 'doubao-seedance-2-0-260128'),
    },
    wanx: {
      apiKey: wanxKey.value,
      apiKeySource: wanxKey.source,
      envName: 'DASHSCOPE_API_KEY',
      baseURL: firstNonEmpty(wanx.baseURL, env.DASHSCOPE_BASE_URL, DEFAULT_WANX_BASE),
      imageModel: firstNonEmpty(wanx.imageModel, env.WANX_IMAGE_MODEL, 'wanx2.1-t2i-turbo'),
      videoModel: firstNonEmpty(wanx.videoModel, env.WANX_VIDEO_MODEL, 'wanx2.1-t2v-turbo'),
    },
    tongyiWanx: {
      apiKey: tongyiKey.value,
      apiKeySource: tongyiKey.source,
      envName: 'TONGYI_WANX_API_KEY',
      baseURL: firstNonEmpty(tongyiWanx.baseURL, env.TONGYI_WANX_BASE_URL, DEFAULT_WANX_BASE),
      imageModel: firstNonEmpty(tongyiWanx.imageModel, env.TONGYI_WANX_IMAGE_MODEL, 'wanx2.1-t2i-turbo'),
      videoModel: firstNonEmpty(tongyiWanx.videoModel, env.TONGYI_WANX_VIDEO_MODEL, 'wanx2.1-t2v-turbo'),
    },
    kling: {
      accessKey: pickWithSource(kling.accessKey, env.KLING_ACCESS_KEY, asObject(file.kling).accessKey).value,
      secretKey: pickWithSource(kling.secretKey, env.KLING_SECRET_KEY, asObject(file.kling).secretKey).value,
      accessKeySource: pickWithSource(kling.accessKey, env.KLING_ACCESS_KEY, asObject(file.kling).accessKey).source,
      baseURL: firstNonEmpty(kling.baseURL, env.KLING_BASE_URL, DEFAULT_KLING_BASE),
      imageModel: firstNonEmpty(kling.imageModel, env.KLING_IMAGE_MODEL, 'kling-v1'),
      videoModel: firstNonEmpty(kling.videoModel, env.KLING_VIDEO_MODEL, 'kling-v1'),
    },
  }
}

/** 轮询节奏：patch config → 环境变量 → 默认。 */
export function resolvePolling(config = {}, env = process.env) {
  const polling = asObject(config.polling)
  return {
    maxPolls: clampInt(
      firstNonEmpty(env.FILM_STUDIO_POLL_MAX) || polling.maxPolls,
      DEFAULT_POLLING.maxPolls,
      1,
      240,
    ),
    initialDelayMs: clampInt(
      firstNonEmpty(env.FILM_STUDIO_POLL_INITIAL_MS) || polling.initialDelayMs,
      DEFAULT_POLLING.initialDelayMs,
      0,
      60_000,
    ),
    maxDelayMs: clampInt(
      firstNonEmpty(env.FILM_STUDIO_POLL_MAX_MS) || polling.maxDelayMs,
      DEFAULT_POLLING.maxDelayMs,
      0,
      120_000,
    ),
  }
}

/** 失败切换节奏：patch config → 环境变量 → 默认。 */
export function resolveFailover(config = {}, env = process.env) {
  const failover = asObject(config.failover)
  return {
    sameProviderRetries: clampInt(
      firstNonEmpty(env.FILM_STUDIO_RETRIES) || failover.sameProviderRetries,
      DEFAULT_FAILOVER.sameProviderRetries,
      0,
      3,
    ),
    retryDelayMs: clampInt(
      firstNonEmpty(env.FILM_STUDIO_RETRY_DELAY_MS) || failover.retryDelayMs,
      DEFAULT_FAILOVER.retryDelayMs,
      0,
      30_000,
    ),
  }
}


/* ------------------------------------------------------------------ */
/* 模块 3：分镜工作区                                                   */
/* ------------------------------------------------------------------ */

/**
 * 默认工作区：优先 FILM_STUDIO_WORKSPACE / config.workspaceDir，
 * 其次 DSH 文档目录下的 film-studio；不写死任何用户目录。
 */
export function defaultWorkspaceDir(env = process.env) {
  const documents = firstNonEmpty(env.DSH_WORKSPACE_DOCUMENTS)
  if (documents) return join(documents, 'film-studio')
  const xdg = firstNonEmpty(env.XDG_DOCUMENTS_DIR)
  if (xdg) return join(xdg, 'film-studio')
  return join(homedir() || process.cwd(), 'Documents', 'film-studio')
}

/**
 * storyboard.json 的完整路径：显式配置优先，否则落在 workspaceDir 下。
 */
export function resolveStoryboardPath(config = {}, env = process.env) {
  const explicit = firstNonEmpty(env[`${ENV_PREFIX}STORYBOARD`], asObject(config).storyboardPath)
  if (explicit !== '') return explicit
  const workspace = firstNonEmpty(env[`${ENV_PREFIX}WORKSPACE`], asObject(config).workspaceDir)
  const base = workspace !== '' ? workspace : defaultWorkspaceDir(env)
  return join(base, 'storyboard.json')
}


/* ------------------------------------------------------------------ */
/* 模块 3 修正：按 projectId 分区                                       */
/* ------------------------------------------------------------------ */

/** 默认项目 id。 */
export const DEFAULT_PROJECT_ID = 'default'

/** 项目 id 只允许安全字符，防止路径穿越。 */
export function sanitizeProjectId(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  return safe === '' || safe === '.' || safe === '..' ? DEFAULT_PROJECT_ID : safe
}

/**
 * 一个项目在磁盘上的固定布局：
 *   workspace/projects/<projectId>/storyboard.json
 *   workspace/projects/<projectId>/assets/     ← 素材
 *   workspace/projects/<projectId>/output/     ← 导出
 * 显式配置的 storyboardPath 仍然优先（兼容旧配置）。
 */
export function resolveProjectPaths(workspaceDir, projectId = DEFAULT_PROJECT_ID, explicitStoryboardPath = '') {
  const id = sanitizeProjectId(projectId)
  const projectDir = join(workspaceDir, 'projects', id)
  return {
    projectId: id,
    projectDir,
    storyboardPath: explicitStoryboardPath !== '' ? explicitStoryboardPath : join(projectDir, 'storyboard.json'),
    assetsDir: join(projectDir, 'assets'),
    outputDir: join(projectDir, 'output'),
  }
}
