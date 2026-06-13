import type { ApiStatus, ProjectSummary } from "../types";

type HomePageProps = {
  apiStatus: ApiStatus;
  selectedProject: ProjectSummary | null;
  onNavigate: (page: "create" | "read" | "library") => void;
};

const CAPABILITIES = [
  "项目创建",
  "大纲与人物卡",
  "流式章节生成",
  "阅读与导出",
  "未来 Narrative Graph",
  "本地 workspace 存储",
];

const QUICK_START_STEPS = [
  "新建项目",
  "填写创作种子",
  "生成大纲与人物卡",
  "生成第一章",
  "在阅读页检查正文",
  "后续在资料库管理伏笔、场景和物品",
];

export function HomePage({ apiStatus, selectedProject, onNavigate }: HomePageProps) {
  return (
    <section className="home-page">
      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-hero-copy">
          <span className="section-kicker">Local long-form writing desk</span>
          <h1 id="home-title">Braipen</h1>
          <p className="home-lede">面向长篇创作的 AI 写作工作台。</p>
          <p>
            把灵感、设定、伏笔和章节组织成可持续创作的长篇工程。React 前端展示品牌名为 Braipen，
            内部项目与目录仍保持 `novel-generator`。
          </p>
          <div className="home-cta">
            <button className="button primary-button" type="button" onClick={() => onNavigate("create")}>
              进入创作
            </button>
            <button className="button secondary-button" type="button" onClick={() => onNavigate("read")}>
              开始阅读
            </button>
            <button className="button subtle-button" type="button" onClick={() => onNavigate("library")}>
              查看资料库
            </button>
          </div>
          <p className="home-current-project">
            {selectedProject
              ? `当前项目：${selectedProject.title || selectedProject.project_ref}`
              : apiStatus === "online"
                ? "选择或创建项目后，工作区会在各页面间保留当前上下文。"
                : "API 离线时仍可浏览首页；启动 FastAPI 后即可加载项目。"}
          </p>
        </div>

        <div className="home-hero-visual" aria-label="未来 3D 大脑与钢笔品牌动画占位">
          <div className="braipen-mark-preview" aria-hidden="true">
            <span className="brain-shell" />
            <span className="brain-line brain-line-one" />
            <span className="brain-line brain-line-two" />
            <span className="brain-line brain-line-three" />
            <span className="pen-line" />
            <span className="pen-nib" />
          </div>
          <p>未来首页将承载 3D 大脑、钢笔与 2D logo 转场动画。</p>
        </div>
      </section>

      <section className="home-section" aria-labelledby="home-capabilities">
        <div className="section-heading">
          <span className="section-kicker">Capabilities</span>
          <h2 id="home-capabilities">核心能力</h2>
        </div>
        <div className="home-card-grid">
          {CAPABILITIES.map((item) => (
            <article className="home-info-card" key={item}>
              <strong>{item}</strong>
            </article>
          ))}
        </div>
      </section>

      <section className="home-section quick-start-section" aria-labelledby="home-quick-start">
        <div className="section-heading">
          <span className="section-kicker">Quick start</span>
          <h2 id="home-quick-start">快速开始</h2>
        </div>
        <ol className="quick-start-grid">
          {QUICK_START_STEPS.map((step, index) => (
            <li key={step}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{step}</strong>
            </li>
          ))}
        </ol>
      </section>
    </section>
  );
}
