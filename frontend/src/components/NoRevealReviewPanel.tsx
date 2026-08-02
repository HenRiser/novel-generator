import { Alert, Button, Card, Descriptions, Space, Spin, Tag, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import type { NoRevealReview } from "../types";

type NoRevealReviewPanelProps = {
  review: NoRevealReview | null;
  loading: boolean;
  error: string;
  onRefresh: () => void;
  disabled?: boolean;
};

const VERDICT_MAP: Record<string, { color: string; text: string }> = {
  pass: { color: "green", text: "通过" },
  warn: { color: "orange", text: "警告" },
  fail: { color: "red", text: "未通过" },
  not_applicable: { color: "default", text: "不适用" },
};

function verdictDisplay(review: NoRevealReview | null): { color: string; text: string } {
  if (!review) {
    return { color: "default", text: "无记录" };
  }
  const verdict = String(review.verdict || "unknown").toLowerCase();
  return VERDICT_MAP[verdict] ?? { color: "default", text: String(review.verdict || "未知") };
}

export function NoRevealReviewPanel({
  review,
  loading,
  error,
  onRefresh,
  disabled = false,
}: NoRevealReviewPanelProps) {
  const violations = review?.violations ?? [];
  const categories = review?.categories ?? [];
  const isFail = String(review?.verdict || "").toLowerCase() === "fail";
  const verdict = verdictDisplay(review);

  return (
    <Card
      size="small"
      title={
        <Space>
          <Typography.Text strong>合规审查（No-Reveal）</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            检查正文是否泄漏了未到揭示时机的关键信息
          </Typography.Text>
        </Space>
      }
      extra={
        <Space>
          <Tag color={verdict.color}>{verdict.text}</Tag>
          {loading && <Spin size="small" />}
        </Space>
      }
    >
      {isFail && (
        <Alert
          type="error"
          showIcon
          message="该章违反 No-Reveal / 场景计划禁止项，需要人工复核。"
          description="建议：先人工复核证据，再决定是否保留该章、重写或继续。"
          style={{ marginBottom: 12 }}
        />
      )}
      {!loading && !review && !error && (
        <Alert type="info" showIcon message="暂无合规审查记录。生成章节后会自动检查并显示结果。" />
      )}
      {error && <Alert type="error" showIcon message={error} closable onClose={() => undefined} style={{ marginBottom: 12 }} />}

      {review && (
        <>
          <Descriptions size="small" column={2} bordered style={{ marginBottom: 12 }}>
            <Descriptions.Item label="结论">{review.verdict ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="评分">{review.score != null ? `${review.score}/5` : "-"}</Descriptions.Item>
            <Descriptions.Item label="审查记录 ID">{review.id || "-"}</Descriptions.Item>
            <Descriptions.Item label="AI 运行 ID">{review.ai_run_id || "-"}</Descriptions.Item>
          </Descriptions>

          {review.summary && (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
              {review.summary}
            </Typography.Paragraph>
          )}

          {categories.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
              {categories.map((category) => (
                <Tag key={category} color="blue">{category}</Tag>
              ))}
            </div>
          )}

          {violations.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {violations.slice(0, 5).map((violation, index) => (
                <Card key={`${violation.category}-${index}`} size="small" type="inner">
                  <Space direction="vertical" size={4} style={{ width: "100%" }}>
                    <Typography.Text strong>
                      {violation.category} · {violation.severity}
                    </Typography.Text>
                    <Typography.Text>{violation.evidence}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {violation.source_rule}
                    </Typography.Text>
                  </Space>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      <div style={{ marginTop: 12 }}>
        <Button size="small" icon={<ReloadOutlined />} onClick={onRefresh} disabled={disabled || loading}>
          刷新审查
        </Button>
      </div>
    </Card>
  );
}
