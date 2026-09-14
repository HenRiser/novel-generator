import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Alert, Button, Dropdown, Empty, Input, Modal, Skeleton, message } from "antd";
import { ArrowRightOutlined, PlusOutlined, MoreOutlined, SearchOutlined, ReloadOutlined, EditOutlined, NodeIndexOutlined, SafetyCertificateOutlined, FileTextOutlined } from "@ant-design/icons";
import { deleteProject } from "../api";
import { useProjectData, useProjects } from "../hooks/useProjectData";
import { selectGenerationBusy, useAppStore } from "../store/useAppStore";
import ProjectCreateModal from "../components/project/ProjectCreateModal";
import NeuralSculpture from "../components/intro/NeuralSculpture";
import type { ProjectSummary } from "../types";

const PATHWAYS = [
  { n: "01", title: "构建故事", text: "从一颗创作种子，展开大纲与角色。", icon: <EditOutlined />, route: "/writing" },
  { n: "02", title: "明确方向", text: "定义章节任务，安排场景与信息边界。", icon: <FileTextOutlined />, route: "/review" },
  { n: "03", title: "连接线索", text: "让人物、伏笔与世界设定彼此关联。", icon: <NodeIndexOutlined />, route: "/graph" },
  { n: "04", title: "审核沉淀", text: "审阅知识候选，让新的变化有据可查。", icon: <SafetyCertificateOutlined />, route: "/library" },
];
function displayDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "尚无更新时间" : date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit", year: "numeric" });
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { projects, projectsLoading, selectedProjectRef, selectedProject, chapters, chaptersLoading, apiStatus, selectProject, clearProjectState } = useAppStore();
  const busy = useAppStore(selectGenerationBusy);
  const { error, refresh } = useProjects();
  const { detailError, chaptersError } = useProjectData(selectedProjectRef);
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [deletingRef, setDeletingRef] = useState<string | null>(null);
  const visibleProjects = useMemo(() => projects.filter(p => `${p.title} ${p.description}`.toLowerCase().includes(search.trim().toLowerCase())), [projects, search]);
  const selected = projects.find(p => p.project_ref === selectedProjectRef);
  const chapterCount = new Set(chapters.map(c => c.chapter_number)).size;
  const ready = apiStatus === "online";

  const openProject = (project: ProjectSummary, path = "/writing") => {
    if (busy || deletingRef) return;
    selectProject(project.project_ref);
    navigate(path);
  };
  const handleDelete = (project: ProjectSummary) => {
    Modal.confirm({
      title: `删除《${project.title}》？`, content: "这会删除该项目及其全部章节文件，无法撤销。", okText: "删除项目", cancelText: "保留", okButtonProps: { danger: true },
      onOk: async () => {
        setDeletingRef(project.project_ref);
        try {
          await deleteProject(project.project_ref);
          if (useAppStore.getState().selectedProjectRef === project.project_ref) clearProjectState();
          await refresh();
          message.success("项目已删除");
        } catch (e) { message.error(e instanceof Error ? e.message : "删除失败，请重试"); throw e; }
        finally { setDeletingRef(null); }
      },
    });
  };

  return <div className="page-container dashboard-page">
    <section className="dashboard-hero" aria-labelledby="hero-title">
      <div className="hero-copy">
        <div className="eyebrow"><span className="ink-dot" /> BRAIPEN / CREATIVE LAB</div>
        <h1 id="hero-title">让思想成形。<br /><span>让故事生长。</span></h1>
        <p>从一闪而过的灵感，到彼此相连的叙事。<br />与 AI 一起写作，把方向留在自己手中。</p>
        <div className="hero-actions"><Button type="primary" size="large" icon={selected ? <ArrowRightOutlined /> : <PlusOutlined />} iconPlacement="end" disabled={!ready || busy} onClick={() => selected ? navigate("/writing") : setCreateOpen(true)}>{selected ? "继续创作" : "开始一个故事"}</Button><span className="hero-caption">灵感由你，可能无限。</span></div>
      </div>
      <div className="hero-art"><span className="figure-index">FIG. 01 — THE SHAPE OF THOUGHT</span><NeuralSculpture className="hero-brain" /><div className="figure-caption"><span>BRAIN + PEN</span><span>思考与表达，相遇于此。</span></div></div>
      <div className="hero-bottom-line"><span>HUMAN INTENT <i /> AI EXPLORATION</span><span>一个关于可控创作的独立实验 ↗</span></div>
    </section>

    {apiStatus === "offline" && <Alert className="connection-alert" type="warning" showIcon title="创作服务暂未连接" description="你的故事保存在本地。连接服务后，即可读取项目并继续创作。" action={<Button onClick={() => navigate("/settings")}>查看连接设置</Button>} />}
    {(error || detailError || chaptersError) && ready && <Alert type="error" showIcon title={error || detailError || chaptersError} action={<Button size="small" onClick={() => void refresh()}>重新读取</Button>} style={{ marginBottom: 20 }} />}

    {selected && <section className="continue-strip" aria-label="当前故事">
      <div className="continue-mark"><FileTextOutlined /></div><div className="continue-title"><span className="eyebrow">ON YOUR DESK / 当前故事</span><h2>{selectedProject?.title || selected.title}</h2></div>
      <div className="continue-meta"><b>{chaptersLoading ? "—" : chapterCount}</b><span>个已保存章节</span></div>
      <Button icon={<ArrowRightOutlined />} iconPlacement="end" onClick={() => navigate("/writing")} disabled={!ready}>回到创作台</Button>
    </section>}

    <section className="projects-section" aria-labelledby="projects-heading">
      <div className="section-heading"><div><span className="eyebrow">YOUR STORIES</span><h2 id="projects-heading">故事书架 <span className="count-label">{projects.length.toString().padStart(2, "0")}</span></h2></div><div className="section-tools"><Input aria-label="搜索故事" placeholder="寻找一个故事…" prefix={<SearchOutlined />} value={search} onChange={e => setSearch(e.target.value)} allowClear className="project-search" /><Button icon={<ReloadOutlined />} aria-label="刷新故事" onClick={() => void refresh()} loading={projectsLoading} disabled={!ready} /><Button icon={<PlusOutlined />} onClick={() => setCreateOpen(true)} disabled={!ready || busy}>新建故事</Button></div></div>
      {projectsLoading && !projects.length ? <div className="project-grid">{[0, 1, 2].map(n => <div className="book-card" key={n}><Skeleton active paragraph={{ rows: 3 }} /></div>)}</div> : visibleProjects.length === 0 ? <div className="shelf-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={search ? "没有找到这个故事，换个关键词试试。" : "书架的第一页，等你落笔。"} />{!search && <Button type="primary" onClick={() => setCreateOpen(true)} disabled={!ready || busy} icon={<PlusOutlined />}>写下第一个灵感</Button>}</div> : <div className="project-grid">
        {visibleProjects.map((project, index) => <article className={`book-card book-tone-${index % 3}${selectedProjectRef === project.project_ref ? " is-current" : ""}`} key={project.project_ref}>
          <div className="book-top"><span className="book-number">STORY / {String(projects.indexOf(project) + 1).padStart(2, "0")}</span>{selectedProjectRef === project.project_ref && <span className="current-indicator"><span /> 当前故事</span>}<Dropdown trigger={["click"]} menu={{ items: [{ key: "read", label: "在阅读空间打开" }, { type: "divider" }, { key: "delete", label: "删除项目", danger: true }], onClick: ({ key }) => key === "delete" ? handleDelete(project) : openProject(project, "/reader") }}><Button type="text" icon={<MoreOutlined />} aria-label={`《${project.title}》更多操作`} disabled={busy || !ready || Boolean(deletingRef)} /></Dropdown></div>
          <button className="book-main" onClick={() => openProject(project)} disabled={busy || !ready || Boolean(deletingRef)}><h3>{project.title}</h3><p>{(project.description && !/\[(workspace|legacy)\]/.test(project.description) ? project.description : "独立故事空间 · 本地保存")}</p></button>
          <div className="book-bottom"><span>{displayDate(project.updated_at)} <span className="date-label">更新</span></span><button aria-label={`继续创作《${project.title}》`} disabled={busy || !ready || Boolean(deletingRef)} onClick={() => openProject(project)}><ArrowRightOutlined /></button></div>
        </article>)}
        <button className="new-story-card" disabled={!ready || busy} onClick={() => setCreateOpen(true)}><span><PlusOutlined /></span><b>下一个故事</b><small>让一个新的念头，有处安放。</small></button>
      </div>}
    </section>

    <section className="pathways-section" aria-labelledby="pathways-heading"><div className="section-heading"><div><span className="eyebrow">A CONSIDERED PROCESS</span><h2 id="pathways-heading">从灵感，到有迹可循。</h2></div><p>四个创作入口，一条持续演进的线索。</p></div><div className="pathway-grid">{PATHWAYS.map(item => <button key={item.n} className="pathway" onClick={() => selectedProjectRef ? navigate(item.route) : setCreateOpen(true)} disabled={!ready || busy}><div><span className="pathway-number">{item.n}</span>{item.icon}</div><h3>{item.title}<ArrowRightOutlined /></h3><p>{item.text}</p></button>)}</div></section>
    <ProjectCreateModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={ref => { setCreateOpen(false); selectProject(ref); void refresh(); navigate("/writing"); }} />
  </div>;
}
