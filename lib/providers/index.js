/**
 * 供应商池：把 settings 里的配置实例化成统一的适配器列表。
 *
 * 适配器接口（调度器只认这套）：
 *   submit({ kind, prompt, params, signal }) → { taskId, url?, raw }
 *   poll(taskId, { kind, signal })          → { status: 'pending'|'succeeded'|'failed', url?, error?, raw? }
 *   classifyError(error)                    → { kind, retryable }
 *   isConfigured()                          → { ok: true, source } | { ok: false, missing: string[] }
 *   supports                                → ['image'] / ['video'] / ['image','video']
 * @module providers
 */
import { createJimengProvider } from './jimeng.js'
import { createKlingProvider } from './kling.js'
import { createArkProvider } from './ark.js'
import { createWanxProvider } from './wanx.js'

export { createJimengProvider, createKlingProvider, createArkProvider, createWanxProvider }
export { ProviderError, FAILURE_KINDS, RETRYABLE_BY_KIND, classifyFailure } from './errors.js'

/** 已知供应商的显示名。 */
export const PROVIDER_LABELS = Object.freeze({
  jimeng: '即梦（火山方舟）',
  'doubao-seedream': '豆包 Seedream（方舟）',
  'doubao-seedance': '豆包 Seedance（方舟）',
  wanx: '通义万相（Wanx）',
  'tongyi-wanx': '通义万相（Tongyi-Wanx）',
  kling: '可灵（Kling AI）',
})

/** 池的默认顺序。 */
export const DEFAULT_PROVIDER_ORDER = Object.freeze([
  'jimeng',
  'doubao-seedream',
  'doubao-seedance',
  'wanx',
  'tongyi-wanx',
  'kling',
])

const FACTORIES = {
  jimeng: (config, deps) => createJimengProvider(config, deps),
  kling: (config, deps) => createKlingProvider(config, deps),
  'doubao-seedream': (config, deps) => createArkProvider({
    ...config,
    name: 'doubao-seedream',
    label: PROVIDER_LABELS['doubao-seedream'],
    supports: ['image'],
  }, deps),
  'doubao-seedance': (config, deps) => createArkProvider({
    ...config,
    name: 'doubao-seedance',
    label: PROVIDER_LABELS['doubao-seedance'],
    supports: ['video'],
  }, deps),
  wanx: (config, deps) => createWanxProvider({
    ...config,
    name: 'wanx',
    label: PROVIDER_LABELS.wanx,
  }, deps),
  'tongyi-wanx': (config, deps) => createWanxProvider({
    ...config,
    name: 'tongyi-wanx',
    label: PROVIDER_LABELS['tongyi-wanx'],
  }, deps),
}

/**
 * 按 settings 创建供应商实例，顺序遵循 settings.providers.order。
 * @param {object} settings resolveSettings() 的结果
 * @param {{fetchImpl?: typeof fetch, requestTimeoutMs?: number}} [deps]
 */
export function createProviders(settings, deps = {}) {
  const config = settings?.providers ?? {}
  const order = Array.isArray(config.order) && config.order.length > 0 ? config.order : [...DEFAULT_PROVIDER_ORDER]
  const configByName = {
    jimeng: config.jimeng,
    kling: config.kling,
    'doubao-seedream': config.doubaoSeedream,
    'doubao-seedance': config.doubaoSeedance,
    wanx: config.wanx,
    'tongyi-wanx': config.tongyiWanx,
  }
  const created = new Map()

  for (const name of order) {
    const factory = FACTORIES[name]
    if (factory && !created.has(name)) created.set(name, factory(configByName[name] ?? {}, deps))
  }
  // 没在 order 里列出的已知供应商追加在末尾，避免配置写错就静默少一家。
  for (const name of DEFAULT_PROVIDER_ORDER) {
    const factory = FACTORIES[name]
    if (factory && !created.has(name)) created.set(name, factory(configByName[name] ?? {}, deps))
  }

  return [...created.values()]
}
