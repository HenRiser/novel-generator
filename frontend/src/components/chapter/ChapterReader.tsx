import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Drawer, Empty, Space, Spin, Tooltip } from "antd";
import { DownloadOutlined, EditOutlined, FontSizeOutlined, MinusOutlined, PlusOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import { exportChapterUrl } from "../../api";
import { useAppStore } from "../../store/useAppStore";
import { useChapterContent } from "../../hooks/useProjectData";
import ContinueWriter from "./ContinueWriter";
import "./reader.css";

type ChapterReaderProps = { chapterNumber: number | null };
export default function ChapterReader({ chapterNumber }: ChapterReaderProps) {
  const navigate = useNavigate();
  const { selectedProjectRef, chapters, apiStatus } = useAppStore();
  const [refreshToken, setRefreshToken] = useState(0);
  const { content, title, loading, error } = useChapterContent(selectedProjectRef, chapterNumber, refreshToken);
  const [anchorText, setAnchorText] = useState<string | null>(null);
  const [writePanelOpen, setWritePanelOpen] = useState(false);
  const [fontSize, setFontSize] = useState(17);
  const proseRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const manuscriptHeading = content?.match(/^#\s+([^\n]+)\r?\n/);
  const manuscriptBody = manuscriptHeading ? content!.slice(manuscriptHeading[0].length).trimStart() : content;
  const chapter = chapters.find((item) => item.chapter_number === chapterNumber);
  useEffect(() => { setAnchorText(null); setWritePanelOpen(false); if (scrollRef.current) scrollRef.current.scrollTop = 0; }, [chapterNumber, selectedProjectRef]);
  const handleSelection = useCallback(() => {
    if (!selectedProjectRef || chapterNumber === null || apiStatus !== "online") return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !proseRef.current?.contains(selection.anchorNode) || !proseRef.current.contains(selection.focusNode)) return;
    const text = selection.toString().trim();
    if (text.length >= 5 && text.length <= 8000) { setAnchorText(text); setWritePanelOpen(true); }
  }, [chapterNumber, selectedProjectRef, apiStatus]);
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ chapterNumber: number; projectRef?: string }>).detail;
      if (!detail || detail.chapterNumber !== chapterNumber || detail.projectRef && detail.projectRef !== selectedProjectRef) return;
      setRefreshToken((current) => current + 1);
    };
    window.addEventListener("braipen:continue-saved", handler);
    return () => window.removeEventListener("braipen:continue-saved", handler);
  }, [chapterNumber, selectedProjectRef]);

  return <div className="chapter-reader">
    {selectedProjectRef && chapterNumber !== null && <header className="chapter-reader-toolbar"><span>第 {chapterNumber} 章 {chapter?.is_version ? `· v${chapter.version}` : ""}</span><Space wrap size={6}><Space.Compact><Tooltip title="缩小字号"><Button type="text" size="small" aria-label="缩小阅读字号" disabled={fontSize <= 14} icon={<MinusOutlined />} onClick={() => setFontSize((size) => size - 1)} /></Tooltip><Button type="text" size="small" disabled icon={<FontSizeOutlined />}>{fontSize}</Button><Tooltip title="放大字号"><Button type="text" size="small" aria-label="放大阅读字号" disabled={fontSize >= 23} icon={<PlusOutlined />} onClick={() => setFontSize((size) => size + 1)} /></Tooltip></Space.Compact><Button size="small" type="text" icon={<DownloadOutlined />} href={exportChapterUrl(selectedProjectRef, chapterNumber)} target="_blank" rel="noreferrer">下载</Button><Button size="small" icon={<EditOutlined />} disabled={!content || loading || apiStatus !== "online"} onClick={() => { setAnchorText(null); setWritePanelOpen(true); }}>续写</Button></Space></header>}
    <div className="chapter-reader-scroll" ref={scrollRef}>
      {loading ? <div className="reader-loading"><Spin /><p>正在翻开这一页…</p></div> : error ? <Alert type="error" showIcon message={error} action={<Button size="small" onClick={() => setRefreshToken((current) => current + 1)}>重试</Button>} /> : content ? <article className="reader-prose" ref={proseRef} onMouseUp={handleSelection} onKeyUp={handleSelection}><div className="reader-chapter-kicker">CHAPTER {String(chapterNumber).padStart(2, "0")}</div><h2>{manuscriptHeading?.[1] || title || chapter?.title || `第 ${chapterNumber} 章`}</h2><div className="reader-chapter-rule" /><div className="reader-prose-body" style={{ fontSize }}>{manuscriptBody}</div><div className="reader-end-mark" aria-hidden="true">✦</div></article> : <div className="reader-blank"><span className="eyebrow">THE NEXT PAGE</span><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={!selectedProjectRef ? "选择一本作品，翻开故事。" : chapterNumber === null ? "从目录中选择一章，或开始写下新的故事。" : "这一章还没有正文。"}><Button icon={<EditOutlined />} onClick={() => navigate(selectedProjectRef ? "/writing" : "/dashboard")}>{selectedProjectRef ? "前往创作台" : "前往作品概览"}</Button></Empty></div>}
    </div>
    <Drawer title="接着这一页，继续写" open={writePanelOpen && Boolean(content)} onClose={() => setWritePanelOpen(false)} size={520} destroyOnHidden>
      <p className="reader-drawer-hint">描述你想推进的情节。生成后可以预览，再决定如何保存。</p>
      {selectedProjectRef && chapterNumber !== null && content && <ContinueWriter key={`${selectedProjectRef}:${chapterNumber}`} projectRef={selectedProjectRef} chapterNumber={chapterNumber} contextText={content} anchorText={anchorText} onClearAnchor={() => setAnchorText(null)} />}
    </Drawer>
  </div>;
}
