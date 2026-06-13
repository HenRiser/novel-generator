import type { ProjectSummary } from "../types";

type LibraryPageProps = {
  selectedProject: ProjectSummary | null;
};

const PLACEHOLDERS = ["人物", "场景", "特殊物品", "伏笔", "世界观事实", "剧情走向"];
const FUTURE_FEATURES = ["Narrative Graph", "nodes + edges", "Entity Inspector", "本地近似检索", "2D/3D 图谱展示"];

export function LibraryPage({ selectedProject }: LibraryPageProps) {
  return (
    <section className="workspace-single-page" aria-labelledby="library-title">
      <section className="panel page-intro-panel">
        <span className="section-kicker">Library</span>
        <h1 id="library-title">创作资料库</h1>
        <p>
          未来用于管理人物、场景、特殊物品、伏笔、世界观事实和剧情走向。本阶段只保留页面框架，
          不新增后端 API、不扫描 workspace、不实现图算法。
        </p>
        <p className="state-text">
          当前项目：{selectedProject ? selectedProject.title || selectedProject.project_ref : "尚未选择项目"}
        </p>
      </section>

      <section className="library-grid" aria-label="资料库占位模块">
        {PLACEHOLDERS.map((item) => (
          <article className="panel library-module" key={item}>
            <span className="section-kicker">Placeholder</span>
            <h2>{item}</h2>
            <p>后续阶段接入真实创作资料与实体检查器。</p>
          </article>
        ))}
      </section>

      <section className="panel future-panel" aria-labelledby="library-future">
        <span className="section-kicker">Future</span>
        <h2 id="library-future">预留能力边界</h2>
        <div className="future-chip-list">
          {FUTURE_FEATURES.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      </section>
    </section>
  );
}
