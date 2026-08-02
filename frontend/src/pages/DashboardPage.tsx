import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Alert, Button, Card, Col, Row, Skeleton, Statistic, Steps, Typography } from "antd";
import {
  ApiOutlined,
  BookOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  EditOutlined,
} from "@ant-design/icons";
import { useProjectData } from "../hooks/useProjectData";
import { useAppStore } from "../store/useAppStore";
import ProjectListPanel from "../components/project/ProjectListPanel";

export default function DashboardPage() {
  const navigate = useNavigate();
  const {
    apiStatus,
    selectedProjectRef,
    selectedProject,
    projectLoading,
    chapters,
    chaptersLoading,
  } = useAppStore();

  const { detailError, chaptersError } = useProjectData(selectedProjectRef);

  const currentChapterNumber = useMemo(() => {
    const numbers = chapters.map((chapter) => chapter.chapter_number);
    return numbers.length > 0 ? Math.max(...numbers) : null;
  }, [chapters]);

  const chapterCount = chapters.length;
  const lastUpdated = selectedProject?.config?.updated_at
    ? String(selectedProject.config.updated_at)
    : "";

  useEffect(() => {
    if (apiStatus !== "online" && selectedProjectRef) {
      return;
    }
  }, [apiStatus, selectedProjectRef]);

  return (
    <div className="page-container">
      <h1 className="page-title">仪表盘</h1>
      <p className="page-subtitle">项目概览与创作进度</p>

      {apiStatus === "offline" && (
        <Alert
          type="error"
          showIcon
          message="后端服务未连接"
          description="请先启动 FastAPI 后端（uvicorn api.main:app --port 8000），再刷新页面。"
          style={{ marginBottom: 16 }}
        />
      )}

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={7}>
          <Card title="项目" size="small" styles={{ body: { height: "calc(100vh - 260px)", overflowY: "auto" } }}>
            <ProjectListPanel />
          </Card>
        </Col>

        <Col xs={24} lg={17}>
          {!selectedProjectRef ? (
            <Card>
              <div style={{ textAlign: "center", padding: "48px 0" }}>
                <BookOutlined style={{ fontSize: 48, color: "#d3c7b4" }} />
                <Typography.Title level={4} style={{ marginTop: 16 }}>
                  还没有选择项目
                </Typography.Title>
                <Typography.Text type="secondary">
                  从左侧选择一个项目，或新建项目开始创作。
                </Typography.Text>
                <div style={{ marginTop: 16 }}>
                  <Button type="primary" icon={<EditOutlined />} onClick={() => navigate("/writing")}>
                    前往创作驾驶舱
                  </Button>
                </div>
              </div>
            </Card>
          ) : (
            <>
              {(detailError || chaptersError) && (
                <Alert
                  type="error"
                  showIcon
                  message={detailError || chaptersError}
                  closable
                  style={{ marginBottom: 16 }}
                />
              )}

              <Card size="small" style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Typography.Title level={4} style={{ margin: "0 0 4px" }}>
                      {projectLoading ? <Skeleton.Input active size="small" /> : (selectedProject?.title ?? selectedProjectRef)}
                    </Typography.Title>
                    <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                      {selectedProjectRef}
                      {lastUpdated && (
                        <span style={{ marginLeft: 12 }}>
                          <ClockCircleOutlined /> 更新于 {lastUpdated}
                        </span>
                      )}
                    </Typography.Text>
                  </div>
                  <Button type="primary" icon={<EditOutlined />} onClick={() => navigate("/writing")}>
                    进入创作
                  </Button>
                </div>
              </Card>

              <Row gutter={[16, 16]}>
                <Col xs={12} md={6}>
                  <Card size="small">
                    <Statistic
                      title="章节数"
                      value={chaptersLoading ? "—" : chapterCount}
                      prefix={chaptersLoading ? undefined : <BookOutlined />}
                    />
                  </Card>
                </Col>
                <Col xs={12} md={6}>
                  <Card size="small">
                    <Statistic
                      title="当前进度"
                      value={currentChapterNumber ?? 0}
                      suffix={`/ ${chapterCount || "?"}`}
                    />
                  </Card>
                </Col>
                <Col xs={12} md={6}>
                  <Card size="small">
                    <Statistic
                      title="API 状态"
                      value={apiStatus === "online" ? "在线" : apiStatus === "offline" ? "离线" : "检测中"}
                      valueStyle={{ color: apiStatus === "online" ? "#4f7354" : apiStatus === "offline" ? "#a6534e" : "#a16d24" }}
                      prefix={<ApiOutlined />}
                    />
                  </Card>
                </Col>
                <Col xs={12} md={6}>
                  <Card size="small">
                    <Statistic
                      title="创作流程"
                      value={chapterCount > 0 ? "已启动" : "待启动"}
                      valueStyle={{ color: chapterCount > 0 ? "#4f7354" : "#a16d24" }}
                      prefix={chapterCount > 0 ? <CheckCircleOutlined /> : <ClockCircleOutlined />}
                    />
                  </Card>
                </Col>
              </Row>

              <Card title="创作向导" size="small" style={{ marginTop: 16 }}>
                <Steps
                  size="small"
                  current={chapterCount > 0 ? 2 : 0}
                  items={[
                    { title: "创建项目", description: "设定故事种子与风格" },
                    { title: "生成大纲与人物卡", description: "让 AI 建立世界与角色" },
                    { title: "逐章生成", description: "从第 1 章开始创作" },
                    { title: "持续创作", description: "维护设定与续写" },
                  ]}
                />
                <div style={{ marginTop: 16, textAlign: "right" }}>
                  <Button onClick={() => navigate("/writing")}>打开创作驾驶舱</Button>
                </div>
              </Card>
            </>
          )}
        </Col>
      </Row>
    </div>
  );
}
