/**
 * 模块 3 的工具：分镜编排 + 自然语言改片（按 projectId 分区）。
 *
 *   film_create_storyboard  从对话生成分镜（写入 projects/<id>/storyboard.json）
 *   film_list_scenes        读回当前项目分镜
 *   film_update_scene       改某个镜头的文案/画面/参数/生成类型
 *   film_regenerate_scene   复用模块 2 调度器重生成，并把素材落到 assets/
 *
 * 所有写入都经 store 的串行队列与原子写；工作台页面走同一份文件。
 * @module tools/storyboard
 */
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { generateWithFailover } from '../scheduler.js'
import { trackCall } from '../lifecycle.js'
import { downloadToFile, guessExtension } from '../media/download.js'
import { sanitizeProjectId } from '../settings.js'
import {
  appendScenes,
  createStoryboardFromInput,
  emptyStoryboard,
  markGeneration,
  normalizeStoryboard,
  updateScene,
} from '../storyboard/model.js'

const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] }

const SWITCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
    reason: { type: 'string', required: true },
    attempt: { type: 'integer', required: true },
    message: { ...NULLABLE_STRING, required: true },
  },
}

const ASSETS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    image: { ...NULLABLE_STRING, required: true },
    video: { ...NULLABLE_STRING, required: true },
  },
}

const PARAMS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['image', 'video'], required: true },
    aspectRatio: { ...NULLABLE_STRING, required: true },
    duration: { type: 'integer', required: true },
    provider: { ...NULLABLE_STRING, required: true },
    model: { ...NULLABLE_STRING, required: true },
    negativePrompt: { ...NULLABLE_STRING, required: true },
  },
}

const SCENE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    index: { type: 'integer', required: true },
    narration: { type: 'string', required: true },
    visualPrompt: { type: 'string', required: true },
    imageUrl: { ...NULLABLE_STRING, required: true },
    videoUrl: { ...NULLABLE_STRING, required: true },
    status: { type: 'string', enum: ['draft', 'generating', 'done', 'failed'], required: true },
    assets: { ...ASSETS_SCHEMA, required: true },
    params: { ...PARAMS_SCHEMA, required: true },
    switchTrace: { type: 'array', items: SWITCH_SCHEMA, required: true },
    error: { ...NULLABLE_STRING, required: true },
    lastGeneratedAt: { ...NULLABLE_STRING, required: true },
  },
}

const STORYBOARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    version: { type: 'integer', required: true },
    title: { type: 'string', required: true },
    updatedAt: { ...NULLABLE_STRING, required: true },
    scenes: { type: 'array', items: SCENE_SCHEMA, required: true },
  },
}

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

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    projectId: { type: 'string', required: true },
    storyboardPath: { type: 'string', required: true },
    storyboard: { ...STORYBOARD_SCHEMA, required: true },
    scene: { oneOf: [SCENE_SCHEMA, { type: 'null' }], required: true },
    error: { ...ERROR_SCHEMA, required: true },
  },
}

const GENERATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    provider: { ...NULLABLE_STRING, required: true },
    url: { ...NULLABLE_STRING, required: true },
    localAsset: { ...NULLABLE_STRING, required: true },
    warning: { ...NULLABLE_STRING, required: true },
    polls: { type: 'integer', required: true },
    elapsedMs: { type: 'integer', required: true },
    switchTrace: { type: 'array', items: SWITCH_SCHEMA, required: true },
    error: { ...ERROR_SCHEMA, required: true },
  },
}

const REGENERATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    projectId: { type: 'string', required: true },
    storyboardPath: { type: 'string', required: true },
    scene: { oneOf: [SCENE_SCHEMA, { type: 'null' }], required: true },
    generation: { ...GENERATION_SCHEMA, required: true },
    error: { ...ERROR_SCHEMA, required: true },
  },
}

const SCENE_INPUT_PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['image', 'video'] },
    aspectRatio: { type: 'string' },
    duration: { type: 'integer' },
    provider: { type: 'string', enum: ['jimeng', 'doubao-seedream', 'doubao-seedance', 'wanx', 'tongyi-wanx', 'kling'] },
    model: { type: 'string' },
    negativePrompt: { type: 'string' },
  },
}

function renderSummary(label, value) {
  const lines = []
  if (value.ok) lines.push(`✓ ${label}：共 ${value.storyboard.scenes.length} 个镜头（${value.storyboard.title}）`)
  else lines.push(`✗ ${label}${value.error ? `：${value.error.message}` : ''}`)
  lines.push(`项目：${value.projectId} · 文件：${value.storyboardPath}`)
  if (value.scene) {
    lines.push(`当前镜头：${value.scene.id} · ${value.scene.status} · ${value.scene.narration.slice(0, 40)}`)
  }
  for (const scene of value.storyboard.scenes.slice(0, 12)) {
    const flag = scene.status === 'done' ? '✓' : scene.status === 'failed' ? '✗' : '·'
    lines.push(`  ${flag} ${scene.id}｜${scene.narration.slice(0, 36)}`)
  }
  if (value.storyboard.scenes.length > 12) lines.push(`  … 还有 ${value.storyboard.scenes.length - 12} 个镜头`)
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderRegenerate(value) {
  const lines = []
  const generation = value.generation
  if (generation.ok) {
    lines.push(`✓ ${value.scene?.id ?? ''} 生成成功（${generation.provider ?? ''}，${(generation.elapsedMs / 1000).toFixed(1)}s，轮询 ${generation.polls} 次）`)
    if (generation.url) lines.push(`远程素材：${generation.url}`)
    if (generation.localAsset) lines.push(`本地素材：${generation.localAsset}`)
    if (generation.warning) lines.push(`注意：${generation.warning}`)
  } else {
    lines.push(`✗ ${value.scene?.id ?? ''} 生成失败：${generation.error?.kind ?? 'unknown'} —— ${generation.error?.message ?? ''}`)
  }
  if (generation.switchTrace.length > 0) {
    lines.push('切换记录：')
    for (const item of generation.switchTrace) {
      lines.push(`  · ${item.from} → ${item.to}（${item.reason}，第 ${item.attempt} 次尝试）`)
    }
  }
  lines.push(`项目：${value.projectId} · 文件：${value.storyboardPath}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

function compact(input) {
  const output = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value
  }
  return output
}

/**
 * 构建分镜工具。
 * @param {{
 *   projects: ReturnType<import('../storyboard/projects.js').createProjectStores>,
 *   settings: object,
 *   providers: Array<any>,
 *   ctx: any,
 *   taskScope: {track: Function, abortAll: Function},
 *   deps?: {fetchImpl?: typeof fetch, downloadTimeoutMs?: number, maxAssetBytes?: number},
 * }} input
 */
export function buildStoryboardTools(input) {
  const { projects, settings, providers, ctx, taskScope, deps = {} } = input

  const projectOf = (value) => sanitizeProjectId(value ?? 'default')

  function result(projectId, store, storyboard, scene, error = null) {
    return {
      ok: error === null,
      projectId,
      storyboardPath: store.filePath,
      storyboard: normalizeStoryboard(storyboard),
      scene: scene ?? null,
      error,
    }
  }

  /** 把生成结果下载到项目 assets/；失败只返回 warning，不让整次生成失败。 */
  async function persistAsset(projectId, paths, sceneId, kind, url, signal) {
    const extension = guessExtension(url) || (kind === 'image' ? '.png' : '.mp4')
    const filename = `${sceneId}${extension}`
    const destination = join(paths.assetsDir, filename)
    try {
      const downloaded = await downloadToFile({
        url,
        destination,
        signal,
        timeoutMs: deps.downloadTimeoutMs ?? 180_000,
        maxBytes: deps.maxAssetBytes ?? 200 * 1024 * 1024,
        fetchImpl: deps.fetchImpl ?? globalThis.fetch,
      })
      return { relative: `assets/${filename}`, bytes: downloaded.bytes, warning: null }
    } catch (error) {
      return { relative: null, bytes: 0, warning: `素材已生成，但下载到本地失败：${String(error?.message ?? error)}` }
    }
  }

  return [
    defineTool({
      name: 'film_create_storyboard',
      description:
        '从当前对话生成分镜列表并写入项目目录（projects/<projectId>/storyboard.json）。每个镜头给 narration（旁白/文案）与 visualPrompt（画面描述），' +
        '可带 params（kind=image/video、aspectRatio、duration、provider、model、negativePrompt）。append=true 时追加到现有分镜，否则覆盖。' +
        'projectId 默认 default，可按影片/项目分区。',
      parameters: {
        projectId: { type: 'string', description: '项目 id，默认 default' },
        title: { type: 'string', description: '影片标题，默认「未命名影片」' },
        scenes: {
          type: 'array',
          required: true,
          description: '镜头列表，至少 1 个',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              narration: { type: 'string', required: true, description: '旁白/文案（会显示在工作台卡片上）' },
              visualPrompt: { type: 'string', required: true, description: '画面描述，直接用于生成图/视频' },
              params: SCENE_INPUT_PARAMS,
            },
          },
        },
        append: { type: 'boolean', description: '追加到现有分镜而不是覆盖，默认 false' },
      },
      output: { schema: RESULT_SCHEMA, render: (_args, value) => renderSummary('分镜已保存', value) },
      execute: async (args) => {
        const projectId = projectOf(args.projectId)
        const paths = await projects.ensure(projectId)
        const store = projects.store(projectId)
        try {
          const scenes = Array.isArray(args.scenes) ? args.scenes : []
          if (scenes.length === 0) {
            return result(projectId, store, emptyStoryboard(), null, { kind: 'server', message: '至少需要一个镜头' })
          }
          let saved
          if (args.append === true) {
            saved = await store.mutate((current) => appendScenes(current, scenes))
          } else {
            saved = await store.write(createStoryboardFromInput({ title: args.title, scenes }), { agentCwd: paths.projectDir })
          }
          return result(projectId, store, saved.storyboard, null)
        } catch (error) {
          return result(projectId, store, emptyStoryboard(), null, { kind: 'server', message: String(error?.message ?? error) })
        }
      },
    }),

    defineTool({
      name: 'film_list_scenes',
      description: '读取指定项目的 storyboard.json（镜头 id、旁白、画面描述、状态、素材 URL/本地路径、切换记录）。修改前先用它确认 sceneId。',
      parameters: {
        projectId: { type: 'string', description: '项目 id，默认 default' },
      },
      output: { schema: RESULT_SCHEMA, render: (_args, value) => renderSummary('当前分镜', value) },
      isConcurrencySafe: true,
      execute: async (args) => {
        const projectId = projectOf(args.projectId)
        await projects.ensure(projectId)
        const store = projects.store(projectId)
        const current = await store.read()
        return result(projectId, store, current.storyboard, null)
      },
    }),

    defineTool({
      name: 'film_update_scene',
      description:
        '修改指定镜头的字段：narration（旁白）、visualPrompt（画面描述）、params（生成参数，含 kind=image/video）。用于自然语言改片——' +
        '用户说「把第三个镜头改得更悬疑」，就由模型把意图落成具体字段值，调用本工具并传 sceneId。只传要改的字段，其余保持不变。',
      parameters: {
        projectId: { type: 'string', description: '项目 id，默认 default' },
        sceneId: { type: 'string', required: true, description: '镜头 id，如 scene-3' },
        narration: { type: 'string', description: '新的旁白/文案' },
        visualPrompt: { type: 'string', description: '新的画面描述' },
        params: SCENE_INPUT_PARAMS,
      },
      output: { schema: RESULT_SCHEMA, render: (_args, value) => renderSummary('镜头已更新', value) },
      execute: async (args) => {
        const projectId = projectOf(args.projectId)
        await projects.ensure(projectId)
        const store = projects.store(projectId)
        let found = null
        try {
          const saved = await store.mutate((current) => {
            const applied = updateScene(current, args.sceneId, {
              narration: args.narration,
              visualPrompt: args.visualPrompt,
              params: args.params,
            })
            if (applied === null) return current
            found = applied.scene
            return applied.storyboard
          })
          if (found === null) {
            return result(projectId, store, saved.storyboard, null, { kind: 'server', message: `找不到镜头 ${args.sceneId}` })
          }
          return result(projectId, store, saved.storyboard, found)
        } catch (error) {
          return result(projectId, store, emptyStoryboard(), null, { kind: 'server', message: String(error?.message ?? error) })
        }
      },
    }),

    defineTool({
      name: 'film_regenerate_scene',
      description:
        '对指定镜头重新触发生成：复用模块 2 的供应商池与失败切换，结果写回镜头的 imageUrl/videoUrl、status 与 switchTrace，' +
        '并尽量把素材下载到项目 assets/ 目录。kind 默认取镜头 params.kind（image 快、video 慢），也可显式覆盖。' +
        '生成失败时 status=failed、error 写明原因，switchTrace 保留切换过程。',
      parameters: {
        projectId: { type: 'string', description: '项目 id，默认 default' },
        sceneId: { type: 'string', required: true, description: '镜头 id，如 scene-3' },
        kind: { type: 'string', enum: ['image', 'video'], description: '生成类型，默认取镜头参数里的 kind' },
        provider: { type: 'string', enum: ['jimeng', 'doubao-seedream', 'doubao-seedance', 'wanx', 'tongyi-wanx', 'kling'], description: '优先供应商（失败仍会切换）' },
        promptOverride: { type: 'string', description: '临时替换画面描述，不写回分镜' },
        maxPolls: { type: 'integer', description: '轮询上限，默认取插件配置' },
      },
      timeoutMs: 1_200_000,
      output: { schema: REGENERATE_SCHEMA, render: (_args, value) => renderRegenerate(value) },
      execute: async (args, exec) => {
        const projectId = projectOf(args.projectId)
        const paths = await projects.ensure(projectId)
        const store = projects.store(projectId)
        const current = await store.read()
        const scene = current.storyboard.scenes.find((item) => item.id === args.sceneId) ?? null
        if (scene === null) {
          return {
            ok: false,
            projectId,
            storyboardPath: store.filePath,
            scene: null,
            generation: { ok: false, provider: null, url: null, localAsset: null, warning: null, polls: 0, elapsedMs: 0, switchTrace: [], error: { kind: 'server', message: `找不到镜头 ${args.sceneId}` } },
            error: { kind: 'server', message: `找不到镜头 ${args.sceneId}` },
          }
        }

        const kind = args.kind === 'video' ? 'video' : args.kind === 'image' ? 'image' : (scene.params.kind === 'video' ? 'video' : 'image')
        const prompt = String(args.promptOverride ?? scene.visualPrompt ?? '').trim() || scene.narration
        const params = compact({
          provider: args.provider ?? scene.params.provider ?? undefined,
          aspectRatio: scene.params.aspectRatio,
          duration: scene.params.duration,
          model: scene.params.model ?? undefined,
          negativePrompt: scene.params.negativePrompt ?? undefined,
        })

        await store.mutate((board) => markGeneration(board, scene.id, { status: 'generating' }).storyboard)

        const controller = new AbortController()
        const release = trackCall(ctx, taskScope, {
          controller,
          outerSignal: exec?.signal,
          label: `dsh-film-studio: regenerate ${scene.id}`,
        })

        let generation
        try {
          generation = await generateWithFailover({
            kind,
            prompt,
            params,
            settings,
            providers,
            signal: controller.signal,
            maxPolls: args.maxPolls,
          })
        } finally {
          release()
        }

        const generationOutput = {
          ok: generation.ok === true,
          provider: generation.provider ?? null,
          url: generation.url ?? null,
          localAsset: null,
          warning: null,
          polls: generation.polls ?? 0,
          elapsedMs: generation.elapsedMs ?? 0,
          switchTrace: Array.isArray(generation.switchTrace) ? generation.switchTrace : [],
          error: generation.error
            ? { kind: String(generation.error.kind ?? 'server'), message: String(generation.error.message ?? '生成失败') }
            : null,
        }

        if (generation.ok && generation.url) {
          const persisted = await persistAsset(projectId, paths, scene.id, kind, generation.url, undefined)
          generationOutput.localAsset = persisted.relative
          generationOutput.warning = persisted.warning
        }

        const saved = await store.mutate((board) => {
          if (generation.ok) {
            const next = markGeneration(board, scene.id, {
              status: 'done',
              imageUrl: kind === 'image' ? generation.url : undefined,
              videoUrl: kind === 'video' ? generation.url : undefined,
              assets: {
                image: kind === 'image' ? generationOutput.localAsset : undefined,
                video: kind === 'video' ? generationOutput.localAsset : undefined,
              },
              error: null,
              switchTrace: generation.switchTrace,
            })
            return next.storyboard
          }
          const next = markGeneration(board, scene.id, {
            status: 'failed',
            error: generation.error?.message ?? '生成失败',
            switchTrace: generation.switchTrace,
          })
          return next.storyboard
        })

        const updated = saved.storyboard.scenes.find((item) => item.id === scene.id) ?? null
        return {
          ok: generation.ok === true,
          projectId,
          storyboardPath: store.filePath,
          scene: updated,
          generation: generationOutput,
          error: generationOutput.error,
        }
      },
    }),
  ]
}
