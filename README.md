# novel-generator

一个本地运行的轻量 AI 小说生成器，使用 Streamlit 提供 Web 页面，通过 OpenAI Python SDK 调用 DeepSeek API。项目面向个人写作和长期迭代：结构清晰、没有数据库、没有用户系统，方便继续扩展 Prompt、生成模式和文件管理能力。

## 功能列表

- 输入小说标题、类型、风格、人物、世界观、核心冲突、目标读者和额外要求。
- 生成小说大纲，保存到 `outputs/novel_outline.md` 或自动追加版本号。
- 生成人物卡，保存到 `outputs/characters.md` 或自动追加版本号。
- 生成指定章节正文，保存为 `outputs/chapter_001.md`、`outputs/chapter_002.md` 等。
- 自动避免覆盖已有文件，例如生成 `chapter_001_v2.md`。
- 章节生成后自动生成 100 字以内摘要，保存到 `outputs/summaries/`。
- 自动维护 `outputs/chapter_index.md`。
- 支持续写上一章，读取最近一章正文、历史摘要、大纲和人物卡作为上下文。
- 支持 Prompt 预览，不调用 API，方便调试。
- 支持保存和加载 `outputs/project_config.json`。
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
