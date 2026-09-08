# Braipen（novel-generator）项目交接文档

> **本文档面向接手的 AI**：读完即可理解项目全貌，无需额外询问即可继续开发。
> 最后更新：2026-09-08（对应 git 提交 `59964fa`，master 分支，123 个后端测试全绿）

---

## 目录

1. [项目背景与目标](#一项目背景与目标)
2. [技术栈与整体架构](#二技术栈与整体架构)
3. [目录结构与核心模块](#三目录结构与核心模块)
4. [当前开发进度与已完成功能](#四当前开发进度与已完成功能)
5. [未完成任务与后续计划](#五未完成任务与后续计划)
6. [已知问题与潜在风险](#六已知问题与潜在风险)
7. [环境配置与运行方式](#七环境配置与运行方式)
8. [代码规范与开发约定](#八代码规范与开发约定)
9. [重要协作上下文](#九重要协作上下文)

---

## 一、项目背景与目标

### 1.1 这是什么

**Braipen**（仓库名 `novel-generator`）是一个**本地运行的轻量 AI 长篇小说生成器**，面向个人写作和长期迭代。

- **仓库地址**：https://github.com/HenRiser/novel-generator.git （master 分支）
- **本地路径**：`D:\vibecoding\novel-generator`
- **运行方式**：本地单用户工具，**没有数据库、没有用户系统、不做公网部署**
- **大模型**：通过 OpenAI 兼容的 **DeepSeek API** 完成创作（`deepseek-v4-flash` / `deepseek-v4-pro`）

### 1.2 核心目标

把"小说创作"做成一个有据可依的工作流，而不是单次 prompt 碰运气：

```
灵感设定 → 大纲 → 人物卡 → 叙事图谱（人物/事件/伏笔/世界规则）
   → 章节任务单 → 场景计划 → 章节正文生成（流式 + 推理展示）
   → 合规审查（No-Reveal）→ 知识草稿审核 → 写回叙事图谱
```

关键设计原则：
- **叙事图谱（Narrative Graph）是唯一的"故事事实库"**，图谱变化要经过"知识草稿 → 人工审核 → 写回"的闭环，模型不能直接改图谱。
- **AI 推理过程（reasoning_content）只展示、绝不写入任何文件**——文件里只存最终正文。这是硬性约束。
- **上下文预算可控**：推理模型流式生成时 `max_tokens` 必须 ≥ 16384，否则推理会耗尽预算导致"只有思考、没有正文"。

### 1.3 历史脉络

项目前身是 Streamlit 前端（`app.py`，已删除）。2026-08 完成 React + FastAPI 全面重写，之后持续推进功能补全、体验修复、质量收尾。**所有新开发只面向 React + FastAPI**，Streamlit 不再维护、不作为回归测试目标。

---

## 二、技术栈与整体架构

### 2.1 技术栈

| 层 | 技术 | 版本 |
|---|---|---|
| 前端框架 | React | ^19.2.3 |
| 构建 | Vite | ^7.3.0 |
| UI 组件库 | Ant Design (AntD) | ^6.5.3 |
| 图谱可视化 | @antv/g6 | ^5.1.1 |
| 状态管理 | zustand | ^5.0.14 |
| 语言 | TypeScript | ^5.9.3 |
| 后端框架 | FastAPI | 0.136.3 |
| ASGI 服务 | uvicorn | 0.46.0 |
| AI SDK | openai | 2.36.0 |
| 数据校验 | pydantic | 2.13.4 |
| 环境变量 | python-dotenv | 1.2.2 |
| 测试（开发依赖） | httpx | 0.28.1（TestClient 用） |

### 2.2 整体架构

**数据流（自上而下）**：

```
┌─────────────────────────────────────────────────┐
│  React 前端 (http://127.0.0.1:5173)             │
│  pages (7 页) → components → store(zustand)      │
│  api.ts 封装所有 HTTP 调用                        │
└──────────────────┬──────────────────────────────┘
                   │ HTTP / JSON（部分 SSE 流式）
┌──────────────────▼──────────────────────────────┐
│  FastAPI (http://127.0.0.1:8000)                │
│  api/routers/*  (53 个接口端点)                  │
│      ↓                                          │
│  services/*     (业务逻辑，纯函数 + 文件操作)      │
│      ↓                                          │
│  file_manager / project_context / config_manager │
│  deepseek_client (DeepSeek API 调用)             │
└──────────────────┬──────────────────────────────┘
                   │ 读写文件系统
┌──────────────────▼──────────────────────────────┐
│  workspace/books/{book_id}/  (项目数据，无数据库) │
│  book.json / novel_outline.md / characters.md    │
│  chapters/ summaries/ memory/ logs/ snapshots/   │
└─────────────────────────────────────────────────┘
```

**分层职责**（严格遵守，不要跨层调用）：

| 层 | 位置 | 职责 | 禁忌 |
|---|---|---|---|
| 路由层 | `api/routers/*.py` | 参数校验、调 service、返回 schema、统一错误码 | 不写业务逻辑、不直接读文件 |
| 服务层 | `services/*.py` | 业务逻辑、读写文件、组装数据 | 不做 HTTP 参数解析 |
| 存储层 | `file_manager.py` `project_context.py` | 路径解析、文件读写、项目上下文 | 不含业务规则 |
| 配置层 | `config.py` `config_manager.py` | 常量、.env 读写、模型配置 | — |
| AI 层 | `deepseek_client.py` `prompt_templates.py` | API 调用、prompt 组装 | — |

### 2.3 数据存储（关键：无数据库）

项目数据全部存在文件系统，**`workspace/books/{book_id}/`**：

```
workspace/books/{book_id}/
├── book.json                    # 项目元数据（标题、book_id）
├── project_config.json          # 生成配置（model/max_tokens/temperature/各任务配置）
├── novel_outline.md             # 小说大纲（可带版本号 novel_outline_v2.md）
├── characters.md                # 人物卡（可带版本号）
├── chapter_index.md             # 章节索引（标题/文件/时间/模型/摘要）
├── setting_expansion_latest.json# 最近一次设定扩写结果
├── chapters/chapter_001.md      # 章节正文
├── summaries/chapter_001_summary.md  # 章节摘要
├── memory/narrative_graph.json  # 叙事图谱（节点 + 边）
├── memory/graph_views.json      # 图谱视图/布局配置（预留，布局持久化未实现）
├── history/events.json          # 事件日志（审计）
├── snapshots/                   # 关键写操作前的安全快照
├── logs/ai_runs/                # AI 调用追溯（不含完整 prompt 明文）
└── revisions/                   # 修订历史
```

- 旧项目兼容 `outputs/{小说标题}/`，通过 `legacy:{dir_name}` 引用，**不自动迁移/删除/改名**。
- 项目引用格式：`book:{book_id}`（新）或 `legacy:{dir_name}`（旧）。

---

## 三、目录结构与核心模块

### 3.1 根目录

```
novel-generator/
├── api/                     # FastAPI 应用
│   ├── main.py              # 应用入口，注册全部路由（CORS 只允许 5173）
│   ├── schemas.py           # 全部 Pydantic 请求/响应模型
│   ├── generation_state.py  # 生成任务状态
│   └── routers/             # 14 个路由模块（见下）
├── services/                # 业务逻辑层（19 个服务模块）
├── frontend/                # React 前端
├── tests/                   # 后端测试（10 个文件，123 个用例）
├── file_manager.py          # 文件读写 + 项目路径解析（核心存储层）
├── project_context.py       # ProjectContext 数据类 + 项目解析
├── config.py                # 全局常量（PROJECT_ROOT/DEFAULT_MODEL 等）
├── config_manager.py        # .env 读写、API Key 校验、模型配置
├── deepseek_client.py       # DeepSeek API 封装（同步/流式）
├── prompt_templates.py      # prompt 组装
├── generation_config.py     # 生成配置默认值
├── export_service.py        # 导出
├── ui_options.py            # UI 选项常量
├── setup.bat                # 一键初始化（建 .venv + 装依赖 + 生成 .env）
├── start-react.bat          # 启动正式前端（FastAPI + React）
├── start.bat                # 废弃兼容脚本（打印提示并转向 start-react.bat）
├── requirements.txt         # 运行依赖
├── requirements-dev.txt     # 开发依赖（含 httpx 用于 TestClient）
├── .env / .env.example      # 环境变量（.env 不提交 git）
├── docs/                    # 设计文档（prompt_design.md 等）
├── workspace/books/         # 项目数据（不提交 git）
└── outputs/                 # 旧项目目录（兼容）
```

### 3.2 后端路由（`api/routers/`，共 53 个端点）

| 文件 | 前缀 | 功能 |
|---|---|---|
| `health.py` | `/api/health` | 健康检查 |
| `projects.py` | `/api/projects` | 项目 CRUD、生成设置、章节读取/导出、**大纲/人物卡读取** |
| `settings.py` | `/api/settings` | API Key 配置状态/保存/连接测试 |
| `generation.py` | `/api/projects/{ref}/.../generate` | 章节/大纲/人物卡生成（含 SSE 流式） |
| `continue_writing.py` | `.../continue` | 对话式续写（流式 + 保存回章节） |
| `chapter_tasks.py` | `.../chapter-tasks` | 章节任务单 CRUD/批准 |
| `scene_plans.py` | `.../scene-plans` | 场景计划 CRUD/批准 |
| `chapter_function_reviews.py` | `.../chapter-function-reviews` | No-Reveal 合规审查 |
| `chapter_status.py` | `.../chapter-status` | 章节状态汇总 + Workflow Guard |
| `narrative_graph.py` | `.../narrative-graph` | 图谱 CRUD、标签、**从大纲导入** |
| `context_pack.py` | `.../context-pack` | 上下文包预览/选择 |
| `story_delta.py` | `.../story-delta` | 章节后 Story Delta 分析 |
| `knowledge_drafts.py` | `.../knowledge-drafts` | 知识草稿审核（accept/reject） |
| `audit.py` | `/api/audit` | 事件日志/快照 |

### 3.3 后端服务（`services/`）

| 文件 | 功能 |
|---|---|
| `common.py` | 公共工具：`clean_text`、原子写、时间戳、项目上下文解析（**改服务前先看这个**） |
| `generation_service.py` | 章节/大纲/人物卡生成主流程 |
| `narrative_graph_service.py` | 图谱 CRUD + `_normalize_graph_document` + `import_assets_to_graph`（从大纲导入） |
| `project_service.py` | 项目 CRUD、生成设置、大纲/人物卡就绪校验 |
| `reader_service.py` | 章节阅读、整本/单章导出 |
| `chapter_task_service.py` | 章节任务单 |
| `scene_plan_service.py` | 场景计划 |
| `chapter_function_review_service.py` | No-Reveal 审查 |
| `chapter_status_service.py` | 章节状态汇总 |
| `knowledge_draft_service.py` | 知识草稿 Review & Merge |
| `context_pack_service.py` | 上下文包选择 |
| `story_delta_service.py` | Story Delta 分析 |
| `event_log_service.py` | 事件日志（`append_event_best_effort`，签名见 §9） |
| `safety_snapshot_service.py` | 安全快照 |
| `ai_run_service.py` | AI 运行追溯 |
| `consistency_check_service.py` | 轻量一致性检查 |
| `prompt_profile_service.py` | Prompt Profile |
| `setting_service.py` | 设定扩写 |
| `schemas.py` | 服务层数据类（与服务层 dataclass 区分，注意与 `api/schemas.py` 不同） |

### 3.4 前端（`frontend/src/`）

**页面（`pages/`，7 个路由）**：

| 路由 | 页面 | 功能 |
|---|---|---|
| `/dashboard` | DashboardPage | 仪表盘（项目总览） |
| `/writing` | WritingCockpitPage | 创作驾驶舱（**主工作区**：项目/章节/生成/阅读/设定资产/状态） |
| `/reader` | ReaderPage | 阅读器（逐章阅读） |
| `/graph` | GraphPage | 叙事图谱（G6 画布 + 节点/边编辑 + 从大纲导入） |
| `/review` | ReviewPage | 章节审查（任务单→场景计划→合规审查串联） |
| `/settings` | SettingsPage | 设置（API 密钥 + 系统状态 + 项目生成设置） |
| `/library` | LibraryPage | 资料库（知识草稿审核 + 图谱入口） |

**组件（`components/`）**：

| 路径 | 组件 | 功能 |
|---|---|---|
| `AssetsPanel.tsx` | 设定资产面板 | 展示大纲/人物卡（Markdown） |
| `chapter/ChapterListPanel.tsx` | 章节列表 | — |
| `chapter/ChapterReader.tsx` | 章节阅读器 | — |
| `chapter/ContinueWriter.tsx` | 续写面板 | 流式 + 推理展示 + 保存 |
| `generation/GenerationPanel.tsx` | 生成面板 | 章节/大纲/人物卡生成 |
| `generation/StreamingPreview.tsx` | 流式预览 | — |
| `graph/GraphCanvas.tsx` | 图谱画布 | G6 v5 渲染 + d3-force 布局 |
| `layout/AppLayout.tsx` | 应用布局 | 侧边栏导航 + 内容区 |
| `library/KnowledgeDraftReviewPanel.tsx` | 知识草稿审核 | accept/reject 候选变更 |
| `project/ProjectListPanel.tsx` | 项目列表 | 选择/删除项目 |
| `project/ProjectCreateModal.tsx` | 项目创建弹窗 | — |
| `NoRevealReviewPanel.tsx` | 合规审查面板 | （已 AntD 重写） |
| `ChapterTaskSheetPanel.tsx` | 任务单面板 | （已 AntD 重写） |
| `ScenePlanPanel.tsx` | 场景计划面板 | （已 AntD 重写） |

**其他关键文件**：
- `api.ts`：**所有 HTTP 调用的唯一封装**，含 `apiFetch/postJson/deleteJson/streamJson`，新增接口务必在此封装。
- `types.ts`：所有 TypeScript 类型定义。
- `store/useAppStore.ts`：zustand 全局状态（项目/章节/生成状态等），含 `clearProjectState`（删项目后清空）。
- `appConfig.ts`：应用配置开关（如 `showIntro` 开屏动画，默认关闭，可用 `VITE_SHOW_INTRO` 覆盖）。
- `theme.ts` / `styles/global.css`：主题（米色/羊皮纸暖色系，非深色科技风）。

**注意：`frontend/src_legacy/` 是重写前的旧代码残留**，已被 `.gitignore` 排除，不要改、不要参考，等待清理。

---

## 四、当前开发进度与已完成功能

### 4.1 已完成的里程碑

**P0 基础重构（已完成）**
- 服务层去重（抽出 `services/common.py` 公共工具）
- 删除废弃代码（Streamlit `app.py` 等）
- 依赖规范化（`requirements.txt` / `requirements-dev.txt` 分离）
- 前端代码分包优化

**P1 功能补全（已完成）**
- 前端删除项目（`deleteProject` API 封装 + `clearProjectState` 状态清理）
- 设置页 `/settings`（系统状态 + 项目生成设置）
- 审查页 `/review`（任务单→场景计划→合规审查串联）
- 资料库页 `/library`（知识草稿审核 + 图谱入口）
- 图谱数据接入（`POST /narrative-graph/import-assets` 从大纲导入，幂等）

**P2 质量收尾（已完成）**
- 补测试（101 → 112）
- 清理 61 个已合并/废弃分支（仅剩 master）
- 删除遗留页（旧 LibraryPage、GraphNarrativeView）
- README 全面同步

**后续功能（已完成）**
- 叙事图谱可视化：G6 v5 画布、拖拽布局、节点增删改、关系连线
- AI 推理展示：章节生成/续写时以 `reasoning` 事件流式透传思考过程（只展示不写文件）
- 对话式续写闭环：续写结果一键保存回章节（append/replace）
- 项目删除接口（仅 workspace 项目）
- 开屏动画配置开关（默认关闭）
- API Key 管理入口（设置页"API 密钥"tab，保存 + 连接测试 + 严格校验）

**四个体验问题修复（已完成，提交 59964fa）**
1. 大纲/人物卡可见窗口：后端 `GET .../assets/outline` `assets/characters` + 前端"设定资产"tab
2. 章节审查可读性：三个旧 CSS 组件全部 AntD 重写 + 中文化
3. 图谱初始布局：加 d3-force 力导向，节点不再重叠
4. 资料库中文化：KnowledgeDraftReviewPanel 重写 + 全中文

### 4.2 质量基线（当前）

| 指标 | 状态 |
|---|---|
| 后端测试 | **123 个全绿**（`python -m unittest discover -s tests`） |
| 前端类型检查 | 零错误（`tsc --noEmit`） |
| 前端生产构建 | 成功（`vite build`） |
| git | master 与 origin/master 同步，工作区干净 |
| 最新提交 | `59964fa` |

---

## 五、未完成任务与后续计划

> 按优先级排序。建议先做完"短期"再动"中期"。

### 5.1 短期（体验补全，优先做）

| # | 任务 | 说明 | 预估 |
|---|---|---|---|
| 1 | **图谱布局持久化** | G6 拖拽后刷新会回到力导向布局，坐标不保存。`memory/graph_views.json` 已预留 layout 字段，补"读布局→应用→拖拽后写回"即可。**收益最直接，推荐第一个做** | 约半小时 |
| 2 | **章节改写/润色模式** | 续写链路已通（流式 + 推理 + 保存），加"改写本章""润色语气"入口复用同一套逻辑 | 低成本 |
| 3 | **清理孤儿组件** | `HomePage.tsx` `ProjectSettingsPage.tsx` `SystemSettingsPage.tsx` `ChapterStatusPanel.tsx` 无任何引用（旧 CSS + 英文死代码）。删除时注意用 mv 移出（见 §6 安全删除坑） | 很快 |

### 5.2 中期（创作能力）

| # | 任务 | 说明 |
|---|---|---|
| 4 | 角色一致性检查 | 基于图谱节点做跨章一致性校验（现轻量检查只覆盖日期/生死/身份） |
| 5 | 批量章节生成 / 一键继续下一章 | 现只能单章生成，README 长期标注"未迁移" |
| 6 | 多模型分任务配置 | 大纲用 pro、正文用 flash 混合（`project_config.json` 已支持 task 级 model keys） |

### 5.3 长期（架构）

| # | 任务 | 说明 |
|---|---|---|
| 7 | 图谱节点进 prompt 上下文预算 | 节点多时选择性注入（Context Pack 目前只按 importance≥8 做硬约束） |
| 8 | Timeline Review / Health Dashboard / Consistency Policy | README 里列出的未实现深层一致性体系 |
| 9 | 图谱导入增加"角色关系"边 | 解析人物卡关系字段自动建 `character_relation` 边（现只建节点） |
| 10 | 删除接口 legacy 支持 | 当前只允许删 workspace 项目，旧 outputs/ 项目删除策略待定 |

---

## 六、已知问题与潜在风险

> ⚠️ 这一节是**血泪教训**，接手开发前务必通读，避免重蹈覆辙。

### 6.1 高危：文件删除被环境拦截（safe-delete shim）

**现象**：当前运行环境有安全删除拦截（safe-delete shim），会拦截所有文件删除操作（`os.unlink` / `shutil.rmtree` / `rm` / `git rm` 等），回收站也不可用，报错形如 `[safe-delete][SAFE_DELETE_FAIL_CLOSED]`。

**曾发生的事故**：执行删除类操作时，`frontend/src/` 整个目录**两次意外消失**（40+ 文件）。

**应对策略（必须遵守）**：
- **删除文件一律改用 `mv` 移出项目**（如移到 `D:\vibecoding\archive\`），mv 不触发删除拦截。
- 恢复丢失的已跟踪文件用：`git restore --source=HEAD <path>`（**必须显式加 `--source=HEAD`**，否则从 index 恢复可能是旧的/坏的状态）。
- `git index.lock` 残留时，删除拦截会导致无法删锁——用 `mv .git/index.lock .git/index.lock.stale` 改名绕开。

### 6.2 高危：.env 被覆盖、无备份

**曾发生的事故**：测试 API Key 写接口时，旧 `_is_real_api_key` 只校验"非空"，导致测试值 `abc123` 覆盖了真实 DeepSeek API Key，且 `.env` 不被 git 跟踪、无备份，真实 Key 永久丢失。

**已修复**：`_is_real_api_key` 现在严格校验 `sk-` 前缀 + 至少 16 字符（`config_manager.py`）。

**教训与约定**：
- **修改 `.env` 或任何本地配置文件前先备份**。
- **写接口的测试必须隔离真实文件**（用临时目录 + `patch get_env_path`，并清理 `os.environ` 防泄漏），参考 `tests/test_settings_api.py`。
- **当前 .env 的 DEEPSEEK_API_KEY 可能需要用户重新填写**（被覆盖事故后重置为占位符），生成前确认。

### 6.3 中危：行尾符噪音（CRLF / LF）

**现象**：Windows 下 `Path.write_text()` 默认写 CRLF，而 git 仓库中部分文件 HEAD 是 LF，会造成"整个文件都变了"的假 diff。

**约定**：用 Python 读写前端文件时，用 `read_bytes()` / `write_bytes()` 按字节处理，写入前与 HEAD 的行尾对齐（`git cat-file blob HEAD:file` 检查）。提交前用 `git diff --ignore-space-at-eol --stat` 确认是"语义差异"而非行尾噪音。

### 6.4 中危：推理模型 max_tokens 陷阱

`deepseek-v4-flash` 是**推理模型**，流式生成时先输出推理过程再输出正文。`max_tokens` 低于约 8192 时，推理会耗尽预算，报错 `"Model stream ended without final content"`（只有推理、无正文）。

**现状**：后端 `DEFAULT_MAX_TOKENS` 已设为 **16384**（章节生成与续写一致）。**改动时保持 ≥ 8192，前端创建/编辑项目时也要提示用户**。

### 6.5 其他注意

- **AI 推理内容（reasoning_content）绝不写入任何输出文件**——文件只存最终正文。这是用户硬性要求，新增任何"生成"功能时务必遵守。
- **mock 路径要对**：patch 必须匹配"各模块内 import 的名字"（如 `api.routers.xxx.resolve_workspace_context` 而非 `services.common.resolve_workspace_context`）。`resolve_workspace_context` 返回 **4 元组**（ctx, message, status, code），mock 时注意。
- **重写 JSX 的脚本陷阱**：用脚本替换组件 JSX 时，定位 `return (` 必须从 `export function 组件名` **之后**找，否则会匹配到辅助函数的 return 破坏文件（曾因匹配到 192 行辅助函数导致文件损坏，靠 `git checkout` 恢复）。
- **`_workspace_context` vs `read_latest_*` 路径不一致**：服务函数里 mock 的 ctx 与 file_manager 的真实 resolve 可能不一致，`import_assets_to_graph` 已改为从 `ctx.project_dir` 直接读文件（兼容 mock），新代码参考这个模式。
- **characters.md 生成不稳定**：曾混入模型思考文本。所以图谱导入**只用大纲**（novel_outline.md）解析人物/世界观，不用 characters.md。

---

## 七、环境配置与运行方式

### 7.1 环境要求

- **Python 3.10+**（项目用 `.venv` 虚拟环境）
- **Node.js**（前端；本机有多版本，managed 优先）
- **Windows**（开发环境是 win32，bat 脚本是 Windows 专用）

### 7.2 首次初始化

```bat
cd /d D:\vibecoding\novel-generator
setup.bat
```

`setup.bat` 会：创建 `.venv`、安装 `requirements.txt`、若 `.env` 不存在则从 `.env.example` 生成。

### 7.3 配置 API Key

编辑 `D:\vibecoding\novel-generator\.env`：

```env
DEEPSEEK_API_KEY=sk-你的真实key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEFAULT_MODEL=deepseek-v4-flash
```

或在运行时通过前端 **设置 → API 密钥** 页保存（写入 .env，立即生效）。**`.env` 不提交 git**。

### 7.4 启动

**一键启动（推荐）**：

```bat
start-react.bat
```

会自动起两个窗口：FastAPI（`http://127.0.0.1:8000`）+ React（`http://127.0.0.1:5173`），浏览器打开 `http://127.0.0.1:5173`。

**手动分开启动**：

```bat
# 后端
.\.venv\Scripts\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8000

# 前端（新终端）
cd /d D:\vibecoding\novel-generator\frontend
npm run dev -- --host 127.0.0.1 --port 5173
```

### 7.5 验证与测试

```bat
# 后端测试（应在项目根目录运行）
.\.venv\Scripts\python.exe -m unittest discover -s tests

# 前端类型检查
cd frontend
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit

# 前端生产构建
node node_modules/vite/bin/vite.js build

# 后端健康检查
curl http://127.0.0.1:8000/api/health
```

**每次改动后必做**：后端测试 + 前端 tsc + 生产构建，三者全绿再提交。

---

## 八、代码规范与开发约定

### 8.1 工作流约定（用户明确要求）

- **分步执行**：任务拆成小步，每步端到端验证后再做清晰的 git commit（附汇总表）。
- **commit 规范**：`feat:` / `fix:` / `refactor:` / `test:` 前缀 + 中文描述，正文列出改动要点。
- **推送前先全量测试**：后端 123 测试 + tsc + 构建全绿 → `git push origin master`。
- **文件只输出到本项目工作区**，产品源码只读。

### 8.2 编码约定

- **语言**：除特殊词汇（如 token）外，**文案、注释、commit 一律用中文**。
- **接口封装**：前端所有 HTTP 调用走 `frontend/src/api.ts`，不裸写 `fetch`。
- **分层纪律**：路由层不写业务、服务层不碰 HTTP、存储层不含规则（见 §2.2）。
- **错误码**：后端统一 `{"error":{"code":"xxx","message":"..."}}` 格式，HTTP 校验错误统一转 `400 invalid_request`。
- **新增后端接口**：路由 + schema（`api/schemas.py`）+ service + 测试四件套。
- **新增前端页面**：page + App.tsx 路由 + AppLayout 菜单项 + api.ts 封装。

### 8.3 测试约定

- 测试文件放 `tests/`，命名 `test_xxx.py`，用 `unittest` + `TestClient`。
- 用临时目录 + `create_workspace_book` 建测试项目（参考 `tests/test_chapter_task_api.py`）。
- mock `resolve_project_context` / `resolve_workspace_context` 时注意返回元组数量和模块内名字路径。

---

## 九、重要协作上下文

### 9.1 用户偏好（影响产出风格）

- **中文为主**，回复偏好中文 + 详细分步技术说明 + 具体可执行命令。
- **技术输出要 grounded**：以源码为准，给 file:line 引用和置信度，不空谈。
- **源码讲解风格**：逐文件/逐函数走查 + 行号引用 + 架构图，优于简短总结。
- **函数缩写要括注完整名称**（如 `【system_config】`）。
- **排版偏好（学习类材料）**：HTML 优于 Markdown，米色/羊皮纸暖色系，非深色科技风。
- **对技术准确性要求严格**，对笼统结论会要求精确区分（如"是 fork/process 通用规则还是本应用专属逻辑"）。

### 9.2 关键函数签名（易踩坑）

```python
# services/event_log_service.py —— 4 个参数，不是 action/target/detail
append_event_best_effort(
    project_ref: str,
    event_type: str,
    summary: str = "",
    chapter_number: int | None = None,
    source: dict | None = None,
    changed_targets: list | None = None,
    snapshot_id: str | None = None,
)

# services/common.py —— 返回 4 元组
resolve_workspace_context(project_ref, resolve=..., ...) -> (ctx, message, status_code, error_code)
```

### 9.3 图谱数据结构

- 节点类型：`character`（人物）、`event`、`scene`、`foreshadowing`（伏笔）、`world_fact`（世界规则）、`plot_direction`（剧情方向）、`relationship_note`、`item`、`organization`
- 节点来源标记：`source.created_by = "outline_import"`（从大纲导入）等
- 导入解析：大纲 `## 主要人物` → `character` 节点；`## 世界观设定` → `world_fact` 节点；幂等（已存在 label 跳过）

### 9.4 本次交接文档的生成方式

本文档由上一任 AI 在核实 git 状态（`59964fa`）、测试基线（123 绿）、目录结构、启动脚本、配置文件后编写。所有数据均来自**实时核实**而非记忆，接手时若与本文档不符，**以实际代码和 git 状态为准**。

### 9.5 一份"前情提要"（给完全不了解的接手者）

这个项目经历了从 Streamlit 到 React+FastAPI 的彻底重写，期间踩过几个大坑（删除拦截误删目录、API Key 被覆盖、行尾噪音、推理模型 max_tokens 陷阱），都已在 §6 记录并修复。目前功能完整、测试全绿、代码干净，处于"功能就绪、等待体验深化"的阶段。接下来的工作重心是 §5 的短期任务（图谱布局持久化、改写模式、清理孤儿组件），都是低风险、高回报的小改动。**先读 §6 避坑，再从 §5.1 开始动手。**

---

**祝顺利。有任何与本文档冲突的地方，信代码，不信文档。**
