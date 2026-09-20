import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Alert, Button, ConfigProvider, Drawer, Empty, Space, Spin, Tooltip, theme as antdTheme } from "antd";
import { DownloadOutlined, EditOutlined, MinusOutlined, PlusOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import { exportChapterUrl, getChapters } from "../../api";
import { selectGenerationBusy, useAppStore } from "../../store/useAppStore";
import { useChapterContent } from "../../hooks/useProjectData";
import { useReaderPreferences, useReadingPosition } from "../../hooks/useReaderPreferences";
import type { ReaderFont, ReaderTheme } from "../../workspacePreferences";
import type { ChapterWorkflow } from "../../types";
import ContinueWriter from "./ContinueWriter";
import ChapterConfirmationPanel from "./ChapterConfirmationPanel";
import "./reader.css";

type ChapterReaderProps = { chapterNumber: number | null; onWorkflowChange?: (workflow: ChapterWorkflow | null) => void; footer?: ReactNode };
export default function ChapterReader({ chapterNumber, onWorkflowChange, footer }: ChapterReaderProps) {
  const navigate = useNavigate();
  const { selectedProjectRef, chapters, apiStatus } = useAppStore();
  const [refreshToken, setRefreshToken] = useState(0);
  const { content, title, filename, loading, error } = useChapterContent(selectedProjectRef, chapterNumber, refreshToken);
  const [workflow, setWorkflow] = useState<ChapterWorkflow | null>(null);
  const busy = useAppStore(selectGenerationBusy);
  const [anchorText, setAnchorText] = useState<string | null>(null);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [writePanelOpen, setWritePanelOpen] = useState(false);
  const { fontSize, setFontSize, font, setFont, theme, setTheme } = useReaderPreferences();
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const readerTheme = theme === "auto" ? systemDark ? "night" : "paper" : theme;
  const controlTheme = useMemo(() => {
    const dark = readerTheme === "night";
    const paper = readerTheme === "paper";
    return {
      inherit: false,
      algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      token: {
        colorPrimary: dark ? "#9fbea5" : "#244d3c",
        colorTextLightSolid: dark ? "#18241c" : "#ffffff",
        colorBgContainer: dark ? "#202522" : paper ? "#fffdf6" : "#fcfcfa",
        colorBgElevated: dark ? "#202522" : paper ? "#fffdf6" : "#fcfcfa",
        colorText: dark ? "#d8d9cf" : "#343a34",
        colorTextSecondary: dark ? "#b2b7ac" : "#696c60",
        colorBorder: dark ? "#414940" : "#dcdace",
        borderRadius: 8,
        fontFamily: '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
      },
    };
  }, [readerTheme]);
  const readerStyle = { "--reader-font-size": `${fontSize}px` } as CSSProperties;
  const proseRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const layoutAnchor = useRef<{ range: Range | null; top: number; progress: number } | null>(null);
  const selectionActionsRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLElement>(null);
  const locateButtonRef = useRef<HTMLElement | null>(null);
  const [located, setLocated] = useState<{ evidence: string; revision: string; index: number } | null>(null);
  const [locationError, setLocationError] = useState("");
  const syncReadingPosition = useReadingPosition({ projectRef: selectedProjectRef, chapterNumber, filename, content, loading, scrollRef });
  const manuscriptHeading = content?.match(/^#\s+([^\n]+)\r?\n/);
  const manuscriptBody = manuscriptHeading ? content!.slice(manuscriptHeading[0].length).trimStart() : content;
  const changeTypography = (change: () => void) => {
    syncReadingPosition();
    const scroll = scrollRef.current;
    const body = proseRef.current?.querySelector(".reader-prose-body");
    if (scroll && body) {
      const box = scroll.getBoundingClientRect();
      const textBox = body.getBoundingClientRect();
      const y = Math.max(box.top, textBox.top, 0) + 12;
      const x = textBox.left + Math.min(20, textBox.width / 2);
      let range: Range | null = null;
      if (y < Math.min(box.bottom, textBox.bottom, window.innerHeight)) {
        const caret = document.caretPositionFromPoint?.(x, y);
        if (caret) { range = document.createRange(); range.setStart(caret.offsetNode, caret.offset); range.collapse(true); }
        else range = document.caretRangeFromPoint?.(x, y) ?? null;
        if (range && (!body.contains(range.startContainer) || range.startContainer.nodeType !== Node.TEXT_NODE || !range.getBoundingClientRect().height)) range = null;
      }
      layoutAnchor.current = { range, top: range ? range.getBoundingClientRect().top - box.top : 0, progress: scroll.scrollTop / Math.max(1, scroll.scrollHeight - scroll.clientHeight) };
    }
    change();
  };
  useLayoutEffect(() => {
    const anchor = layoutAnchor.current;
    layoutAnchor.current = null;
    const scroll = scrollRef.current;
    if (!scroll || !anchor) return;
    // 原文节点不变，以同一字符恢复换行前的位置；旧浏览器退回相对进度。
    if (anchor.range && proseRef.current?.contains(anchor.range.startContainer)) scroll.scrollTop += anchor.range.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.top;
    else scroll.scrollTop = anchor.progress * Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    syncReadingPosition();
  }, [fontSize, font, syncReadingPosition]);
  const chapter = chapters.find((item) => item.chapter_number === chapterNumber);
  const displayTitle = manuscriptHeading?.[1] || title || chapter?.title || `第 ${chapterNumber} 章`;
  const evidenceMatches = useMemo(() => {
    const matches: { section: "title" | "body"; start: number; end: number }[] = [];
    if (!located?.evidence || located.revision !== workflow?.revision) return matches;
    for (const section of ["title", "body"] as const) {
      const text = section === "title" ? displayTitle : manuscriptBody || "";
      let start = text.indexOf(located.evidence);
      while (start >= 0) {
        matches.push({ section, start, end: start + located.evidence.length });
        start = text.indexOf(located.evidence, start + located.evidence.length);
      }
    }
    return matches;
  }, [located, workflow?.revision, displayTitle, manuscriptBody]);
  const activeMatch = located ? evidenceMatches[located.index] : undefined;
  const highlightedText = (text: string, section: "title" | "body") => activeMatch?.section === section
    ? <>{text.slice(0, activeMatch.start)}<mark ref={highlightRef} tabIndex={-1} className="reader-evidence-highlight" aria-label="当前定位的冲突原文">{text.slice(activeMatch.start, activeMatch.end)}</mark>{text.slice(activeMatch.end)}</>
    : text;
  const canContinue = Boolean(content && workflow?.editable && filename && filename.replace(/\\/g, "/").split("/").pop() === workflow.chapter_file.replace(/\\/g, "/").split("/").pop()) && !busy && !loading && apiStatus === "online";
  const handleWorkflow = useCallback((value: ChapterWorkflow | null) => { setWorkflow(value); onWorkflowChange?.(value); }, [onWorkflowChange]);
  const handleConfirmed = useCallback(() => {
    if (!selectedProjectRef) return;
    const projectRef = selectedProjectRef;
    setRefreshToken((value) => value + 1);
    void getChapters(projectRef).then((items) => { if (useAppStore.getState().selectedProjectRef === projectRef) useAppStore.getState().setChapters(items); }).catch(() => undefined);
  }, [selectedProjectRef]);
  useEffect(() => { setWorkflow(null); setAnchorText(null); setWritePanelOpen(false); }, [chapterNumber, selectedProjectRef]);
  useEffect(() => { setLocated(null); setLocationError(""); setSelectedText(null); }, [content, filename, chapterNumber, selectedProjectRef]);
  useEffect(() => { if (workflow && !workflow.editable) { setWritePanelOpen(false); setSelectedText(null); } }, [workflow]);
  useEffect(() => { if (!canContinue) setSelectedText(null); }, [canContinue]);
  const handleSelection = useCallback(() => {
    if (!selectedProjectRef || chapterNumber === null || !canContinue) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !proseRef.current?.contains(selection.anchorNode) || !proseRef.current.contains(selection.focusNode)) { setSelectedText(null); return; }
    const text = selection.toString().trim();
    setSelectedText(text.length >= 5 && text.length <= 8000 ? text : null);
  }, [chapterNumber, selectedProjectRef, canContinue]);
  useEffect(() => {
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!proseRef.current?.contains(target) && !selectionActionsRef.current?.contains(target)) setSelectedText(null);
    };
    const dismissEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setSelectedText(null); };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissEscape);
    return () => { document.removeEventListener("pointerdown", dismissOutside); document.removeEventListener("keydown", dismissEscape); };
  }, []);
  const locateEvidence = useCallback((evidence: string, revision: string) => {
    setLocationError("");
    if (loading || !workflow || revision !== workflow.revision || workflow.content !== content) {
      setLocated(null); setLocationError("正文版本已变化，请刷新提示后再定位。"); return;
    }
    if (!evidence || !displayTitle.includes(evidence) && !manuscriptBody?.includes(evidence)) {
      setLocated(null); setLocationError("当前正文中未找到这段原文，请核对提示与正文版本。"); return;
    }
    locateButtonRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setLocated({ evidence, revision, index: 0 });
  }, [loading, workflow, content, displayTitle, manuscriptBody]);
  useEffect(() => {
    if (!located || !activeMatch) return;
    highlightRef.current?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    highlightRef.current?.focus({ preventScroll: true });
  }, [located, activeMatch]);
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ chapterNumber?: number; projectRef?: string }>).detail;
      if (!detail || detail.chapterNumber !== undefined && detail.chapterNumber !== chapterNumber || detail.projectRef && detail.projectRef !== selectedProjectRef) return;
      setRefreshToken((current) => current + 1);
    };
    window.addEventListener("braipen:continue-saved", handler);
    window.addEventListener("braipen:workflow-changed", handler);
    return () => { window.removeEventListener("braipen:continue-saved", handler); window.removeEventListener("braipen:workflow-changed", handler); };
  }, [chapterNumber, selectedProjectRef]);

  return <ConfigProvider theme={controlTheme}><div className="chapter-reader" data-reader-font={font} data-reader-theme={readerTheme} style={readerStyle}>
    {selectedProjectRef && chapterNumber !== null && <header className="chapter-reader-toolbar">
      <span>第 {chapterNumber} 章 {chapter?.is_version ? `· v${chapter.version}` : ""}</span>
      <div className="reader-preference-controls">
        <label className="reader-preference-label">字体<select className="reader-preference-select" aria-label="阅读字体" value={font} onChange={(event) => changeTypography(() => setFont(event.target.value as ReaderFont))}><option value="serif">书页 · 宋体</option><option value="sans">清晰 · 黑体</option></select></label>
        <Space.Compact><Tooltip title="缩小字号"><Button type="text" size="small" aria-label="缩小阅读字号" disabled={fontSize <= 14} icon={<MinusOutlined />} onClick={() => changeTypography(() => setFontSize((size) => size - 1))} /></Tooltip><output className="reader-font-value" aria-label="阅读字号" aria-live="polite">{fontSize}</output><Tooltip title="放大字号"><Button type="text" size="small" aria-label="放大阅读字号" disabled={fontSize >= 28} icon={<PlusOutlined />} onClick={() => changeTypography(() => setFontSize((size) => size + 1))} /></Tooltip></Space.Compact>
        <label className="reader-preference-label">底色<select className="reader-preference-select" aria-label="阅读底色" value={theme} onChange={(event) => setTheme(event.target.value as ReaderTheme)}><option value="auto">随系统</option><option value="paper">暖纸</option><option value="white">清白</option><option value="night">夜读</option></select></label>
        <Button size="small" type="text" icon={<DownloadOutlined />} href={exportChapterUrl(selectedProjectRef, chapterNumber)} target="_blank" rel="noreferrer">下载</Button><Button size="small" icon={<EditOutlined />} disabled={!canContinue} onClick={() => { setAnchorText(null); setWritePanelOpen(true); }}>续写</Button>
      </div>
    </header>}

    {selectedText && canContinue && <div className="reader-selection-actions" ref={selectionActionsRef} role="group" aria-label="选中文本操作"><span>已选中 {selectedText.length} 字</span><Button size="small" onClick={() => { setAnchorText(selectedText); setSelectedText(null); setWritePanelOpen(true); }}>以此为参考续写</Button><Button size="small" type="text" onClick={() => setSelectedText(null)}>收起</Button></div>}
    {locationError && <Alert type="info" showIcon message={locationError} closable onClose={() => setLocationError("")} />}
    {located && evidenceMatches.length > 0 && <div className="reader-evidence-actions" role="group" aria-label="原文定位"><span role="status">{evidenceMatches.length > 1 ? `共 ${evidenceMatches.length} 处相同原文，当前第 ${located.index + 1} 处` : "已定位原文"}</span>{evidenceMatches.length > 1 && <><Button size="small" disabled={located.index === 0} onClick={() => setLocated({ ...located, index: located.index - 1 })}>上一处</Button><Button size="small" disabled={located.index >= evidenceMatches.length - 1} onClick={() => setLocated({ ...located, index: located.index + 1 })}>下一处</Button></>}<Button size="small" type="text" onClick={() => { locateButtonRef.current?.scrollIntoView({ block: "center" }); locateButtonRef.current?.focus({ preventScroll: true }); }}>返回提示</Button><Button size="small" type="text" onClick={() => setLocated(null)}>关闭定位</Button></div>}
    <div className="chapter-reader-scroll" ref={scrollRef}>
    {selectedProjectRef && chapterNumber !== null && <ChapterConfirmationPanel key={`${selectedProjectRef}:${chapterNumber}`} projectRef={selectedProjectRef} chapterNumber={chapterNumber} displayedFilename={filename} readingLoading={loading} refreshToken={refreshToken} onWorkflowChange={handleWorkflow} onConfirmed={handleConfirmed} onLocateEvidence={locateEvidence} />}
      {loading ? <div className="reader-loading"><Spin /><p>正在翻开这一页…</p></div> : error ? <Alert type="error" showIcon message={error} action={<Button size="small" onClick={() => setRefreshToken((current) => current + 1)}>重试</Button>} /> : content ? <article className="reader-prose" ref={proseRef} onMouseUp={handleSelection} onKeyUp={handleSelection}><div className="reader-chapter-kicker">CHAPTER {String(chapterNumber).padStart(2, "0")}</div><h2>{highlightedText(displayTitle, "title")}</h2><div className="reader-chapter-rule" /><div className="reader-prose-body" style={{ fontSize }}>{highlightedText(manuscriptBody || "", "body")}</div><div className="reader-end-mark" aria-hidden="true">✦</div></article> : <div className="reader-blank"><span className="eyebrow">THE NEXT PAGE</span><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={!selectedProjectRef ? "选择一本作品，翻开故事。" : chapterNumber === null ? "从目录中选择一章，或开始写下新的故事。" : "这一章还没有正文。"}><Button icon={<EditOutlined />} onClick={() => navigate(selectedProjectRef ? "/writing" : "/dashboard")}>{selectedProjectRef ? "前往创作台" : "前往作品概览"}</Button></Empty></div>}
    </div>
    {footer}
    <Drawer title="接着这一页，继续写" rootClassName={`reader-drawer reader-theme-${readerTheme} reader-font-${font}`} rootStyle={readerStyle} open={writePanelOpen && Boolean(content)} onClose={() => setWritePanelOpen(false)} size={520} destroyOnHidden>
      <p className="reader-drawer-hint">描述你想推进的情节。生成后可以预览，再决定如何保存。</p>
      {selectedProjectRef && chapterNumber !== null && content && <ContinueWriter key={`${selectedProjectRef}:${chapterNumber}`} projectRef={selectedProjectRef} chapterNumber={chapterNumber} contextText={content} anchorText={anchorText} disabled={!workflow?.editable || busy} onClearAnchor={() => setAnchorText(null)} />}
    </Drawer>
  </div></ConfigProvider>;
}
