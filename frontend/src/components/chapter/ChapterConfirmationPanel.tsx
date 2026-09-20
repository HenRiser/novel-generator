import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Space, Spin, Tag } from "antd";
import { CheckOutlined, EditOutlined, ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import { ApiRequestError, confirmChapter, getChapterWorkflow } from "../../api";
import { selectGenerationBusy, useAppStore } from "../../store/useAppStore";
import type { ChapterWorkflow } from "../../types";

type Props = {
  projectRef: string;
  chapterNumber: number;
  displayedFilename: string;
  readingLoading: boolean;
  refreshToken: number;
  onWorkflowChange: (workflow: ChapterWorkflow | null) => void;
  onConfirmed: () => void;
  onLocateEvidence: (evidence: string, revision: string) => void;
};
const basename = (value: string) => value.replace(/\\/g, "/").split("/").pop() || "";
const pending = (value: string) => value === "pending" || value === "running";
type SessionDraft = { content: string; baseContent: string; baseRevision: string };
const sessionDrafts = new Map<string, SessionDraft>();
const draftKey = (projectRef: string, chapterNumber: number) => `braipen:chapter-draft:${JSON.stringify([projectRef, chapterNumber])}`;

function readSessionDraft(key: string): SessionDraft | null {
  const cached = sessionDrafts.get(key);
  if (cached) return cached;
  try {
    const stored: unknown = JSON.parse(window.sessionStorage.getItem(key) || "null");
    if (stored && typeof stored === "object" && "content" in stored && typeof stored.content === "string" && "baseContent" in stored && typeof stored.baseContent === "string" && "baseRevision" in stored && typeof stored.baseRevision === "string") {
      const value = { content: stored.content, baseContent: stored.baseContent, baseRevision: stored.baseRevision };
      sessionDrafts.set(key, value);
      return value;
    }
  } catch { /* In-memory drafts still survive navigation when browser storage is unavailable. */ }
  return null;
}

function storeSessionDraft(key: string, value: SessionDraft): boolean {
  sessionDrafts.set(key, value);
  try { window.sessionStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}

function clearSessionDraft(key: string): void {
  sessionDrafts.delete(key);
  try { window.sessionStorage.removeItem(key); } catch { /* Storage can be disabled by the browser. */ }
}

export default function ChapterConfirmationPanel({ projectRef, chapterNumber, displayedFilename, readingLoading, refreshToken, onWorkflowChange, onConfirmed, onLocateEvidence }: Props) {
  const { apiStatus, batchStatusLoading, batchStatusError } = useAppStore();
  const busy = useAppStore(selectGenerationBusy);
  const [workflow, setWorkflow] = useState<ChapterWorkflow | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [baseContent, setBaseContent] = useState("");
  const [baseRevision, setBaseRevision] = useState("");
  const [restoredDraft, setRestoredDraft] = useState(false);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [reload, setReload] = useState(0);
  const callbacks = useRef({ onWorkflowChange, onConfirmed });
  callbacks.current = { onWorkflowChange, onConfirmed };
  const saveController = useRef<AbortController | null>(null);
  const lifetime = useRef(0);
  const dirty = editing && draft !== baseContent;
  const sessionKey = draftKey(projectRef, chapterNumber);

  useEffect(() => {
    ++lifetime.current;
    const savedDraft = readSessionDraft(sessionKey);
    setWorkflow(null); setEditing(Boolean(savedDraft)); setDraft(savedDraft?.content ?? ""); setError(""); setSaving(false);
    setBaseContent(savedDraft?.baseContent ?? ""); setBaseRevision(savedDraft?.baseRevision ?? "");
    setRestoredDraft(Boolean(savedDraft));
    setStorageUnavailable(savedDraft ? !storeSessionDraft(sessionKey, savedDraft) : false);
    callbacks.current.onWorkflowChange(null);
    return () => { ++lifetime.current; saveController.current?.abort(); };
  }, [chapterNumber, projectRef, sessionKey]);

  useEffect(() => {
    if (apiStatus !== "online") { setLoading(false); return; }
    let disposed = false;
    let timer: number | undefined;
    const controller = new AbortController();
    setLoading(true);
    const refresh = async () => {
      try {
        const value = await getChapterWorkflow(projectRef, chapterNumber, controller.signal);
        if (disposed) return;
        setWorkflow(value);
        callbacks.current.onWorkflowChange(value);
        setError("");
        if (pending(value.summary_status) || pending(value.review_status)) timer = window.setTimeout(() => void refresh(), 1500);
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : "正文确认状态读取失败。");
      } finally { if (!disposed) setLoading(false); }
    };
    void refresh();
    return () => { disposed = true; controller.abort(); window.clearTimeout(timer); };
  }, [apiStatus, chapterNumber, projectRef, refreshToken, reload]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const sameFile = Boolean(workflow && displayedFilename && basename(displayedFilename) === basename(workflow.chapter_file));
  const staleDraft = editing && workflow?.revision !== baseRevision;
  const blocked = !workflow || !workflow.editable || !sameFile || loading || readingLoading || saving || busy || batchStatusLoading || Boolean(batchStatusError) || apiStatus !== "online";
  const beginEdit = () => {
    if (!workflow || blocked) return;
    setDraft(workflow.content); setBaseContent(workflow.content); setBaseRevision(workflow.revision); setEditing(true);
    setRestoredDraft(false);
    setStorageUnavailable(!storeSessionDraft(sessionKey, { content: workflow.content, baseContent: workflow.content, baseRevision: workflow.revision }));
  };
  const updateDraft = (content: string) => {
    setDraft(content);
    setStorageUnavailable(!storeSessionDraft(sessionKey, { content, baseContent, baseRevision }));
  };
  const cancelEdit = () => {
    clearSessionDraft(sessionKey);
    setEditing(false); setRestoredDraft(false); setStorageUnavailable(false);
  };
  const confirm = async () => {
    if (!workflow || blocked || staleDraft || (editing && !draft.trim())) return;
    const version = lifetime.current;
    const controller = new AbortController();
    saveController.current = controller;
    setSaving(true); setError("");
    try {
      const value = await confirmChapter(projectRef, chapterNumber, editing ? draft : workflow.content, editing ? baseRevision : workflow.revision, controller.signal);
      if (controller.signal.aborted || version !== lifetime.current || useAppStore.getState().selectedProjectRef !== projectRef) return;
      clearSessionDraft(sessionKey);
      setRestoredDraft(false); setStorageUnavailable(false);
      setWorkflow(value); setEditing(false); setDraft(value.content); setBaseContent(value.content); setBaseRevision(value.revision);
      callbacks.current.onWorkflowChange(value);
      callbacks.current.onConfirmed();
      setReload((current) => current + 1);
    } catch (cause) {
      if (!controller.signal.aborted && version === lifetime.current) {
        setError(cause instanceof ApiRequestError && cause.status === 409 ? "正文版本或锁定状态已变化。你的修改仍保留在编辑器中，请刷新状态并核对最新正文。" : cause instanceof Error ? cause.message : "正文确认失败。");
      }
    } finally {
      if (version === lifetime.current) { setSaving(false); saveController.current = null; }
    }
  };

  return <section className="chapter-confirmation" aria-label="正文确认与摘要" aria-live="polite">
    <div className="chapter-confirmation-heading"><strong>正文确认</strong><Space wrap>
      {loading && <Spin size="small" />}
      {workflow && <Tag color={workflow.status === "confirmed" ? "success" : "gold"}>{workflow.status === "confirmed" ? "已确认正文" : "待你确认"}</Tag>}
      <Button type="text" size="small" icon={<ReloadOutlined />} aria-label="刷新正文确认状态" disabled={saving || apiStatus !== "online"} onClick={() => setReload((value) => value + 1)} />
    </Space></div>
    {error && <Alert showIcon type="error" message={error} />}
    {workflow && <>
      {!workflow.editable && <Alert showIcon type="info" message={workflow.lock_reason || (workflow.locked_by_chapter ? `第 ${workflow.locked_by_chapter} 章已开始，前文已锁定。` : "本章当前不可修改。")} />}
      {!sameFile && !readingLoading && <Alert showIcon type="warning" message="当前阅读文件不是最新正文，不能直接提交这一版本。" description="刷新章节正文后，再编辑和确认最新版本。" />}
      {workflow.status === "awaiting_confirmation" && <p className="chapter-confirmation-hint">先阅读正文。可以保留原稿，也可以修改后确认；确认后才在后台生成摘要并检查内容。</p>}
      <div className="chapter-background-status">
        <span>摘要：{({ not_requested: "确认后生成", pending: "等待后台生成", running: "后台生成中", ready: "已完成", failed: "生成失败" })[workflow.summary_status]}</span>
        <span>{workflow.review_scope === "semantic_and_rules" ? "逻辑与规则检查" : "规则检查"}：{({ not_requested: "尚未检查", pending: "等待后台检查", running: "后台检查中", ready: workflow.warnings.length ? `发现 ${workflow.warnings.length} 条疑似冲突` : "本轮未发现疑似冲突", failed: "检查失败，尚无结论" })[workflow.review_status]}</span>
      </div>
      {workflow.review_status === "ready" && <p className="chapter-confirmation-hint">{workflow.review_scope === "semantic_and_rules" ? "检查依据修改后的正文和已有约束给出提示，请结合原文判断。" : "本轮执行规则检查，未进行全面语义判断；修改正文后会增加逻辑检查。"}</p>}
      {workflow.error && <Alert type="error" showIcon message="摘要未完成" description={workflow.error} />}
      {workflow.review_error && <Alert type="warning" showIcon message="逻辑检查未完成" description={workflow.review_error} />}
      {workflow.warnings.map((warning, index) => <Alert key={`${warning.code}-${index}`} type="warning" showIcon message={warning.message} description={<div className="chapter-warning-details">{warning.evidence && <><p><strong>正文依据：</strong>{warning.evidence}</p><Button size="small" disabled={!sameFile || readingLoading || loading} aria-label={`定位第 ${index + 1} 条提示的原文`} onClick={() => onLocateEvidence(warning.evidence, workflow.revision)}>定位原文</Button></>}{warning.constraint && <p><strong>相关约束：</strong>{warning.constraint}</p>}{warning.suggestion && <p><strong>修改建议：</strong>{warning.suggestion}</p>}</div>} />)}
      {editing ? <>
        {restoredDraft && <Alert type="info" showIcon message="已恢复本标签页暂存的未提交编辑稿。" description="编辑稿仍需确认；提交前会核对原正文版本，避免覆盖后续修改。" />}
        {storageUnavailable && <Alert type="warning" showIcon message="浏览器会话存储不可用，编辑稿目前只在当前页面会话中保留。" description="切换章节和应用内页面仍可恢复；刷新或关闭标签页前请先保存，或复制修改内容。" />}
        <Input.TextArea className="chapter-confirmation-editor" aria-label="编辑本章正文" value={draft} onChange={(event) => updateDraft(event.target.value)} autoSize={{ minRows: 12, maxRows: 28 }} disabled={saving || !workflow.editable || busy} />
        {staleDraft && <Alert type="warning" showIcon message="最新正文已变化，当前编辑稿尚未保存。" description="可先复制你的修改，再取消编辑并重新打开最新正文。" />}
        <Space wrap><Button type="primary" icon={<SaveOutlined />} loading={saving} disabled={blocked || staleDraft || !draft.trim()} onClick={() => void confirm()}>保存并确认</Button><Button disabled={saving} onClick={cancelEdit}>取消编辑</Button><span className="muted-note">{draft.length} 字{dirty ? " · 有未保存修改" : ""}</span></Space>
      </> : <Space wrap>
        {workflow.status === "awaiting_confirmation" && <Button type="primary" icon={<CheckOutlined />} loading={saving} disabled={blocked} onClick={() => void confirm()}>保留原稿并确认</Button>}
        <Button icon={<EditOutlined />} disabled={blocked} onClick={beginEdit}>编辑正文</Button>
        {workflow.status === "confirmed" && (workflow.summary_status === "failed" || workflow.review_status === "failed") && <Button icon={<ReloadOutlined />} loading={saving} disabled={blocked} onClick={() => void confirm()}>重试后台处理</Button>}
      </Space>}
      {workflow.summary_status === "ready" && workflow.summary && <details className="chapter-summary"><summary>查看本版正文的摘要</summary><p>{workflow.summary}</p></details>}
    </>}
  </section>;
}
