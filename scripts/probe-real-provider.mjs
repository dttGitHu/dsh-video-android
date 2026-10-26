/**
 * 真实即梦（火山方舟）链路探针：用真实 API Key 确认请求格式、任务提交、轮询与 URL 结构。
 *
 * 用法：
 *   JIMENG_API_KEY=ark-xxx node scripts/probe-real-provider.mjs
 *   JIMENG_API_KEY=ark-xxx node scripts/probe-real-provider.mjs --skip-video
 *   JIMENG_API_KEY=ark-xxx node scripts/probe-real-provider.mjs \
 *       --model-image doubao-seedream-4-0-20260415 \
 *       --model-video doubao-seedance-2-0-260128 \
 *       --duration 5 --resolution 720p --max-polls 20
 *
 * 设计：
 * - 密钥只从环境变量读，绝不打印、不落盘；
 * - 每一步打印 HTTP 状态、耗时与响应结构（URL 只展示 host/path/签名参数的有无）；
 * - 失败时给出方舟错误码与可操作建议（ModelNotOpen → 去控制台开通）。
 */
import { writeFileSync } from 'node:fs'

const ARK_BASE = process.env.JIMENG_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3'
const API_KEY = String(process.env.JIMENG_API_KEY ?? '').trim()

function parseArgs(argv) {
  const options = {
    modelImage: 'doubao-seedream-4-0-20260415',
    modelVideo: 'doubao-seedance-2-0-260128',
    duration: 5,
    resolution: '720p',
    ratio: '16:9',
    maxPolls: 20,
    skipImage: false,
    skipVideo: false,
    out: '',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--model-image') options.modelImage = next()
    else if (arg === '--model-video') options.modelVideo = next()
    else if (arg === '--duration') options.duration = Number(next())
    else if (arg === '--resolution') options.resolution = next()
    else if (arg === '--ratio') options.ratio = next()
    else if (arg === '--max-polls') options.maxPolls = Number(next())
    else if (arg === '--skip-image') options.skipImage = true
    else if (arg === '--skip-video') options.skipVideo = true
    else if (arg === '--out') options.out = next()
    else if (arg === '-h' || arg === '--help') {
      console.log('见文件头注释里的用法。')
      process.exit(0)
    } else throw new Error(`未知参数：${arg}`)
  }
  return options
}

function log(line = '') {
  console.log(line)
}

/** 只解析 URL 结构，不打印签名。 */
function describeUrl(url) {
  if (typeof url !== 'string' || url === '') return { valid: false }
  try {
    const parsed = new URL(url)
    const signedKeys = [...parsed.searchParams.keys()].filter((key) => /^(x-tos|signature|expires|accesskeyid|sign)/i.test(key))
    return {
      valid: true,
      protocol: parsed.protocol.replace(':', ''),
      host: parsed.host,
      path: parsed.pathname,
      queryKeys: [...parsed.searchParams.keys()],
      looksSigned: signedKeys.length > 0,
      signedKeys,
      ttlSeconds: parsed.searchParams.get('X-Tos-Expires') ?? null,
    }
  } catch {
    return { valid: false, reason: '无法解析为 URL' }
  }
}

async function call(method, path, body, timeoutMs = 120_000) {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  try {
    const response = await fetch(`${ARK_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    let json = null
    try {
      json = text === '' ? null : JSON.parse(text)
    } catch {
      json = null
    }
    return {
      status: response.status,
      ok: response.ok,
      ms: Date.now() - startedAt,
      json,
      text: text.slice(0, 800),
    }
  } finally {
    clearTimeout(timer)
  }
}

function explainError(json, model) {
  const code = json?.error?.code ?? json?.code ?? null
  const message = json?.error?.message ?? json?.message ?? ''
  const hints = []
  if (code === 'ModelNotOpen') {
    hints.push(`模型 ${model} 未在该账号开通：去火山方舟控制台「开通管理」里开通 Seedream（图像）/ Seedance（视频）。`)
  } else if (code === 'InvalidEndpointOrModel.NotFound') {
    hints.push(`模型 ID ${model} 在当前区域不存在：确认区域（当前 ${ARK_BASE}）与该账号可用的模型 ID。`)
  } else if (/authentication|unauthorized/i.test(`${code} ${message}`)) {
    hints.push('鉴权失败：检查 JIMENG_API_KEY 是否完整、是否属于当前账号。')
  } else if (/sensitive|review/i.test(`${code} ${message}`)) {
    hints.push('内容审核未通过：换一版提示词再试。')
  }
  return { code, message, hints }
}

async function listMediaModels() {
  const result = await call('GET', '/models', undefined, 30_000)
  if (!result.ok) return { error: explainError(result.json, '/models') }
  const models = Array.isArray(result.json?.data) ? result.json.data : []
  const media = models
    .filter((item) => /seedream|seedance|seededit/i.test(String(item.id)))
    .map((item) => ({ id: item.id, status: item.status ?? null }))
  return { total: models.length, media }
}

async function probeImage(options) {
  log('\n[图像] POST /images/generations（同步）')
  const body = {
    model: options.modelImage,
    prompt: '一只橘猫坐在窗台上晒太阳，写实摄影，柔和体积光，浅景深',
    response_format: 'url',
    size: '1024x1024',
  }
  log(`  请求体: ${JSON.stringify(body)}`)
  const result = await call('POST', '/images/generations', body, 180_000)
  log(`  HTTP ${result.status} · ${result.ms}ms`)
  if (!result.ok) {
    const info = explainError(result.json, options.modelImage)
    log(`  错误: ${info.code} —— ${info.message}`)
    for (const hint of info.hints) log(`  建议: ${hint}`)
    return { ok: false, httpStatus: result.status, ...info }
  }
  const item = result.json?.data?.[0]
  const url = item?.url ?? null
  log(`  响应字段: ${Object.keys(result.json ?? {}).join(', ')}`)
  log(`  data[0] 字段: ${Object.keys(item ?? {}).join(', ')}`)
  const urlShape = describeUrl(url)
  log(`  URL: ${urlShape.valid ? `${urlShape.protocol}://${urlShape.host}${urlShape.path}` : '缺失'}`)
  log(`  签名参数: ${urlShape.queryKeys?.length ? urlShape.queryKeys.join(', ') : '（无）'}`)
  return { ok: true, httpStatus: result.status, url, urlShape, raw: result.json }
}

async function probeVideo(options) {
  log('\n[视频] POST /contents/generations/tasks（异步）')
  const text = `一只橘猫在窗台上打盹，午后阳光，镜头缓慢推近 --resolution ${options.resolution} --duration ${options.duration} --ratio ${options.ratio}`
  const body = { model: options.modelVideo, content: [{ type: 'text', text }] }
  log(`  请求体: ${JSON.stringify(body)}`)
  const submitted = await call('POST', '/contents/generations/tasks', body, 120_000)
  log(`  HTTP ${submitted.status} · ${submitted.ms}ms`)
  if (!submitted.ok) {
    const info = explainError(submitted.json, options.modelVideo)
    log(`  错误: ${info.code} —— ${info.message}`)
    for (const hint of info.hints) log(`  建议: ${hint}`)
    return { ok: false, httpStatus: submitted.status, ...info }
  }
  const taskId = submitted.json?.id ?? null
  log(`  响应字段: ${Object.keys(submitted.json ?? {}).join(', ')}`)
  log(`  task id: ${taskId}`)
  if (!taskId) return { ok: false, error: '响应里没有任务 id', raw: submitted.json }

  const delays = [5_000, 10_000, 20_000]
  const history = []
  for (let poll = 1; poll <= options.maxPolls; poll += 1) {
    const delay = delays[Math.min(poll - 1, delays.length - 1)]
    log(`  等待 ${delay / 1000}s 后第 ${poll} 次查询…`)
    await new Promise((done) => setTimeout(done, delay))
    const polled = await call('GET', `/contents/generations/tasks/${encodeURIComponent(taskId)}`, undefined, 60_000)
    const status = polled.json?.status ?? '?'
    history.push({ poll, httpStatus: polled.status, status })
    log(`    HTTP ${polled.status} · status=${status}`)
    if (status === 'succeeded') {
      const url = polled.json?.content?.video_url ?? polled.json?.video_url ?? null
      const urlShape = describeUrl(url)
      log(`  响应字段: ${Object.keys(polled.json ?? {}).join(', ')}`)
      log(`  URL: ${urlShape.valid ? `${urlShape.protocol}://${urlShape.host}${urlShape.path}` : '缺失'}`)
      log(`  签名参数: ${urlShape.queryKeys?.length ? urlShape.queryKeys.join(', ') : '（无）'}`)
      return { ok: true, taskId, polls: poll, history, url, urlShape, raw: polled.json }
    }
    if (status === 'failed' || status === 'cancelled') {
      const info = explainError(polled.json?.error ? { error: polled.json.error } : polled.json, options.modelVideo)
      log(`  任务失败: ${info.code} —— ${info.message}`)
      return { ok: false, taskId, polls: poll, history, ...info, raw: polled.json }
    }
  }
  log(`  达到轮询上限 ${options.maxPolls} 次，任务仍未完成。`)
  return { ok: false, taskId, polls: options.maxPolls, history, error: '轮询超时' }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  log(`方舟基址: ${ARK_BASE}`)
  log(`密钥: ${API_KEY === '' ? '未设置 JIMENG_API_KEY' : `已设置（长度 ${API_KEY.length}）`}`)
  if (API_KEY === '') {
    console.error('请先设置环境变量 JIMENG_API_KEY。')
    process.exitCode = 2
    return
  }

  log('\n[模型目录] GET /models')
  const media = await listMediaModels()
  if (media.error) {
    log(`  失败: ${media.error.code} —— ${media.error.message}`)
  } else {
    log(`  目录共 ${media.total} 个模型，其中图像/视频：`)
    for (const item of media.media) log(`    ${item.id} (${item.status ?? 'Available'})`)
  }

  const report = { base: ARK_BASE, image: null, video: null, models: media }
  if (!options.skipImage) report.image = await probeImage(options)
  if (!options.skipVideo && (report.image === null || report.image.ok)) {
    report.video = await probeVideo(options)
  } else if (!options.skipVideo) {
    log('\n[视频] 图像步骤失败，跳过视频探测。')
  }

  const outPath = options.out || '/tmp/film-studio-probe-report.json'
  writeFileSync(outPath, JSON.stringify(report, null, 2), { mode: 0o600 })
  log(`\n报告已写入 ${outPath}`)

  const ok = (report.image === null || report.image.ok) && (report.video === null || report.video.ok)
  if (!ok) {
    log('\n结论：链路未跑通。若错误是 ModelNotOpen，请在火山方舟控制台开通对应模型后重试。')
    process.exitCode = 1
  } else {
    log('\n结论：真实 API 链路跑通（请求 → 任务 → 轮询 → 素材 URL）。')
  }
}

main().catch((error) => {
  console.error('探针异常：', error?.message ?? error)
  process.exitCode = 1
})
