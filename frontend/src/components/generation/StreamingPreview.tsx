import { Alert, Collapse, Space, Tag, Typography } from "antd";
import { CheckCircleOutlined, FileTextOutlined, LoadingOutlined } from "@ant-design/icons";
import type { ChapterStreamDoneEvent } from "../../types";

type StreamingPreviewProps = {
  content: string;
  reasoning: string;
  status: "idle" | "streaming" | "saved" | "failed";
  error: string;
  result: ChapterStreamDoneEvent | null;
  saveSucceeded: boolean;
  fileNameFormatter: (value: unknown) => string;
};

export default function StreamingPreview({
  content,
  reasoning,
  status,
  error,
  result,
  saveSucceeded,
  fileNameFormatter,
}: StreamingPreviewProps) {
  const show = status !== "idle" || content.length > 0;

  if (!show) {
    return null;
  }

  return (
    <div
      style={{
        border: "1px solid #e6dccb",
        borderRadius: 8,
        background: "#fffdf8",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "8px 12px",
          borderBottom: "1px solid #e6dccb",
        }}
      >
        <Space>
          <FileTextOutlined style={{ color: "#5f4b32" }} />
          <Typography.Text strong>手稿实时预览</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {content.length} 字
          </Typography.Text>
        </Space>
        <Space size={8}>
          {status === "streaming" && (
            <Tag icon={<LoadingOutlined />} color="processing">
              生成中
            </Tag>
          )}
          {status === "saved" && saveSucceeded && (
            <Tag icon={<CheckCircleOutlined />} color="success">
              已保存
            </Tag>
          )}
          {status === "failed" && <Tag color="error">失败</Tag>}
        </Space>
      </div>

      <div style={{ padding: 12 }}>
        {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 8 }} />}

        {reasoning.length > 0 && (
          <Collapse
            ghost
            size="small"
            style={{ marginBottom: 8, background: "#f7f1e6", borderRadius: 6 }}
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
                    style={{ fontSize: 12, whiteSpace: "pre-wrap", marginBottom: 0, maxHeight: 180, overflow: "auto" }}
                  >
                    {reasoning}
                  </Typography.Paragraph>
                ),
              },
            ]}
          />
        )}

        {result && saveSucceeded && (
          <Space direction="vertical" size={4} style={{ marginBottom: 8, width: "100%" }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              章节文件：{fileNameFormatter(result.chapter_file) || "—"}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              摘要文件：{fileNameFormatter(result.summary_file) || "—"}
            </Typography.Text>
            {(result.consistency_warnings?.length ?? 0) > 0 && (
              <Alert
                type="warning"
                message={`一致性提示 ${result.consistency_warnings.length} 条`}
                showIcon
                style={{ marginTop: 4 }}
              />
            )}
          </Space>
        )}

        <div className={`chapter-prose-streaming ${status === "streaming" ? "stream-cursor" : ""}`}>
          {content || (status === "streaming" ? "等待模型返回正文…" : "暂无内容。")}
        </div>
      </div>
    </div>
  );
}
