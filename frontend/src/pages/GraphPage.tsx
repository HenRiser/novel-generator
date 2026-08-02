import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from "antd";
import {
  DeleteOutlined,
  EditOutlined,
  NodeIndexOutlined,
  PlusOutlined,
  ReloadOutlined,
  DownloadOutlined,
} from "@ant-design/icons";
import type {
  NarrativeGraphDocument,
  NarrativeGraphEdge,
  NarrativeGraphNode,
  NarrativeGraphNodeType,
} from "../types";
import {
  createNarrativeGraphEdge,
  createNarrativeGraphNode,
  deleteNarrativeGraphEdge,
  deleteNarrativeGraphNode,
  getNarrativeGraph,
  importNarrativeGraphAssets,
  updateNarrativeGraphEdge,
  updateNarrativeGraphNode,
} from "../api";
import { useAppStore } from "../store/useAppStore";
import GraphCanvas from "../components/graph/GraphCanvas";

const NODE_TYPES = [
  { value: "character", label: "角色" },
  { value: "scene", label: "场景" },
  { value: "item", label: "物品" },
  { value: "foreshadowing", label: "伏笔" },
  { value: "relationship_note", label: "关系备注" },
  { value: "plot_direction", label: "剧情走向" },
  { value: "world_fact", label: "世界观设定" },
  { value: "event", label: "事件" },
  { value: "organization", label: "组织" },
];

const EDGE_TYPES = [
  { value: "related", label: "相关" },
  { value: "appears_in", label: "出现于" },
  { value: "belongs_to", label: "属于" },
  { value: "causes", label: "导致" },
  { value: "contrasts_with", label: "对照" },
  { value: "foreshadows", label: "预示" },
  { value: "character_relation", label: "人物关系" },
];

function readableType(type: string): string {
  return NODE_TYPES.find((t) => t.value === type)?.label ?? type;
}

type NodeFormValues = {
  label: string;
  type: string;
  summary: string;
  importance: number;
  status: string;
};

type EdgeFormValues = {
  type: string;
  label: string;
  summary: string;
};

export default function GraphPage() {
  const { selectedProjectRef } = useAppStore();
  const [graph, setGraph] = useState<NarrativeGraphDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedNode, setSelectedNode] = useState<NarrativeGraphNode | null>(null);
  const [nodeModal, setNodeModal] = useState<{ mode: "create" | "edit"; node?: NarrativeGraphNode } | null>(null);
  const [edgeModal, setEdgeModal] = useState<{ sourceId: string; targetId: string } | null>(null);
  const [nodeForm] = Form.useForm<NodeFormValues>();
  const [edgeForm] = Form.useForm<EdgeFormValues>();
  const [saving, setSaving] = useState(false);

  const loadGraph = useCallback(async () => {
    if (!selectedProjectRef) {
      setGraph(null);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await getNarrativeGraph(selectedProjectRef);
      setGraph(result.graph ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "图谱加载失败。");
    } finally {
      setLoading(false);
    }
  }, [selectedProjectRef]);

  useEffect(() => {
    void loadGraph();
  }, [loadGraph]);

  const nodeMap = useMemo(() => {
    const map = new Map<string, NarrativeGraphNode>();
    graph?.graph.nodes.forEach((node) => map.set(node.id, node));
    return map;
  }, [graph]);

  const handleNodeClick = useCallback(
    (nodeId: string) => {
      const node = nodeMap.get(nodeId);
      if (node) {
        setSelectedNode(node);
      }
    },
    [nodeMap],
  );

  const handleNodeDoubleClick = useCallback(
    (nodeId: string) => {
      const node = nodeMap.get(nodeId);
      if (node) {
        setNodeModal({ mode: "edit", node });
        nodeForm.setFieldsValue({
          label: node.label,
          type: node.type,
          summary: node.summary,
          importance: node.importance,
          status: node.status,
        });
      }
    },
    [nodeForm, nodeMap],
  );

  const openCreateNode = useCallback(() => {
    setSelectedNode(null);
    nodeForm.resetFields();
    nodeForm.setFieldsValue({ type: "character", importance: 5, status: "active" });
    setNodeModal({ mode: "create" });
  }, [nodeForm]);

  const closeNodeModal = useCallback(() => {
    setNodeModal(null);
  }, []);

  const handleNodeSave = useCallback(async () => {
    if (!selectedProjectRef || !nodeModal) {
      return;
    }
    setSaving(true);
    try {
      const values = await nodeForm.validateFields();
      const request = {
        label: values.label,
        type: values.type as NarrativeGraphNodeType,
        aliases: [],
        summary: values.summary,
        importance: values.importance,
        layer: "detail" as const,
        status: values.status,
        tags: [],
        properties: {},
        notes: "",
      };
      if (nodeModal.mode === "edit" && nodeModal.node) {
        await updateNarrativeGraphNode(selectedProjectRef, nodeModal.node.id, request);
      } else {
        await createNarrativeGraphNode(selectedProjectRef, request);
      }
      message.success(nodeModal.mode === "edit" ? "节点已更新。" : "节点已创建。");
      closeNodeModal();
      void loadGraph();
    } catch (e) {
      if (e instanceof Error && "errorFields" in e) {
        return; // 表单校验失败
      }
      message.error(e instanceof Error ? e.message : "保存失败。");
    } finally {
      setSaving(false);
    }
  }, [closeNodeModal, loadGraph, nodeForm, nodeModal, selectedProjectRef]);

  const [importing, setImporting] = useState(false);

  const handleImportAssets = useCallback(async () => {
    if (!selectedProjectRef || importing) {
      return;
    }
    setImporting(true);
    try {
      const result = await importNarrativeGraphAssets(selectedProjectRef);
      message.success(result.message || "已从大纲导入图谱节点。");
      setGraph(result.graph ?? null);
    } catch (e) {
      message.error(e instanceof Error ? e.message : "导入失败。");
    } finally {
      setImporting(false);
    }
  }, [importing, selectedProjectRef]);

  const handleNodeDelete = useCallback(
    async (nodeId: string) => {
      if (!selectedProjectRef) {
        return;
      }
      Modal.confirm({
        title: "删除节点",
        content: "删除该节点及其关联关系？此操作不可撤销。",
        okButtonProps: { danger: true },
        okText: "删除",
        cancelText: "取消",
        onOk: async () => {
          try {
            await deleteNarrativeGraphNode(selectedProjectRef, nodeId, { deleteEdges: true });
            message.success("节点已删除。");
            setSelectedNode(null);
            void loadGraph();
          } catch (e) {
            message.error(e instanceof Error ? e.message : "删除失败。");
          }
        },
      });
    },
    [loadGraph, selectedProjectRef],
  );

  const handleCreateEdge = useCallback(async () => {
    if (!selectedProjectRef || !edgeModal) {
      return;
    }
    setSaving(true);
    try {
      const values = await edgeForm.validateFields();
      await createNarrativeGraphEdge(selectedProjectRef, {
        source: edgeModal.sourceId,
        target: edgeModal.targetId,
        type: values.type,
        label: values.label || values.type,
        summary: values.summary,
        importance: 5,
        layer: "detail",
        status: "active",
        properties: {},
        notes: "",
      });
      message.success("关系已创建。");
      setEdgeModal(null);
      void loadGraph();
    } catch (e) {
      if (e instanceof Error && "errorFields" in e) {
        return;
      }
      message.error(e instanceof Error ? e.message : "创建关系失败。");
    } finally {
      setSaving(false);
    }
  }, [edgeForm, edgeModal, loadGraph, selectedProjectRef]);

  const handleEdgeDelete = useCallback(
    async (edgeId: string) => {
      if (!selectedProjectRef) {
        return;
      }
      try {
        await deleteNarrativeGraphEdge(selectedProjectRef, edgeId);
        message.success("关系已删除。");
        void loadGraph();
      } catch (e) {
        message.error(e instanceof Error ? e.message : "删除失败。");
      }
    },
    [loadGraph, selectedProjectRef],
  );

  const relatedEdges = useMemo(() => {
    if (!selectedNode || !graph) {
      return [];
    }
    return graph.graph.edges.filter(
      (edge) => edge.source === selectedNode.id || edge.target === selectedNode.id,
    );
  }, [graph, selectedNode]);

  return (
    <div style={{ padding: 20 }}>
      <Row gutter={16}>
        <Col xs={24} xl={16}>
          <Card
            title={
              <Space>
                <NodeIndexOutlined style={{ color: "#5f4b32" }} />
                <span>叙事图谱</span>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  拖拽布局 · 双击节点编辑 · 滚轮缩放
                </Typography.Text>
              </Space>
            }
            extra={
              <Space>
                <Button
                  icon={<DownloadOutlined />}
                  onClick={() => void handleImportAssets()}
                  loading={importing}
                  disabled={!selectedProjectRef}
                >
                  从大纲导入
                </Button>
                <Button icon={<PlusOutlined />} onClick={openCreateNode} disabled={!selectedProjectRef}>
                  新建节点
                </Button>
                <Button icon={<ReloadOutlined />} onClick={() => void loadGraph()} loading={loading}>
                  刷新
                </Button>
              </Space>
            }
          >
            {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 8 }} />}
            {!selectedProjectRef ? (
              <Alert type="info" showIcon message="请先在左侧选择项目。" />
            ) : (
              <Spin spinning={loading}>
                <GraphCanvas
                  projectRef={selectedProjectRef}
                  graph={graph}
                  loading={loading}
                  onNodeClick={handleNodeClick}
                  onNodeDoubleClick={handleNodeDoubleClick}
                  onBlankClick={() => setSelectedNode(null)}
                />
              </Spin>
            )}
          </Card>
        </Col>

        <Col xs={24} xl={8}>
          <Card size="small" title="节点详情">
            {!selectedNode ? (
              <Alert type="info" showIcon message="点击画布中的节点查看详情。" />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <Descriptions column={1} size="small" bordered>
                  <Descriptions.Item label="名称">{selectedNode.label}</Descriptions.Item>
                  <Descriptions.Item label="类型">
                    <Tag color="geekblue">{readableType(selectedNode.type)}</Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="重要度">{selectedNode.importance}/10</Descriptions.Item>
                  <Descriptions.Item label="状态">{selectedNode.status || "—"}</Descriptions.Item>
                </Descriptions>

                {selectedNode.summary && (
                  <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 0 }}>
                    {selectedNode.summary}
                  </Typography.Paragraph>
                )}

                {selectedNode.tags.length > 0 && (
                  <Space wrap size={4}>
                    {selectedNode.tags.map((tag) => (
                      <Tag key={tag}>{tag}</Tag>
                    ))}
                  </Space>
                )}

                <Space>
                  <Button
                    icon={<EditOutlined />}
                    onClick={() => {
                      setNodeModal({ mode: "edit", node: selectedNode });
                      nodeForm.setFieldsValue({
                        label: selectedNode.label,
                        type: selectedNode.type,
                        summary: selectedNode.summary,
                        importance: selectedNode.importance,
                        status: selectedNode.status,
                      });
                    }}
                  >
                    编辑
                  </Button>
                  <Button danger icon={<DeleteOutlined />} onClick={() => void handleNodeDelete(selectedNode.id)}>
                    删除
                  </Button>
                </Space>

                {relatedEdges.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    <Typography.Text strong style={{ fontSize: 13 }}>
                      关联关系（{relatedEdges.length}）
                    </Typography.Text>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                      {relatedEdges.map((edge) => {
                        const other = edge.source === selectedNode.id ? edge.target : edge.source;
                        const otherNode = nodeMap.get(other);
                        return (
                          <div
                            key={edge.id}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              padding: "6px 10px",
                              border: "1px solid #e6dccb",
                              borderRadius: 6,
                              background: "#fffdf8",
                            }}
                          >
                            <div style={{ overflow: "hidden" }}>
                              <Typography.Text style={{ fontSize: 12 }}>
                                {edge.label || edge.type} → {otherNode?.label ?? other}
                              </Typography.Text>
                            </div>
                            <Button
                              type="text"
                              size="small"
                              danger
                              icon={<DeleteOutlined />}
                              onClick={() => void handleEdgeDelete(edge.id)}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </Card>
        </Col>
      </Row>

      {/* 节点创建/编辑弹窗 */}
      <Modal
        title={nodeModal?.mode === "edit" ? "编辑节点" : "新建节点"}
        open={Boolean(nodeModal)}
        onCancel={closeNodeModal}
        onOk={() => void handleNodeSave()}
        confirmLoading={saving}
        destroyOnClose
      >
        <Form form={nodeForm} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item name="label" label="名称" rules={[{ required: true, message: "请输入节点名称" }]}>
            <Input placeholder="例如：林雾" />
          </Form.Item>
          <Form.Item name="type" label="类型" rules={[{ required: true }]}>
            <Select options={NODE_TYPES} />
          </Form.Item>
          <Form.Item name="importance" label="重要度（1-10）">
            <InputNumber min={1} max={10} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select
              options={[
                { value: "active", label: "活跃" },
                { value: "draft", label: "草稿" },
                { value: "retired", label: "已弃用" },
              ]}
            />
          </Form.Item>
          <Form.Item name="summary" label="摘要">
            <Input.TextArea rows={3} placeholder="一句话说明该节点" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 连线创建弹窗 */}
      <Drawer
        title="新建关系"
        open={Boolean(edgeModal)}
        onClose={() => setEdgeModal(null)}
        width={360}
        extra={
          <Button type="primary" loading={saving} onClick={() => void handleCreateEdge()}>
            创建
          </Button>
        }
      >
        {edgeModal && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Alert
              type="info"
              showIcon
              message={`${nodeMap.get(edgeModal.sourceId)?.label ?? edgeModal.sourceId} → ${nodeMap.get(edgeModal.targetId)?.label ?? edgeModal.targetId}`}
            />
            <Form form={edgeForm} layout="vertical">
              <Form.Item name="type" label="关系类型" rules={[{ required: true }]}>
                <Select options={EDGE_TYPES} />
              </Form.Item>
              <Form.Item name="label" label="关系标签">
                <Input placeholder="例如：林雾 认识 老看守" />
              </Form.Item>
              <Form.Item name="summary" label="说明">
                <Input.TextArea rows={3} placeholder="补充关系细节" />
              </Form.Item>
            </Form>
          </div>
        )}
      </Drawer>
    </div>
  );
}
