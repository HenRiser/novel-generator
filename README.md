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
