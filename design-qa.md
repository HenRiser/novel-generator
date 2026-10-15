# Braipen 视觉改版验收

## 比较目标与证据

- 用户选择：第一张作为默认布局与铅印主题，银灰、午夜只改变配色。
- Source visual truth：`reports/frontend-visual-2026-10-15/reference-editorial.png`。
- Implementation：`http://127.0.0.1:5173/writing`，合成作品第 3 章待确认，20px 宋体，底色随界面。
- 最终 CSS viewport 与两张图像均为 **1487 × 1058**；deviceScaleFactor=1。最终截图使用该标签页的 CDP 精确 CSS clip，无尺寸归一化。首轮旧截图仅作为修复过程证据。
- Full-view comparison：`reports/frontend-visual-2026-10-15/qa-final-comparison.png`。
- Focused comparison：`reports/frontend-visual-2026-10-15/qa-final-focused.png`。
- 已把参考与最终实现在同一图像输入中并排检查整页及标题、正文、控件、确认操作，不仅分别查看截图。
- 截图、测试日志与 HTML 报告是本地忽略产物，不随源码提交。

## Findings 与处置

| 优先级 | 实际发现 | 处置与复验 |
| --- | --- | --- |
| P1 | 系统宋体回退偏细，首轮正文密度偏小 | 同源 Noto Serif SC 分片；新默认 20px，保留已有字号。CDP 实测 NotoSerifSC-Regular / custom=true / 219 个正文 glyph。 |
| P1 | G6 仅 draw 会沿用旧主题的标签映射缓存 | 通过现有 G6 setNode/setEdge 更新映射后 draw；实测深浅切换标签可读，节点位置和视口保留。 |
| P1 | 午夜主要按钮使用深色字时，复用全局 token 导致提示浮层也变暗字 | 主要按钮文字用 Button.primaryColor 单独指定；浮层保持白字。浏览器实测白字 / rgb(66,66,66) 背景。 |
| P2 | 银灰辅助文字未达到 4.5:1 | 调深 muted/faint 至 #5b6672，三套主题正文、说明与主要按钮对比度检查通过。 |
| P2 | 常驻排版与重复操作行推低正文起点 | 使用原生 details 排版入口，宽桌面工具行合并到标签行右侧，次要操作放正文后。支持 Escape 关闭。 |
| P2 | 短章确认操作被挤出首屏 | 待确认状态精简重复说明，保留警告、锁定、取消及版本检查；确认区可见，编辑后 Tab 可滚入保存/取消按钮。 |
| P2 | 长标题和封面并排时换行过多 | 标题限制两行，完整文字保留在 title 与可访问名称中。 |
| P2 | 小屏操作与排版弹层需要独立适配 | 手机触控目标至少 44px，输入 16px；320/390px 弹层无溢出；834px 紧凑双栏，规划侧栏收起但入口保留。 |

复验后，没有本轮范围内未解决的 P0/P1/P2。

## Required fidelity surfaces

- **Fonts/typography：通过。** 宋体标题、正文和系统字体控件层次清楚；品牌沿用原文字标识。参考稿更大字号与首行缩进属于生成画稿的排版示意，实际保留用户字号与纯文本换行，不改写手稿内容；可在“排版”调整字号。
- **Spacing/layout rhythm：通过。** 216px 主导航、244px 作品目录、正文与 216px 规划备注形成选定的编辑书页结构；真实确认、下载、续写与重新生成入口均保留。手机改为上下阅读顺序。
- **Colors/tokens：通过。** 铅印默认，银灰和午夜共享结构；原生 CSS、Ant Design 和 Canvas 标签统一从色板取色。明确的独立阅读底色不被界面主题覆盖。
- **Image quality/assets：通过。** 复用已有封面图片字节和 Ant Design 图标，保持 2:3，无新造占位图片；字体含许可、来源与校验值。最终网络观察字体请求全部同源。
- **Copy/content：通过。** 真实数据优先：生成稿的“0 个章节”与四条目录不一致，实际示例为 3 章、219 字和已批准任务单；恢复副本书名及规则提示保持真实。右栏读取任务单，不生成或批准内容。

## 交互与验证

- Node 自动检查 **159/159** 通过，包含新主题白名单、存储禁用回退、对比度，以及原有阅读偏好兼容。
- `npm run build` 通过（TypeScript + Vite）；无新增依赖、后端或数据格式变更。
- 真实浏览器 **24 项**检查通过：三主题、刷新记忆、跨标签同步、单选键盘导航、未保存正文经历两次换肤仍完整、取消恢复、图谱绘制/缩放/标签缓存、概览与全部主路由、独立阅读底色、手机导航/提示/排版、320/390/834/1366/1487px 布局、裁剪范围键盘操作与取消。
- 完整刷新窗口 **111 条请求**无截断；除 Braipen 健康检查外均为本源资源，没有模型请求或外部字体请求。较早的网络窗口已截断，仅作辅助证据。
- 控制台只有既有 Ant Design Alert `message` 弃用提示，无本轮运行异常。
- 证据：`browser-checks-final.json`、`browser-network.json`、`node-tests-final.log`、`build-final.log`、`qa-final-metadata.json`。

## 边界与 Follow-up Polish

- 8 个既有浏览器脚本未从终端运行；本阶段用 Product Design 指定的浏览器通道执行上述真实交互检查，不把它说成全量端到端测试。
- 手机、平板为浏览器视口模拟，未用真实设备；未调用文字、生图、摘要模型，未修改生产项目或部署网站。
- 字体常用汉字共 6763 个，少见字回退系统字体；全部 15 个分片合计约 1.50 MB，实际按 unicode-range 加载。
- P3：既有 Alert 属性弃用与 Ant Design/G6 大分块警告后续单独处理，不在本轮扩展重构。
- 验收置信度：高（上述本地交互与视觉范围）；真实设备和生产环境尚未验收。

final result: passed
