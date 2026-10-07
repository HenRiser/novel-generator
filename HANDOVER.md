# Braipen 项目交接文档

> 更新时间：2026-10-08（Asia/Shanghai）。工作目录：`D:\vibecoding\novel-generator`。
> 面向接手的新对话：先核对 Git 状态和源码，再据此继续工作。本文记录现状与历史决策；与源码冲突时以源码为准，后续用户的新指令优先。

## 0. 接手前必须知道的现状

- 当前分支：`codex/chapter-planning`。
- 本轮封面开发基线：`b5de406e797356172846933329d9ca2852b3bf78`，提交摘要为“feat: 按项生成故事设定并简化模型连接操作”。**这不是本轮最终发布 SHA**；当前 HEAD、最终提交、远端分支和线上版本须分别核对 Git 与部署的 `RELEASE` 标记。
- 远程：`https://github.com/HenRiser/novel-generator.git`。
- 最新封面生成、原图修改、版本选择、网站展示和媒体备份已完成本地验收及独立代码审查。**不能从本文推定已完成 commit、push 或部署**，最终结果以 Git、`RELEASE` 和发布报告核验为准。
- **不要清理工作区、回退文件或丢弃未跟踪文件。** 新对话须先运行 `git status --short`，保护已有成果。
- 当前主产品路径是 **React 浏览器本地项目 + IndexedDB + FastAPI 请求内计算**。旧 `.env` / JSON / Markdown 文件项目服务仍保留作兼容，不是公网产品的正式存储路径。
- 最新本地验证：后端 **386/386**、Node **128/128**、封面 Edge **9/9**、文字连接回归 **16/16**、真实 IndexedDB 媒体事务综合验证，以及类型检查、生产构建通过。模型请求均为模拟，**不能据此声称真实模型质量或线上部署已通过**。原图编辑、备份字节、预览缩放与原尺寸导出均有验证；真实调用与发布证据见 `reports/cover-delivery-2026-10-08/`。
- 当前目标是发布封面制作流程，并用用户授权的 Seedream 验证生成图片在网站可见。默认输入为白话设定与人物卡，不读取大纲、不做剧透筛选；角色视觉参考卡暂不做。**基于已有大纲预测后续章节、可考虑 JEV** 保留为另行待办。
- 用户已明确授权本轮分步实施、独立审查、推送部署，并要求使用刚才验证过的火山方舟 Seedream 方式生成图片且在网站可见。不要把该授权扩展为其他供应商或大规模付费测试。发布是否成功仍须实际核验，后续不重复询问已授权步骤。

## 1. 项目意义与用户目标

Braipen 是一个 AI 辅助长篇创作工作台，正式前端为 React，后端为 FastAPI。项目最初用于校招简历；用户已经拿到 offer，希望继续将它打磨成能公开展示的 AI 应用与 Agent 系统工程产物。

用户的主要兴趣是 AI 应用与 Agent 工程，并非单纯追求 AI 写小说。后续规划应围绕可控流程、上下文与信息边界、人工审核、可恢复执行和工程验证展开。不能仅靠更换框架名称、增加图谱视觉效果或堆提示词宣称技术壁垒。

当前已形成的产品价值：作者定义章节目标与约束，模型提供候选；正文、摘要、知识、批准版本和执行记录各有明确责任。小说创作是应用场景，长期目标是形成可信、可解释且便于展示的 AI 工作流。

## 2. 当前架构与数据责任

```text
React / TypeScript
  ├─ IndexedDB：项目、章节、摘要、图谱、批准历史、运行记录、导入草稿
  ├─ Key Vault：标签页内存 Key / 可选口令加密记住
  ├─ 浏览器工作流：项目锁、版本校验、取消、确认、连续生成、手动恢复
  └─ computeClient：请求级连接与凭据、v2身份/指纹、JSON/NDJSON
       ↓
FastAPI /api/compute/*：临时计算，不持久化正式项目、Key或后台任务
  ├─ 领域规则、ContextPack、StoryDelta、审核
  ├─ 请求内 LangGraph 章节策划
  └─ model_client + provider_transport：两种协议、安全出口、限时与用量统计
       ↓
用户选择的模型服务商
```

### 2.1 浏览器存储

- `frontend/src/localStore.ts`：数据库名 `braipen.local.v1`，**IndexedDB 版本为 3**；包含 `projects`、`imports`、`settings`、`cover_media` 四个 store。
- `frontend/src/localTypes.ts`：`LocalProject.schema_version = 2`。项目内有 config、assets、chapters、graph/views、任务与场景历史、知识草稿、事件、快照、运行记录和批次状态。
- `updateProject` 在同一事务内检查项目 revision，并可同时检查连接 guard。回调必须同步；不可把 `await` 放进 IndexedDB mutation 回调。
- 完整 JSON 备份版本为 3，兼容 v1/v2，包含独立编码的封面媒体字节。恢复副本会重映射项目、连接、图片版本、父版本和媒体标识；恢复的连接默认禁用，Key 不随备份恢复。**未完成的导入草稿位于 imports store，不包含在完整项目备份中**。
- 浏览器存储属于 origin；更换域名、协议或端口会得到不同数据库。不能把“数据没了”直接归因于服务器。
- `api.ts` 除健康检查外将原 API 样式业务调用转交 `localApi`；`computeClient`、`providerConnections` 另有实际 HTTP 请求，不要误以为所有请求都由 api.ts 单独发送。

### 2.2 后端与公网模式

- `api/main.py`：`BRAIPEN_PUBLIC_MODE=1` 时，放行 `/api/health`、`/api/capabilities`、`/api/compute/*`，隐藏 OpenAPI/文档，其他旧 `/api/*` 业务路径被边界中间件阻止。
- 非公网模式仍保留旧文件项目、配置、章节和审核接口；不要未经设计删除兼容服务。
- `api/routers/compute.py`：协议版本 2；模型请求携带当次 credentials 和 connection，计算结果回显任务身份和三类指纹。
- 文字请求最多 **1 MiB**；图片请求独立限制为 **12 MiB**、单张原图/结果 **8 MiB**；模型调用每次最多 **120 秒**，计算执行预算 **180 秒**，共享最多 **2 个并发模型请求**。策划流与图片成功响应覆盖真实 ASGI 发送和取消清理；图片错误小 JSON 有最多 1 秒发送宽限。取消清理可能超过截止，不能宣称整次 HTTP 交互必在 180 秒内结束。生产目前应使用单 worker；多 worker 需先解决共享 admission。
- 断连和取消传播到上游，清理后释放 admission。JSON/NDJSON 响应设置 `no-store`、`no-transform` 和 `X-Accel-Buffering: no`；真实反代缓存/缓冲行为仍需部署验收。不得添加依赖用户小说数据的服务器后台任务。
- v2 计算路径使用请求级配置，不回退服务器共享 Key。应用代码不主动将完整 prompt、原始 provider 错误、Key 或小说项目副本持久化到服务器日志/文件；反代日志、系统转储和其他中间层是否留存，本轮未在线核验。
- 发布准备修复：`api/main.py` 的公网边界改为纯 ASGI `PublicBoundaryMiddleware`，直接传递真实 `receive/send`，避免函数式HTTP中间件引入内部缓冲后使发送超时与槽位释放脱离真实连接。公网路径隔离、OPTIONS/CORS、非公网旧接口及异常JSON语义保留；已新增完整 `api.main.app` 的慢响应头/慢body与取消清理回归，线上反代仍需发布验收。
- Linux Python3.12候选验收发现锁定LangGraph会把节点取消包装为`NodeCancelledError`；JSON与流两条路径均精准转回`asyncio.CancelledError`，保持清理、一次调用和不重试语义。新增跨版本包装取消回归；Linux候选仍须在最终提交上实际验收，不能用本地结果代替。

## 3. 模型连接与 Key

当前不是 DeepSeek 单服务商项目。`provider_catalog.py` 提供八类预设：DeepSeek、Qwen、Kimi、GLM、OpenAI、Gemini、Claude、OpenRouter，另支持 Custom。

- 两种显式协议：OpenAI Chat Completions 与 Anthropic Messages。
- 结构化能力：`json_schema`、`json_object`、`prompt_only`、`unsupported`。预设与有限模型规则不代表所有模型均兼容；未知能力需显式配置。
- 模型可手填；连接可列目录、检测文字/结构化能力。作品模型可以覆盖连接默认模型。
- `ConnectionSnapshot` 冻结地址、协议、实际模型、参数策略和认证方式；`destination_fingerprint`、`execution_fingerprint`、`request_fingerprint` 防止配置或结果错配。
- `ConnectionGuard` 记录 profile、epoch、目标指纹和 key_version。新请求及权限撤销后晚到的结果须通过连接guard；撤销前已合法保存的完整结果可按版本恢复，策划采纳另需显式续授权。
- v2 Key 为通用 ASCII 认证文本，不应恢复成“必须 sk- 开头”的旧校验。
- `keyVault.ts`：默认每连接在标签页内存使用；可选 PBKDF2-SHA256（600000次）+ AES-256-GCM 加密记住，AAD 绑定连接/协议/地址；口令和派生密钥不持久化。
- Custom 接受公网 HTTPS Base URL；禁止 userinfo、query、fragment、歧义路径、重定向、环境代理和内部/保留地址。出口逐次验证 DNS 全部结果并固定数值 IP，保留 Host/SNI。
- **Custom 执行需要管理员配置 `BRAIPEN_SELF_ADDRESSES`**，用于排除服务器自身地址。本交接不写真实服务器连接资料、Key、密码、私钥或 `.env` 内容。

说明文档：`docs/provider-connections.html`。核心代码：`provider_catalog.py`、`model_client.py`、`provider_transport.py`、`frontend/src/providerConnections.ts`、`providerTypes.ts`、`keyVault.ts`。

### 3.1 图片连接与封面

- 图片目录与文字目录分开，预设 Seedream（火山方舟）、OpenAI、Gemini、百炼，另有 Custom。共用每连接会话 Key、可选加密记住及撤销 guard，图片连接不会进入文字模型选择器。
- `image_provider.py`、`api/routers/image_compute.py` 提供 `/api/compute/images/{validate_connection,models,generate,edit}`。Seedream 默认 `doubao-seedream-5-0-flash-260915`，使用 `/api/v3/images/generations`，`response_format=url`、`size=2K`、`stream=false`、`watermark=true`。编辑携带原图。
- 四预设展示官方建议模型，不代表账号权限验证；Custom 可获取目录，也可手填。OpenAI 的 2K 档位映射为 `1024x1536`，不应宣传所有供应商均原生输出 2K。
- 结果 URL 通过独立无凭据安全客户端及时下载，不将签名 URL 存成资产或转交浏览器。出口复用公网 DNS 校验、固定 IP、无重定向及自身地址排除。
- `CoverPanel` 将结果存为候选，作者明确设为封面后，在创作台、概览和阅读页显示。封面不改人物卡或正文；书名/作者由同一 Canvas 绘制函数预览和导出，不再调用模型。
- 媒体 Blob 独立存储，项目 `cover` 仅含引用、来源和排版。单图 8 MiB、单作品 30 版本、备份媒体总量 120 MiB。缩略图按展示尺寸绘制，导出保留原尺寸。
- 图片任务使用作品 Web Lock，来源在生成时冻结；封面保存不递增文字 revision，避免影响正在写作的章节。页面中断/刷新后的结果标记未知，不自动重试或保证供应商停止计费。旧任务收尾只更新对应 attempt。
- 部署时仅 `/api/compute/images/` 的代理上传限制提高到 12 MiB，文字请求保留 1 MiB；保持关闭缓冲与现有超时设置。

## 4. 当前已实现的业务流程

### 4.1 创作与确认

- 灵感/白话设定扩写、大纲和人物卡、手工任务单和场景计划、正文流式生成、章内续写、阅读和导出均已接入浏览器数据路径。
- 正文先保存为 `awaiting_confirmation`，用户阅读、修改并确认之后才生成摘要/检查。
- 摘要与检查在浏览器页面存活期间异步运行；页面关闭不会由服务器继续代跑。
- 前文须连续、已确认且摘要 ready，才能推进下一章。下一章的流式 started 事件引用前文时，前章被持续锁定。
- 连续生成已实现：每批 1–10 章，仅顺序追加；逐章生成、确认、摘要后推进，可停止/中断并手动恢复。
- Web Locks 项目锁 + BroadcastChannel 协调多标签；保存结果使用 revision/attempt/guard 防止旧结果覆盖。
- 已保存的完整结果可直接恢复应用，不再调用模型；未知结果的重试可能再次计费，必须由用户明确触发。

### 4.2 记忆与审核

- Narrative Graph、Context Pack、Story Delta、Knowledge Draft 审核与合并、事件、快照和运行记录保留。
- Story Delta 是独立操作，不应无设计地插入正文每一步；已有 `next_chapter_proposal` 可供后续功能考虑复用。
- 知识草稿需要作者接受后才进入正式图谱。当前合并主要是创建节点/边，不能称为完整实体更新、归并或历史事实版本系统。
- 当前 ContextPack 本身**没有完整 as_of_chapter 时态过滤**；chapter_number 不能自动隔离所有后文。LangGraph 策划另做来源筛选，不能把它误认为全局时态图谱已完成。
- 模型推理内容只临时展示，不写入正式正文、项目备份或服务器文件。
- 稳定前缀、缓存用量和正文首段/整章耗时已有工程基础；指标用于后续优化，不等于真实性能已经完成评测。

### 4.3 TXT / Markdown 导入

- `novelImport.ts`、`NovelImportPanel.tsx` 支持 TXT/MD、编码处理和章节边界预览。
- 当前限制：文件 10 MiB；选定连续前缀最多 50 章、累计20万非空白字符、单章2万字符。
- **先选择第 N 章作为续写边界，再分析 1…N**。N+1 之后内容仅在本地原文档案中保存，不能进入模型分析或正式前文事实。
- 逐章提取摘要与候选、证据和作者审核，之后综合设置与写作资产，创建独立本地项目。
- 导入章为 confirmed / summary ready / source_locked；从 N+1 继续写。原文、编码、边界、hash、审核记录留在本地来源档案。
- 导入关系当前存为 `relationship_note` 节点，不等于已经构建了全部关系边；别名冲突不能自动无审合并。

## 5. 最新 LangGraph 章节策划与节点进度：实现完成

### 5.1 范围

新增可选的一键策划下一章。**只允许最新连续已确认、摘要就绪前缀之后的尚未生成章节**；空项目可策划第1章。

```text
作者意图 + 显式约束 + 已审核前缀
  → ContextPack → 一次初稿 → 确定性规则检查
                    ├ 合格 → draft_ready
                    └ 明确错误 → 最多一次修订 → 再检查
                                            → draft_ready / needs_user_decision

浏览器保存候选
  → 显式保存任务草稿 → 作者批准任务
  → 当前任务内容重验 + 来源指纹复验 → 绑定真实任务ID/revision
  → 保存场景草稿 → 作者单独批准场景 → 原正文生成
```

- 最多两次模型调用：初稿4000 tokens/0.3，修订4000/0.1，遵守连接温度固定/省略规则。身份、网络、额度、截断错误不自动重试。
- 两轮计算共享180秒执行预算；策划流的解析、绝对截止与清理边界见2.2节。图无持久 checkpointer、interrupt等待作者、node cache、自动retry或远程追踪。
- graph State 仅留必要白名单数据；模型Key在闭包。全新 contextvars.Context + `tracing_context(enabled=False,parent=False)` 隔离环境与父追踪；单独 `callbacks=[]` 不够。
- `draft_ready` 只表示确定性规则通过，**不证明自由文本逻辑正确，不代表作者已批准**。
- 原手工规划和正文路径可跳过策划。LangGraph 是产品流程可选，但当前 `compute_service` 无条件导入策划服务，**启动环境必须安装完整 requirements（含 requirements-langgraph.txt）**。

### 5.2 输入与安全边界

- 策划输入是独立白名单，不复用会携带全量资产/图谱/当前章的普通 `contextInput`。
- 当前输入包含：六项作者config设定、前文摘要、最近一章已确认正文、意图/约束、筛选后的图谱。
- **当前没有直接注入完整 outline / characters 资产来预测后续多章**，也没有长篇预测引擎。“基于已有大纲预测”是另行待办，尚未实施。
- 图节点 provenance在 `source`；关系在 `source_info`，关系的 `source` 是端点ID。
- 仅保留人工全局设定和来源处于前缀的审核事实；planned、未来更新、下一章建议及来源不明记录排除。
- 不上传图谱任意 properties、metadata、tag_registry、原文档案等。浏览器先筛选，后端再筛选；JS与Python边界空白规范已对齐并有测试。
- 明确约束独立于ContextPack排序/截断：预算不被模型放宽、必需角色及禁止推进不被遗漏；必需角色至少出现在一个场景。
- schema只含候选编辑字段；id/status/revision/绑定信息由业务代码创建。SceneProposal不能绑定草稿任务或伪装已批准。

### 5.3 版本、恢复及交互

- 运行结果保存在 `LocalRun.result`，无需改变数据库版本；采纳关联在可选 `planning_application` 字段。
- 首次任务采纳比较提交后的 `result_revision`，不能误用 `input_revision`；保存/批准任务会正常推进项目revision。
- 后续场景采纳使用独立来源指纹、实际已批准任务ID/revision、原始显式约束、当前项目锁/CAS及连接guard。
- 恢复连接后需显式 `authorizePlanningRun`：零新增模型调用，保留原冻结**实际模型**和执行指纹，不把旧结果版本更新为新版本。
- 界面顶部显示真实进度与下一步操作；末步仅“前往创作台”，不自动开始正文。
- 提案可折叠；保存后只刷新目标编辑器，并滚动/聚焦可访问容器；另一编辑器的未保存内容保留。
- 过期、已有草稿、未保存编辑和场景旧任务绑定有明确提示。已批准后Key失效不阻止浏览创作台。

### 5.4 最近修复与独立审查记录

1. 任意图谱properties可能夹带档案/凭据：策划专用投影改为空properties，正式图谱未改。
2. 合法JSON未知字段虽被响应剔除，却进入图State：进入State前即校验投影，保留安全问题，不能因丢弃错误字段而误判通过。
3. JS/Python空白差异可能使planned记录先上传：统一来源筛选边界并补等价反例。
4. 备份/重新关联连接导致guard失效：增加显式同执行目标授权恢复。
5. **同一场景同时允许/禁止同一信息**：共享规则增加归一化交集检查，无任务单也检查；不同场景不强制互斥，旧任务错误优先级保留。
6. **作品模型覆盖连接默认模型后无法重新授权**：授权解析保留 `run.connection.model`；不同目标或能力策略仍由实际执行指纹拒绝。
7. 损坏备份中的不完整候选可能使UI崩溃：增加嵌套闭合结构校验与安全显示。
8. 节点流取消时独立 `wait_for(__anext__)` reader可能比响应存活更久：改为响应work直接读取，截止/断连由单一所有者管理；重复取消不得再次打断模型finally，清理后才释放槽位。
9. 节点读取与轨迹回调等待可能拖过客户端期限：合并调用者、连接撤销与超时signal，检查回调前后权限，过期回调不允许继续持久化；reader与连接在结束时关闭。
10. 页面重载后恢复已写入IndexedDB但界面仍显示running：恢复完成后发出工作流变更通知，避免并行读取序号使已中断状态停留在旧视图。
11. 发布前整应用回归发现HTTP中间件缓冲影响真实发送边界：公网边界改为纯ASGI，保留既有路由/CORS/异常语义，并复验真实应用的慢发送和清理顺序。

计划、逐步实现、复查修复和最终交互均已通过独立审查。历史审查结果是当时的验证结论，不能替代未来新改动的验证。

### 5.5 三阶段节点进度与本地轨迹

1. **第一阶段：冻结事件契约。** Python与TypeScript共享语义与反例，`PlanningEventContract`检查身份、目标章、连续seq、节点访问顺序、累计elapsed与终态。帧包含完整八项v2身份、`event_version=1`、`chapter_number`、`seq`及`started/progress/done/error`；`progress`只含固定节点、visit、started/finished/failed和有限累计观察时间。正常分支六条节点事件、一次修订分支十条；契约最多32条progress，不改变原模型输出schema或审批对象。
2. **第二阶段：请求内节点流。** 新增 `/api/compute/plan_chapter/stream`，仅接受v2；原JSON入口继续兼容v1/v2。`/api/capabilities`声明 `planning_stream_version=1` 及策划流能力。Python3.10下在隔离追踪的任务中内部消费LangGraph `tasks+values`，严格投影后才输出事件；raw State、prompt、Key、推理和原始异常不外发，values只在请求内用于终态。上游仍是非token流的结构化请求，初稿/一次修订上限不变。`done`只在内部迭代正常结束后输出，未知失败不自动重试；发送阻塞、ASGI2.4断连、重复取消及满队列均需等待上游清理，admission由响应所有者释放一次。
3. **第三阶段：客户端与本地可解释记录。** `computePlanningStream`独立验证UTF-8、帧大小、身份、顺序与终态；收到合法done并正常EOF后才返回候选，缺done或done后额外事件不应用结果。首次发送和显式重试前重新查询capability，发送前决定JSON或节点流；已发送后失败不自动fallback重发。`LocalRun.planning_trace`仅保留当前attempt的六个诊断字段：event_version、seq、node、visit、status、elapsed_ms，最多32条，不保存完整身份、文本、凭据或候选。轨迹写入检查attempt/status/revision/连接guard和有效signal，`bumpRevision=false`；不修改数据库版本或业务批准状态。

- 节点区域与作者审核进度分开；仅展示服务端观察的累计时间，不推算完成百分比或精确节点耗时。中断的开始事件显示后续未知，节点结束不等于规则通过或作者批准。
- 旧JSON运行没有trace仍可显示最终nodes；损坏备份诊断记录安全忽略并设置 `planning_trace_invalid` 提示，凭据/原型字段检查不能被诊断清洗绕过。
- **只有已保存完整result可以零模型调用恢复；只有节点记录不能节点续跑。** 缺完整结果仍由作者显式重试，新attempt清空旧轨迹。恢复授权与任务/场景分别批准的既有规则不变。
- 三阶段没有新增模型调用、生产依赖、服务器项目存储或后台执行任务；本轮源码发布状态另见10节。

## 6. 关键源码导航

| 任务 | 优先阅读 |
|---|---|
| 公网接口边界、超时、限流 | api/main.py、api/routers/compute.py |
| stateless操作分派 | services/compute_service.py |
| 项目/备份/事务 | frontend/src/localStore.ts、localTypes.ts |
| 正文/确认/摘要/连续生成/恢复 | frontend/src/localWorkflow.ts、localApi.ts |
| JSON/NDJSON及身份验证 | frontend/src/computeClient.ts |
| 服务商策略、协议、出口 | provider_catalog.py、model_client.py、provider_transport.py |
| 连接冻结与密钥 | frontend/src/providerConnections.ts、providerTypes.ts、keyVault.ts |
| 导入 | frontend/src/novelImport.ts、components/NovelImportPanel.tsx |
| 策划输入/结果/来源白名单 | frontend/src/planningInput.ts、services/chapter_planning_contract.py |
| 请求内StateGraph | services/chapter_planning_service.py |
| 节点帧契约与共享反例 | services/chapter_planning_events.py、frontend/src/planningStreamContract.ts、docs/chapter-planning-events.html、tests/fixtures/chapter-planning-events.json |
| 本地轨迹投影与安全读取 | frontend/src/planningTrace.ts、localTypes.ts、localStore.ts |
| 策划流与完整公网应用回归 | tests/test_chapter_planning_stream.py、tests/test_public_planning_stream.py、frontend/scripts/test-planning-compute-stream.mjs、test-planning-progress.mjs |
| 候选采纳/授权 | frontend/src/chapterPlanning.ts |
| 进度、定位、手工批准 | components/ChapterPlanningPanel.tsx、pages/ReviewPage.tsx、components/ChapterTaskSheetPanel.tsx、ScenePlanPanel.tsx |
| 共享任务/场景规则 | services/chapter_task_service.py、scene_plan_service.py |
| 叙事记忆与候选审核 | services/context_pack_service.py、story_delta_service.py、knowledge_draft_service.py、narrative_graph_service.py |
| 严格模型schema | structured_schemas.py |

## 7. 2026-10-03 初始工作区快照（历史）

以下仅为2026-10-03首次交接时的未提交文件，**不是当前文件清单**，不包含随后三阶段节点进度和发布准备新增文件。提交前须以实时 `git status` 与显式文件检查为准，保留这些初始成果。

已跟踪修改：

```text
HANDOVER.md
frontend/src/components/ChapterTaskSheetPanel.tsx
frontend/src/components/LocalTasksPanel.tsx
frontend/src/components/ScenePlanPanel.tsx
frontend/src/computeClient.ts
frontend/src/localTypes.ts
frontend/src/localWorkflow.ts
frontend/src/pages/ReviewPage.tsx
frontend/src/providerConnections.ts
frontend/src/styles/writing.css
provider_catalog.py
requirements.txt
services/compute_service.py
services/scene_plan_service.py
structured_schemas.py
```

未跟踪新文件（**必须保留，未来提交时显式检查包含**）：

```text
frontend/scripts/test-chapter-planning.mjs
frontend/src/chapterPlanning.ts
frontend/src/components/ChapterPlanningPanel.tsx
frontend/src/planningInput.ts
requirements-langgraph.txt
services/chapter_planning_contract.py
services/chapter_planning_service.py
tests/test_chapter_planning_api.py
tests/test_chapter_planning_contract.py
tests/test_chapter_planning_service.py
```

`reports/`、`.env`、`.venv/`、`frontend/node_modules/`、`frontend/dist/` 均被忽略。报告与旧交接备份仅本地归档。

## 8. 验证记录与运行方式

### 8.1 最新本地验收（2026-10-04 发布准备汇总）

| 验证 | 结果 | 证据 |
|---|---|---|
| Python全量（含完整公网应用发送/清理与包装取消回归） | 346/346，通过 | reports/release-2026-10-03/backend-final.log |
| Node契约、客户端、轨迹及既有测试 | 101/101，通过 | reports/langgraph-stage3-2026-10-03/node.log |
| 策划与交互真实Edge | 30/30，通过 | 同目录browser-planning.log |
| 原工作流/连接真实Edge | 18/18 + 11/11，通过 | 同目录browser-workflows.log、browser-connections.log |
| 新节点进度真实Edge、IndexedDB/Web Locks、分块HTTP | 7/7，通过 | reports/planning-progress-2026-10-03/browser-planning-progress.json |
| TypeScript + Vite构建 | 通过，既有chunk/import警告保留 | reports/langgraph-stage3-2026-10-03/build.log |

Edge合计66个场景。三阶段初次验收与发布准备复验的范围不同：阶段三backend.log记录340项，公网修复后345项，增加包装取消回归后最新346项，不应将前一份日志当作当前总数。上述模型均为mock；新的节点浏览器验收使用真实分块本地HTTP，封禁外部URL，**不代表真实模型质量或公网反代已验证**。

### 8.2 前轮验收与历史证据

| 验证 | 结果 | 证据 |
|---|---|---|
| Python全量 | 309/309，通过 | reports/planning-interaction-2026-10-02/backend.log |
| 策划与交互真实Edge | 30/30，退出码0 | browser-final.log、browser-planning-final.json（同目录） |
| TypeScript + Vite构建 | 通过，现有chunk/import警告保留 | build.log（同目录） |
| 行尾约定检查 | 通过 | git -c core.whitespace=cr-at-eol diff --check |
| 前一轮原工作流/连接浏览器回归 | 18/18 + 11/11，通过 | reports/langgraph-implementation-2026-10-01/legacy-workflows.log、legacy-connections.log |
| 前一轮Node阅读/API测试 | 8/8，通过 | 同目录final-node-tests.log |

所有本轮模型均为mock；浏览器脚本封禁外部URL，使用真实IndexedDB/Web Locks及既有Edge。初轮浏览器29/30的唯一失败是summary测试选择器歧义，收紧选择器后完整链及最终30/30通过，未放宽业务断言。

**编写本交接仅核对了代码与已有记录，没有为了文档重新运行整套测试。** 后续代码变化后需按范围重新验证。

### 8.3 已知本机环境与命令

- Windows / PowerShell；Python `.venv` 3.10.11；Node v23.0.0。
- React19 / TypeScript / Vite / AntD6 / Zustand / G6 / Three.js；FastAPI / Pydantic / HTTPX / OpenAI兼容库；LangGraph1.2.12。
- `requirements.txt` 包含 `-r requirements-langgraph.txt`，必要依赖已安装并锁定。不要漏带该新文件；不要随意升级核心依赖。
- `frontend/package-lock.json` 使用npm。已有node_modules和bundled Playwright；无需为运行测试临时加生产/开发依赖。

```powershell
# 仓库根目录
git status --short
.venv\Scripts\python.exe -m unittest discover -s tests -q

# 明确要启动本地开发服务时
.venv\Scripts\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8000

# frontend目录
npm run dev
npm run build
node --test scripts/test-api-base-url.mjs scripts/test-reader-preferences.mjs
node --test scripts/test-planning-stream-contract.mjs scripts/test-planning-compute-stream.mjs scripts/test-planning-trace.mjs

# 已有Edge浏览器测试；临时Vite/浏览器会自行关闭
$env:BRAIPEN_PLAYWRIGHT_PATH='C:\Users\hrlong\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright'
$env:BRAIPEN_REPORT_DIR='D:\vibecoding\novel-generator\reports\planning-interaction-2026-10-02'
node scripts/test-chapter-planning.mjs
node scripts/test-planning-progress.mjs
node scripts/test-local-workflows.mjs
node scripts/test-provider-connections.mjs
```

公网运行时设置 `BRAIPEN_PUBLIC_MODE=1`；Custom还需管理员核实并设置 `BRAIPEN_SELF_ADDRESSES`。本地真实模型联调同样会消耗额度，应先明确范围与预算。

## 9. 待办、困难及下一步

### 9.1 另行待办：章节规划预测（仅讨论）

- [ ] 探讨利用**已有大纲、人物/世界设定、已确认正文与摘要**，预测后续章节推进、场景安排或规划走向的可行性。
- [ ] 可考虑 **JEV**；这是用户原术语，具体含义未确认。先澄清其指代，再查权威资料，不擅自改写成其他缩写。
- [ ] 讨论与现有“下一章任务/场景提案”的差异，优先复用已有 `next_chapter_proposal` 等业务对象，避免平行体系。
- [ ] 定义“大纲中的未来计划”与“已经发生的事实”的不同用途，防止预测直接泄漏到正文或成为未经审核的正典。
- [ ] 明确是预测一章、短期多章还是滚动预演；评估偏离大纲后的修正、作者采纳方式、模型调用预算、有效性指标和最小实验。
- [ ] 先讨论可行性与方案，再决定实施；这个预测待办没有实施、真实模型试验或新增依赖授权。当前已实现成果的提交/部署授权见0节。

### 9.2 当前工程限制

- 自然语言约束与叙事逻辑不能由字符串规则证明；`draft_ready`不等于文学质量或事实一致性保证。
- 无完整时态图谱，不能在同一项目中安全地任意回到旧章重建当时知识；当前策划明确只支持最新前缀下一章。
- 当前图来源缺失会被保守排除；导入关系是注释节点；事实更新、归并和历史生命周期能力有限。
- 长篇上下文仍受1MiB请求上限与模型窗口限制。摘要压缩、近期/长期记忆布局和缓存命中可继续研究，不能宣称正文加速已实测完成。
- 全部最新验收是mock；真实模型输出长度、结构化兼容、费用和耗时仍需受控联调。
- LangGraph增加19个必要运行时包，原环境版本保持；启动仍需这些依赖。新VPS发布应核实完整依赖、Custom出口参数和单worker限制。
- 浏览器存储配额、清理、origin变化与备份恢复是持续体验风险；未完成导入草稿的备份范围尤其要注意。
- 当前没有账号体系、云端作品同步或多设备自动同步；“公开网站”不意味着作品已保存在云端。
- 现有大chunk/混合导入构建提示不是失败；不应为消除提示擅自重构全站。

### 9.3 已知历史建议，不能当作最新优先级

图谱拖拽布局持久化、独立正文改写/润色入口、更深角色一致性/Timeline体系等可另行评估。旧交接曾把“连续生成”“多模型连接”列为未实现，这两项已完成，不能再照旧重做。

本地小模型设备待定，用户可能考虑Mac，但不是当前主要目标。未授权引入本地模型、微调、多Agent生产系统或迁移整个浏览器工作流到LangGraph。

## 10. 网站、发布和文档可信度

- 公开产品域名：`braipen.world`；历史上已在Spaceship VPS部署并配置HTTPS，用户曾选择公开访问、空白数据和不提供全站共享模型Key。
- 本文这次更新仅核对本地源码与验收证据，**没有核实发布后的线上SHA、服务状态或完整流链路**。不能据历史部署消息或本地测试断言生产已包含最新改动。
- 2026-10-04用户已明确授权提交当前 `codex/chapter-planning` 分支、推送现有远端并部署。发布成功需另核对最终提交、远端分支、线上 `RELEASE`、应用服务状态及 `braipen.world` 的health/capability/节点流；不自动合并master，不沿用旧服务器连接假设，也不提前记录成功结论。
- 不把服务器登录信息、Key、密码、私钥或真实`.env`写入新文档/报告/提交。相关授权与实际连接应在新任务中安全核实。
- 旧HANDOVER（2026-09-08）已过期；已本地备份到 `reports/handover-2026-10-03/HANDOVER.previous.md`。
- README顶端已有浏览器模式说明，后续部分仍含旧文件模式描述；先读源码，不能把“无数据库/仅DeepSeek/自动立即摘要/不做公网”当现状。
- 旧“推理max_tokens必须≥16384”不能推广为所有服务商硬阈值；当前参数受具体模型策略影响，截断会拒绝，不应盲目套统一值。

重要交付记录：

1. `reports/agent-plan-review-2026-09-23/feasibility-review.html`：早期架构可行性分析，作为历史材料。
2. `reports/langgraph-implementation-2026-10-01/plan.html`、`delivery.html`：请求内策划首期计划与实现。
3. `reports/planning-interaction-2026-10-02/review-and-delivery.html`：最近两P2修复、策划交互、309/30验证。
4. 本交接的HTML阅读版：`reports/handover-2026-10-03/HANDOVER.html`。
5. [第一阶段契约报告](reports/langgraph-stage1-2026-10-03/delivery.html)：Python/TypeScript帧契约、schema、共享反例。
6. [第二阶段节点流报告](reports/langgraph-stage2-2026-10-03/delivery.html)：请求内StateGraph事件、v2节点流、取消与槽位回归。
7. [第三阶段交付报告](reports/langgraph-stage3-2026-10-03/delivery.html)：客户端、本地trace、真实Edge与原工作流/连接回归。
8. [2026-10-04发布报告](reports/release-2026-10-04/delivery.html)：发布准备预定归档路径，由本轮发布任务生成；**未生成或缺少实测证据时不能据此声称提交/推送/部署完成**。

### 10.1 2026-10-04 发布准备核验边界

- 代码已完成三阶段实现及公网纯ASGI修复，本地最新验证和独立审查记录见5、8节；本交接不代替最终发布记录。
- 提交前显式检查新增契约、fixture、策划服务/前端、测试与 `requirements-langgraph.txt`，勿只提交已跟踪diff而漏掉未跟踪实现。`reports/`、真实配置、运行环境、node_modules与dist不能进入提交。
- 发布时保留可回滚版本，核实完整依赖与单worker限制；以实际Git SHA和 `RELEASE` 标记对应构建/运行版本，并验证健康、capability与公网流式发送/断连。真实付费模型调用仍未获本轮新增授权。

## 11. 接手协作约定

- 默认中文。先理解源码、风险与验证标准，再给短计划，最小必要改动；避免无关重构、格式化和依赖升级。
- 当前用户偏好重要计划/阶段独立审查，发现真实问题先复现、修复和复审，再推进。
- 保留已有未提交成果；不执行hard reset、强推、历史重写或重要文件清理。
- 真实Key、密码、私钥、Cookie不得进入代码、日志、报告或提交；测试必须隔离真实配置与付费API。
- 不重复询问已明确授权的低风险步骤；如果下一目标不明确，在进行可独立工作的同时及时澄清。
- 重要结果优先自包含HTML报告；解释具体绑定当前工程决策，并总结本阶段三个值得掌握的知识点。
- `.env`、node_modules、venv、dist与reports不得误提交。行尾保留原约定，检查时允许CRLF；不要用全文件格式化掩盖小修改。
- 旧批处理 `start-react.bat` 可能开启可见窗口或自动安装依赖，不要把运行它当作只读验证。
- 历史发布/关机/关闭FlClash等请求不是这轮的任务，不能在新对话自动执行。

## 12. 可复制到新对话的开场说明

```text
工作目录是 D:\vibecoding\novel-generator。请先阅读 HANDOVER.md，并核对当前源码和git status。
当前开发分支 codex/chapter-planning，开发基线dc902ca；最终HEAD、远端及线上SHA须核对Git与RELEASE，勿把基线当成发布版本。请保护已有修改与未跟踪成果。
现有产品以浏览器IndexedDB为正式存储，服务器请求内计算；已有多服务商、小说导入、连续生成和确认后摘要。LangGraph只负责可选章节策划，作者分别批准任务与场景。
已完成三阶段节点契约、请求内节点流与本地trace，以及公网纯ASGI边界与Python3.12包装取消修复；作者审核与恢复仍由浏览器负责。最近本地验收是346后端、101Node、66Edge及构建通过，模型均模拟；线上发布须另核验。
2026-10-04用户已授权当前分支commit/push/deploy，完成状态以发布报告和实际版本为准，不提前宣称成功。基于大纲预测/JEV仍是另行讨论待办，JEV指代未确认。
请根据我随后给出的目标继续，不要把旧README/历史部署消息当作当前源码或线上版本；真实付费模型试验需明确的新授权。
```
