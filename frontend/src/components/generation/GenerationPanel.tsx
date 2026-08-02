import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Card, InputNumber, Space, Tag, Tooltip, Typography } from "antd";
import {
  PlayCircleOutlined,
  ReloadOutlined,
  SaveOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import type { GenerationRequest, ChapterStreamDoneEvent, GenerationSettingsRequest } from "../../types";
import {
  generateChapterStream,
  generateOutlineCharacters,
  updateGenerationSettings,
} from "../../api";
import { useAppStore } from "../../store/useAppStore";
import StreamingPreview from "./StreamingPreview";

const DEFAULT_SETTINGS: GenerationRequest = {
  model: "deepseek-v4-flash",
  max_tokens: 8192,
  temperature: 1.0,
};

function publicFileName(value: unknown): string {
  return typeof value === "string" ? value.split(/[\\/]/).pop() ?? value : "";
}

type GenerationPanelProps = {
  onStreamDone: (result: ChapterStreamDoneEvent) => void;
  onAssetsGenerated: () => void;
};

export default function GenerationPanel({ onStreamDone, onAssetsGenerated }: GenerationPanelProps) {
  const {
    apiStatus,
    selectedProjectRef,
    generationBusy,
    setBusy,
  } = useAppStore();

  const [settings, setSettings] = useState<GenerationRequest>(DEFAULT_SETTINGS);
  const [chapterNumber, setChapterNumber] = useState(1);
  const [outlineGenerating, setOutlineGenerating] = useState(false);
  const [outlineError, setOutlineError] = useState("");
  const [outlineMessage, setOutlineMessage] = useState("");

  const [streamingContent, setStreamingContent] = useState("");
  const [streamingReasoning, setStreamingReasoning] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingStatus, setStreamingStatus] = useState<"idle" | "streaming" | "saved" | "failed">("idle");
  const [streamingError, setStreamingError] = useState("");
  const [streamingResult, setStreamingResult] = useState<ChapterStreamDoneEvent | null>(null);
  const [saveSucceeded, setSaveSucceeded] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const streamingRef = useRef(false);

  const busy = outlineGenerating || streaming;

  const handleGenerateOutline = useCallback(async () => {
    if (!selectedProjectRef || apiStatus !== "online" || busy) {
      return;
    }
    setOutlineGenerating(true);
    setOutlineError("");
    setOutlineMessage("");
    try {
      const result = await generateOutlineCharacters(selectedProjectRef, settings);
      setOutlineMessage(result.message || "大纲与人物卡已生成。");
      onAssetsGenerated();
    } catch (e) {
      setOutlineError(e instanceof Error ? e.message : "大纲与人物卡生成失败。");
    } finally {
      setOutlineGenerating(false);
    }
  }, [apiStatus, busy, onAssetsGenerated, selectedProjectRef, settings]);

  const handleGenerateChapter = useCallback(async () => {
    if (!selectedProjectRef || apiStatus !== "online" || busy) {
      return;
    }
    setStreaming(true);
    setStreamingStatus("streaming");
    setStreamingError("");
    setStreamingContent("");
    setStreamingReasoning("");
    setStreamingResult(null);
    setSaveSucceeded(false);
    streamingRef.current = true;
    setBusy({ chapterStreaming: true });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await generateChapterStream(
        selectedProjectRef,
        chapterNumber,
        settings,
        {
          onDelta: (text) => {
            if (streamingRef.current) {
              setStreamingContent((current) => current + text);
            }
          },
          onReasoning: (text) => {
            if (streamingRef.current) {
              setStreamingReasoning((current) => current + text);
            }
          },
        },
        // 传递 AbortSignal 支持取消
      );
      // 注意：generateChapterStream 不支持 AbortSignal，取消在下方实现
      if (!streamingRef.current) {
        return;
      }
      setStreamingResult(result);
      setStreamingStatus("saved");
      setSaveSucceeded(true);
      onStreamDone(result);
    } catch (e) {
      if (!streamingRef.current) {
        return;
      }
      setStreamingError(e instanceof Error ? e.message : "章节生成失败。");
      setStreamingStatus("failed");
    } finally {
      if (streamingRef.current) {
        setStreaming(false);
        streamingRef.current = false;
        setBusy({ chapterStreaming: false });
        abortRef.current = null;
      }
    }
  }, [apiStatus, busy, chapterNumber, onStreamDone, selectedProjectRef, setBusy, settings]);

  const handleCancelStream = useCallback(() => {
    streamingRef.current = false;
    abortRef.current?.abort();
    setStreaming(false);
    setStreamingStatus("failed");
    setStreamingError("已取消生成。");
    setBusy({ chapterStreaming: false });
  }, [setBusy]);

  // Ctrl+Enter 生成章节
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        if (!busy && selectedProjectRef && apiStatus === "online") {
          void handleGenerateChapter();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [apiStatus, busy, handleGenerateChapter, selectedProjectRef]);

  const handleUpdateSettings = useCallback(
    async (patch: Partial<GenerationSettingsRequest>) => {
      if (!selectedProjectRef) {
        return;
      }
      const next = { ...settings, ...patch };
      setSettings(next);
      try {
        const model =
          next.model === "deepseek-v4-pro" ? ("deepseek-v4-pro" as const) : ("deepseek-v4-flash" as const);
        await updateGenerationSettings(selectedProjectRef, {
          model,
          max_tokens: next.max_tokens,
          temperature: next.temperature,
        });
      } catch {
        // 设置保存失败不阻塞生成
      }
    },
    [selectedProjectRef, settings],
  );

  const canGenerate = Boolean(selectedProjectRef) && apiStatus === "online" && !busy;

  return (
    <Card
      size="small"
      title={
        <Space>
          <ThunderboltOutlined />
          <span>生成控制台</span>
          <Tooltip title="快捷键：Ctrl+Enter 生成章节">
            <Tag color="gold" style={{ cursor: "help" }}>
              Ctrl+Enter
            </Tag>
          </Tooltip>
        </Space>
      }
      styles={{ body: { display: "flex", flexDirection: "column", gap: 12 } }}
    >
      {apiStatus !== "online" && (
        <Alert type="error" showIcon message="API 离线，无法生成。" />
      )}
      {!selectedProjectRef && (
        <Alert type="info" showIcon message="请先选择项目。" />
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Button
          icon={<PlayCircleOutlined />}
          onClick={() => void handleGenerateOutline()}
          loading={outlineGenerating}
          disabled={!canGenerate}
        >
          生成大纲与人物卡
        </Button>
        <span style={{ color: "#9a8f80", fontSize: 12 }}>章节号</span>
        <InputNumber
          min={1}
          value={chapterNumber}
          onChange={(value) => setChapterNumber(Number(value) || 1)}
          disabled={busy}
          style={{ width: 80 }}
        />
        <Button
          type="primary"
          icon={<ThunderboltOutlined />}
          onClick={() => void handleGenerateChapter()}
          loading={streaming}
          disabled={!canGenerate}
        >
          {streaming ? "生成中…" : "生成章节"}
        </Button>
        {streaming && (
          <Button danger onClick={handleCancelStream}>
            取消
          </Button>
        )}
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
        <Space size={8}>
          <span style={{ fontSize: 12, color: "#9a8f80" }}>模型</span>
          <select
            value={settings.model}
            onChange={(e) =>
              void handleUpdateSettings({
                model: e.target.value as "deepseek-v4-flash" | "deepseek-v4-pro",
              })
            }
            style={{ border: "1px solid #ddd0bd", borderRadius: 6, padding: "4px 8px", background: "#fffdf8" }}
            disabled={busy}
          >
            <option value="deepseek-v4-flash">deepseek-v4-flash（快速）</option>
            <option value="deepseek-v4-pro">deepseek-v4-pro（深度）</option>
          </select>
        </Space>
        <Space size={8}>
          <span style={{ fontSize: 12, color: "#9a8f80" }}>max_tokens</span>
          <InputNumber
            min={1024}
            max={32768}
            step={1024}
            value={settings.max_tokens}
            onChange={(value) => void handleUpdateSettings({ max_tokens: Number(value) || 8192 })}
            disabled={busy}
            style={{ width: 110 }}
          />
        </Space>
        <Space size={8}>
          <span style={{ fontSize: 12, color: "#9a8f80" }}>温度</span>
          <InputNumber
            min={0}
            max={2}
            step={0.1}
            value={settings.temperature}
            onChange={(value) => void handleUpdateSettings({ temperature: Number(value) ?? 1.0 })}
            disabled={busy}
            style={{ width: 80 }}
          />
        </Space>
        <Tooltip title="保存设置到项目">
          <Button
            size="small"
            icon={<SaveOutlined />}
            onClick={() => void handleUpdateSettings({})}
            disabled={!selectedProjectRef}
          >
            保存设置
          </Button>
        </Tooltip>
        <Tooltip title="刷新">
          <Button size="small" icon={<ReloadOutlined />} onClick={() => window.location.reload()} />
        </Tooltip>
      </div>

      {outlineMessage && <Alert type="success" message={outlineMessage} showIcon closable />}
      {outlineError && <Alert type="error" message={outlineError} showIcon closable />}

      <StreamingPreview
        content={streamingContent}
        reasoning={streamingReasoning}
        status={streamingStatus}
        error={streamingError}
        result={streamingResult}
        saveSucceeded={saveSucceeded}
        fileNameFormatter={publicFileName}
      />
    </Card>
  );
}
