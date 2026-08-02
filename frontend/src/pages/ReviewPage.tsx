import { useCallback, useEffect, useState } from "react";
import { Alert, Card, Select, Space, Tabs, Typography } from "antd";
import { SafetyCertificateOutlined } from "@ant-design/icons";
import { getChapterFunctionReview } from "../api";
import type { ChapterFunctionReviewResponse, ChapterTaskSheet, NoRevealReview, ScenePlan } from "../types";
import { useAppStore } from "../store/useAppStore";
import { NoRevealReviewPanel } from "../components/NoRevealReviewPanel";
import { ChapterTaskSheetPanel } from "../components/ChapterTaskSheetPanel";
import { ScenePlanPanel } from "../components/ScenePlanPanel";

function extractLatestReview(payload: ChapterFunctionReviewResponse | null): NoRevealReview | null {
  if (!payload) {
    return null;
  }
  if (payload.latest && typeof payload.latest === "object") {
    return payload.latest as NoRevealReview;
  }
  return null;
}

/**
 * 章节审查页：串联"任务单 → 场景计划 → No-Reveal 审查"三个环节。
 * 三个面板都依赖 projectRef + chapterNumber，此处统一提供章节选择。
 */
export default function ReviewPage() {
  const { selectedProjectRef, apiStatus, chapters, chapterStatus } = useAppStore();
  const [chapterNumber, setChapterNumber] = useState<number | null>(null);
  const [review, setReview] = useState<NoRevealReview | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [approvedTask, setApprovedTask] = useState<ChapterTaskSheet | null>(null);

  // 项目切换时重置章节选择（优先选第 1 章）
  useEffect(() => {
    setChapterNumber(null);
  }, [selectedProjectRef]);

  const loadReview = useCallback(async () => {
    if (!selectedProjectRef || chapterNumber === null || apiStatus !== "online") {
      setReview(null);
      return;
    }
    setReviewLoading(true);
    setReviewError("");
    try {
      const result = await getChapterFunctionReview(selectedProjectRef, chapterNumber);
      setReview(extractLatestReview(result));
    } catch (e) {
      setReviewError(e instanceof Error ? e.message : "审查记录加载失败。");
      setReview(null);
    } finally {
      setReviewLoading(false);
    }
  }, [apiStatus, chapterNumber, selectedProjectRef]);

  useEffect(() => {
    void loadReview();
  }, [loadReview]);

  const canUseApi = Boolean(selectedProjectRef?.startsWith("book:") && apiStatus === "online");

  return (
    <div style={{ padding: 20 }}>
      <Card
        title={
          <Space>
            <SafetyCertificateOutlined style={{ color: "#5f4b32" }} />
            <span>章节审查</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              任务单 → 场景计划 → No-Reveal 合规审查
            </Typography.Text>
          </Space>
        }
        extra={
          <Select
            placeholder="选择章节"
            style={{ width: 200 }}
            value={chapterNumber ?? undefined}
            onChange={setChapterNumber}
            options={chapters.map((chapter) => ({
              value: chapter.chapter_number,
              label: `第 ${chapter.chapter_number} 章${chapter.title ? ` · ${chapter.title}` : ""}`,
            }))}
          />
        }
        styles={{ body: { paddingTop: 12 } }}
      >
        {!selectedProjectRef ? (
          <Alert type="info" showIcon message="请先在左侧选择项目。" />
        ) : chapterNumber === null ? (
          <Alert type="info" showIcon message="请选择要审查的章节。" />
        ) : (
          <Tabs
            items={[
              {
                key: "task",
                label: "章节任务单",
                children: (
                  <ChapterTaskSheetPanel
                    projectRef={selectedProjectRef}
                    chapterNumber={chapterNumber}
                    apiStatus={apiStatus}
                    disabled={!canUseApi}
                    onApprovedTaskChange={setApprovedTask}
                  />
                ),
              },
              {
                key: "scene",
                label: "场景计划",
                children: (
                  <ScenePlanPanel
                    projectRef={selectedProjectRef}
                    chapterNumber={chapterNumber}
                    apiStatus={apiStatus}
                    disabled={!canUseApi}
                    approvedChapterTask={approvedTask}
                    onScenePlanStateChange={() => undefined}
                  />
                ),
              },
              {
                key: "review",
                label: "No-Reveal 审查",
                children: (
                  <NoRevealReviewPanel
                    review={review}
                    loading={reviewLoading}
                    error={reviewError}
                    onRefresh={() => void loadReview()}
                    disabled={!canUseApi}
                  />
                ),
              },
              {
                key: "status",
                label: "流程状态",
                children: chapterStatus ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div>
                      待复核：{chapterStatus.chapter_status.review.pending_count} · 已通过：
                      {chapterStatus.chapter_status.review.accepted_count} · 已拒绝：
                      {chapterStatus.chapter_status.review.rejected_count}
                    </div>
                    {chapterStatus.chapter_status.warnings?.length > 0 && (
                      <Alert
                        type="warning"
                        showIcon
                        message="流程提醒"
                        description={chapterStatus.chapter_status.warnings.map((w) => w.message).join("；")}
                      />
                    )}
                  </div>
                ) : (
                  <Alert type="info" showIcon message="暂无流程状态。" />
                ),
              },
            ]}
          />
        )}
      </Card>
    </div>
  );
}
