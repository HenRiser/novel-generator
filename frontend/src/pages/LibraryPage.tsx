import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Alert, Button, Empty, Select } from "antd";
import { ArrowRightOutlined, ExperimentOutlined, NodeIndexOutlined, ReloadOutlined } from "@ant-design/icons";
import { analyzeStoryDelta, getNarrativeGraph, safePublicMessage } from "../api";
import type { NarrativeGraphDocument } from "../types";
import { useAppStore } from "../store/useAppStore";
import { useProjectData } from "../hooks/useProjectData";
import { KnowledgeDraftReviewPanel } from "../components/library/KnowledgeDraftReviewPanel";
import "../components/library/library.css";

/** 从已保存正文提取候选，人工确认后再写入故事记忆。 */
export default function LibraryPage() {
  const navigate = useNavigate();
  const { apiStatus, selectedProjectRef, projects, chapters, chaptersLoading } = useAppStore();
  const { chaptersError } = useProjectData(selectedProjectRef);
  const [graph, setGraph] = useState<NarrativeGraphDocument | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState("");
  const [selectedChapter, setSelectedChapter] = useState<number | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState("");
  const [analysisMessage, setAnalysisMessage] = useState("");
  const [analysisWarnings, setAnalysisWarnings] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const lifecycle = useRef(0);
  const graphRequest = useRef(0);
  const currentProject = useRef(selectedProjectRef);
  currentProject.current = selectedProjectRef;
  const selectedProject = projects.find((project) => project.project_ref === selectedProjectRef) ?? null;
  const modernProject = Boolean(selectedProjectRef?.startsWith("book:"));
  const chapterOptions = useMemo(() => Array.from(new Map(chapters.map((chapter) => [chapter.chapter_number, chapter])).values())
    .sort((a, b) => b.chapter_number - a.chapter_number)
    .map((chapter) => ({ value: chapter.chapter_number, label: `第 ${chapter.chapter_number} 章 · ${chapter.title || "未命名章节"}` })), [chapters]);
  const chapterNumber = selectedChapter ?? chapterOptions[0]?.value ?? null;

  const loadGraph = useCallback(async () => {
    const requestId = ++graphRequest.current;
    if (!selectedProjectRef || apiStatus !== "online") { setGraph(null); setGraphLoading(false); return; }
    const current = () => requestId === graphRequest.current && currentProject.current === selectedProjectRef;
    setGraphLoading(true);
    setGraphError("");
    try {
      const result = await getNarrativeGraph(selectedProjectRef);
      if (current()) setGraph(result.graph ?? null);
    } catch (error) {
      if (current()) { setGraphError(safePublicMessage(error instanceof Error ? error.message : "", "图谱加载失败，请重试。")); setGraph(null); }
    } finally {
      if (current()) setGraphLoading(false);
    }
  }, [selectedProjectRef, apiStatus]);

  useEffect(() => {
    lifecycle.current++;
    setGraph(null); setSelectedChapter(null); setAnalyzing(false); setAnalysisError(""); setAnalysisMessage(""); setAnalysisWarnings([]);
    void loadGraph();
    return () => { lifecycle.current++; graphRequest.current++; };
  }, [loadGraph]);

  async function analyzeChapter() {
    if (!selectedProjectRef || chapterNumber === null || analyzing || !modernProject || apiStatus !== "online") return;
    const epoch = lifecycle.current;
    const current = () => lifecycle.current === epoch && currentProject.current === selectedProjectRef;
    setAnalyzing(true); setAnalysisError(""); setAnalysisMessage(""); setAnalysisWarnings([]);
    try {
      const result = await analyzeStoryDelta(selectedProjectRef, chapterNumber, {
        include_knowledge_draft: true, include_next_chapter_proposal: false, dry_run: false,
      });
      if (!current()) return;
      if (!result.ok) throw new Error(result.message || "章节分析未完成，请重试。");
      const count = result.knowledge_draft?.candidate_changes?.length ?? 0;
      setAnalysisMessage(`第 ${chapterNumber} 章分析完成，提取了 ${count} 项候选变更。请在下方逐项审核。`);
      setAnalysisWarnings(result.warnings ?? []);
      setRevision((value) => value + 1);
    } catch (error) {
      if (current()) setAnalysisError(safePublicMessage(error instanceof Error ? error.message : "", "章节分析失败，请检查模型连接后重试。"));
    } finally {
      if (current()) setAnalyzing(false);
    }
  }

  return (
    <div className="page-container library-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">HUMAN IN THE LOOP / 05</div>
          <h1 className="page-title">让故事，留下可信的记忆。</h1>
          <p className="page-subtitle">从正文提取人物、事件与关系。由你决定，哪些成为下一次创作的依据。</p>
        </div>
        <Button icon={<NodeIndexOutlined />} onClick={() => navigate("/graph")}>打开叙事图谱</Button>
      </div>
      {!selectedProjectRef ? (
        <div className="library-empty"><Empty description="选择一个作品，开始整理它的故事记忆。" image={Empty.PRESENTED_IMAGE_SIMPLE} /><Button onClick={() => navigate("/dashboard")}>前往作品集</Button></div>
      ) : (
        <>
          {apiStatus !== "online" && <Alert type="warning" showIcon message="本地服务尚未连接，连接恢复后可继续审核。" />}
          {!modernProject && <Alert type="info" showIcon message="当前是旧版作品。章节知识分析适用于新版作品；可在作品集新建一个作品开始体验。" />}
          <section className="library-pipeline" aria-label="知识审核流程">
            <div><span>01</span><strong>已保存正文</strong><p>以真实章节为来源</p></div><ArrowRightOutlined />
            <div><span>02</span><strong>模型提取候选</strong><p>保留证据与分析理由</p></div><ArrowRightOutlined />
            <div><span>03</span><strong>人工审核入图</strong><p>逐项接受，沉淀故事记忆</p></div>
          </section>
          <section className="library-analysis">
            <div className="library-analysis-copy"><ExperimentOutlined /><div><h2>分析一个章节</h2><p>提取候选知识，不会自动修改正式图谱。此操作将调用已配置的 AI 模型。</p></div></div>
            <div className="library-analysis-controls">
              <Select aria-label="待分析章节" placeholder="暂无已保存章节" value={chapterNumber} options={chapterOptions} onChange={setSelectedChapter} loading={chaptersLoading} disabled={analyzing || !chapterOptions.length} />
              <Button type="primary" loading={analyzing} disabled={!modernProject || apiStatus !== "online" || chapterNumber === null || chaptersLoading} onClick={() => void analyzeChapter()}>{analyzing ? "正在提取候选" : "分析章节 · 调用模型"}</Button>
            </div>
            {chapterOptions.length === 0 && !chaptersLoading && <p className="library-analysis-hint">保存第一章后即可提取故事知识。<Button type="link" size="small" onClick={() => navigate("/writing")}>前往创作台 <ArrowRightOutlined /></Button></p>}
          </section>
          {chaptersError && <Alert type="error" showIcon message={chaptersError} />}
          {analysisError && <Alert type="error" showIcon message={analysisError} />}
          {analysisMessage && <Alert type="success" showIcon message={analysisMessage} />}
          {analysisWarnings.length > 0 && <Alert type="warning" showIcon message="分析提示" description={analysisWarnings.map((warning, index) => <div key={index}>{warning}</div>)} />}
          <div className="library-memory-count"><span>正式图谱 <strong>{graph ? `${graph.graph.nodes.length} 个节点 / ${graph.graph.edges.length} 条关系` : "待加载"}</strong></span><Button type="text" size="small" icon={<ReloadOutlined />} loading={graphLoading} disabled={apiStatus !== "online"} onClick={() => void loadGraph()}>刷新图谱</Button></div>
          {graphError && <Alert type="error" showIcon message={graphError} />}
          {selectedProject && <KnowledgeDraftReviewPanel key={`${selectedProjectRef}:${revision}`} apiStatus={apiStatus} graph={graph} onGraphUpdated={(updated) => { if (useAppStore.getState().selectedProjectRef === selectedProjectRef) { graphRequest.current++; setGraphLoading(false); setGraph(updated); } }} selectedProject={selectedProject} />}
        </>
      )}
    </div>
  );
}
