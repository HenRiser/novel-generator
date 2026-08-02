import { useEffect, useState } from "react";
import { Alert, Card, Col, Row } from "antd";
import { useAppStore } from "../store/useAppStore";
import { useProjectData } from "../hooks/useProjectData";
import ProjectListPanel from "../components/project/ProjectListPanel";
import ChapterListPanel from "../components/chapter/ChapterListPanel";
import ChapterReader from "../components/chapter/ChapterReader";

export default function ReaderPage() {
  const { selectedProjectRef, apiStatus, chapters } = useAppStore();
  const [selectedChapterNumber, setSelectedChapterNumber] = useState<number | null>(null);
  const { refreshChapters } = useProjectData(selectedProjectRef);

  useEffect(() => {
    void refreshChapters();
  }, [refreshChapters, selectedProjectRef]);

  return (
    <div className="page-container">
      <h1 className="page-title">阅读器</h1>
      <p className="page-subtitle">沉浸式章节阅读与导出</p>

      {apiStatus === "offline" && (
        <Alert type="error" showIcon message="后端服务未连接" style={{ marginBottom: 12 }} />
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
            title={`章节（${chapters.length}）`}
            styles={{ body: { height: "calc(100vh - 200px)", overflowY: "hidden", display: "flex", flexDirection: "column" } }}
          >
            <ChapterListPanel
              selectedChapterNumber={selectedChapterNumber}
              onSelectChapter={setSelectedChapterNumber}
            />
          </Card>
        </Col>
        <Col xs={24} md={8} xl={13}>
          <Card size="small" styles={{ body: { height: "calc(100vh - 200px)", overflowY: "hidden" } }}>
            <ChapterReader chapterNumber={selectedChapterNumber} />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
