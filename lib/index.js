/**
 * dsh-film-studio —— 手机 DSHA 上的视频制作工作台（整合式二次开发）。
 *
 * 模块进度：
 *   模块 1  FFmpeg / ffprobe 探测，验证 proot 子进程链路
 *   模块 2  供应商统一适配层 + 失败分类 + 自动切换（即梦 / 可灵）
 *   模块 3  分镜编排 + 手机窄屏工作台 + 自然语言改片
 *   模块 4  FFmpeg 合成导出（待开发）
 *   模块 5  提示词自优化（待开发）
 *
 * 设计约束：
 * - 只用 Node 内置能力；网络用原生 fetch；签名用 node:crypto；
 * - Config 用 schemastery（z.object），配置走 cordis.patch.yml / 环境变量；
 * - 每个注册的工具、每条工作台路由、每个进行中的生成任务都由 ctx.effect 管理；
 * - 分镜用工作区里的 storyboard.json 持久化，不引数据库。
 */
import z from '@deepseek-ai/schemastery'
import { resolveSettings } from './settings.js'
import { buildProbeTool } from './tools/probe-ffmpeg.js'
import { buildGenerateTool } from './tools/generate-media.js'
import { buildStoryboardTools } from './tools/storyboard.js'
import { createProviders } from './providers/index.js'
import { readProvidersFile } from './providers/file-store.js'
import { createTaskScope } from './lifecycle.js'
import { createProjectStores } from './storyboard/projects.js'
import { createExportScope } from './export/scope.js'
import { createExportProgress } from './export/progress.js'
import { buildExportTools } from './tools/export.js'
import { buildPromptTools } from './tools/prompt.js'
import { createPromptSessions } from './prompt/sessions.js'
import { registerWorkbench } from './workbench/server.js'

/** Cordis 插件名。 */
export const name = 'dsh-film-studio'

/** 只依赖工具面；工作台路由要 webServer，用可选 inject 分支取。 */
export const inject = ['tools']

/**
 * 插件配置（cordis.patch.yml 里 config 字段的形状）。
 * 所有字段都有默认值；环境变量优先级更高，见 lib/settings.js。
 */
export const Config = z.object({
  ffmpegPath: z.string().default('').description('ffmpeg 可执行文件路径；留空则用 PATH 里的 ffmpeg'),
  ffprobePath: z.string().default('').description('ffprobe 可执行文件路径；留空则用 PATH 里的 ffprobe'),
  outputDir: z.string().default('').description('导出目录；留空则用工作区下的 film-studio'),
  timeoutMs: z.number().default(20_000).description('单次外部命令超时（毫秒）'),

  workspaceDir: z.string().default('').description('分镜工作区目录；留空则用文档目录下的 film-studio'),
  storyboardPath: z.string().default('').description('storyboard.json 的完整路径；留空则用 workspaceDir/storyboard.json'),

  providers: z.object({
    order: z.array(z.string()).default(['jimeng', 'kling']).description('供应商尝试顺序'),
    jimeng: z.object({
      apiKey: z.string().default('').description('即梦/方舟 API Key；留空则读 JIMENG_API_KEY'),
      baseURL: z.string().default('').description('方舟 API 基址；留空用官方地址'),
      imageModel: z.string().default('').description('即梦图像模型名'),
      videoModel: z.string().default('').description('即梦视频模型名'),
    }).default({}),
    doubaoSeedream: z.object({
      apiKey: z.string().default('').description('豆包 Seedream 图像 Key；留空则读 DOUBAO_SEEDREAM_API_KEY 或 JIMENG_API_KEY'),
      baseURL: z.string().default('').description('方舟基址'),
      imageModel: z.string().default('').description('图像模型名'),
    }).default({}),
    doubaoSeedance: z.object({
      apiKey: z.string().default('').description('豆包 Seedance 视频 Key；留空则读 DOUBAO_SEEDANCE_API_KEY 或 JIMENG_API_KEY'),
      baseURL: z.string().default('').description('方舟基址'),
      videoModel: z.string().default('').description('视频模型名'),
    }).default({}),
    wanx: z.object({
      apiKey: z.string().default('').description('通义万相 Key；留空则读 DASHSCOPE_API_KEY'),
      baseURL: z.string().default('').description('DashScope 基址'),
      imageModel: z.string().default('').description('图像模型名'),
      videoModel: z.string().default('').description('视频模型名'),
    }).default({}),
    tongyiWanx: z.object({
      apiKey: z.string().default('').description('通义万相（Tongyi-Wanx）Key；留空则读 TONGYI_WANX_API_KEY 或 DASHSCOPE_API_KEY'),
      baseURL: z.string().default('').description('DashScope 基址'),
      imageModel: z.string().default('').description('图像模型名'),
      videoModel: z.string().default('').description('视频模型名'),
    }).default({}),
    kling: z.object({
      accessKey: z.string().default('').description('可灵 AccessKey；留空则读 KLING_ACCESS_KEY'),
      secretKey: z.string().default('').description('可灵 SecretKey；留空则读 KLING_SECRET_KEY'),
      baseURL: z.string().default('').description('可灵 API 基址；留空用官方地址'),
      imageModel: z.string().default('').description('可灵图像模型名'),
      videoModel: z.string().default('').description('可灵视频模型名'),
    }).default({}),
  }).default({}),

  polling: z.object({
    maxPolls: z.number().default(60).description('轮询上限次数'),
    initialDelayMs: z.number().default(5_000).description('首次轮询前的等待（毫秒）'),
    maxDelayMs: z.number().default(20_000).description('轮询间隔上限（毫秒）'),
  }).default({}),

  failover: z.object({
    sameProviderRetries: z.number().default(1).description('同一供应商内重试次数'),
    retryDelayMs: z.number().default(800).description('同供应商重试前的退避（毫秒）'),
  }).default({}),
})

/**
 * 构建全部工具。
 *
 * @param {ReturnType<typeof resolveSettings>} settings
 * @param {{
 *   ctx?: any,
 *   taskScope?: ReturnType<typeof createTaskScope>,
 *   deps?: {fetchImpl?: typeof fetch, requestTimeoutMs?: number},
 *   providers?: Array<any>,
 *   projects?: ReturnType<typeof createProjectStores>,
 *   scope?: ReturnType<typeof createExportScope>,
 *   sessions?: ReturnType<typeof createPromptSessions>,
 *   progress?: ReturnType<typeof createExportProgress>,
 * }} [options]
 */
export function buildTools(settings, options = {}) {
  const ctx = options.ctx ?? null
  const taskScope = options.taskScope ?? createTaskScope()
  const deps = options.deps ?? {}
  const providers = options.providers ?? createProviders(settings, deps)
  const projects = options.projects ?? createProjectStores({
    workspaceDir: settings.workspaceDir,
    explicitStoryboardPath: settings.storyboardPath,
  })
  const scope = options.scope ?? createExportScope()
  const sessions = options.sessions ?? createPromptSessions()
  const progress = options.progress ?? createExportProgress()

  return [
    buildProbeTool(settings),
    buildGenerateTool({
      name: 'film_generate_image',
      kind: 'image',
      description:
        '用统一供应商池生成图片：即梦（火山方舟，同步返回）与可灵（Kling，异步轮询）二选一，失败自动切换。' +
        '返回值里 switchTrace 显示「因为什么原因从哪家切到哪家」，attempts 显示每次尝试的结果；' +
        'ok=false 时 error.message 会写清楚是未配置密钥、限流、内容审核还是网络问题。' +
        '生成结果是一个远程图片 URL，可直接下载或交给后续导出流程。',
      settings,
      providers,
      ctx,
      taskScope,
      timeoutMs: 300_000,
    }),
    buildGenerateTool({
      name: 'film_generate_video',
      kind: 'video',
      description:
        '用统一供应商池生成视频：即梦（火山方舟 Seedance）或可灵（Kling text2video），失败自动切换。' +
        '提交后按 5s → 10s → 20s 退避轮询，默认最多 60 次；返回值包含素材 URL、轮询次数、' +
        'switchTrace（切换原因）与 attempts（每次尝试明细）。ok=false 时 error.message 给出可读原因。' +
        '适合生成分镜镜头素材；一次调用只生成一个镜头，多镜头请分多次调用。',
      settings,
      providers,
      ctx,
      taskScope,
      timeoutMs: 1_200_000,
    }),
    ...buildStoryboardTools({ projects, settings, providers, ctx, taskScope, deps }),
    ...buildExportTools({ projects, settings, scope, progress, deps }),
    ...buildPromptTools({ projects, settings, sessions }),
  ]
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  // 先按 config/env 解析出 workspaceDir，再读工作台写入的 providers.json 作为第三层。
  const baseSettings = resolveSettings(rawConfig ?? {})
  const providersFile = readProvidersFile(baseSettings.workspaceDir)
  const settings = resolveSettings(rawConfig ?? {}, process.env, providersFile)
  const taskScope = createTaskScope()

  // 插件卸载时中断所有进行中的生成任务（轮询、HTTP 请求都会随 signal 结束）。
  ctx.effect(() => () => taskScope.abortAll(), 'dsh-film-studio: 卸载时中断所有生成任务')

  const providers = createProviders(settings)
  const projects = createProjectStores({
    workspaceDir: settings.workspaceDir,
    explicitStoryboardPath: settings.storyboardPath,
  })
  const scope = createExportScope()
  const sessions = createPromptSessions()
  const progress = createExportProgress()
  // 卸载时：中断生成任务 + 强制结束 ffmpeg/ffprobe + 删除临时目录 + 清空优化会话与导出进度。
  ctx.effect(() => () => scope.cleanup(), 'dsh-film-studio: 卸载时清理导出进程与临时目录')
  ctx.effect(() => () => sessions.clear(), 'dsh-film-studio: 卸载时清空提示词优化会话')
  ctx.effect(() => () => progress.clear(), 'dsh-film-studio: 卸载时清空导出进度')
  const tools = buildTools(settings, { ctx, taskScope, providers, projects, scope, sessions, progress })

  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `dsh-film-studio: ${tool.name}`)
  }

  // 工作台页面与 API 挂在 DSH 自己的 WebServer 上；没有 webServer 时只是少一个界面，工具照常可用。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => registerWorkbench(webCtx, { projects, tools, settings, logger: webCtx.logger }),
      'dsh-film-studio: 工作台路由',
    )
  })
}
