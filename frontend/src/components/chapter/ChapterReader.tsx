import { useCallback, useEffect, useState } from "react";
import { Button, Collapse, Empty, Spin, Typography } from "antd";
import { DownloadOutlined, EditOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import { exportChapterUrl } from "../../api";
import { useAppStore } from "../../store/useAppStore";
import { useChapterContent } from "../../hooks/useProjectData";
import ContinueWriter from "./ContinueWriter";

type ChapterReaderProps = {
  chapterNumber: number | null;
};

export default function ChapterReader({ chapterNumber }: ChapterReaderProps) {
  const navigate = useNavigate();
  const { selectedProjectRef, chapters } = useAppStore();
  const [refreshToken, setRefreshToken] = useState(0);
  const { content, title, loading, error } = useChapterContent(selectedProjectRef, chapterNumber, refreshToken);
  const [anchorText, setAnchorText] = useState<string | null>(null);
  const [writePanelOpen, setWritePanelOpen] = useState(false);

  const chapter = chapters.find((c) => c.chapter_number === chapterNumber) ?? null;

  // 切换章节时重置续写状态
  useEffect(() => {
    setAnchorText(null);
    setWritePanelOpen(false);
  }, [chapterNumber, selectedProjectRef]);

  // 监听选中文本（通过 mouseup 捕获用户选区）
  const handleSelection = useCallback(() => {
    if (!selectedProjectRef || chapterNumber === null) {
      return;
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      return;
    }
    const text = selection.toString().trim();
    if (text.length >= 5 && text.length <= 8000) {
      setAnchorText(text);
      setWritePanelOpen(true);
    }
  }, [chapterNumber, selectedProjectRef]);

  // 续写结果保存成功后刷新章节正文
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ chapterNumber: number }>).detail;
      if (!detail || detail.chapterNumber !== chapterNumber) {
        return;
      }
      setRefreshToken((current) => current + 1);
    };
    window.addEventListener("braipen:continue-saved", handler);
    return () => window.removeEventListener("braipen:continue-saved", handler);
  }, [chapterNumber]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        height: "100%",
        minHeight: 0,
        overflowY: "hidden",
      }}
      onMouseUp={handleSelection}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block" }}>
            Reader
          </Typography.Text>
          <Typography.Title level={4} style={{ margin: "2px 0 0" }} ellipsis>
            {title || chapter?.title || "章节正文"}
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {chapter?.filename || "选中文本可直接续写"}
          </Typography.Text>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          {selectedProjectRef && chapterNumber !== null && (
            <Button
              icon={<DownloadOutlined />}
              href={exportChapterUrl(selectedProjectRef, chapterNumber)}
              target="_blank"
              rel="noreferrer"
            >
              下载 TXT
            </Button>
          )}
          {selectedProjectRef && chapterNumber !== null && (
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              onClick={() => setWritePanelOpen((current) => !current)}
            >
              续写
            </Button>
          )}
        </div>
      </div>

      {loading && (
        <div style={{ textAlign: "center", padding: 32 }}>
          <Spin tip="正在加载章节正文…">
            <div style={{ padding: 24 }} />
          </Spin>
        </div>
      )}
      {error && <Typography.Text type="danger">{error}</Typography.Text>}
      {!loading && !error && content && <pre className="chapter-prose">{content}</pre>}
      {!loading && !error && !content && chapterNumber === null && (
        <Empty description="请选择左侧章节" style={{ marginTop: 40 }} />
      )}
      {!loading && !error && !content && !selectedProjectRef && (
        <Empty description="请先选择项目">
          <Button type="primary" icon={<EditOutlined />} onClick={() => navigate("/writing")}>
            前往创作页
          </Button>
        </Empty>
      )}

      {writePanelOpen && selectedProjectRef && chapterNumber !== null && content && (
        <div style={{ flexShrink: 0 }}>
          <Collapse
            defaultActiveKey={["writer"]}
            items={[
              {
                key: "writer",
                label: "对话式续写",
                children: (
                  <ContinueWriter
                    projectRef={selectedProjectRef}
                    chapterNumber={chapterNumber}
                    contextText={content}
                    anchorText={anchorText}
                    onClearAnchor={() => setAnchorText(null)}
                  />
                ),
              },
            ]}
          />
        </div>
      )}
    </div>
  );
}
