import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Alert, Button, Card, Space, Tabs, Typography } from "antd";
import { DatabaseOutlined, NodeIndexOutlined, ReloadOutlined } from "@ant-design/icons";
import { getNarrativeGraph } from "../api";
import type { NarrativeGraphDocument, ProjectSummary } from "../types";
import { useAppStore } from "../store/useAppStore";
import { KnowledgeDraftReviewPanel } from "../components/library/KnowledgeDraftReviewPanel";

/**
 * 资料库页：知识草稿审核 + 叙事图谱入口。
 * 知识草稿 accept 成功后自动刷新图谱数据。
 */
export default function LibraryPage() {
  const navigate = useNavigate();
  const { apiStatus, selectedProjectRef, projects } = useAppStore();
  const [graph, setGraph] = useState<NarrativeGraphDocument | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState("");

  const selectedProjectSummary: ProjectSummary | null =
    projects.find((project) => project.project_ref === selectedProjectRef) ?? null;

  const loadGraph = useCallback(async () => {
    if (!selectedProjectRef) {
      setGraph(null);
      return;
    }
    setGraphLoading(true);
    setGraphError("");
    try {
      const result = await getNarrativeGraph(selectedProjectRef);
      setGraph(result.graph ?? null);
    } catch (e) {
      setGraphError(e instanceof Error ? e.message : "图谱加载失败。");
      setGraph(null);
    } finally {
      setGraphLoading(false);
    }
  }, [selectedProjectRef]);

  useEffect(() => {
    void loadGraph();
  }, [loadGraph]);

  return (
    <div style={{ padding: 20 }}>
      <Card
        title={
          <Space>
            <DatabaseOutlined style={{ color: "#5f4b32" }} />
            <span>资料库</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              知识草稿审核 · 叙事图谱
            </Typography.Text>
          </Space>
        }
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void loadGraph()} loading={graphLoading}>
            刷新
          </Button>
        }
        styles={{ body: { paddingTop: 12 } }}
      >
        {!selectedProjectRef ? (
          <Alert type="info" showIcon message="请先在左侧选择项目。" />
        ) : (
          <Tabs
            items={[
              {
                key: "drafts",
                label: "知识草稿",
                children: selectedProjectSummary ? (
                  <KnowledgeDraftReviewPanel
                    apiStatus={apiStatus}
                    graph={graph}
                    onGraphUpdated={setGraph}
                    selectedProject={selectedProjectSummary}
                  />
                ) : (
                  <Alert type="info" showIcon message="项目信息加载中…" />
                ),
              },
              {
                key: "graph",
                label: "叙事图谱",
                children: (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {graphError && <Alert type="error" showIcon message={graphError} />}
                    <Alert
                      type="info"
                      showIcon
                      message={`图谱包含 ${graph?.graph.nodes.length ?? 0} 个节点 / ${graph?.graph.edges.length ?? 0} 条关系`}
                      description="拖拽布局、节点编辑、连线创建请在可视化画布中操作。"
                      action={
                        <Button size="small" type="primary" icon={<NodeIndexOutlined />} onClick={() => navigate("/graph")}>
                          打开图谱画布
                        </Button>
                      }
                    />
                  </div>
                ),
              },
            ]}
          />
        )}
      </Card>
    </div>
  );
}
