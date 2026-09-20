import { useEffect, useState } from "react";
import { Alert, Button, Card, Empty, Space } from "antd";
import { ArrowLeftOutlined, ArrowRightOutlined, DownloadOutlined, EditOutlined } from "@ant-design/icons";
import { useNavigate, useSearchParams } from "react-router-dom";
import { exportFullBookUrl } from "../api";
import { useAppStore } from "../store/useAppStore";
import { useProjectData } from "../hooks/useProjectData";
import { getProjectWorkspace, rememberProjectWorkspace } from "../workspacePreferences";
import ChapterListPanel from "../components/chapter/ChapterListPanel";
import ChapterReader from "../components/chapter/ChapterReader";
import "../components/chapter/reader.css";

export default function ReaderPage() {
  const { selectedProjectRef } = useAppStore();
  return <ReaderWorkspace key={selectedProjectRef ?? "no-project"} />;
}

function ReaderWorkspace() {
  const { selectedProjectRef, apiStatus, chapters, chaptersLoading, chaptersLoaded, selectedProject } = useAppStore();
  const [selectedChapterNumber, setSelectedChapterNumber] = useState<number | null>(null);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { chaptersError, refreshChapters } = useProjectData(selectedProjectRef);
  const sorted = [...chapters].sort((a, b) => a.chapter_number - b.chapter_number);
  const requestedChapter = Number(params.get("chapter"));

  useEffect(() => {
    if (!chaptersLoaded || chaptersLoading) return;
    const has = (number: number | null | undefined) => chapters.some((item) => item.chapter_number === number);
    const remembered = getProjectWorkspace(selectedProjectRef).chapterNumber;
    const desired = has(requestedChapter) ? requestedChapter : has(selectedChapterNumber) ? selectedChapterNumber : has(remembered) ? remembered! : sorted[0]?.chapter_number ?? null;
    setSelectedChapterNumber(desired);
    if (selectedProjectRef && desired !== null) rememberProjectWorkspace(selectedProjectRef, { chapterNumber: desired });
  }, [chapters, chaptersLoaded, chaptersLoading, selectedChapterNumber, selectedProjectRef, requestedChapter]);

  const selectChapter = (chapter: number | null) => {
    setSelectedChapterNumber(chapter);
    setParams(chapter === null ? {} : { chapter: String(chapter) }, { replace: true });
  };
  const index = sorted.findIndex((item) => item.chapter_number === selectedChapterNumber);

  return <div className="page-container reader-page">
    <div className="page-heading"><div><span className="eyebrow">A MOMENT FOR THE STORY</span><h1 className="page-title">阅读室</h1><p className="page-subtitle">回到文字本身。阅读、推敲，把故事交还给自己的判断。</p></div><Space wrap><Button icon={<EditOutlined />} onClick={() => navigate("/writing")}>回到创作台</Button>{selectedProjectRef && chapters.length > 0 && <Button icon={<DownloadOutlined />} href={exportFullBookUrl(selectedProjectRef)} target="_blank" rel="noreferrer">导出全书</Button>}</Space></div>
    {apiStatus === "offline" && <Alert type="warning" showIcon message="本地服务尚未连接，连接后可读取章节。" />}
    {chaptersError && <Alert type="error" showIcon message={chaptersError} action={<Button size="small" onClick={() => void refreshChapters()}>重新加载</Button>} />}
    {!selectedProjectRef ? <Card><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择一本作品，开始阅读。"><Button type="primary" onClick={() => navigate("/dashboard")}>前往作品概览</Button></Empty></Card> : <div className="reader-workspace">
      <aside className="reader-directory"><div className="reader-directory-heading"><span className="eyebrow">CONTENTS</span><h2>{selectedProject?.title || "作品目录"}</h2><span>{chapters.length} 章 · 当前正文</span></div><ChapterListPanel selectedChapterNumber={selectedChapterNumber} onSelectChapter={selectChapter} /></aside>
      <section className="reader-sheet"><ChapterReader chapterNumber={selectedChapterNumber} footer={<footer className="reader-pagination"><Button type="text" icon={<ArrowLeftOutlined />} disabled={index <= 0} onClick={() => selectChapter(sorted[index - 1].chapter_number)}>上一章</Button><span>{index >= 0 ? `${index + 1} / ${sorted.length}` : "BRAIPEN · READER"}</span><Button type="text" disabled={index < 0 || index >= sorted.length - 1} onClick={() => selectChapter(sorted[index + 1].chapter_number)}>下一章 <ArrowRightOutlined /></Button></footer>} /></section>
    </div>}
  </div>;
}
