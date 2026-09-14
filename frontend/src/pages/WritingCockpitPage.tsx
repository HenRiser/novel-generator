import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Empty, Skeleton, Space, Tabs } from "antd";
import { ArrowRightOutlined, FileTextOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { Link, useSearchParams } from "react-router-dom";
import type { ChapterStreamDoneEvent } from "../types";
import { selectGenerationBusy, useAppStore } from "../store/useAppStore";
import { useChapterStatus, useProjectData } from "../hooks/useProjectData";
import ChapterReader from "../components/chapter/ChapterReader";
import GenerationPanel from "../components/generation/GenerationPanel";
import AssetsPanel from "../components/AssetsPanel";
import "../styles/writing.css";

export default function WritingCockpitPage() {
  const { selectedProjectRef } = useAppStore();
  const { refreshChapters, detailError, chaptersError } = useProjectData(selectedProjectRef);
  return <div className="page-container writing-page">
    <div className="page-heading"><div><span className="eyebrow">THE WRITING ROOM</span><h1 className="page-title">创作台</h1><p className="page-subtitle">从一个念头，到一页手稿。故事的方向始终由你掌握。</p></div></div>
    {(detailError || chaptersError) && <Alert type="error" showIcon message={detailError || chaptersError} />}
    {!selectedProjectRef ? <div className="studio-empty"><span className="studio-empty-mark"><FileTextOutlined /></span><h2>给下一个故事，留一张空白纸。</h2><p>从顶部选择已有项目，或回到概览创建一个新故事。</p><Link to="/dashboard"><Button type="primary">前往项目概览 <ArrowRightOutlined /></Button></Link></div> : <Studio key={selectedProjectRef} refreshChapters={refreshChapters} />}
  </div>;
}

function Studio({ refreshChapters }: { refreshChapters: () => Promise<void> }) {
  const { selectedProjectRef, selectedProject, chapters, chaptersLoading, chapterStatus } = useAppStore();
  const [selectedChapterNumber, setSelectedChapterNumber] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState("generate");
  const [revision, setRevision] = useState(0);
  const [assetsRevision, setAssetsRevision] = useState(0);
  const busy = useAppStore(selectGenerationBusy);
  const [params, setParams] = useSearchParams();
  const requested = Number(params.get("chapter"));
  const targetChapter = Number.isInteger(requested) && requested > 0 ? requested : null;
  const setTargetChapter = (value: number | null) => setParams(value === null ? {} : { chapter: String(value) }, { replace: true });
  const [saved, setSaved] = useState<ChapterStreamDoneEvent | null>(null);
  const sorted = useMemo(() => [...chapters].sort((a, b) => a.chapter_number - b.chapter_number), [chapters]);
  const nextChapter = Math.max(0, ...chapters.map((chapter) => chapter.chapter_number)) + 1;
  const status = useChapterStatus(selectedProjectRef, selectedChapterNumber, revision);
  useEffect(() => {
    if (selectedChapterNumber === null && sorted.length) setSelectedChapterNumber(sorted[sorted.length - 1].chapter_number);
  }, [selectedChapterNumber, sorted]);
  const handleDone = useCallback((result: ChapterStreamDoneEvent) => {
    setSaved(result); setSelectedChapterNumber(result.chapter_number); setRevision((value) => value + 1); setActiveTab("reader"); setParams({}, { replace: true });
    void refreshChapters();
  }, [refreshChapters, setParams]);
  const handleAssets = useCallback(() => { setAssetsRevision((value) => value + 1); setActiveTab("assets"); }, []);

  return <>
    {saved && <Alert className="studio-saved" type="success" showIcon message={`第 ${saved.chapter_number} 章已保存`} description="可以继续阅读和续写，也可以在流程记录中查看本章的审查结果。" closable onClose={() => setSaved(null)} />}
    <div className="studio-layout">
      <aside className="studio-rail" aria-label="章节目录">
        <div className="studio-rail-heading"><span className="eyebrow">MANUSCRIPT</span><h2>{selectedProject?.title || "我的手稿"}</h2><span className="muted-note">{chapters.length} 个章节</span></div>
        <Button type="primary" icon={<PlusOutlined />} block disabled={busy} onClick={() => { setTargetChapter(nextChapter); setActiveTab("generate"); }}>开始第 {nextChapter} 章</Button>
        <div className="studio-rail-label"><span>章节目录</span><Button type="text" size="small" icon={<ReloadOutlined />} aria-label="刷新章节目录" loading={chaptersLoading} onClick={() => void refreshChapters()} /></div>
        {chaptersLoading && !chapters.length ? <Skeleton active paragraph={{ rows: 4 }} title={false} /> : sorted.length ? <nav className="studio-chapters">{sorted.map((chapter) => <button type="button" key={chapter.chapter_number} className={`studio-chapter${selectedChapterNumber === chapter.chapter_number && activeTab === "reader" ? " is-active" : ""}`} onClick={() => { setSelectedChapterNumber(chapter.chapter_number); setActiveTab("reader"); }} aria-current={selectedChapterNumber === chapter.chapter_number && activeTab === "reader" ? "page" : undefined}><span className="studio-chapter-number">{String(chapter.chapter_number).padStart(2, "0")}</span><span><strong>{chapter.title || `第 ${chapter.chapter_number} 章`}</strong><small>{chapter.is_version ? `修订版本 ${chapter.version}` : "已保存手稿"}</small></span></button>)}</nav> : <p className="studio-rail-empty">第一章还未落笔。<br />先准备大纲与人物，<br />再开始你的故事。</p>}
        <div className="studio-rail-footer"><span className="eyebrow">AUTHOR IN CONTROL</span><p>规划 → 生成 → 审核<br />每一步，都留得下依据。</p><Link to={`/review?chapter=${targetChapter ?? nextChapter}`}>准备章节规划 <ArrowRightOutlined /></Link></div>
      </aside>
      <section className="studio-main" aria-label="创作工作区">
        <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
          { key: "generate", label: "AI 共创", children: <GenerationPanel onStreamDone={handleDone} onAssetsGenerated={handleAssets} targetChapterNumber={targetChapter ?? nextChapter} onTargetChapterChange={setTargetChapter} /> },
          { key: "reader", label: "章节手稿", children: selectedChapterNumber !== null ? <div className="studio-reader"><div className="studio-document-actions"><Button size="small" type="text" disabled={busy} onClick={() => { setTargetChapter(selectedChapterNumber); setActiveTab("generate"); }}>重新生成第 {selectedChapterNumber} 章</Button><Link to={`/review?chapter=${selectedChapterNumber}`}>本章规划 <ArrowRightOutlined /></Link></div><ChapterReader key={`${selectedProjectRef}-${selectedChapterNumber}-${revision}`} chapterNumber={selectedChapterNumber} /></div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="生成第一章后，手稿会出现在这里。" /> },
          { key: "assets", label: "故事设定", children: <AssetsPanel key={`${selectedProjectRef}-${assetsRevision}`} /> },
          { key: "status", label: "流程记录", children: <div className="studio-status"><div className="studio-status-heading"><div><span className="eyebrow">CHAPTER RECORD</span><h2>{selectedChapterNumber !== null ? `第 ${selectedChapterNumber} 章的创作记录` : "等待第一章"}</h2></div><Button icon={<ReloadOutlined />} loading={status.loading} onClick={() => void status.refresh()} disabled={selectedChapterNumber === null}>刷新记录</Button></div>{status.error && <Alert type="error" showIcon message={status.error} />}{status.loading ? <Skeleton active /> : chapterStatus ? <><div className="studio-status-grid"><div><strong>{chapterStatus.chapter_status.chapter.exists ? "已保存" : "未生成"}</strong><span>章节手稿</span></div><div><strong>{chapterStatus.chapter_status.review.pending_count}</strong><span>等待复核</span></div><div><strong>{chapterStatus.chapter_status.review.accepted_count}</strong><span>已接受变更</span></div><div><strong>{chapterStatus.chapter_status.knowledge_drafts.counts.total}</strong><span>知识草稿</span></div></div>{chapterStatus.chapter_status.warnings.map((warning) => <Alert key={warning.code} type="warning" showIcon message={warning.message} />)}<Space wrap><Link to={`/review?chapter=${selectedChapterNumber}`}><Button>查看章节审查</Button></Link><Link to="/library"><Button>审核知识变更 <ArrowRightOutlined /></Button></Link></Space></> : !status.error && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择一个章节，查看它的生成与审核记录。" />}</div> },
        ]} />
      </section>
    </div>
  </>;
}
