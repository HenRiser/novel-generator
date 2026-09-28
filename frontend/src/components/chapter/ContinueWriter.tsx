import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Collapse, Input, Space, Typography, message } from "antd";
import { CommentOutlined, SaveOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { continueChapterStream, safePublicMessage, saveContinueResult } from "../../api";
import { useAppStore } from "../../store/useAppStore";

type ContinueWriterProps = {
  projectRef: string;
  chapterNumber: number;
  /** 当前章节全文，作为续写上下文 */
  contextText: string;
  /** 用户选中的文本（可选），用于续写参考；保存仍追加到章末。 */
  anchorText?: string | null;
  onClearAnchor?: () => void;
  disabled?: boolean;
};

type StreamStatus = "idle" | "streaming" | "done" | "error";

/**
 * 对话式续写面板：在章节末尾 / 选中文本之后继续生成。
 * 使用 NDJSON 流式接口 /api/projects/{ref}/chapters/{n}/continue。
 */
export default function ContinueWriter({
  projectRef,
  chapterNumber,
  contextText,
  anchorText,
  onClearAnchor,
  disabled = false,
}: ContinueWriterProps) {
  const [instruction, setInstruction] = useState("");
  const [output, setOutput] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [status, setStatus] = useState<StreamStatus>("idle");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const { apiStatus, generationBusy, setBusy } = useAppStore();
  const runId = useRef<string>("");
  const abortRef = useRef<AbortController | null>(null);
  const activeRef = useRef(false);
  const instanceVersion = useRef(0);

  const canStart = !disabled && Boolean(projectRef && contextText) && apiStatus === "online" && !saving && status !== "streaming" && !generationBusy.chapterStreaming && !generationBusy.chapterGenerating && !generationBusy.outlineGenerating && !generationBusy.batchGenerating;

  useEffect(() => {
    ++instanceVersion.current;
    setOutput(""); setReasoning(""); setStatus("idle"); setError(""); setSaved(false);
    return () => {
      ++instanceVersion.current;
      const wasActive = activeRef.current;
      activeRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
      if (wasActive) setBusy({ chapterStreaming: false });
    };
  }, [chapterNumber, projectRef, setBusy]);

  const handleStop = useCallback(() => {
    activeRef.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus("idle");
    setBusy({ chapterStreaming: false });
  }, [setBusy]);

  const handleStart = useCallback(async () => {
    if (!canStart) {
      return;
    }
    activeRef.current = true; runId.current = "";
    setOutput("");
    setReasoning("");
    setError("");
    setStatus("streaming");
    setSaved(false);
    setBusy({ chapterStreaming: true });

    const controller = new AbortController();
    abortRef.current = controller;
    const current = () => abortRef.current === controller && !controller.signal.aborted;

    try {
      const response = await continueChapterStream(projectRef, chapterNumber, {
        context_text: contextText, instruction, anchor_text: anchorText || undefined,
      }, {
        onDelta: text => { if (current()) setOutput(value => value + text); },
        onReasoning: text => { if (current()) setReasoning(value => value + text); },
      }, controller.signal);
      if (current()) { runId.current = String(response.run_id || ""); setStatus("done"); activeRef.current = false; }
    } catch (e) {
      if (!current()) {
        return; // 用户主动取消
      }
      activeRef.current = false;
      setError(safePublicMessage(e instanceof Error ? e.message : "", "续写失败。"));
      setStatus("error");
    } finally {
      if (abortRef.current === controller) { abortRef.current = null; setBusy({ chapterStreaming: false }); }
    }
  }, [anchorText, canStart, chapterNumber, contextText, instruction, projectRef, setBusy]);

  const handleInsert = useCallback(async () => {
    if (!output || !projectRef || saving || saved || disabled || !runId.current) {
      return;
    }
    setSaving(true);
    const version = instanceVersion.current;
    try {
      const result = await saveContinueResult(projectRef, chapterNumber, {
        content: output, run_id: runId.current,
        mode: "append",
      });
      if (version !== instanceVersion.current || useAppStore.getState().selectedProjectRef !== projectRef) return;
      setSaved(true);
      message.success(result.message || "续写内容已保存到章节文件。");
      // 通知阅读器刷新章节正文
      window.dispatchEvent(
        new CustomEvent("braipen:continue-saved", { detail: { projectRef, chapterNumber } }),
      );
      setStatus("done");
    } catch (e) {
      if (version === instanceVersion.current) message.error(e instanceof Error ? e.message : "保存失败，请重试。");
    } finally {
      if (version === instanceVersion.current) setSaving(false);
    }
  }, [chapterNumber, output, projectRef, saved, saving, disabled]);

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: "var(--paper)",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <Space size={8}>
        <CommentOutlined style={{ color: "var(--accent)" }} />
        <Typography.Text strong>对话式续写</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          在章节末尾继续生成，跟随你的指令调整风格
        </Typography.Text>
      </Space>

      {anchorText && (
        <Alert
          type="info"
          showIcon
          message={`以选中文本（${anchorText.length} 字）为参考，保存时追加到章节末尾`}
          closable
          onClose={onClearAnchor}
        />
      )}

      <Input.TextArea
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder="告诉模型接下来如何发展、调整节奏或语气。留空则自然续写。"
        autoSize={{ minRows: 2, maxRows: 5 }}
        disabled={status === "streaming"}
      />

      <Space>
        <Button
          type="primary"
          icon={<ThunderboltOutlined />}
          onClick={() => void handleStart()}
          loading={status === "streaming"}
          disabled={!canStart}
        >
          {status === "streaming" ? "续写中…" : "开始续写"}
        </Button>
        {status === "streaming" && (
          <Button danger onClick={handleStop}>
            停止
          </Button>
        )}
        {output && status === "done" && (
          <Button type="primary" icon={<SaveOutlined />} onClick={() => void handleInsert()} loading={saving} disabled={saved || disabled}>
            {saved ? "已追加到章末" : "追加到章节末尾"}
          </Button>
        )}
      </Space>

      {error && <Alert type="error" message={error} showIcon />}
      {reasoning.length > 0 && (
        <Collapse
          ghost
          size="small"
          style={{ background: "var(--paper)", borderRadius: 6 }}
          items={[
            {
              key: "reasoning",
              label: (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  AI 思考过程（仅展示，不写入文件）
                </Typography.Text>
              ),
              children: (
                <Typography.Paragraph
                  type="secondary"
                  style={{ fontSize: 12, whiteSpace: "pre-wrap", marginBottom: 0, maxHeight: 160, overflow: "auto" }}
                >
                  {reasoning}
                </Typography.Paragraph>
              ),
            },
          ]}
        />
      )}
      {output && (
        <div className={`chapter-prose-streaming ${status === "streaming" ? "stream-cursor" : ""}`}>
          {output}
        </div>
      )}
    </div>
  );
}
