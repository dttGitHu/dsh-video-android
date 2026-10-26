/**
 * 模块 2 的本地验收脚本（不依赖真实密钥、不联网）。
 *
 * 覆盖：
 *   1. 两个适配器接口签名一致；
 *   2. rate_limit：同供应商退避重试一次 → 切换 → switchTrace 可见；
 *   3. content_review：不重试同一家，直接跨供应商；
 *   4. auth：指定优先供应商鉴权失败 → 切回另一家；
 *   5. 密钥缺失：明确「未配置 XXX」，不是裸 fetch 报错；
 *   6. 轮询退避：5s → 10s → 20s 封顶；
 *   7. 轮询上限：达到 maxPolls 后放弃；
 *   8. 可灵 JWT 结构（HS256 / iss / exp / nbf）；
 *   9. 真实 Cordis fiber：插件卸载 → 进行中的轮询被中止。
 *
 * 用法：node scripts/verify-providers.mjs
 */
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import { resolveSettings } from '../lib/settings.js'
import { createProviders } from '../lib/providers/index.js'
import { signKlingJwt, verifyJwtShape } from '../lib/providers/kling.js'
import { pollDelayMs } from '../lib/polling.js'
import { generateWithFailover } from '../lib/scheduler.js'

let checks = 0
const failures = []

function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    failures.push(`${label}${detail === '' ? '' : ` —— ${detail}`}`)
    console.log(`  ✗ ${label}${detail === '' ? '' : ` —— ${detail}`}`)
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 记录每次 fetch 调用的 mock 工具。 */
function createMockFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body) : null,
      headers: init.headers ?? {},
    }
    calls.push(call)
    return handler(call)
  }
  return { fetchImpl, calls }
}

function settingsWith({ jimeng = {}, kling = {}, polling = {}, failover = {} } = {}) {
  return resolveSettings(
    {
      providers: { jimeng, kling },
      polling: { initialDelayMs: 0, maxDelayMs: 0, maxPolls: 6, ...polling },
      failover: { retryDelayMs: 0, sameProviderRetries: 1, ...failover },
    },
    {},
  )
}

const fastSleep = async () => {}

/* ------------------------------------------------------------------ */
console.log('\n[1/9] 适配器接口签名')
/* ------------------------------------------------------------------ */

const baseSettings = settingsWith({
  jimeng: { apiKey: 'jm-test-key' },
  kling: { accessKey: 'kling-ak', secretKey: 'kling-sk' },
})
const providers = createProviders(baseSettings, { fetchImpl: async () => jsonResponse({}) })
const jimeng = providers.find((provider) => provider.name === 'jimeng')
const kling = providers.find((provider) => provider.name === 'kling')

for (const provider of [jimeng, kling]) {
  check(`${provider.name} 暴露 submit/poll/classifyError/isConfigured`,
    ['submit', 'poll', 'classifyError', 'isConfigured'].every((method) => typeof provider[method] === 'function'))
  check(`${provider.name} 支持 image/video`, provider.supports.includes('image') && provider.supports.includes('video'))
}
check('两家供应商都已配置', jimeng.isConfigured().ok === true && kling.isConfigured().ok === true)

/* ------------------------------------------------------------------ */
console.log('\n[2/9] rate_limit：同供应商重试 → 切换可灵')
/* ------------------------------------------------------------------ */

const rateLimitScenario = createMockFetch((call) => {
  if (call.url.includes('ark.cn-beijing') && call.method === 'POST') {
    return jsonResponse({ error: { code: 'RateLimitExceeded', message: 'rate limit exceeded' } }, 429)
  }
  if (call.url.includes('klingai.com') && call.url.endsWith('/v1/videos/text2video') && call.method === 'POST') {
    return jsonResponse({ code: 0, data: { task_id: 'kling-task-1', task_status: 'submitted' } })
  }
  if (call.url.includes('/v1/videos/text2video/kling-task-1')) {
    return jsonResponse({ code: 0, data: { task_status: 'succeed', task_result: { videos: [{ url: 'https://cdn.example/kling.mp4' }] } } })
  }
  return jsonResponse({ message: `未预期的请求 ${call.method} ${call.url}` }, 500)
})

const rateLimitProviders = createProviders(baseSettings, { fetchImpl: rateLimitScenario.fetchImpl })
const rateLimitResult = await generateWithFailover({
  kind: 'video',
  prompt: '一只猫在窗台上打盹',
  params: { duration: 5 },
  settings: baseSettings,
  providers: rateLimitProviders,
  sleepImpl: fastSleep,
})

check('最终成功', rateLimitResult.ok === true, rateLimitResult.error?.message)
check('切到可灵', rateLimitResult.provider === 'kling', String(rateLimitResult.provider))
check('素材 URL 正确', rateLimitResult.url === 'https://cdn.example/kling.mp4', String(rateLimitResult.url))
check('switchTrace 有一条切换记录', rateLimitResult.switchTrace.length === 1, JSON.stringify(rateLimitResult.switchTrace))
const trace = rateLimitResult.switchTrace[0]
check('switchTrace 结构符合约定',
  trace?.from === 'jimeng' && trace?.to === 'kling' && trace?.reason === 'rate_limit' && trace?.attempt === 2,
  JSON.stringify(trace))
check('即梦被尝试了 2 次（同供应商重试一次）',
  rateLimitScenario.calls.filter((call) => call.url.includes('ark.cn-beijing')).length === 2,
  String(rateLimitScenario.calls.filter((call) => call.url.includes('ark.cn-beijing')).length))
const effectiveAttempts = rateLimitResult.attempts.filter((item) => item.outcome !== 'skipped')
check('attempts 记录 jimeng×2 + kling×1',
  effectiveAttempts.length === 3 &&
  effectiveAttempts.filter((item) => item.provider === 'jimeng' && item.outcome === 'failed').length === 2,
  JSON.stringify(effectiveAttempts.map((item) => `${item.provider}:${item.outcome}`)))

/* ------------------------------------------------------------------ */
console.log('\n[3/9] content_review：不重试同一家，直接跨供应商')
/* ------------------------------------------------------------------ */

const reviewScenario = createMockFetch((call) => {
  if (call.url.includes('ark.cn-beijing') && call.method === 'POST') {
    return jsonResponse({ error: { code: 'SensitiveContentDetected', message: '内容审核不通过：敏感内容' } }, 400)
  }
  if (call.url.includes('klingai.com') && call.method === 'POST') {
    return jsonResponse({ code: 0, data: { task_id: 'kling-task-2', task_status: 'submitted' } })
  }
  return jsonResponse({ code: 0, data: { task_status: 'succeed', task_result: { videos: [{ url: 'https://cdn.example/review-ok.mp4' }] } } })
})

const reviewResult = await generateWithFailover({
  kind: 'video',
  prompt: '测试审核',
  params: {},
  settings: baseSettings,
  providers: createProviders(baseSettings, { fetchImpl: reviewScenario.fetchImpl }),
  sleepImpl: fastSleep,
})

check('审核失败后切到可灵并成功', reviewResult.ok === true && reviewResult.provider === 'kling', reviewResult.error?.message)
check('即梦只提交了 1 次（没有同家重试）',
  reviewScenario.calls.filter((call) => call.url.includes('ark.cn-beijing')).length === 1,
  String(reviewScenario.calls.filter((call) => call.url.includes('ark.cn-beijing')).length))
check('switchTrace 原因是 content_review', reviewResult.switchTrace[0]?.reason === 'content_review', reviewResult.switchTrace[0]?.reason)

/* ------------------------------------------------------------------ */
console.log('\n[4/9] auth：优先供应商鉴权失败 → 切回另一家')
/* ------------------------------------------------------------------ */

const authScenario = createMockFetch((call) => {
  if (call.url.includes('klingai.com') && call.method === 'POST') {
    return jsonResponse({ code: 1200, message: 'authentication failed' }, 401)
  }
  if (call.url.includes('ark.cn-beijing') && call.method === 'POST') {
    return jsonResponse({ id: 'jimeng-task-1', status: 'queued' })
  }
  if (call.url.includes('/contents/generations/tasks/jimeng-task-1')) {
    return jsonResponse({ id: 'jimeng-task-1', status: 'succeeded', content: { video_url: 'https://cdn.example/jimeng.mp4' } })
  }
  return jsonResponse({ message: 'unexpected' }, 500)
})

const authResult = await generateWithFailover({
  kind: 'video',
  prompt: '测试鉴权切换',
  params: { provider: 'kling' },
  settings: baseSettings,
  providers: createProviders(baseSettings, { fetchImpl: authScenario.fetchImpl }),
  sleepImpl: fastSleep,
})

check('鉴权失败后切到即梦并成功', authResult.ok === true && authResult.provider === 'jimeng', authResult.error?.message)
check('switchTrace from=kling to=jimeng reason=auth',
  authResult.switchTrace[0]?.from === 'kling' && authResult.switchTrace[0]?.to === 'jimeng' && authResult.switchTrace[0]?.reason === 'auth',
  JSON.stringify(authResult.switchTrace[0]))

/* ------------------------------------------------------------------ */
console.log('\n[5/9] 密钥缺失：可读错误，不发请求')
/* ------------------------------------------------------------------ */

const emptySettings = resolveSettings({}, {})
let networkCalled = false
const emptyProviders = createProviders(emptySettings, {
  fetchImpl: async () => {
    networkCalled = true
    return jsonResponse({})
  },
})
const emptyResult = await generateWithFailover({
  kind: 'image',
  prompt: '测试',
  params: {},
  settings: emptySettings,
  providers: emptyProviders,
  sleepImpl: fastSleep,
})
check('返回失败而不是抛异常', emptyResult.ok === false)
check('错误分类为 auth', emptyResult.error?.kind === 'auth', emptyResult.error?.kind)
check('错误信息点名缺失的环境变量',
  /未配置/.test(emptyResult.error?.message ?? '') &&
  /JIMENG_API_KEY/.test(emptyResult.error?.message ?? '') &&
  /KLING_ACCESS_KEY/.test(emptyResult.error?.message ?? ''),
  emptyResult.error?.message)
check('没有对未配置的供应商发请求', networkCalled === false)
check('attempts 里两家都是 skipped', emptyResult.attempts.every((item) => item.outcome === 'skipped'))

/* ------------------------------------------------------------------ */
console.log('\n[6/9] 轮询退避序列')
/* ------------------------------------------------------------------ */

check('默认节奏：10s / 20s / 20s 封顶',
  pollDelayMs(1) === 10_000 && pollDelayMs(2) === 20_000 && pollDelayMs(3) === 20_000 && pollDelayMs(4) === 20_000,
  [1, 2, 3, 4].map((n) => pollDelayMs(n)).join(','))

const waits = []
const slowScenario = createMockFetch((call) => {
  if (call.url.includes('ark.cn-beijing') && call.method === 'POST') return jsonResponse({ id: 'slow-1', status: 'queued' })
  if (call.url.includes('ark.cn-beijing')) return jsonResponse({ id: 'slow-1', status: 'running' })
  return jsonResponse({ message: '不应该轮到可灵' }, 500)
})
const slowSettings = settingsWith({
  jimeng: { apiKey: 'x' },
  polling: { initialDelayMs: 5_000, maxDelayMs: 20_000, maxPolls: 3 },
  failover: { sameProviderRetries: 0, retryDelayMs: 0 },
})
const slowProviders = createProviders(slowSettings, { fetchImpl: slowScenario.fetchImpl })
const slowResult = await generateWithFailover({
  kind: 'video',
  prompt: '轮询节奏',
  params: {},
  settings: slowSettings,
  providers: slowProviders,
  sleepImpl: async (ms) => {
    waits.push(ms)
  },
})

check('达到上限后失败', slowResult.ok === false)
check('轮询上限生效（3 次）', /3 次/.test(slowResult.error?.message ?? ''), slowResult.error?.message)
check('等待序列 = [5000, 10000, 20000]', JSON.stringify(waits) === JSON.stringify([5_000, 10_000, 20_000]), JSON.stringify(waits))
check('只走了即梦一条供应商链路', slowScenario.calls.every((call) => call.url.includes('ark.cn-beijing')))

/* ------------------------------------------------------------------ */
console.log('\n[7/9] 可灵 JWT')
/* ------------------------------------------------------------------ */

const jwt = signKlingJwt('test-ak', 'test-sk', 1_700_000_000)
const jwtShape = verifyJwtShape(jwt)
check('三段式 + HS256', jwtShape.ok === true, jwtShape.reason)
check('iss 是 AccessKey', jwtShape.ok && jwtShape.payload.iss === 'test-ak')
check('exp = now + 1800', jwtShape.ok && jwtShape.payload.exp === 1_700_001_800, String(jwtShape.payload?.exp))
check('nbf = now - 5', jwtShape.ok && jwtShape.payload.nbf === 1_699_999_995, String(jwtShape.payload?.nbf))

/* ------------------------------------------------------------------ */
console.log('\n[8/9] 插件加载与工具注册')
/* ------------------------------------------------------------------ */

const registry = new Map()
const ctx = new Context()
ctx.provide('tools', {
  register(tool) {
    registry.set(tool.name, tool)
    return () => registry.delete(tool.name)
  },
})

// 不传密钥：让真实 fiber 里的工具走「未配置」路径，验证端到端返回值形状。
const fiber = ctx.plugin(plugin, { workspaceDir: '/tmp/film-verify-providers-empty' })
await fiber.await()

check('注册了 13 个工具', registry.size === 13, [...registry.keys()].join(','))
check('注册了生成工具', registry.has('film_generate_image') && registry.has('film_generate_video'))

const imageTool = registry.get('film_generate_image')
check('图片工具带 timeoutMs', typeof imageTool?.timeoutMs === 'number')
check('视频工具 timeoutMs 更长', (registry.get('film_generate_video')?.timeoutMs ?? 0) > (imageTool?.timeoutMs ?? 0))

const imageCall = await imageTool.execute({ prompt: '真实 fiber 中的一张测试图' }, { signal: new AbortController().signal })
check('真实 fiber 调用：返回未配置错误', imageCall?.ok === false && imageCall?.error?.kind === 'auth', imageCall?.error?.message)
check('返回值形状符合 schema（数组字段齐全）',
  Array.isArray(imageCall?.switchTrace) && Array.isArray(imageCall?.attempts) && imageCall?.kind === 'image')
check('render 输出点名缺失的密钥', /JIMENG_API_KEY/.test(imageTool.output.render({ prompt: 'x' }, imageCall)?.[0]?.text ?? ''))

/* ------------------------------------------------------------------ */
console.log('\n[9/9] 卸载中断：进行中的轮询被 ctx.effect 清理')
/* ------------------------------------------------------------------ */

const pendingCalls = []
const stuckScenario = createMockFetch((call) => {
  pendingCalls.push(call.url)
  if (call.url.includes('ark.cn-beijing') && call.method === 'POST') return jsonResponse({ id: 'stuck-jimeng', status: 'queued' })
  if (call.url.includes('ark.cn-beijing')) return jsonResponse({ id: 'stuck-jimeng', status: 'running' })
  return jsonResponse({ message: '不应该轮到可灵' }, 500)
})

const videoTool = registry.get('film_generate_video')
// 换成会卡住的供应商（工具内部已经按 apply 时的配置建好 providers，
// 这里直接调用 scheduler 来验证「fiber 卸载 → signal abort」这条链路）。
const stuckSettings = settingsWith({
  jimeng: { apiKey: 'x' },
  kling: { accessKey: 'x', secretKey: 'y' },
  polling: { initialDelayMs: 20, maxDelayMs: 40, maxPolls: 200 },
})
const stuckProviders = createProviders(stuckSettings, { fetchImpl: stuckScenario.fetchImpl })

const { createTaskScope, trackCall } = await import('../lib/lifecycle.js')
const outerController = new AbortController()
const scope = createTaskScope()
const toolLabel = 'verify: stuck polling'

// 用插件 fiber 的 ctx 登记（与工具执行时同一条路径）
const release = trackCall(fiber.ctx, scope, {
  controller: outerController,
  outerSignal: new AbortController().signal,
  label: toolLabel,
})

const stuckPromise = generateWithFailover({
  kind: 'video',
  prompt: '卡住的轮询',
  params: {},
  settings: stuckSettings,
  providers: stuckProviders,
  signal: outerController.signal,
  sleepImpl: (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener?.('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  }),
})

await new Promise((resolve) => setTimeout(resolve, 60))
await fiber.dispose()
const stuckResult = await stuckPromise
check('卸载后轮询被中断并返回取消', stuckResult.ok === false && /取消/.test(stuckResult.error?.message ?? ''), stuckResult.error?.message)
check('任务作用域已清空', scope.size() === 0, String(scope.size()))
release()
check('工具仍注册在插件里（工具定义未被卸载影响）', typeof videoTool?.execute === 'function')

await ctx.fiber.dispose()
check('卸载后注册表为空', registry.size === 0, [...registry.keys()].join(','))

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
console.log('\n[附加] 供应商池扩展：Seedream / Seedance / Wanx / Tongyi-Wanx')
/* ------------------------------------------------------------------ */

const poolSettings = resolveSettings(
  {
    providers: {
      jimeng: { apiKey: 'jm-key' },
      doubaoSeedream: { apiKey: 'seedream-key' },
      doubaoSeedance: { apiKey: 'seedance-key' },
      wanx: { apiKey: 'wanx-key' },
      tongyiWanx: { apiKey: 'tongyi-key' },
      kling: { accessKey: 'kling-ak', secretKey: 'kling-sk' },
    },
    polling: { initialDelayMs: 0, maxDelayMs: 0, maxPolls: 3 },
    failover: { retryDelayMs: 0, sameProviderRetries: 0 },
  },
  {},
)
const poolProviders = createProviders(poolSettings, { fetchImpl: async () => jsonResponse({}) })
check('池内 6 家供应商', poolProviders.length === 6, poolProviders.map((p) => p.name).join(','))
check('Seedream 仅支持图像', poolProviders.find((p) => p.name === 'doubao-seedream')?.supports.join(',') === 'image')
check('Seedance 仅支持视频', poolProviders.find((p) => p.name === 'doubao-seedance')?.supports.join(',') === 'video')
check('Wanx 与 Tongyi-Wanx 均支持图像/视频',
  poolProviders.find((p) => p.name === 'wanx')?.supports.join(',') === 'image,video' &&
  poolProviders.find((p) => p.name === 'tongyi-wanx')?.supports.join(',') === 'image,video')
check('六家全部已配置', poolProviders.every((p) => p.isConfigured().ok === true))

const poolMock = createMockFetch((call) => {
  if (call.url.includes('ark.cn-beijing') && call.url.endsWith('/images/generations')) {
    if (String(call.headers?.authorization ?? '').includes('Bearer jm-key')) {
      return jsonResponse({ error: { code: 'RateLimitExceeded', message: 'rate limit' } }, 429)
    }
    return jsonResponse({ data: [{ url: 'https://cdn.example/seedream.png' }] })
  }
  if (call.url.includes('dashscope.aliyuncs.com') && call.url.includes('/text2image/')) {
    return jsonResponse({ output: { task_id: 'wanx-task-1' } })
  }
  if (call.url.includes('/tasks/wanx-task-1')) {
    return jsonResponse({ output: { task_status: 'SUCCEEDED', results: [{ url: 'https://cdn.example/wanx.png' }] } })
  }
  return jsonResponse({ message: 'unexpected' }, 500)
})

const poolFetch = createProviders(poolSettings, { fetchImpl: poolMock.fetchImpl })
const poolResult = await generateWithFailover({
  kind: 'image',
  prompt: '一只橘猫',
  params: {},
  settings: poolSettings,
  providers: poolFetch,
  sleepImpl: fastSleep,
})
check('图像任务从即梦切到 Seedream', poolResult.ok === true && poolResult.provider === 'doubao-seedream', poolResult.error?.message)
check('Seedance 因类型不符被跳过',
  poolResult.attempts.some((item) => item.provider === 'doubao-seedance' && item.outcome === 'skipped' && /不支持生成 image/.test(item.message ?? '')))
check('switchTrace 记录 jimeng → doubao-seedream',
  poolResult.switchTrace[0]?.from === 'jimeng' && poolResult.switchTrace[0]?.to === 'doubao-seedream' && poolResult.switchTrace[0]?.reason === 'rate_limit',
  JSON.stringify(poolResult.switchTrace))

const wanxResult = await generateWithFailover({
  kind: 'image',
  prompt: '一只橘猫',
  params: { provider: 'wanx' },
  settings: poolSettings,
  providers: createProviders(poolSettings, { fetchImpl: poolMock.fetchImpl }),
  sleepImpl: fastSleep,
})
check('Wanx 图像任务成功', wanxResult.ok === true && wanxResult.provider === 'wanx' && wanxResult.url === 'https://cdn.example/wanx.png', wanxResult.error?.message)

const tongyiResult = await generateWithFailover({
  kind: 'image',
  prompt: '一只橘猫',
  params: { provider: 'tongyi-wanx' },
  settings: poolSettings,
  providers: createProviders(poolSettings, { fetchImpl: poolMock.fetchImpl }),
  sleepImpl: fastSleep,
})
check('Tongyi-Wanx 图像任务成功', tongyiResult.ok === true && tongyiResult.provider === 'tongyi-wanx', tongyiResult.error?.message)

console.log(`\n结果：${checks - failures.length}/${checks} 项通过`)
if (failures.length > 0) {
  console.log('\n失败项：')
  for (const item of failures) console.log(`  - ${item}`)
  process.exitCode = 1
} else {
  console.log('模块 2 验证通过：统一接口 → 五类分类 → 同家退避重试 → 结构化切换 → 卸载中断。\n')
}
