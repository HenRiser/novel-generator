# novel-generator

[中文](README.md) | [English](README.en.md)

一个本地运行的轻量 AI 小说生成器，使用 Streamlit 提供 Web 页面，通过 OpenAI Python SDK 调用 DeepSeek API。项目面向个人写作和长期迭代：结构清晰、没有数据库、没有用户系统，方便继续扩展 Prompt、章节创作流程和文件管理能力。

## 功能列表

- 输入小说标题、类型、风格、人物、世界观、核心冲突和额外要求。
- 大纲生成，新项目保存到 `workspace/books/{book_id}/novel_outline.md`，旧项目继续兼容 `outputs/小说标题/novel_outline.md`，并自动追加版本号。
- 人物卡生成，新项目保存到 `workspace/books/{book_id}/characters.md`，旧项目继续兼容 `outputs/小说标题/characters.md`，并自动追加版本号。
- 生成指定章节正文，新项目保存为 `workspace/books/{book_id}/chapters/chapter_001.md`、`chapter_002.md` 等，旧项目继续兼容 `outputs/小说标题/chapters/`。
- 自动避免覆盖已有文件，例如生成 `chapter_001_v2.md`。
- 章节生成后自动生成 100 字以内摘要，保存到当前项目的 `summaries/`。
- 自动维护当前项目的 `chapter_index.md`。
- 支持续写上一章，读取最近一章正文、历史摘要、大纲和人物卡作为上下文。
- 支持设定输入与智能扩写，可将一句话灵感、白话梗概或完整企划整理为主角、配角、世界观和核心冲突。
- 支持 Prompt 预览，不调用 API，方便调试。
- 支持保存和加载当前项目的 `project_config.json`；新项目默认位于 `workspace/books/{book_id}/`。
- 支持 Quick Start Wizard，在 UI 中配置 DeepSeek API Key、默认模型并测试连接。
- 支持日常 API / 模型设置入口，可修改 API Key、Base URL、默认模型和自定义模型名。
- API Key 从环境变量或本地 `.env` 读取；Quick Start 可将 Key 保存到本地 `.env`，不会写入代码、日志或输出文件。

## 项目结构

```text
novel-generator
├── app.py
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

启动应用：

```bat
streamlit run app.py
```

打开浏览器中的本地地址，通常是：

```text
http://localhost:8501
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

启动应用：

```bat
start.bat
```

`start.bat` 会激活虚拟环境、启动 Streamlit，并自动打开：

```text
http://localhost:8501
```

如果启动失败：

- 确认已经运行 `setup.bat`。
- 确认 Python 已加入 PATH。
- 确认 `.env` 中已填写 `DEEPSEEK_API_KEY`。
- 如果 8501 端口被占用，可以手动运行：

```bat
streamlit run app.py --server.port 8502
```

仍然可以使用手动启动方式：

```bat
cd /d D:\vibecoding\novel-generator
.venv\Scripts\activate
streamlit run app.py
```

## Quick Start

首次启动后，如果没有检测到有效的 DeepSeek API Key，页面会自动显示 Quick Start Wizard。

Quick Start 支持：

1. 在 UI 中输入 DeepSeek API Key。
2. 选择 `deepseek-v4-flash`、`deepseek-v4-pro` 或 `custom` 模型。
3. 点击“测试连接”验证 API Key 和模型是否可用。
4. 测试成功后保存配置。
5. 将 API Key 保存到本地 `.env`。
6. 将 Base URL 写入 `.env` 中的 `DEEPSEEK_BASE_URL`。
7. 将默认模型写入 `.env` 中的 `DEFAULT_MODEL`。

`.env` 只应保存在本地，不应提交到 Git。

## API Key 安全说明

本项目定位为本地单用户工具，不包含用户系统和公网多用户部署配置。

- API Key 可通过 Quick Start 保存到本地 `.env`，也可由环境变量提供。
- `.env` 已被 `.gitignore` 排除，不应提交到仓库。
- 页面不会显示已有 API Key 明文。
- API Key 不会写入 `project_config.json`。
- 如果需要更换 API Key、Base URL 或默认模型，可以使用侧边栏的“API / 模型设置”，也可以重新打开 Quick Start。

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

## 设定扩写配置

设定扩写支持快速配置和高级配置。快速配置包括小说类型、写作风格、写作模式和期望章节数。

高级配置默认折叠，包括剧情密度、叙事节奏、世界观复杂度、角色规模、大纲粒度和额外创作要求。期望章节数会影响大纲规模、角色数量、世界观复杂度和叙事节奏，普通用户只使用快速配置即可。

## API / 模型配置

项目支持在侧边栏选择 DeepSeek 模型。默认模型为 `deepseek-v4-flash`，Base URL 默认为 `https://api.deepseek.com`。

首次使用可以通过 Quick Start 配置 API Key 和默认模型；日常修改可以使用侧边栏的“API / 模型设置”入口。该入口包含 API Key 输入、Base URL、默认模型选择、自定义模型名、连接测试入口和保存配置按钮。

内置可选模型为：

- `deepseek-v4-flash`
- `deepseek-v4-pro`

侧边栏默认开启“使用统一模型”，开启后所有任务共用同一个模型。关闭统一模型模式后，可以分别设置：

- 设定扩写模型
- 大纲生成模型
- 人物卡生成模型
- 章节正文生成模型
- 章节标题生成模型
- 章节摘要生成模型

每个模型选择项都支持 `custom`。自定义模型名会直接传给 DeepSeek API；如果模型名无效，API 会返回错误，页面会显示错误信息。当前任务模型设置会保存进当前小说项目的 `project_config.json`，默认模型和 Base URL 会保存进本地 `.env`。

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

旧版 `outputs/小说标题/` 项目仍会出现在项目列表中，并继续按原目录读写；系统不会自动迁移、删除或改名旧项目。不同小说的数据互相隔离。一键继续下一章只会读取当前小说项目的 `chapters/`、`summaries/`、`novel_outline.md` 和 `characters.md`。新项目标题为空时使用“未命名小说”作为显示标题。

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

页面中的正文生成入口集中在“章节创作”区域：

- 一键继续下一章：根据当前项目已有最新章节，生成最大章节号 + 1。
- 指定章节：使用用户输入的章节编号生成正文。
- 批量章节：按起始章节到结束章节顺序生成。
- 一次最多生成 5 章，超过限制时不会调用 API。
- 第一版会阻止跳章，范围起点必须是当前最新章节的下一章；如果当前项目没有章节，则只能从第 1 章开始。
- 每章都会顺序读取当前小说项目的上一章正文、历史摘要、大纲和人物卡，并自动生成章节标题、摘要、更新 `chapter_index.md`。
- 如果中途某章正文生成失败，批量生成会停止，已成功保存的章节会保留。

## 当前开发状态

- 新项目默认写入 `workspace/books/{book_id}/`。
- 旧 `outputs/{小说标题}/` 项目继续兼容读取与写入，不会自动迁移、删除或改名。
- UI 已采用“章节创作”流程，大纲与人物卡属于小说设定资产。
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
