# workspace/books 存储结构迁移设计

## 1. 背景与目标

当前项目使用 `outputs/{小说标题}/` 保存单本小说的数据，包括项目配置、大纲、人物卡、章节正文、章节摘要和章节索引。这个结构简单直观，适合早期本地单用户工具，但它把“显示标题”和“真实目录名”绑定在一起：中文书名、标题修改、同名书籍、Windows 路径限制都会直接影响项目定位。

后续如果继续加入 Writing Skill、偏好学习、`revisions`、`exports`、`logs` 等模块化能力，`outputs/{小说标题}/` 会逐渐承担过多职责。它既是导出输出目录，又是项目身份目录，还要容纳生成过程、编辑版本、技能配置和用户偏好，长期维护成本会升高。

推荐目标是引入稳定的 `book_id`，将新项目保存到：

```text
workspace/books/{book_id}/
```

其中 `book_id` 是不可变项目身份，中文 `title` 只作为显示名称保存到 metadata。这样可以解耦显示标题和真实目录，支持后续标题修改、同名书籍、手动迁移和更清晰的模块化数据结构。

本设计仍以当前产品定位为边界：项目是开源、本地优先、单用户 AI 小说创作工具，不引入多用户系统，不引入数据库，不设计 SaaS 权限模型。

## 2. 当前结构问题

当前实现已经完成了路径入口的初步收口，但仍保留标题驱动路径的核心假设：

- `config.py` 当前根路径仍是 `OUTPUT_DIR = PROJECT_ROOT / "outputs"`。
- `ProjectContext.from_title()` 仍通过 `title` 清洗结果推导 `project_dir`。
- `list_project_titles()` 返回 `outputs` 下的目录名，因此项目列表本质上仍是目录名列表。
- `app.py` 当前 UI 选择已有项目时，仍倾向于把目录名当作 `title` 写回会话状态。
- `save_project_config()`、`save_chapter()`、`save_summary()` 等读写函数仍以 `title` 解析路径。
- `project_config.json` 中保存了 `title`，但该 `title` 同时被 UI 和路径解析间接依赖，容易造成职责混淆。

同时，当前项目有一个有利条件：`file_manager.py` 已成为主要文件读写边界，`export_service.py` 也主要通过 `file_manager.py` 间接受益。这说明迁移不需要在所有业务流程中直接拼接新路径，后续可以优先扩展 `ProjectContext` 和 `file_manager.py`，逐步降低对 UI 和生成逻辑的影响。

## 3. 推荐目标结构

推荐的目标结构如下：

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
        ├── summaries/
        ├── revisions/
        ├── exports/
        ├── logs/
        ├── skills/
        └── preferences/
```

第一阶段只切换外层目录和新增 `book.json`。也就是说，新项目可以先进入 `workspace/books/{book_id}/`，但内部文件名继续保持兼容：

- `project_config.json`
- `novel_outline.md`
- `characters.md`
- `chapter_index.md`
- `setting_expansion_latest.json`
- `chapters/chapter_001.md`
- `summaries/chapter_001_summary.md`

`revisions/`、`exports/`、`logs/`、`skills/`、`preferences/` 是后续能力的预留目录，应按需创建，不建议一开始强行创建。这样可以减少迁移初期的行为变化，避免一次性重排内部文件结构。

## 4. book_id 设计

`book_id` 用于标识单本书项目，是工作区结构中的真实目录名。推荐格式为：

```text
bk_YYYYMMDD_HHMMSS_<8hex>
```

示例：

```text
bk_20260530_134512_a1b2c3d4
```

生成规则：

- 使用 Python 标准库生成，不新增依赖。
- 时间部分使用 `datetime`，便于人工大致判断创建时间。
- 随机部分使用 `secrets.token_hex(4)`，生成 8 位十六进制字符串。
- 如果目标目录已存在，则重新生成随机部分并重试。
- `book_id` 永久不可变。
- `book_id` 不从中文标题生成。
- 修改书名不修改真实目录。
- `title` 只保存在 `book.json`、过渡期的 `project_config.json` 等 metadata 中。

这种设计比直接使用 UUID 更便于本地排查目录，也比标题清洗目录更稳定。

## 5. book.json 设计

`book.json` 是项目身份元数据文件，负责描述书籍身份、存储布局和来源。它不替代 `project_config.json` 的创作配置职责。

新建项目示例：

```json
{
  "schema_version": 1,
  "book_id": "bk_20260530_134512_a1b2c3d4",
  "title": "废土演员",
  "created_at": "2026-05-30T13:45:12+08:00",
  "updated_at": "2026-05-30T13:45:12+08:00",
  "storage": {
    "kind": "workspace",
    "layout_version": 1
  },
  "source": {
    "kind": "new"
  },
  "title_history": []
}
```

从 legacy `outputs` 迁移来的项目示例：

```json
{
  "schema_version": 1,
  "book_id": "bk_20260530_134512_a1b2c3d4",
  "title": "废土演员",
  "created_at": "2026-05-30T13:45:12+08:00",
  "updated_at": "2026-05-30T13:45:12+08:00",
  "storage": {
    "kind": "workspace",
    "layout_version": 1
  },
  "source": {
    "kind": "legacy_outputs",
    "legacy_dir_name": "废土演员",
    "migrated_at": "2026-05-30T13:45:12+08:00"
  },
  "title_history": []
}
```

字段说明：

- `schema_version`：`book.json` 自身 schema 版本。
- `book_id`：不可变项目 ID，必须与目录名一致。
- `title`：用户可见书名，可以是中文，可以修改。
- `created_at`：项目创建时间。
- `updated_at`：metadata 更新时间。
- `storage.kind`：当前为 `workspace`。
- `storage.layout_version`：目录布局版本。
- `source.kind`：项目来源，`new` 表示新建，`legacy_outputs` 表示从旧结构复制迁移。
- `source.legacy_dir_name`：旧 `outputs` 目录名，仅迁移项目需要。
- `source.migrated_at`：迁移时间，仅迁移项目需要。
- `title_history`：标题历史，后续可用于追踪改名。

`project_config.json` 继续保存创作配置，例如类型、风格、人物设定、模型设置和设定扩写选项。过渡期内，`title` 可以同时存在于 `book.json` 和 `project_config.json`，但未来主数据源应倾向于 `book.json.title`；`project_config.json.title` 只作为创作配置兼容字段。

## 6. project ref 设计

为了同时支持 workspace 项目和 legacy 项目，UI 和内部读写不应继续只传递 `title`。推荐引入 project ref：

```text
book:<book_id>
legacy:<legacy_dir_name>
```

示例：

```text
book:bk_20260530_134512_a1b2c3d4
legacy:废土演员
```

设计原则：

- workspace 项目 ref 使用 `book:<book_id>`。
- legacy 项目 ref 使用 `legacy:<legacy_dir_name>`。
- UI 显示 `title`，但内部选项值使用 ref。
- 同名项目必须能区分，例如显示为 `废土演员（workspace）` 和 `废土演员（legacy）`。
- ref 只作为内部标识，不作为真实路径名。
- ref 不应暴露给普通用户作为主要交互内容，除非在调试信息或高级信息中展示。

这种 ref 层能让 `ProjectContext` 从“根据 title 推导路径”升级为“根据 ref 解析项目”。后续无论项目来自新 workspace 还是旧 outputs，都可以得到统一的 `project_dir`、`chapters_dir`、`summaries_dir`、`config_path` 等路径。

## 7. legacy outputs 兼容策略

legacy 兼容策略应以“不丢数据、不强制迁移、不破坏旧工作流”为原则：

- 保留 `outputs/`。
- 不自动删除旧项目。
- legacy 项目继续读写原目录。
- 新项目默认进入 `workspace/books/{book_id}/`。
- 新增 `list_projects()` 合并 workspace 和 legacy 项目。
- `ProjectContext` 从 title 推导升级为从 ref 解析。
- `ProjectContext.from_title()` 保留为 legacy 兼容入口，短期内服务旧函数包装层。

建议的数据来源优先级：

1. workspace 项目从 `workspace/books/*/book.json` 读取 title 和 metadata。
2. legacy 项目从 `outputs/*` 扫描目录名，必要时读取 `project_config.json.title` 作为显示标题。
3. 如果 legacy 项目没有配置文件，则使用目录名作为显示标题。

兼容期内，旧函数可以保留：

```text
save_chapter(title, ...)
load_project_config(title)
list_project_titles()
```

但内部应逐步迁移到：

```text
save_chapter_by_ref(project_ref, ...)
load_project_config_by_ref(project_ref)
list_projects()
```

旧函数只作为 wrapper 存在，避免一次性修改所有调用点。

## 8. 迁移策略比较

| 策略 | 做法 | 优点 | 缺点 | 推荐结论 |
| --- | --- | --- | --- | --- |
| 不迁移，仅新项目用新结构 | 旧项目继续留在 `outputs/`，新项目进入 `workspace/books/{book_id}/` | 风险最低；不会写旧数据；容易回滚；适合第一阶段 | 双结构会并存一段时间；列表和 UI 需要兼容两类项目 | 第一阶段采用 |
| 手动迁移 | 用户主动选择某个 legacy 项目，系统复制到 workspace 并写入 `book.json` | 用户可控；可做迁移前后校验；失败时仍可用旧目录 | 需要新增迁移入口、校验逻辑和状态提示 | 第二阶段提供 |
| 自动迁移 | 启动时自动把 `outputs/*` 转为 workspace 项目 | 结构统一最快；用户无需理解迁移 | 启动即写数据；冲突、失败和回滚风险高；网络盘或 ECS 环境更难排查 | 现在不做 |

推荐结论：

- 第一阶段采用“不迁移，仅新项目用新结构”。
- 第二阶段提供“手动迁移”。
- 现在不做“启动即自动迁移”。

## 9. 分阶段实施路线

### 阶段 0：当前状态

当前项目已有 `ProjectContext`，并且 `file_manager.py` 已成为主要路径边界。这个状态适合继续向下收口路径能力，不适合直接移动目录。

### 阶段 1：双结构基础

本阶段目标是让代码理解 workspace 和 legacy 两种存储结构，但不切换 UI 行为。

建议内容：

- 新增 workspace 常量，例如 `WORKSPACE_DIR`、`BOOKS_DIR`。
- 新增 `book_id` 生成器。
- 新增 `book.json` 读写函数。
- 扩展 `ProjectContext`，支持 workspace / legacy 双模式。
- 保留 `from_title()` 作为 legacy 兼容入口。
- 不改 UI 项目选择方式。
- 不迁移已有 `outputs`。

### 阶段 2：项目列表与 ref

本阶段目标是让项目选择从 `title` 过渡到 project ref。

建议内容：

- 新增 `list_projects()`，返回统一项目描述，例如 `ref`、`kind`、`title`、`book_id`、`project_dir`。
- UI 项目选择的选项值从 title 改为 ref。
- UI 显示仍使用 title，同名项目追加来源说明。
- 新建项目默认进入 workspace。
- legacy 项目仍可读写。

### 阶段 3：file_manager ref 化

本阶段目标是让文件读写边界内部统一解析 project ref。

建议内容：

- 在 `file_manager.py` 内部统一通过 `project_ref` 获取 `ProjectContext`。
- 新增 ref 版读写函数。
- 旧 title API 保留 wrapper，降低一次性修改面。
- 导出与阅读中心继续通过 `file_manager.py` 读取章节。

### 阶段 4：UI 状态调整

本阶段目标是消除 UI 中“标题就是项目身份”的假设。

建议内容：

- 将 `selected_project_title` 迁移为 `selected_project_ref`。
- `title` 输入框只表示显示标题。
- 加载 `project_config.json` 时兼容旧字段。
- 保存项目配置时同步更新 `book.json.title` 和过渡期 `project_config.json.title`。
- 当前项目状态展示真实项目目录，但普通用户主要看到标题。

### 阶段 5：手动迁移工具

本阶段目标是提供可控迁移，而不是静默自动迁移。

建议内容：

- 用户选择 legacy 项目后，可以手动触发迁移。
- 迁移时复制 legacy 目录到新的 `workspace/books/{book_id}/`。
- 写入 `book.json`，记录 `source.kind = "legacy_outputs"`。
- 校验迁移前后关键文件和文件数量。
- 不删除旧 `outputs`。
- 迁移失败时提示继续使用 legacy 项目。

### 阶段 6：稳定后策略

当 workspace 结构稳定后，可以考虑：

- 对 legacy 项目显示迁移提示。
- 可选地将 legacy 标记为只读，但不应作为第一阶段行为。
- 仍不做静默自动迁移。

## 当前实现进度

阶段 1 基础设施已完成：

- 已新增 `WORKSPACE_DIR` 和 `BOOKS_DIR` 常量。
- 已新增 `book_id` 生成器。
- 已新增 `book.json` metadata 构造、读取、写入、校验和更新时间能力。
- `ProjectContext` 已具备 legacy / workspace 双模式表达能力。
- `ProjectContext.from_title()` 仍保持 legacy 行为。
- `ProjectContext.from_book_id()` 可读取 workspace book metadata。

阶段 2 基础能力已完成：

- 已新增 `ProjectRecord` 轻量项目记录。
- 已新增 `list_projects()`，可合并 legacy outputs 项目和 workspace books 项目。
- 已新增 project ref 解析能力，支持 `legacy:<legacy_dir_name>` 和 `book:<book_id>`。
- 已新增从 project ref 解析 `ProjectContext` 的能力。
- `list_project_titles()` 仍作为 legacy compatibility API 保留，旧 UI 行为不变。

当前仍未启用完整迁移；新项目默认保存位置仍是 `outputs/{小说标题}/`，旧 `outputs` 项目不会被自动迁移。

## 10. 影响面分析

### ProjectContext

`ProjectContext` 是迁移核心。它需要从单一 `title -> outputs/{safe_title}` 模型扩展为：

- `book:<book_id> -> workspace/books/{book_id}`
- `legacy:<legacy_dir_name> -> outputs/{legacy_dir_name}`

它仍应只负责路径和轻量 metadata，不应承担生成、导出、Prompt 或 UI 状态职责。

### file_manager.py

`file_manager.py` 是主要读写边界，应优先支持 ref 化。`save_project_config()`、`load_project_config()`、`save_chapter()`、`read_chapter()`、`find_latest_chapter()`、`save_summary()` 等函数最终应有 ref 版本。

旧 title 版本短期保留，避免一次性修改所有调用点。

### export_service.py

`export_service.py` 当前通过 `file_manager.py` 获取章节，迁移影响较小。需要注意整本 TXT 导出的书名不应变成 `book_id`，应从 `book.json.title` 或兼容 title 字段读取显示标题。

### app.py 项目选择

项目选择是 UI 影响最大的区域。当前选择值倾向于目录名或 title，后续应改为 project ref。显示层继续展示用户可读标题，同名项目用来源后缀区分。

### 导出与阅读中心

阅读中心应继续依赖章节列表和章节读取函数，不直接关心目录结构。需要改造的是传入参数从 title 逐步变成 project ref。

### TXT 下载文件名

下载文件名应继续使用显示标题清洗结果，不使用 `book_id`。如果标题为空，则使用兜底标题。

### Quick Start 文案

Quick Start 不受存储结构直接影响。需要修改的只是帮助文案中的输出目录说明，从 `outputs/小说标题/` 调整为“新项目默认保存到 workspace，旧项目仍兼容 outputs”。

### 设定输入与智能扩写

设定扩写本身不依赖目录结构。保存 `setting_expansion_latest.json` 时应通过 ref 找到当前项目目录。标题候选仍只是显示标题候选，不能直接创建目录。

### 章节生成

章节生成保存正文、摘要、索引时通过 `file_manager.py` 访问路径，因此主要影响在 file_manager ref 化。生成逻辑不应直接关心 workspace 或 legacy。

### 一键续写

一键续写依赖 `find_latest_chapter()`、`read_previous_chapter()`、`read_history_summaries()` 和 `load_project_config()`。这些函数支持 ref 后，一键续写逻辑可以保持基本不变。

### 批量生成

批量生成依赖最新章节号和顺序保存。只要章节扫描和保存函数正确解析 ref，批量生成不需要理解底层存储结构。

### README

README 应在实际功能落地时更新存储结构说明。设计阶段可以只增加设计文档链接；如果尚未实现功能，不应提前把 README 改成已支持 workspace。

## 11. 风险清单

| 风险 | 说明 | 缓解方式 |
| --- | --- | --- |
| 同名书冲突 | workspace 和 legacy 可能存在相同 title | UI 使用 ref 作为值，显示时追加来源说明 |
| 中文标题路径兼容 | 旧项目仍可能依赖中文目录 | legacy 保持原目录读写，不强制改名 |
| 标题修改导致误写目录 | 当前 title 改变可能推导出新目录 | 新结构以 book_id 定位，title 只做 metadata |
| legacy / workspace 双份数据混淆 | 手动迁移后可能有两份同名书 | `source` 记录来源，UI 显示来源，迁移后给出明确提示 |
| 导出标题变成 book_id | 如果导出只拿目录名，可能使用 ID | 导出标题从 metadata 读取 |
| 旧项目无法加载 | ref 解析不兼容旧目录 | 保留 `from_title()` 和 legacy resolver |
| ECS 上已有 outputs 数据不能丢 | 服务器或本地已有历史输出 | 不删除 `outputs`，迁移只复制 |
| 手动迁移中断 | 复制过程失败可能产生半成品 | 使用临时目录或迁移状态文件，成功后再标记可用 |
| 回滚困难 | 如果直接移动目录，回滚成本高 | 不移动旧目录，保留 legacy 可用 |
| UI 中 ref 泄露给普通用户造成困惑 | `book:...` 不适合作为主要显示文本 | UI 显示 title，ref 只作为内部值 |

## 12. 防丢失与回滚方案

防丢失原则：

- 迁移只复制，不移动。
- 不删除 `outputs`。
- 不覆盖已有 workspace 项目。
- 迁移前生成 legacy 文件清单。
- 迁移后生成 workspace 文件清单。
- 校验关键文件和文件数量，例如 `project_config.json`、`chapters/`、`summaries/`、`chapter_index.md`。
- 迁移失败时继续使用 legacy 项目。

回滚方案：

- 如果 workspace 解析出现问题，可以关闭 workspace 项目列表，只回到 legacy resolver。
- 因为旧 `outputs` 未删除，旧项目仍可按原结构使用。
- 对已经创建的 workspace 新书，可以提供“导出为 legacy layout”作为补救方向，将 `workspace/books/{book_id}/` 的兼容文件复制到 `outputs/{title}/`。
- 不使用 `git reset` 或删除用户数据作为回滚手段。

## 13. 不建议现在做的内容

当前不建议做以下内容：

- 不做启动自动迁移。
- 不做数据库。
- 不做多用户。
- 不做 SaaS 权限模型。
- 不一次性重排内部文件结构。
- 不把 Writing Skill、偏好学习、revision 一次性实现。
- 不做完整前后端分离。
- 不把 `outputs` 立即改成只读。
- 不删除或清空 legacy 项目。

这些能力可以在 workspace 基础稳定后逐步设计，但不应阻塞当前路径迁移。

## 14. 最终建议

可以开始准备 `workspace/books`，但第一步应是双结构兼容层，而不是直接迁移目录。

推荐最终实施顺序：

```text
ProjectContext 双模式
-> list_projects/ref
-> 新项目默认 workspace
-> file_manager 兼容
-> UI 状态调整
-> 手动迁移工具
```

这个顺序的核心优点是：旧项目始终可读写，新项目逐步进入稳定 ID 结构，迁移失败时仍能回到 legacy 工作流。对于当前本地优先、单用户、无数据库的项目，这是风险最低且最容易验证的路径。
