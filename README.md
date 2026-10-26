# dsh-film-studio

手机 DSHA（Linux arm64 + glibc，proot 容器）上的**视频制作工作台**插件，按「整合式二次开发」思路
从现有 DSH 插件拆出可复用模块重新组装。纯 JS，无原生模块，不依赖 Windows 专有路径。

## 模块进度

| 模块 | 内容 | 状态 |
| --- | --- | --- |
| 1 | FFmpeg / ffprobe 探测，验证 proot 子进程链路 | ✅ |
| 2 | 供应商统一适配层 + 失败分类 + 自动切换（6 家：即梦 / 豆包 Seedream / 豆包 Seedance / 通义万相 ×2 / 可灵） | ✅ |
| 3 | 分镜数据结构 + 工具 + 手机窄屏工作台 + 自然语言改片 | ✅（含 4 项修正） |
| 4 | FFmpeg 合成导出本地 MP4（Ken Burns / 视频裁剪 / 统一规格 / 超时清理） | ✅ |
| 5 | 提示词自优化（规则检查 + 模型自评 + 历史回溯） | ✅ |
| 收尾 | 项目切换 / 导出进度 / Ken Burns 参数 | ✅ |

## 目录结构

```
dsh-film-studio/
├── lib/
│   ├── index.js                 # Config + apply（工具/路由/进程都在 ctx.effect 里）
│   ├── settings.js              # 配置解析 + 项目路径
│   ├── probe.js                 # 可执行文件探测
│   ├── polling.js               # 轮询上限 + 退避
│   ├── lifecycle.js             # 生成任务作用域
│   ├── scheduler.js             # 供应商池 + 失败切换
│   ├── providers/               # 即梦 / 可灵 / 五类错误
│   ├── storyboard/
│   │   ├── model.js             # 镜头模型（含 kind / assets）
│   │   ├── store.js             # 原子写 + 串行队列
│   │   └── projects.js          # projectId 分区 + 旧布局迁移
│   ├── media/download.js        # 素材下载（超时 + 大小上限）
│   ├── export/
│   │   ├── command.js           # FFmpeg 参数构造（纯函数）
│   │   ├── runner.js            # 子进程执行（超时/取消/SIGKILL）
│   │   ├── scope.js             # 子进程 + 临时目录作用域
│   │   └── exporter.js          # 预检 → 下载 → 转码 → 拼接 → ffprobe 校验
│   ├── workbench/server.js      # /film-studio 页面 + API + 素材路由
│   └── tools/
│       ├── probe-ffmpeg.js      # film_probe_ffmpeg
│       ├── generate-media.js    # film_generate_image / film_generate_video
│       ├── storyboard.js        # 分镜 4 个工具
│       └── export.js            # film_check_assets / film_export_mp4
├── assets/workbench.html        # 自包含窄屏页面
├── scripts/
│   ├── verify.mjs               # 模块 1（21 项）
│   ├── verify-providers.mjs     # 模块 2（42 项）
│   ├── verify-storyboard.mjs    # 模块 3（32 项）
│   ├── verify-export.mjs        # 模块 4（24 项，真实 ffmpeg）
│   ├── probe-real-provider.mjs  # 真实供应商探针
│   └── preview-workbench.mjs    # 工作台本地预览
├── cordis.patch.yml
└── package.json
```

## 项目布局（模块 3 修正）

```
workspace/
└── projects/
    └── <projectId>/
        ├── storyboard.json     # 分镜
        ├── assets/             # 素材（生成后下载落盘）
        └── output/final.mp4    # 导出
```

- 默认 `projectId = default`；旧的 `workspace/storyboard.json` 与 `workspace/assets/` 会在首次访问时迁移到 `projects/default/`；
- 工具、工作台 API、素材路由都带 `projectId`；
- `storyboard.json` 原子写（临时文件 + rename），读改写串行。

## 配置

优先级按字段不同：

- **FFmpeg / ffprobe**：`config.ffmpegPath` → `DSH_FFMPEG_PATH` → `FILM_STUDIO_FFMPEG` → PATH（ffprobe 同理）；
- **供应商密钥**：`cordis.patch.yml` 的 `config.providers.*` → 对应环境变量 → 工作台的 `providers.json` → 未配置（未配置的供应商会被跳过，不会发请求）；
- **其他**（workspace、轮询、导出等）：环境变量 → patch config → 默认值。

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `workspaceDir` / `FILM_STUDIO_WORKSPACE` | `$DSH_WORKSPACE_DOCUMENTS/film-studio` | 项目根目录 |
| `ffmpegPath` / `DSH_FFMPEG_PATH` | `ffmpeg` | 配错返回明确错误 |
| `providers.order` | 6 家默认顺序 | 供应商尝试顺序 |
| `JIMENG_API_KEY` | — | 即梦/方舟（图像+视频） |
| `DOUBAO_SEEDREAM_API_KEY` | 回退 `JIMENG_API_KEY` | 豆包 Seedream（仅图像） |
| `DOUBAO_SEEDANCE_API_KEY` | 回退 `JIMENG_API_KEY` | 豆包 Seedance（仅视频） |
| `DASHSCOPE_API_KEY` | — | 通义万相（Wanx） |
| `TONGYI_WANX_API_KEY` | 回退 `DASHSCOPE_API_KEY` | 通义万相（Tongyi-Wanx 入口） |
| `KLING_ACCESS_KEY` / `KLING_SECRET_KEY` | — | 可灵 JWT 凭据 |
| `polling.*` | 60 / 5000 / 20000 | 轮询上限与退避 |

## 工具（13 个）

| 工具 | 作用 |
| --- | --- |
| `film_probe_ffmpeg` | 探测 FFmpeg / ffprobe |
| `film_generate_image` / `film_generate_video` | 供应商池生成，失败自动切换 |
| `film_create_storyboard` | 生成分镜（`projectId` 分区，可追加） |
| `film_list_scenes` | 读分镜 |
| `film_update_scene` | 改旁白 / 画面 / 参数（含 kind=image/video） |
| `film_regenerate_scene` | 重生成镜头，素材落 `assets/` |
| `film_check_assets` | 导出前预检：每个镜头就绪状态与缺失原因 |
| `film_export_mp4` | 合成 MP4：图片转片段（可选 Ken Burns）、视频裁剪、统一规格、拼接、ffprobe 校验 |
| `film_evaluate_scene_prompt` | 评估提示词：四要素、旁白长度、空泛词、三维规则评分、改进建议（不改数据） |
| `film_optimize_scene_prompt` | 单镜头优化：两阶段（start 给指令 → submit 回传），写 history 与 currentPrompt |
| `film_optimize_all_prompts` | 批量优化 draft 镜头，逐镜头进度，单镜头失败不阻断 |
| `film_export_progress` | 查询一次导出的阶段（checking/downloading/segment/concat/verifying/done/failed） |

## 供应商设置面板（给普通用户）

工作台右上角 **⚙** 打开设置抽屉：逐家填 API Key、保存、清除，不用编辑 YAML。

- 存储：`<workspaceDir>/providers.json`（权限 600，只写填过的字段，合并保存）；
- 优先级：`cordis.patch.yml` 的 config **>** 环境变量 **>** `providers.json`（所以高级用户仍可用前两者覆盖面板）；
- 页面只显示「已配置 / 未配置」与来源提示，输入框是 `type=password`，保存接口只回掩码（前 4 + 后 4），不回显完整 Key；
- 保存后提示「重启 DSHA 生效」——密钥在插件启动时解析，重启后生效，会话记录保留；
- 接口：`GET /film-studio/api/providers/status`、`POST /film-studio/api/providers/save`、`POST /film-studio/api/providers/remove`。

## 供应商池（6 家）

默认顺序：`jimeng → doubao-seedream → doubao-seedance → wanx → tongyi-wanx → kling`（可用 `providers.order` 调整）。

| 供应商 | 平台 / 鉴权 | 支持类型 | 说明 |
| --- | --- | --- | --- |
| `jimeng` | 火山方舟，Bearer API Key | 图像 + 视频 | 即梦，Seedream/Seedance 模型 |
| `doubao-seedream` | 火山方舟，Bearer API Key | 仅图像 | 豆包 Seedream，图像专用条目 |
| `doubao-seedance` | 火山方舟，Bearer API Key | 仅视频 | 豆包 Seedance，视频专用条目 |
| `wanx` | DashScope，Bearer Key + `X-DashScope-Async` | 图像 + 视频 | 通义万相（异步任务） |
| `tongyi-wanx` | DashScope，同上 | 图像 + 视频 | 通义万相的第二个池条目（独立 Key/基址） |
| `kling` | Kling AI，AccessKey/SecretKey 签 JWT | 图像 + 视频 | 可灵 |

调度器先按生成类型过滤：图像任务跳过 `doubao-seedance`，视频任务跳过 `doubao-seedream`，被跳过的原因会写进 `attempts`。

## 导出流程与规格

1. `film_check_assets` 预检：`status !== done`、无素材、本地缺失且无远程 URL 都会明确报出；
2. 有缺失时 `film_export_mp4` **拒绝执行**并列出原因；
3. 逐镜头处理：
   - 图片：`-loop 1 -framerate 30 -t <时长>`，可选 `zoompan` 做 Ken Burns；
   - 视频：`-t <镜头时长>` 裁剪；
   - 统一 `scale + pad` 到 1280×720、30fps、H.264(yuv420p)，音频统一为 AAC（拼接时加静音轨）；
4. concat demuxer 拼接；
5. `ffprobe` 复核分辨率与时长，不符记入 `warnings`；
6. 全程 120 秒超时（可配），超时 SIGKILL ffmpeg；
7. `ctx.effect` 兜底：插件卸载时 kill 所有 ffmpeg/ffprobe 进程并删除临时目录。

## 提示词自优化（模块 5）

优化由**当前会话的模型**完成，插件不调用第二个 LLM：
工具返回「改什么 + 按什么标准改 + 提交什么 JSON」，模型生成后 `submit` 回传，插件做规则检查并合并模型自评。

数据层（每个 scene）：

```json
{
  "currentPrompt": { "narration": "…", "visualPrompt": "…" },
  "promptStyle": "悬疑",
  "promptHistory": [
    { "round": 0, "narration": "原始", "visualPrompt": "原始", "scores": null, "reason": "原始版本", "timestamp": "…" },
    { "round": 1, "narration": "…", "visualPrompt": "…", "scores": { "specificity": 4, "visual": 4, "emotion": 4 }, "reason": "…", "timestamp": "…" }
  ]
}
```

- 第 0 轮原始版本**永不删除**；优化轮次只保留最近 5 轮（`trimPromptHistory`）；
- `currentPrompt` 是当前生效版本，`narration` / `visualPrompt` 与它同步；
- 规则检查：主体 / 动作 / 场景 / 光线四要素、旁白 10–60 字、空泛词表；
- 三维评分：具体性 / 可视化 / 情绪，规则分与模型自评**取较低值**；
- 停止条件：达标（规则通过且三维 ≥3）或到达最大轮次（1–3，默认 1）；
- 上限：单镜头 3 轮；批量总提交轮次 ≤ 镜头数 × 2；会话总超时默认 90 秒；
- 超时：已完成的轮次已写入文件，当前轮不写入，返回 `phase: "timeout"`；
- 风格：写实电影感 / 动画漫剧 / 悬疑 / 治愈，通过不同优化指令影响方向（悬疑强调阴影与冷暖对比，治愈强调柔和光线与自然元素）。

## 收尾打磨

### 项目切换

- 顶部项目胶囊按钮 → 底部抽屉列出 `workspace/projects/` 下的项目（标题、镜头数、更新时间）；
- 切换 = 改 URL `?project=<id>` 并重新加载，不整页刷新；未保存编辑（卡片编辑 / 参数抽屉 / 新增表单）会先 `confirm`；
- 切换成功后显式重置 `editing / params / creating / dirty` 标记；
- 新建项目：严格校验 id（1–64 字符、不以 `.` 开头、仅字母数字点下划线短横线），重复返回 409；
- 空列表时前端回退显示当前项目，不自动在磁盘创建 default 目录。

接口：`GET /film-studio/api/projects`、`POST /film-studio/api/projects/create`。

### 导出进度

阶段式（不解析 ffmpeg stderr）：`checking → downloading（有远程素材时）→ segment 第 N/M 段 → concat → verifying → done/failed`。

内存状态 `Map<exportId, ExportProgress>`（`ctx.effect` 管理，卸载清空），终态保留 30 秒、惰性清理；失败返回 `lastPhase` / `lastSceneIndex`。

读取：工具 `film_export_progress({ exportId })`，或页面轮询 `GET /film-studio/api/export/status?project=`（1.5s 一次，终态/切换项目/页面隐藏时 `clearInterval`）。

### Ken Burns 参数

- 方向：`in` 推近 / `out` 拉远；幅度：`light` 轻微（+10%）/ `medium` 中等（+18%），默认 `in/light`；
- zoompan 用输出帧号线性表达式 `min(1+step*on,max)` / `max(max-step*on,1)`——比 `zoom` 自增在不同 ffmpeg 版本上更稳定（实测自增在部分参数组合下会被重置，导致整段静止）；
- 工作台参数抽屉内两个 chips，关闭时幅度置灰；设置存 localStorage，导出请求带 `kenBurnsDirection` / `kenBurnsStrength`。

## 工作台（窄屏）

访问 `http://127.0.0.1:<DSH端口>/film-studio?project=<id>`（同源、复用 DSH 登录态）。

- 卡片单列纵向；状态徽章（草稿/生成中/已完成/失败）；生成类型徽章（图片/视频）；
- 「参数」打开底部抽屉：生成类型（图片/视频，切换时联动显示时长）、比例、供应商、模型、负向提示词；
- 「重新生成」按镜头 `params.kind` 执行（不再需要用户记忆传 kind）；
- 「+」打开新增镜头抽屉（旁白 / 画面描述 / 生成类型 / 比例 / 时长），提交后写入并刷新；
- 触控目标 ≥ 44×44px；`visualViewport` 适配软键盘，提交按钮固定在抽屉底部；
- 生成中每 3 秒自动刷新，页面重新聚焦时重新读取。

## 验证

```bash
cd /root/.dsh/plugin-src/dsh-film-studio

node scripts/verify.mjs            # 21 项
node scripts/verify-providers.mjs  # 42 项
node scripts/verify-storyboard.mjs # 32 项
node scripts/verify-export.mjs     # 24 项（真实 ffmpeg 合成）
node scripts/verify-prompt.mjs     # 36 项（永不达标 / 中途超时 / 批量 / 裁剪 / 预算）
node scripts/verify-workbench.mjs  # 22 项（项目列表 / 切换 / 创建校验 / 状态重置）
node scripts/verify-providers-ui.mjs # 24 项（密钥保存 / 掩码 / 优先级 / 600 权限）
node scripts/verify-e2e.mjs        # 端到端：分镜 → 优化 → 素材 → 导出

node /root/.dsh/profiles/web/node_modules/dsh-android-portability/tools/cli.js . --strict
```

## 收尾打磨验收备注

- **项目切换**：两项目各自分镜、切换后列表正确；重复创建 409、非法 id 400；页面含未保存提示、状态重置、URL 编码、44px 触控。
- **导出进度**：3 段素材的阶段序列完整（checking → segment×3 → concat → verifying → done）；FIFO 素材失败时 `lastPhase=segment`、`lastSceneIndex=1`；终态 TTL 惰性清理通过。
- **Ken Burns**：四种组合（in/out × light/medium）均导出成功、分辨率保持 1280×720；首尾帧不同，推近与拉远首帧不同，轻微与中等首帧不同。
- 提示：手机 WebView 实测仍受设备通道限制；工作台预览可跑 `node scripts/preview-workbench.mjs --port 3099`，访问 `http://127.0.0.1:3099/film-studio`。

## 模块 5 验收备注

- **永不达标**：连续 3 轮自评 2 分 → 第 3 轮后 `phase: "done"`，`promptHistory` 有 3 条优化记录 + 第 0 轮原始，`currentPrompt` 是第 3 轮结果；不会无限循环。
- **中途超时**：`timeoutMs` 设小后第 1 轮写入、等待超时、第 2 轮 `submit` 返回 `timeout`，文件里没有第 2 轮半成品。
- **批量**：3 镜头 3/3 完成，每镜头 history + currentPrompt 正确，原始版本仍在第 0 轮；2 镜头批量的总提交轮次被 `镜头数×2=4` 截断。
- **风格差异**：同一镜头「悬疑」指令强调阴影/冷暖对比/留白，「治愈」强调柔和/自然元素/暖色调。
- **端到端**：创建分镜 → 批量优化 → 素材 → 导出 8.0s/1280×720 MP4，优化后链路正常。

## 模块 4 验收备注

- **真实合成已跑通**：2 张图片 + 1 段短视频 → 8.0 秒 / 1280×720 / H.264 + AAC 的 MP4（55 KB），ffprobe 复核通过，可提取封面帧。
- **超时清理已验证**：用 FIFO 素材让 ffmpeg 阻塞，5 秒超时后进程被 SIGKILL，`scope.childCount() === 0`、`scope.dirCount() === 0`，`/tmp/film-studio-export-*` 无残留。
- **手机 WebView 实测未完成**：本次会话的设备通道未授权（`adb-shell` 返回 `DEVICE_CHANNEL_UNAVAILABLE`，虚拟屏 `REJECTED`），无法在真机 WebView 打开确认。已用本地预览（`preview-workbench.mjs`）与静态检查替代：页面 200、生成类型选择器/新增抽屉/44px/键盘适配/素材路由/项目参数均存在。待用户在 DSHA 中打开 `/film-studio` 后补充真机备注；如发现软键盘遮挡或抽屉高度异常，优先检查 `visualViewport` 是否触发 `adjustForKeyboard`。
- 已知待打磨项（记入模块 5 收尾）：工作台缺少项目切换下拉（目前靠 URL `?project=`）；导出无进度条；Ken Burns 参数（推近幅度/方向）未暴露到 UI。
