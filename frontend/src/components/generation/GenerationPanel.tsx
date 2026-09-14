import { useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Collapse, Input, InputNumber, Select, Space, Tag } from "antd";
import { ArrowRightOutlined, FileSearchOutlined, SaveOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";
import type { ChapterStreamDoneEvent, ChapterTaskSheet, ContextPackPreviewResponse, GenerationRequest, ScenePlan } from "../../types";
import { generateChapterStream, generateOutlineCharacters, getChapterTask, getScenePlan, previewContextPack, updateGenerationSettings } from "../../api";
import { useAppStore } from "../../store/useAppStore";
import StreamingPreview from "./StreamingPreview";

const DEFAULT_SETTINGS: GenerationRequest = { model: "deepseek-v4-flash", max_tokens: 16384, temperature: 1 };
type Props = { onStreamDone: (result: ChapterStreamDoneEvent) => void; onAssetsGenerated: () => void; targetChapterNumber: number; onTargetChapterChange: (value: number) => void };

export default function GenerationPanel({ onStreamDone, onAssetsGenerated, targetChapterNumber, onTargetChapterChange }: Props) {
  const { apiStatus, selectedProjectRef, selectedProject, projectLoading, generationBusy, setBusy } = useAppStore();
  const [settings, setSettings] = useState<GenerationRequest>(DEFAULT_SETTINGS);
  const chapterNumber = targetChapterNumber;
  const [outlineGenerating, setOutlineGenerating] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingReasoning, setStreamingReasoning] = useState("");
  const [status, setStatus] = useState<"idle" | "streaming" | "saved" | "failed" | "stopped">("idle");
  const [result, setResult] = useState<ChapterStreamDoneEvent | null>(null);
  const [task, setTask] = useState<ChapterTaskSheet | null>(null);
  const [plan, setPlan] = useState<ScenePlan | null>(null);
  const [plansLoading, setPlansLoading] = useState(false);
  const [plansError, setPlansError] = useState("");
  const [usePlan, setUsePlan] = useState(true);
  const [goal, setGoal] = useState("");
  const [context, setContext] = useState<ContextPackPreviewResponse | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState("");
  const [useContext, setUseContext] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const contextSequence = useRef(0);
  const busy = outlineGenerating || status === "streaming";
  const canGenerate = Boolean(selectedProjectRef && selectedProject) && apiStatus === "online" && !busy && !projectLoading && !generationBusy.chapterStreaming && !generationBusy.chapterGenerating && !generationBusy.outlineGenerating;
  const supportsPlanning = Boolean(selectedProjectRef?.startsWith("book:"));

  useEffect(() => {
    setSettings(DEFAULT_SETTINGS); setNotice(""); setError(""); setStatus("idle"); setResult(null);
    setStreamingContent(""); setStreamingReasoning(""); setOutlineGenerating(false); setSaving(false); setGoal("");
    return () => {
      controllerRef.current?.abort(); controllerRef.current = null; ++contextSequence.current;
      setBusy({ chapterStreaming: false, outlineGenerating: false });
    };
  }, [selectedProjectRef, setBusy]);
  useEffect(() => {
    if (selectedProject?.project_ref !== selectedProjectRef) return;
    const config = selectedProject?.config ?? {};
    setSettings({
      model: typeof config.model === "string" ? config.model : DEFAULT_SETTINGS.model,
      max_tokens: typeof config.max_tokens === "number" ? config.max_tokens : DEFAULT_SETTINGS.max_tokens,
      temperature: typeof config.temperature === "number" ? config.temperature : DEFAULT_SETTINGS.temperature,
    });
  }, [selectedProject, selectedProjectRef]);
  useEffect(() => {
    let cancelled = false;
    setTask(null); setPlan(null); setPlansError(""); setUsePlan(true);
    setContext(null); setUseContext(false); setContextError(""); setContextLoading(false); ++contextSequence.current;
    if (!selectedProjectRef || !supportsPlanning || apiStatus !== "online") { setPlansLoading(false); return; }
    setPlansLoading(true);
    void Promise.all([getChapterTask(selectedProjectRef, chapterNumber), getScenePlan(selectedProjectRef, chapterNumber)])
      .then(([tasks, plans]) => { if (!cancelled) { setTask(tasks.approved); setPlan(plans.approved); } })
      .catch((e) => { if (!cancelled) setPlansError(e instanceof Error ? e.message : "章节规划读取失败。"); })
      .finally(() => { if (!cancelled) setPlansLoading(false); });
    return () => { cancelled = true; };
  }, [apiStatus, chapterNumber, selectedProjectRef, supportsPlanning]);

  const handleGenerateOutline = async () => {
    if (!selectedProjectRef || !canGenerate) return;
    const controller = new AbortController(); controllerRef.current = controller;
    setOutlineGenerating(true); setBusy({ outlineGenerating: true }); setError(""); setNotice("");
    try {
      const response = await generateOutlineCharacters(selectedProjectRef, settings, controller.signal);
      if (controllerRef.current !== controller || controller.signal.aborted) return;
      setNotice(response.message || "大纲与人物卡已保存，可在「故事设定」查看。"); onAssetsGenerated();
    } catch (e) {
      if (controllerRef.current === controller && !controller.signal.aborted) setError(e instanceof Error ? e.message : "设定生成失败。");
    } finally {
      if (controllerRef.current === controller) { controllerRef.current = null; setOutlineGenerating(false); setBusy({ outlineGenerating: false }); }
    }
  };
  const planMatchesTask = !plan?.source_chapter_task_id || (plan.source_chapter_task_id === task?.id && plan.source_chapter_task_revision === task?.revision);
  const handleGenerateChapter = async () => {
    if (!selectedProjectRef || !canGenerate || plansLoading || plansError) return;
    const controller = new AbortController(); controllerRef.current = controller;
    const current = () => controllerRef.current === controller && !controller.signal.aborted;
    setStatus("streaming"); setBusy({ chapterStreaming: true }); setError(""); setNotice("");
    setStreamingContent(""); setStreamingReasoning(""); setResult(null);
    try {
      const response = await generateChapterStream(selectedProjectRef, chapterNumber, {
        ...settings, chapter_task_id: task?.id,
        scene_plan_id: usePlan && planMatchesTask ? plan?.id : undefined,
        narrative_context_text: useContext && context ? context.prompt_text : undefined,
      }, {
        onDelta: (text) => { if (current()) setStreamingContent((value) => value + text); },
        onReasoning: (text) => { if (current()) setStreamingReasoning((value) => value + text); },
      }, controller.signal);
      if (!current()) return;
      setResult(response); setStatus("saved"); onStreamDone(response);
    } catch (e) {
      if (current()) { setError(e instanceof Error ? e.message : "章节生成失败。"); setStatus("failed"); }
    } finally {
      if (controllerRef.current === controller) { controllerRef.current = null; setBusy({ chapterStreaming: false }); }
    }
  };
  const stop = () => {
    controllerRef.current?.abort(); controllerRef.current = null;
    setStatus("stopped"); setOutlineGenerating(false); setBusy({ chapterStreaming: false, outlineGenerating: false });
    setNotice("已断开生成连接。后端可能已完成保存，请刷新章节目录核对结果。");
  };
  const saveSettings = async () => {
    if (!selectedProjectRef || saving) return;
    const projectRef = selectedProjectRef;
    setSaving(true); setError(""); setNotice("");
    try {
      await updateGenerationSettings(projectRef, { ...settings, model: settings.model === "deepseek-v4-pro" ? "deepseek-v4-pro" : "deepseek-v4-flash" });
      if (useAppStore.getState().selectedProjectRef === projectRef) setNotice("生成参数已保存到当前项目。");
    } catch (e) {
      if (useAppStore.getState().selectedProjectRef === projectRef) setError(e instanceof Error ? e.message : "参数保存失败，请重试。");
    } finally { if (useAppStore.getState().selectedProjectRef === projectRef) setSaving(false); }
  };
  const preview = async () => {
    if (!selectedProjectRef || !supportsPlanning) return;
    const sequence = ++contextSequence.current;
    setContextLoading(true); setContextError(""); setContext(null); setUseContext(false);
    try {
      const response = await previewContextPack(selectedProjectRef, {
        chapter_number: chapterNumber, chapter_goal: goal, min_importance: 1, max_nodes: 30, max_edges: 40,
        include_neighbors: true, include_unresolved_foreshadowing: true,
      });
      if (sequence === contextSequence.current) { setContext(response); setUseContext(true); }
    } catch (e) { if (sequence === contextSequence.current) setContextError(e instanceof Error ? e.message : "上下文预览失败。"); }
    finally { if (sequence === contextSequence.current) setContextLoading(false); }
  };

  return <div className="generation-workspace">
    <div className="generation-intro"><span className="eyebrow">CO-WRITE WITH AI</span><h2>你定方向，模型落笔。</h2><p>先准备故事设定，再让已确认的章节规划与叙事知识参与创作。</p></div>
    <div className="generation-action-row">
      <label className="field-label">目标章节<InputNumber aria-label="目标章节" min={1} precision={0} value={chapterNumber} onChange={(value) => onTargetChapterChange(value ?? 1)} disabled={busy} /></label>
      <Button type="primary" size="large" icon={<ThunderboltOutlined />} onClick={() => void handleGenerateChapter()} loading={status === "streaming"} disabled={!canGenerate || plansLoading || Boolean(plansError)}>{status === "streaming" ? "正在写作" : "生成这一章"}</Button>
      {busy && <Button onClick={stop}>停止接收</Button>}
      <Button type="text" onClick={() => void handleGenerateOutline()} loading={outlineGenerating} disabled={!canGenerate}>生成大纲与人物卡 <ArrowRightOutlined /></Button>
    </div>
    <div className="generation-inputs" aria-live="polite">
      <span className="field-caption">本次创作依据</span><Tag>{plansLoading ? "正在读取规划" : task ? `已批准任务单 · v${task.revision}` : "未设置任务单"}</Tag>
      {plan && planMatchesTask ? <Checkbox checked={usePlan} onChange={(e) => setUsePlan(e.target.checked)} disabled={busy}>场景计划 v{plan.revision}</Checkbox> : <span className="muted-note">{plan ? "场景计划需按最新任务单重新批准" : "未设置场景计划"}</span>}
      <Link to={`/review?chapter=${chapterNumber}`}>编辑章节规划 <ArrowRightOutlined /></Link>
    </div>
    {plansError && <Alert type="warning" showIcon message="暂时无法读取章节规划" description={plansError} />}
    {apiStatus === "offline" && <Alert type="warning" showIcon message="连接后端后可开始生成，已有内容仍可浏览。" />}
    {notice && <Alert type="info" message={notice} showIcon closable onClose={() => setNotice("")} />}
    {error && status !== "failed" && <Alert type="error" message={error} showIcon closable onClose={() => setError("")} />}
    <Collapse className="generation-options" items={[
      { key: "context", label: <Space><FileSearchOutlined /><span>叙事上下文</span><span className="muted-note">查看模型将参考哪些知识</span></Space>, children: <div className="generation-option-content">
        <p className="muted-note">根据章节目标从叙事图谱选取知识；预览不调用生成模型。</p>
        <Input.TextArea aria-label="本章目标" placeholder="本章想推进什么？例如：两位主角第一次达成合作。" value={goal} onChange={(e) => { setGoal(e.target.value); setContext(null); setUseContext(false); ++contextSequence.current; setContextLoading(false); }} autoSize={{ minRows: 2, maxRows: 4 }} disabled={busy} />
        <Button icon={<FileSearchOutlined />} onClick={() => void preview()} loading={contextLoading} disabled={!supportsPlanning || apiStatus !== "online" || busy}>预览上下文</Button>
        {contextError && <Alert type="error" showIcon message={contextError} />}
        {context && <div className="context-result">
          <div className="context-result-heading"><strong>{context.context_pack.selected_nodes.length} 条知识 · {context.context_pack.selected_edges.length} 条关系</strong><Checkbox checked={useContext} onChange={(e) => setUseContext(e.target.checked)} disabled={busy}>用于本次生成</Checkbox></div>
          {context.context_pack.selected_nodes.length ? <div className="context-node-list">{context.context_pack.selected_nodes.map((node) => <div key={node.id}><strong>{node.label}</strong><p>{node.summary || node.notes || "暂无摘要"}</p></div>)}</div> : <p className="muted-note">还没有符合条件的知识。可先在叙事图谱中补充人物、事件或设定。</p>}
          {context.context_pack.warnings.length > 0 && <Alert type="warning" showIcon message={context.context_pack.warnings.map(warning => warning.startsWith("chapter_goal is empty") ? "未填写章节目标，将优先选择重要设定与尚未解决的伏笔。" : warning).join("；")} />}
          <details className="context-prompt"><summary>查看实际注入文本</summary><pre>{context.prompt_text || "本次未选入额外上下文。"}</pre></details>
        </div>}
      </div> },
      { key: "settings", label: <Space><span>生成参数</span><span className="muted-note">{settings.model} · {settings.max_tokens.toLocaleString()} tokens</span></Space>, children: <div className="generation-option-content">
        <div className="generation-settings-grid">
          <label className="field-label">模型<Select aria-label="生成模型" value={settings.model} onChange={(model) => setSettings((value) => ({ ...value, model }))} options={[{ value: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }, { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro" }]} disabled={busy} /></label>
          <label className="field-label">输出预算（tokens）<InputNumber aria-label="输出预算" min={512} max={32768} precision={0} step={1024} value={settings.max_tokens} onChange={(max_tokens) => setSettings((value) => ({ ...value, max_tokens: max_tokens ?? 16384 }))} disabled={busy} /></label>
          <label className="field-label">温度<InputNumber aria-label="温度" min={0} max={2} step={0.1} value={settings.temperature} onChange={(temperature) => setSettings((value) => ({ ...value, temperature: temperature ?? 1 }))} disabled={busy} /></label>
        </div><p className="muted-note">参数调整立即用于下一次生成；保存后会成为该项目的默认值。输出预算包含模型推理与正文消耗。</p><Button icon={<SaveOutlined />} loading={saving} onClick={() => void saveSettings()} disabled={!selectedProjectRef || busy || projectLoading}>保存为项目默认参数</Button>
      </div> },
    ]} />
    <StreamingPreview content={streamingContent} reasoning={streamingReasoning} status={status} error={status === "failed" ? error : ""} result={result} saveSucceeded={status === "saved"} fileNameFormatter={(value) => typeof value === "string" ? value.split(/[\\/]/).pop() ?? value : ""} />
  </div>;
}
