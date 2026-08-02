import { useCallback, useRef, useState } from "react";
import { Alert, Button, Collapse, Input, Space, Typography, message } from "antd";
import { CommentOutlined, SaveOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { API_BASE_URL, saveContinueResult } from "../../api";

type ContinueWriterProps = {
  projectRef: string;
  chapterNumber: number;
  /** 当前章节全文，作为续写上下文 */
  contextText: string;
  /** 用户选中的文本（可选），续写紧跟其后 */
  anchorText?: string | null;
  onClearAnchor?: () => void;
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
}: ContinueWriterProps) {
  const [instruction, setInstruction] = useState("");
  const [output, setOutput] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [status, setStatus] = useState<StreamStatus>("idle");
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const activeRef = useRef(false);

  const canStart = Boolean(projectRef) && status !== "streaming" && (instruction.trim().length > 0 || Boolean(anchorText));

  const handleStop = useCallback(() => {
    activeRef.current = false;
    abortRef.current?.abort();
    setStatus("idle");
  }, []);

  const handleStart = useCallback(async () => {
    if (!projectRef || status === "streaming") {
      return;
    }
    activeRef.current = true;
    setOutput("");
    setReasoning("");
    setError("");
    setStatus("streaming");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/projects/${encodeURIComponent(projectRef)}/chapters/${chapterNumber}/continue`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
          body: JSON.stringify({
            context_text: contextText,
            instruction: instruction,
            anchor_text: anchorText || undefined,
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        let payload: unknown = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        const message =
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as { error: { message?: string } }).error?.message ?? "续写请求失败。")
            : `续写请求失败（${response.status}）。`;
        throw new Error(message);
      }

      if (!response.body) {
        throw new Error("流式响应不可用。");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const consume = (final = false) => {
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0 && activeRef.current) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) {
            handleEvent(line);
          }
          newlineIndex = buffer.indexOf("\n");
        }
        if (final && buffer.trim() && activeRef.current) {
          handleEvent(buffer.trim());
          buffer = "";
        }
      };

      const handleEvent = (line: string) => {
        let payload: { type?: string; text?: string; message?: string; code?: string };
        try {
          payload = JSON.parse(line);
        } catch {
          return;
        }
        if (payload.type === "delta" && typeof payload.text === "string") {
          setOutput((current) => current + payload.text);
        } else if (payload.type === "reasoning" && typeof payload.text === "string") {
          setReasoning((current) => current + payload.text);
        } else if (payload.type === "done") {
          setStatus("done");
          activeRef.current = false;
        } else if (payload.type === "error") {
          setError(payload.message || "续写失败。");
          setStatus("error");
          activeRef.current = false;
        }
      };

      while (activeRef.current) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        consume();
      }
      if (activeRef.current) {
        buffer += decoder.decode();
        consume(true);
        setStatus("done");
      }
      activeRef.current = false;
    } catch (e) {
      if (!activeRef.current) {
        return; // 用户主动取消
      }
      activeRef.current = false;
      setError(e instanceof Error ? e.message : "续写失败。");
      setStatus("error");
    } finally {
      abortRef.current = null;
    }
  }, [anchorText, chapterNumber, contextText, instruction, projectRef, status]);

  const [saving, setSaving] = useState(false);

  const handleInsert = useCallback(async () => {
    if (!output || !projectRef || saving) {
      return;
    }
    setSaving(true);
    try {
      const result = await saveContinueResult(projectRef, chapterNumber, {
        content: output,
        mode: "append",
      });
      message.success(result.message || "续写内容已保存到章节文件。");
      // 通知阅读器刷新章节正文
      window.dispatchEvent(
        new CustomEvent("braipen:continue-saved", { detail: { chapterNumber } }),
      );
      setStatus("done");
    } catch (e) {
      message.error(e instanceof Error ? e.message : "保存失败，请重试。");
    } finally {
      setSaving(false);
    }
  }, [chapterNumber, output, projectRef, saving]);

  return (
    <div
      style={{
        border: "1px solid #e6dccb",
        borderRadius: 10,
        background: "#fffdf8",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <Space size={8}>
        <CommentOutlined style={{ color: "#5f4b32" }} />
        <Typography.Text strong>对话式续写</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          在章节末尾继续生成，跟随你的指令调整风格
        </Typography.Text>
      </Space>

      {anchorText && (
        <Alert
          type="info"
          showIcon
          message={`已锚定选中文本（${anchorText.length} 字），续写将紧跟其后`}
          closable
          onClose={onClearAnchor}
        />
      )}

      <Input.TextArea
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder="例如：用更悬疑的笔调继续，埋下灰剧团失踪的伏笔…（留空则自然续写）"
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
          <Button type="primary" icon={<SaveOutlined />} onClick={() => void handleInsert()} loading={saving}>
            保存到章节文件
          </Button>
        )}
      </Space>

      {error && <Alert type="error" message={error} showIcon />}
      {reasoning.length > 0 && (
        <Collapse
          ghost
          size="small"
          style={{ background: "#f7f1e6", borderRadius: 6 }}
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
