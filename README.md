# novel-generator

一个本地运行的轻量 AI 小说生成器，使用 Streamlit 提供 Web 页面，通过 OpenAI Python SDK 调用 DeepSeek API。项目面向个人写作和长期迭代：结构清晰、没有数据库、没有用户系统，方便继续扩展 Prompt、生成模式和文件管理能力。

## 功能列表

- 输入小说标题、类型、风格、人物、世界观、核心冲突、目标读者和额外要求。
- 生成小说大纲，保存到 `outputs/小说标题/novel_outline.md` 或自动追加版本号。
- 生成人物卡，保存到 `outputs/小说标题/characters.md` 或自动追加版本号。
- 生成指定章节正文，保存为 `outputs/小说标题/chapters/chapter_001.md`、`chapter_002.md` 等。
- 自动避免覆盖已有文件，例如生成 `chapter_001_v2.md`。
- 章节生成后自动生成 100 字以内摘要，保存到 `outputs/小说标题/summaries/`。
- 自动维护 `outputs/小说标题/chapter_index.md`。
- 支持续写上一章，读取最近一章正文、历史摘要、大纲和人物卡作为上下文。
- 支持白话设定自动扩写，将松散想法拆分为主角、配角、世界观和核心冲突。
- 支持 Prompt 预览，不调用 API，方便调试。
- 支持保存和加载 `outputs/小说标题/project_config.json`。
- API Key 只从环境变量读取，不会写入代码、日志或输出文件。

## 项目结构

```text
novel-generator
├── app.py
├── config.py
├── deepseek_client.py
├── prompt_templates.py
├── file_manager.py
├── requirements.txt
├── README.md
├── .env.example
├── outputs/
│   └── .gitkeep
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
```

启动应用：

```bat
streamlit run app.py
```

打开浏览器中的本地地址，通常是：

```text
http://localhost:8501
```

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

## 白话设定自动扩写

用户可以在页面顶部输入一段松散的故事想法，例如“我想写一个赛博朋克故事，主角是失忆黑客，妹妹失踪了，城市被大公司控制，人的记忆可以被修改，主角要查清真相。”

系统会调用 DeepSeek 自动扩写并拆分成：

- 标题候选和推荐标题
- 主角设定
- 重要配角设定
- 世界观设定
- 故事核心冲突

你可以先点击“预览设定扩写 Prompt”检查即将发送的 messages。确认后点击“自动扩写并填入设定”，扩写结果会自动填入页面对应输入框。之后可以继续手动修改，再生成大纲、人物卡或章节正文。

如果没有填写小说标题，系统会根据白话设定自动生成多个标题候选，并选择一个推荐标题填入标题输入框。如果你已经填写标题，系统不会覆盖，只会展示候选标题供参考。最终 `outputs` 子目录会根据当前标题创建。

如果启用了保存扩写结果，最近一次结果会写入：

```text
outputs/小说标题/setting_expansion_latest.json
```

## 模型切换

项目支持在侧边栏选择 DeepSeek 模型。默认模型为 `deepseek-v4-flash`。

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

每个模型选择项都支持 `custom`。自定义模型名会直接传给 DeepSeek API；如果模型名无效，API 会返回错误，页面会显示错误信息。当前模型设置会保存进当前小说项目的 `project_config.json`。

## 输出目录结构

输出内容会按小说标题分类保存：

```text
outputs/
├── 小说标题/
│   ├── project_config.json
│   ├── novel_outline.md
│   ├── characters.md
│   ├── chapter_index.md
│   ├── setting_expansion_latest.json
│   ├── chapters/
│   │   └── chapter_001.md
│   └── summaries/
│       └── chapter_001_summary.md
```

不同小说的数据互相隔离。一键继续下一章只会读取当前小说项目的 `chapters/`、`summaries/`、`novel_outline.md` 和 `characters.md`。标题中的 Windows 非法路径字符会被自动替换为 `_`，标题为空时使用“未命名小说”。

## 自动章节标题

每次生成章节正文后，系统会再根据本章正文调用模型生成一个章节标题。标题会被清洗并统一写入章节 Markdown 开头，例如：

```text
# 第 1 章：霓虹雨中的旧记忆
```

`chapter_index.md` 也会记录章节标题、章节文件、生成时间、模型和摘要。如果章节标题生成失败，系统会使用“未命名章节”作为兜底标题，不影响章节正文保存。

## 批量章节生成

页面支持批量生成章节：

- 自动续写到第 N 章：根据当前项目已有最新章节，依次生成后续章节。
- 生成指定章节范围：按起始章节到结束章节顺序生成。
- 一次最多生成 5 章，超过限制时不会调用 API。
- 第一版会阻止跳章，范围起点必须是当前最新章节的下一章；如果当前项目没有章节，则只能从第 1 章开始。
- 每章都会顺序读取当前小说项目的上一章正文、历史摘要、大纲和人物卡，并自动生成章节标题、摘要、更新 `chapter_index.md`。
- 如果中途某章正文生成失败，批量生成会停止，已成功保存的章节会保留。

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
