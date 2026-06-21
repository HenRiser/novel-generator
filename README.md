# novel-generator

[中文](README.md) | [English](README.en.md)

一个本地运行的轻量 AI 小说生成器。当前正式前端是 Braipen：React + FastAPI，通过 OpenAI 兼容的 DeepSeek API 完成长篇创作工作流。项目面向个人写作和长期迭代：结构清晰、没有数据库、没有用户系统。Streamlit 前端已废弃，不再维护，也不再作为回归测试目标。

## 功能列表

- 输入小说标题、类型、风格、人物、世界观、核心冲突和额外要求。
- 大纲生成，新项目保存到 `workspace/books/{book_id}/novel_outline.md`，旧项目继续兼容 `outputs/小说标题/novel_outline.md`，并自动追加版本号。
- 人物卡生成，新项目保存到 `workspace/books/{book_id}/characters.md`，旧项目继续兼容 `outputs/小说标题/characters.md`，并自动追加版本号。
- 生成指定章节正文，新项目保存为 `workspace/books/{book_id}/chapters/chapter_001.md`、`chapter_002.md` 等，旧项目继续兼容 `outputs/小说标题/chapters/`。
- 自动避免覆盖已有文件，例如生成 `chapter_001_v2.md`。
- 章节生成后自动生成 100 字以内摘要，保存到当前项目的 `summaries/`。
- 自动维护当前项目的 `chapter_index.md`。
- 支持指定章节流式生成，读取最近章节正文、历史摘要、大纲和人物卡作为上下文。
- 支持 Narrative Graph、Context Pack、Story Delta、Knowledge Draft Review & Merge 的 React + FastAPI 工作流。
- 支持 Event Log + Safety Snapshot Foundation：关键写操作会追加审计事件，Review & Merge accept 与 Narrative Graph update/delete 前会创建安全快照。
- 支持 AI Run Provenance + Prompt Profile Foundation：第一版记录 `chapter_generation` 与 `story_delta_analysis` 的模型、参数、prompt profile、prompt hash、限长 preview、上下文引用和结果引用。
- 支持 Chapter Status Panel / Workflow Guard Foundation：创作页汇总每章正文、Story Delta、Knowledge Draft、AI Run、Event 状态，并在生成前给出非阻断提醒。
- 支持保存和加载当前项目的 `project_config.json`；新项目默认位于 `workspace/books/{book_id}/`。
- 支持 React 项目配置页中的 Genesis 只读展示和 Generation Settings 安全编辑。
- API Key 从环境变量或本地 `.env` 读取，不会写入代码、日志或输出文件。

## 项目结构

```text
novel-generator
├── app.py  # 已废弃的 Streamlit 前端，仅保留历史参考
├── config.py
├── config_manager.py
├── deepseek_client.py
├── prompt_templates.py
├── file_manager.py
├── project_context.py
├── export_service.py
├── generation_config.py
├── ui_options.py
├── requirements.txt
├── README.md
├── .env.example
├── outputs/
│   └── .gitkeep
├── workspace/
│   └── books/
└── docs/
    └── prompt_design.md
```

## 环境配置

建议使用 Python 3.10 或更高版本。

进入项目目录：

```bat
cd /d D:\vibecoding\novel-generator
```

创建虚拟环境：

```bat
python -m venv .venv
```

激活虚拟环境：

```bat
.venv\Scripts\activate
```

安装依赖：

```bat
pip install -r requirements.txt
```

创建 `.env`：

```bat
copy .env.example .env
```

在 `.env` 中填写 DeepSeek API Key：

```env
DEEPSEEK_API_KEY=your_api_key_here
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEFAULT_MODEL=deepseek-v4-flash
```

启动正式 Braipen 前端：

```bat
start-react.bat
```

打开浏览器中的本地地址，通常是：

```text
http://127.0.0.1:5173
```

## 一键初始化与启动

Windows 下可以直接使用项目根目录中的批处理脚本。

初始化环境：

```bat
setup.bat
```

`setup.bat` 会创建 `.venv`、安装 `requirements.txt` 中的依赖，并在 `.env` 不存在时从 `.env.example` 生成 `.env`。如果 `.env` 已经存在，脚本不会覆盖它。

填写 API Key：

```env
DEEPSEEK_API_KEY=your_api_key_here
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEFAULT_MODEL=deepseek-v4-flash
```

启动正式 Braipen 前端：

```bat
start-react.bat
```

`start-react.bat` 会启动 FastAPI 和 React，并自动打开：

```text
http://127.0.0.1:5173
```

`start.bat` 仅作为废弃兼容脚本保留：它会打印 Streamlit 退役提示，并转向 `start-react.bat`。

如果启动失败：

- 确认已经运行 `setup.bat`。
- 确认 Python 已加入 PATH。
- 确认 `.env` 中已填写 `DEEPSEEK_API_KEY`。
- 如果需要手动启动，可分别启动 FastAPI 和 React：

```bat
.\.venv\Scripts\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8000
```

```bat
cd /d D:\vibecoding\novel-generator\frontend
npm run dev -- --host 127.0.0.1 --port 5173
```

## Quick Start

Streamlit Quick Start 已废弃。当前正式配置路径是 React + FastAPI：

当前支持：

1. 在 `.env` 中配置 `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL` 和 `DEFAULT_MODEL`。
2. 使用 React 项目配置页安全编辑当前项目的 `model`、`max_tokens` 和 `temperature`。
3. 系统级 API Key 写入、模型连接测试和完整 `.env` 管理将作为后续 React + FastAPI 设置能力处理。

`.env` 只应保存在本地，不应提交到 Git。

## API Key 安全说明

本项目定位为本地单用户工具，不包含用户系统和公网多用户部署配置。

- API Key 通过本地 `.env` 或环境变量提供。
- `.env` 已被 `.gitignore` 排除，不应提交到仓库。
- 页面不会显示已有 API Key 明文。
- API Key 不会写入 `project_config.json`。
- 如果需要更换 API Key、Base URL 或默认模型，当前请直接编辑本地 `.env`；React 的完整系统设置入口会在后续阶段补齐。

## 导出与阅读

项目支持在网页中按章节阅读当前小说，并提供上一章 / 下一章切换。

阅读区支持下载当前章节 TXT，也支持按章节顺序合并并下载整本正文 TXT。部署在服务器上时，“打开当前项目目录”可能无法打开你本机文件夹，建议使用网页阅读或 TXT 下载。

## 示例输入

小说标题：

```text
雾城回响
```

小说类型：

```text
赛博朋克
```

写作风格：

```text
冷峻
```

主角设定：

```text
林昼，前城市记忆工程师，能读取被删除的公共监控残影。因为一次失败的记忆修复事故，他失去了妹妹最后一天的真实记忆。
```

重要配角设定：

```text
沈棠，地下诊所医生，擅长非法神经修补；白鸦，黑市情报商，永远只出售半真半假的线索。
```

世界观设定：

```text
近未来海滨巨城，城市由中央算法分配工作、医疗和居住权限。人的记忆可以合法备份，但低收入区只能使用残缺版本。
```

故事核心冲突：

```text
主角发现妹妹的死亡记录被城市算法反复改写，而每一次追查都会让他的个人记忆继续缺失。
```

额外要求：

```text
第三人称，节奏偏快，多对话，避免解释腔，每章结尾保留悬念。
```

## 设定输入与智能扩写

用户可以在页面顶部输入一句话灵感、白话故事梗概、人物设定、世界观设定、剧情冲突说明，或已经整理好的小说企划。例如：“我想写一个赛博朋克故事，主角是失忆黑客，妹妹失踪了，城市被大公司控制，人的记忆可以被修改，主角要查清真相。”

系统会调用 DeepSeek 自动整理、补全并拆分成：

- 标题候选和推荐标题
- 主角设定
- 重要配角设定
- 世界观设定
- 故事核心冲突

你可以先点击“预览设定扩写 Prompt”检查即将发送的 messages。确认后点击“整理并扩写设定”，扩写结果会自动填入页面对应输入框。之后可以继续手动修改，再生成大纲、人物卡或章节正文。

如果没有填写小说标题，系统会根据输入的设定内容自动生成多个标题候选，并选择一个推荐标题填入标题输入框。如果你已经填写标题，系统不会覆盖，只会展示候选标题供参考。新项目首次保存或生成时会创建到 `workspace/books/{book_id}/`，标题只作为显示名称保存。

如果启用了保存扩写结果，最近一次结果会写入：

```text
workspace/books/{book_id}/setting_expansion_latest.json
```

## Streamlit 退役说明

Streamlit 前端已废弃。`app.py` 暂时保留为历史参考，`start.bat` 只打印退役提示并转向 `start-react.bat`。后续新功能、UI 变更和回归测试只面向 React + FastAPI。

Streamlit 残留功能清点：

- 已由 React + FastAPI 覆盖：项目创建、项目列表、项目详情、大纲与人物卡生成、指定章节生成、流式预览、同步备用生成、generation status、章节阅读、TXT 导出、Narrative Graph、Context Pack、Story Delta、Knowledge Draft Review & Merge、项目 Generation Settings。
- 本阶段有意不迁移：Streamlit Prompt 预览、打开本地输出目录、完整 `.env` API Key 写入 UI、设定扩写 UI、编辑生成结果后另存版本、旧阅读中心细节控件。
- 后续可考虑迁移：独立“一键继续下一章”按钮、批量章节生成、系统级 API Key / 模型连接测试。

## API / 模型配置

项目默认模型为 `deepseek-v4-flash`，Base URL 默认为 `https://api.deepseek.com`。当前正式前端在“项目配置”页支持编辑当前项目的 `model`、`max_tokens` 和 `temperature`。

内置可选模型为：

- `deepseek-v4-flash`
- `deepseek-v4-pro`

React 当前只允许安全选择内置模型，不允许任意输入模型名。系统级 API Key、Base URL、连接测试和完整模型管理仍是后续 React + FastAPI 设置页任务。

## 输出目录结构

新建小说项目会保存到稳定的 `book_id` 目录，中文标题写入 `book.json`，不再作为真实目录名：

```text
workspace/
└── books/
    └── bk_YYYYMMDD_HHMMSS_xxxxxxxx/
        ├── book.json
        ├── project_config.json
        ├── novel_outline.md
        ├── characters.md
        ├── chapter_index.md
        ├── setting_expansion_latest.json
        ├── chapters/
        │   └── chapter_001.md
        └── summaries/
            └── chapter_001_summary.md
```

旧版 `outputs/小说标题/` 项目仍会出现在项目列表中，并继续按原目录读写；系统不会自动迁移、删除或改名旧项目。不同小说的数据互相隔离。新项目标题为空时使用“未命名小说”作为显示标题。

## 项目路径管理

当前新项目默认使用 `workspace/books/{book_id}/` 存储，旧 `outputs/{小说标题}/` 项目保留兼容。项目内部通过 `ProjectContext` 和 `file_manager.py` 统一表达项目目录、配置文件、章节目录、摘要目录、章节索引、大纲和人物卡等路径。

普通用户主要看到小说标题；系统内部使用 `book:<book_id>` 或 `legacy:<legacy_dir_name>` 区分真实项目身份，避免中文标题、同名书籍或标题修改影响目录定位。

## 自动章节标题

每次生成章节正文后，系统会再根据本章正文调用模型生成一个章节标题。标题会被清洗并统一写入章节 Markdown 开头，例如：

```text
# 第 1 章：霓虹雨中的旧记忆
```

`chapter_index.md` 也会记录章节标题、章节文件、生成时间、模型和摘要。如果章节标题生成失败，系统会使用“未命名章节”作为兜底标题，不影响章节正文保存。

## 章节创作

React 创作页中的正文生成入口集中在单章生成工作流：

- 指定章节：使用用户输入的章节编号生成正文。
- 推荐下一章：页面显示建议下一章编号，用户可通过同一单章控件生成。
- 默认流式生成：实时预览正文，完成后保存章节、摘要并更新 `chapter_index.md`。
- 同步备用生成：保留为流式异常时的备用 / 调试入口。
- Context Pack：可预览并选择是否辅助本次生成，默认关闭；单章生成区域会显示本次是否注入 Context Pack，以及资料、关系和硬约束数量摘要。
- Lightweight Consistency Check：章节生成保存后会基于本次注入的 Hard Continuity Constraints 返回轻量一致性提醒，第一版只覆盖显式日期、死亡 / 存活状态、身份状态和组织归属冲突；提醒非阻断，不会自动改正文，也不是完整 Consistency Policy / Conflict Detection。
- Story Delta：章节存在后可手动触发第二次分析，生成待审核 Knowledge Draft。
- Knowledge Draft Review & Merge：资料库页支持单条 candidate_change 接受 / 拒绝；第一版只允许 `create_node` / `create_edge` 写入正式 `narrative_graph.json`，拒绝不会写入 graph。
- Review 面板会默认聚焦最新待审核 Knowledge Draft；如果没有待审核 draft，则显示最新 draft。该优化只影响前端选择与列表排序，不改变 accept/reject 语义。
- Event Log + Safety Snapshot：`workspace/books/{book_id}/history/events.json` 记录章节生成、Story Delta、Knowledge Draft review 和 Narrative Graph CRUD 事件；`workspace/books/{book_id}/snapshots/` 保存 Review & Merge accept 与 Narrative Graph update/delete 前的关键 JSON 快照。第一版不提供 rollback / restore UI、diff view、自动清理、Timeline、Health Dashboard、Future Outline Revision、Consistency Policy 或 Advanced Review & Merge。
- AI Run Provenance：`workspace/books/{book_id}/logs/ai_runs/` 保存 AI 调用追溯记录。第一版只接入 `chapter_generation` 与 `story_delta_analysis`，不保存完整 prompt 明文，不保存 API Key，不返回本地绝对路径；Prompt Profile 仅在代码中定义 `chapter_generation_v1` 与 `story_delta_analysis_v1`，Prompt Editor、Timeline、Health Dashboard、Future Outline Revision、Consistency Policy 和 Advanced Review & Merge 仍未实现。
- Chapter Status / Workflow Guard：创作页显示当前章节状态，API 提供 `GET /api/projects/{project_ref}/chapters/{chapter_number}/status`、`GET /api/projects/{project_ref}/chapter-status` 和 `POST /api/projects/{project_ref}/workflow-guard/check`。Workflow Guard 第一版只针对 `generate_chapter` 给出软提醒，不强制阻断；没有可靠持久化 freshness 元数据时，Context Pack 状态显示为 `unknown`，不会误报 stale。Timeline Review、Health Dashboard、Future Outline Revision、Consistency Policy 和 Advanced Review & Merge 仍未实现。
- 暂不支持合并的 operation 会展示但不可接受，包括人物卡写入、`update_node` / `update_edge`、批量接受、自动冲突检测和自动 duplicate resolution。

批量章节生成和独立“一键继续下一章”按钮暂未迁移。

## 当前开发状态

- 新项目默认写入 `workspace/books/{book_id}/`。
- 旧 `outputs/{小说标题}/` 项目继续兼容读取与写入，不会自动迁移、删除或改名。
- UI 已采用“章节创作”流程，大纲与人物卡属于小说设定资产。
- 资料库页已支持 Knowledge Draft 单条审核；模型只提出候选变化，用户接受后才会写入正式 Narrative Graph。
- 写作模式表示叙事节奏/风格；短篇、中篇、长篇由期望章节数自动推导。
- 侧边栏默认保持简洁，环境状态、路径和调试信息位于“高级状态 / 调试信息”折叠区。

## 后续可扩展方向

- 增加分卷规划生成。
- 增加章节改写、润色、扩写模式。
- 增加角色一致性检查 Prompt。
- 增加世界观规则表和禁用设定表。
- 增加多模型切换配置。
- 增加自动生成下一章标题和本章目标。
- 增加导出整本小说为单个 Markdown 文件。
- 增加更细的上下文预算控制。

## 注意事项

- 不要把真实 API Key 提交到 GitHub。
- `.env` 文件只保存在本地。
- 如果生成失败，页面会显示可读错误原因。
- 如果摘要生成失败，章节正文仍会正常保存。

## Story Delta / Knowledge Draft schema alignment

- Story Delta candidate_changes are aligned with Review & Merge.
- New `create_node` payloads use `type`, not `node_type`.
- Legacy `node_type` payloads remain accepted as a compatibility fallback for old drafts.
- First-order `create_world_fact`, `create_foreshadowing`, `create_plot_direction`, and `create_character_card` candidates are normalized into `create_node` where possible.
- `create_edge` can reference existing graph nodes or same-draft node candidates with `source_change_id` and `target_change_id`.
- Story Delta prompt now uses a conservative importance rubric: most future candidate_changes should be 4-7, 8-10 are rare high-priority continuity constraints, and confirmed does not automatically mean high importance. This affects future candidates only; historical Graph data, Context Pack selection, and Hard Constraints extraction are unchanged.
- Story Delta prompt now also applies conservative fact-compression and uncertainty-status guards: candidate changes should distinguish explicit facts from hints, speculation, partial records, and possible links; summaries containing 可能、怀疑、暗示、尚未明确、线索指向, or similar uncertainty markers should usually avoid `confirmed` and use `unresolved`, `partially_revealed`, `introduced`, `active`, or `planned` when appropriate. Story Delta should not rewrite disease names, dates, years, death timing, voting timing, investigation targets, organization actions, or causality. This is prompt guidance only, not a full fact-checking system, and it does not automatically fix or reject candidates.
- Timeline Review, Health Dashboard, Future Outline Revision, Consistency Policy, Advanced Review & Merge, and Streamlit recovery are not implemented in this stage.

## Graph Narrative View / Review Semantic Cards

- The Library page includes a creator-focused Narrative View for Graph records.
- Narrative View groups records as characters, events/scenes, foreshadowing, world rules, plot directions, relationship notes, relationships, and other records.
- Narrative View supports local search and filters by keyword, story asset type, importance, status, and layer; relationship cards stay creator-readable during filtering.
- Relationship cards show node labels instead of raw source/target ids when labels are available.
- Knowledge Draft review cards summarize `create_node` and `create_edge` candidates as story assets and narrative relationships first.
- Operation names, ids, targets, and payload JSON remain available in collapsed Debug details and Raw / Technical View.
- Timeline Review, Health Dashboard, Future Outline Revision, Consistency Policy, Advanced Review & Merge, and Streamlit recovery are not implemented in this stage.

## Context Pack Preview

- The creation page includes a creator-focused Context Pack preview.
- The preview groups selected context as characters, events/scenes, foreshadowing, world rules, plot directions, narrative relationships, and high-priority reminders for the next chapter.
- Relationship cards show source and target labels when available instead of making raw node ids the primary reading surface.
- Raw Prompt / Debug remains available for inspection.
- Context Pack selection is unchanged, but prompt text now separates selected records into Hard Continuity Constraints, Confirmed Facts, and Background Context. Only selected `status=confirmed` records with `importance >= 8` become hard constraints; Graph writes, Story Delta, and Review & Merge behavior are unchanged.
- The chapter generation panel shows whether the current generation will inject the previewed Context Pack. After generation is saved, a lightweight consistency warning pass compares the prose with the injected Hard Continuity Constraints for explicit date, life/death, identity, and organization-affiliation conflicts. Warnings are non-blocking and never rewrite prose; this is not a full Consistency Policy / Conflict Detection system.
- Timeline Review, Health Dashboard, Future Outline Revision, Consistency Policy, Advanced Review & Merge, and Streamlit recovery are not implemented in this stage.
