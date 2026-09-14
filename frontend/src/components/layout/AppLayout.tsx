import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { Badge, Button, Drawer, Select, Space } from "antd";
import { AppstoreOutlined, EditOutlined, NodeIndexOutlined, ReadOutlined, SafetyCertificateOutlined, SettingOutlined, DatabaseOutlined, MenuOutlined, ArrowUpOutlined, PlayCircleOutlined, ExperimentOutlined } from "@ant-design/icons";
import { selectGenerationBusy, useAppStore } from "../../store/useAppStore";
import PageBoundary from "./PageBoundary";

const NAV_ITEMS = [
  { path: "/dashboard", icon: <AppstoreOutlined />, label: "创作概览", number: "01" },
  { path: "/writing", icon: <EditOutlined />, label: "创作台", number: "02" },
  { path: "/reader", icon: <ReadOutlined />, label: "阅读空间", number: "03" },
  { path: "/graph", icon: <NodeIndexOutlined />, label: "叙事图谱", number: "04" },
  { path: "/review", icon: <SafetyCertificateOutlined />, label: "章节规划", number: "05" },
  { path: "/library", icon: <DatabaseOutlined />, label: "知识审核", number: "06" },
];
const API_STATUS = {
  loading: { status: "processing" as const, text: "连接中" },
  online: { status: "success" as const, text: "本地服务已连接" },
  offline: { status: "default" as const, text: "本地服务未连接" },
};

export function BrandMark() {
  return <svg viewBox="0 0 36 36" fill="none" aria-hidden="true"><path d="M17 7c-3-5-11-1-9 4-6 2-5 10 0 11-2 6 5 10 9 5V7Zm4 0c3-5 11-1 9 4 6 2 5 10 0 11 2 6-5 10-9 5V7Z" stroke="currentColor" strokeWidth="1.5"/><path d="M8 11c4 0 5 3 4 6m-4 5c4 0 6-2 5-5m17-6c-4 0-5 3-4 6m4 5c-4 0-6-2-5-5M19 4v28m-3-3 3 4 3-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>;
}

export default function AppLayout({ onReplayIntro }: { onReplayIntro: () => void }) {
  const location = useLocation();
  const { apiStatus, projects, projectsLoading, selectedProjectRef, selectProject } = useAppStore();
  const busy = useAppStore(selectGenerationBusy);
  const [menuOpen, setMenuOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const title = NAV_ITEMS.find(item => item.path === location.pathname)?.label ?? "偏好设置";
  const status = API_STATUS[apiStatus];

  useEffect(() => { setMenuOpen(false); document.title = `${title} · Braipen`; window.scrollTo(0, 0); }, [location.pathname, title]);

  const navigation = <>
    <Link to="/dashboard" className="brand"><BrandMark /><span>braipen<small>思想，有迹可循。</small></span></Link>
    <div className="sidebar-label">WORKSPACE <span>工作空间</span></div>
    <nav aria-label="主导航" className="main-nav">
      {NAV_ITEMS.map(item => <NavLink key={item.path} to={item.path} className={({ isActive }) => isActive ? "nav-item active" : "nav-item"}>
        {item.icon}<span>{item.label}</span><small>{item.number}</small>
      </NavLink>)}
    </nav>
    <div className="sidebar-foot">
      <div className="lab-note"><span className="lab-dot" /> AN INDEPENDENT EXPLORATION<p>在故事里，探索 AI 的可能。</p></div>
      <NavLink to="/settings" className={({ isActive }) => isActive ? "nav-item active" : "nav-item"}><SettingOutlined /><span>偏好设置</span></NavLink>
      <button className="nav-item" onClick={() => { setAboutOpen(true); setMenuOpen(false); }}><ExperimentOutlined /><span>关于这次探索</span><ArrowUpOutlined rotate={45} /></button>
    </div>
  </>;

  return <div className="app-shell">
    <a href="#main-content" className="skip-link">跳到主要内容</a>
    <aside className="app-sidebar">{navigation}</aside>
    <Drawer className="mobile-nav" placement="left" open={menuOpen} onClose={() => setMenuOpen(false)} styles={{ body: { padding: 20 }, wrapper: { width: 260 } }} title="工作空间">{navigation}</Drawer>
    <div className="app-main">
      <header className="app-header">
        <div className="header-location"><Button className="mobile-menu-button" type="text" icon={<MenuOutlined />} aria-label="打开导航" onClick={() => setMenuOpen(true)} /><span className="header-section">工作空间</span><span className="header-slash">/</span><strong>{title}</strong></div>
        <div className="header-tools">
          <Select aria-label="当前项目" className="header-project" placeholder="选择一个故事" showSearch allowClear loading={projectsLoading} disabled={busy} value={selectedProjectRef ?? undefined} optionFilterProp="label" onChange={value => selectProject(value ?? null)} options={projects.map(p => ({ value: p.project_ref, label: p.title }))} notFoundContent={projectsLoading ? "正在读取项目…" : "还没有故事，从概览新建"} />
          <span className="connection-status" title={status.text}><Badge status={status.status} /><span>{status.text}</span></span>
        </div>
      </header>
      <main id="main-content" tabIndex={-1}><PageBoundary key={location.pathname}><Outlet /></PageBoundary></main>
      <footer className="app-footer"><span>BRAIPEN <span className="footer-divider">/</span> 人定方向，AI 参与创作。</span><button onClick={onReplayIntro}><PlayCircleOutlined /> 重播开场</button></footer>
    </div>
    <Drawer title="关于这次探索" open={aboutOpen} onClose={() => setAboutOpen(false)} size="large">
      <div className="about-content"><span className="eyebrow">BRAIPEN · PROJECT NOTES</span><h2>把一次生成，<br />放进完整的创作过程。</h2><p>Braipen 是一个独立的 AI 应用实验。它从小说生成出发，探索当文本越来越长、角色关系越来越多时，人如何继续掌握创作的方向。</p>
        <div className="about-principle"><b>01 / 先表达意图</b><p>用创作种子建立大纲与角色，再用章节任务和场景计划明确这一章要推进什么。</p></div>
        <div className="about-principle"><b>02 / 让上下文可见</b><p>把角色、场景、伏笔与关系组织进叙事图谱，为章节生成提供可选择的叙事素材。</p></div>
        <div className="about-principle"><b>03 / 把判断留给人</b><p>模型提出故事变化与知识候选，由作者审核后沉淀到图谱。章节规则检查提供线索，最终判断仍由作者完成。</p></div>
        <p className="about-caption">当前实现采用本地文件存储，支持流式生成、章节版本、任务审批与知识审核。它是一份可继续演进的工程作品。</p>
        <Space><Button onClick={() => { setAboutOpen(false); onReplayIntro(); }} icon={<PlayCircleOutlined />}>观看开场</Button><Button type="primary" onClick={() => setAboutOpen(false)}>回到创作</Button></Space>
      </div>
    </Drawer>
  </div>;
}
