import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Card, Col, Row, Tabs } from "antd";
import type { ChapterStreamDoneEvent } from "../types";
import { useAppStore } from "../store/useAppStore";
import { useProjectData } from "../hooks/useProjectData";
import ProjectListPanel from "../components/project/ProjectListPanel";
import ChapterListPanel from "../components/chapter/ChapterListPanel";
import ChapterReader from "../components/chapter/ChapterReader";
import GenerationPanel from "../components/generation/GenerationPanel";

export default function WritingCockpitPage() {
  const {
    selectedProjectRef,
    apiStatus,
    chapters,
    chapterStatus,
  } = useAppStore();

  const [selectedChapterNumber, setSelectedChapterNumber] = useState<number | null>(null);
  const [streamDone, setStreamDone] = useState<ChapterStreamDoneEvent | null>(null);

  const { refreshChapters } = useProjectData(selectedProjectRef);

  // 生成完成后自动跳到最新章节
  const handleStreamDone = useCallback(
    (result: ChapterStreamDoneEvent) => {
      setStreamDone(result);
      setSelectedChapterNumber(result.chapter_number);
      void refreshChapters();
    },
    [refreshChapters],
  );

  // 大纲/人物卡生成后刷新章节列表
  const handleAssetsGenerated = useCallback(() => {
    void refreshChapters();
  }, [refreshChapters]);

  useEffect(() => {
    setStreamDone(null);
  }, [selectedProjectRef]);

  const chapterCount = chapters.length;

  const readerTabContent = useMemo(
    () => (
      <div style={{ height: "calc(100vh - 180px)", display: "flex", flexDirection: "column" }}>
        <ChapterReader chapterNumber={selectedChapterNumber} />
      </div>
    ),
    [selectedChapterNumber],
  );

  return (
    <div className="page-container">
      <h1 className="page-title">创作驾驶舱</h1>
      <p className="page-subtitle">大纲 → 章节 → 设定管理的完整创作流</p>

      {apiStatus === "offline" && (
        <Alert
          type="error"
          showIcon
          message="后端服务未连接"
          style={{ marginBottom: 12 }}
        />
      )}
      {streamDone && (
        <Alert
          type="success"
          showIcon
          message={`第 ${streamDone.chapter_number} 章已生成保存`}
          description={streamDone.message}
          closable
          style={{ marginBottom: 12 }}
          onClose={() => setStreamDone(null)}
        />
      )}

      <Row gutter={[16, 16]}>
        <Col xs={24} md={7} xl={5}>
          <Card size="small" title="项目" styles={{ body: { height: "calc(100vh - 200px)", overflowY: "auto" } }}>
            <ProjectListPanel />
          </Card>
        </Col>

        <Col xs={24} md={9} xl={6}>
          <Card
            size="small"
            title={`章节（${chapterCount}）`}
            styles={{ body: { height: "calc(100vh - 200px)", overflowY: "hidden", display: "flex", flexDirection: "column" } }}
          >
            <ChapterListPanel
              selectedChapterNumber={selectedChapterNumber}
              onSelectChapter={setSelectedChapterNumber}
            />
          </Card>
        </Col>

        <Col xs={24} md={8} xl={13}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <GenerationPanel onStreamDone={handleStreamDone} onAssetsGenerated={handleAssetsGenerated} />
            <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
              <Tabs
                size="small"
                items={[
                  { key: "reader", label: "章节阅读", children: readerTabContent },
                  {
                    key: "status",
                    label: `章节状态${chapterStatus ? "" : ""}`,
                    children: (
                      <div>
                        <ChapterStatusBrief />
                      </div>
                    ),
                  },
                ]}
              />
            </Card>
          </div>
        </Col>
      </Row>
    </div>
  );
}

function ChapterStatusBrief() {
  const { chapterStatus, selectedProjectRef, chapters } = useAppStore();

  if (!selectedProjectRef) {
    return <Alert type="info" showIcon message="请先选择项目查看章节状态。" />;
  }
  if (!chapterStatus) {
    return <Alert type="info" showIcon message="暂无章节状态数据，生成章节后自动刷新。" />;
  }
  const review = chapterStatus.chapter_status.review;
  const counts = chapterStatus.chapter_status.knowledge_drafts.counts;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div>章节总数：{chapters.length}</div>
      <div>待复核：{review.pending_count} · 已通过：{review.accepted_count} · 已拒绝：{review.rejected_count}</div>
      <div>
        知识草稿：待审 {counts.pending_review} · 已接受 {counts.accepted} · 已拒绝 {counts.rejected} · 失败{" "}
        {counts.failed}
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
  );
}
