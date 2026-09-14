import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Card, Descriptions, Drawer, Empty, Form, Input, InputNumber, Modal, Select, Space, Spin, Tag } from "antd";
import { ArrowRightOutlined, DeleteOutlined, EditOutlined, LinkOutlined, PlusOutlined, ReloadOutlined, ImportOutlined, SearchOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import type { NarrativeGraphDocument, NarrativeGraphNode, NarrativeGraphNodeType } from "../types";
import { createNarrativeGraphEdge, createNarrativeGraphNode, deleteNarrativeGraphEdge, deleteNarrativeGraphNode, getNarrativeGraph, importNarrativeGraphAssets, updateNarrativeGraphNode } from "../api";
import { useAppStore } from "../store/useAppStore";
import GraphCanvas, { NODE_COLORS } from "../components/graph/GraphCanvas";
import "../components/graph/graph.css";

const NODE_TYPES = [
  { value: "character", label: "角色" }, { value: "scene", label: "场景" },
  { value: "item", label: "物品" }, { value: "foreshadowing", label: "伏笔" },
  { value: "relationship_note", label: "关系备注" }, { value: "plot_direction", label: "剧情走向" },
  { value: "world_fact", label: "世界设定" }, { value: "event", label: "事件" }, { value: "organization", label: "组织" },
];
const EDGE_TYPES = [
  { value: "related", label: "相关" }, { value: "appears_in", label: "出现于" },
  { value: "belongs_to", label: "属于" }, { value: "causes", label: "导致" },
  { value: "contrasts_with", label: "对照" }, { value: "foreshadows", label: "预示" },
  { value: "character_relation", label: "人物关系" },
];
const readableType = (type: string) => NODE_TYPES.find((item) => item.value === type)?.label ?? type;
type NodeFormValues = { label: string; type: NarrativeGraphNodeType; summary: string; importance: number; status: string };
type EdgeFormValues = { source: string; target: string; type: string; label: string; summary: string };

export default function GraphPage() {
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const { selectedProjectRef, apiStatus } = useAppStore();
  const [graph, setGraph] = useState<NarrativeGraphDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodeModal, setNodeModal] = useState<{ mode: "create" | "edit"; node?: NarrativeGraphNode } | null>(null);
  const [edgeOpen, setEdgeOpen] = useState(false);
  const [nodeForm] = Form.useForm<NodeFormValues>();
  const [edgeForm] = Form.useForm<EdgeFormValues>();
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const currentProject = useRef(selectedProjectRef);
  currentProject.current = selectedProjectRef;
  const requestId = useRef(0);
  const canEdit = Boolean(selectedProjectRef) && apiStatus === "online" && !loading && !saving && !importing;

  const loadGraph = useCallback(async () => {
    const id = ++requestId.current;
    if (!selectedProjectRef) { setGraph(null); setLoading(false); return; }
    setLoading(true); setError("");
    try {
      const result = await getNarrativeGraph(selectedProjectRef);
      if (id === requestId.current && currentProject.current === selectedProjectRef) setGraph(result.graph);
    } catch (e) {
      if (id === requestId.current && currentProject.current === selectedProjectRef) setError(e instanceof Error ? e.message : "图谱暂时无法加载，请重试。");
    } finally {
      if (id === requestId.current && currentProject.current === selectedProjectRef) setLoading(false);
    }
  }, [selectedProjectRef]);

  useEffect(() => {
    setGraph(null); setSelectedNodeId(null); setNodeModal(null); setEdgeOpen(false); setError(""); setSaving(false); setImporting(false);
    if (apiStatus === "online") void loadGraph();
    else setLoading(false);
    return () => { requestId.current++; };
  }, [loadGraph, apiStatus]);

  const nodes = graph?.graph.nodes ?? [];
  const edges = graph?.graph.edges ?? [];
  const nodeMap = useMemo(() => new Map((graph?.graph.nodes ?? []).map((node) => [node.id, node])), [graph]);
  const selectedNode = selectedNodeId ? nodeMap.get(selectedNodeId) ?? null : null;
  const relatedEdges = selectedNode ? edges.filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id) : [];
  const nodeOptions = nodes.map((node) => ({ value: node.id, label: node.label }));

  const openEditNode = useCallback((id: string) => {
    const node = nodeMap.get(id);
    if (!node) return;
    nodeForm.setFieldsValue({ label: node.label, type: node.type as NarrativeGraphNodeType, summary: node.summary, importance: node.importance, status: node.status });
    setNodeModal({ mode: "edit", node });
  }, [nodeMap, nodeForm]);
  const openCreateNode = () => {
    nodeForm.resetFields();
    nodeForm.setFieldsValue({ type: "character", importance: 5, status: "active" });
    setNodeModal({ mode: "create" });
  };
  const openCreateEdge = (source?: string) => {
    edgeForm.resetFields(); edgeForm.setFieldsValue({ type: "related", source }); setEdgeOpen(true);
  };

  async function handleNodeSave() {
    if (!selectedProjectRef || !nodeModal || saving) return;
    let values: NodeFormValues;
    try { values = await nodeForm.validateFields(); } catch { return; }
    const projectRef = selectedProjectRef;
    setSaving(true);
    try {
      // 编辑只提交表单展示的字段，保留别名、标签、层级和来源等元数据。
      const edited = { ...values, label: values.label.trim(), summary: values.summary ?? "" };
      const result = nodeModal.mode === "edit" && nodeModal.node
        ? await updateNarrativeGraphNode(projectRef, nodeModal.node.id, edited)
        : await createNarrativeGraphNode(projectRef, { ...edited, aliases: [], tags: [], layer: "detail", properties: {}, notes: "" });
      if (currentProject.current !== projectRef) return;
      setGraph(result.graph); setSelectedNodeId(result.node.id); setNodeModal(null);
      message.success(nodeModal.mode === "edit" ? "节点已更新" : "节点已加入图谱");
    } catch (e) {
      if (currentProject.current === projectRef) message.error(e instanceof Error ? e.message : "节点保存失败");
    } finally { if (currentProject.current === projectRef) setSaving(false); }
  }

  async function handleImport() {
    if (!selectedProjectRef || !canEdit) return;
    const projectRef = selectedProjectRef;
    setImporting(true);
    try {
      const result = await importNarrativeGraphAssets(projectRef);
      if (currentProject.current !== projectRef) return;
      setGraph(result.graph); message.success("已从已有大纲与人物资料导入图谱");
    } catch (e) { if (currentProject.current === projectRef) message.error(e instanceof Error ? e.message : "导入失败"); }
    finally { if (currentProject.current === projectRef) setImporting(false); }
  }

  async function handleCreateEdge() {
    if (!selectedProjectRef || saving) return;
    let values: EdgeFormValues;
    try { values = await edgeForm.validateFields(); } catch { return; }
    const projectRef = selectedProjectRef;
    setSaving(true);
    try {
      const result = await createNarrativeGraphEdge(projectRef, { ...values, label: values.label?.trim() || EDGE_TYPES.find((type) => type.value === values.type)?.label || values.type, summary: values.summary ?? "", importance: 5, layer: "detail", status: "active", properties: {}, notes: "" });
      if (currentProject.current !== projectRef) return;
      setGraph(result.graph); setEdgeOpen(false); message.success("关系已建立");
    } catch (e) { if (currentProject.current === projectRef) message.error(e instanceof Error ? e.message : "关系创建失败"); }
    finally { if (currentProject.current === projectRef) setSaving(false); }
  }

  function confirmDelete(kind: "node" | "edge", id: string, label: string) {
    if (!selectedProjectRef || !canEdit) return;
    const projectRef = selectedProjectRef;
    modal.confirm({
      title: `删除${kind === "node" ? "节点" : "关系"}「${label}」？`,
      content: kind === "node" ? "该节点和与它连接的关系都会被删除。此操作无法撤销。" : "这条关系将从正式图谱中移除。此操作无法撤销。",
      okText: "删除", cancelText: "保留", okButtonProps: { danger: true },
      onOk: async () => {
        if (currentProject.current !== projectRef) return;
        setSaving(true);
        try {
          const result = kind === "node"
            ? await deleteNarrativeGraphNode(projectRef, id, { deleteEdges: true })
            : await deleteNarrativeGraphEdge(projectRef, id);
          if (currentProject.current !== projectRef) return;
          setGraph(result.graph);
          if (kind === "node") setSelectedNodeId(null);
          message.success("已删除");
        } catch (e) { message.error(e instanceof Error ? e.message : "删除失败"); throw e; }
        finally { if (currentProject.current === projectRef) setSaving(false); }
      },
    });
  }

  return (
    <div className="page-container graph-page">
      <div className="page-heading">
        <div><span className="eyebrow">THE STORY, CONNECTED</span><h1 className="page-title">叙事图谱</h1><p className="page-subtitle">让角色、伏笔与世界设定之间的联系，成为看得见的创作线索。</p></div>
        <Button icon={<ArrowRightOutlined />} onClick={() => navigate("/library")}>审核新线索</Button>
      </div>
      {error && <Alert type="error" showIcon message={error} action={<Button size="small" onClick={() => void loadGraph()}>重试</Button>} />}
      {apiStatus === "offline" && <Alert type="warning" showIcon message="本地服务尚未连接，连接后可读取和编辑图谱。" />}
      {!selectedProjectRef ? <Card><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择一本作品，展开它的故事网络。"><Button type="primary" onClick={() => navigate("/dashboard")}>前往作品概览</Button></Empty></Card> : <>
        <div className="graph-toolbar">
          <Select className="graph-search" aria-label="查找图谱节点" showSearch allowClear optionFilterProp="label" placeholder="查找角色、伏笔或设定" suffixIcon={<SearchOutlined />} options={nodeOptions} value={selectedNodeId ?? undefined} onChange={(value) => setSelectedNodeId(value ?? null)} />
          <Space wrap>
            <Button icon={<ImportOutlined />} onClick={() => void handleImport()} loading={importing} disabled={!canEdit}>从资料导入</Button>
            <Button icon={<LinkOutlined />} onClick={() => openCreateEdge(selectedNodeId ?? undefined)} disabled={!canEdit || nodes.length < 2}>建立关系</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreateNode} disabled={!canEdit}>添加节点</Button>
            <Button aria-label="刷新图谱" icon={<ReloadOutlined />} loading={loading} disabled={saving || importing || apiStatus !== "online"} onClick={() => void loadGraph()} />
          </Space>
        </div>
        <div className="graph-workspace">
          <section className="graph-stage" aria-label="叙事关系画布">
            <div className="graph-stage-heading"><span>故事网络 <span className="graph-count">{graph ? `${nodes.length} 节点 / ${edges.length} 关系` : "等待加载"}</span></span><span>拖动探索 · 双击编辑</span></div>
            <Spin spinning={loading}>
              <GraphCanvas projectRef={selectedProjectRef} graph={graph} loading={loading} selectedNodeId={selectedNodeId} onNodeClick={setSelectedNodeId} onNodeDoubleClick={openEditNode} onBlankClick={() => setSelectedNodeId(null)} />
              {!loading && graph && nodes.length === 0 && <div className="graph-empty"><div className="graph-empty-orbit" aria-hidden="true"><span /><span /><span /></div><h3>每个故事，从一个联系开始</h3><p>从已有资料导入角色与设定，或亲手放下第一个节点。</p><Button type="primary" icon={<PlusOutlined />} disabled={!canEdit} onClick={openCreateNode}>添加第一个节点</Button></div>}
            </Spin>
            <div className="graph-legend">{NODE_TYPES.filter((type) => nodes.some((node) => node.type === type.value) || nodes.length === 0 && ["character", "scene", "foreshadowing", "world_fact"].includes(type.value)).map((type) => <span key={type.value}><i style={{ background: NODE_COLORS[type.value] }} />{type.label}</span>)}<span className="graph-legend-note">节点大小表示重要度</span></div>
          </section>
          <aside className="graph-inspector">
            <div className="graph-inspector-heading"><span className="eyebrow">INSPECTOR</span><span>{selectedNode ? readableType(selectedNode.type) : "节点详情"}</span></div>
            {!selectedNode ? <div className="graph-inspector-empty"><div className="inspector-glyph" aria-hidden="true">↗</div><h3>循着联系，走进故事</h3><p>点击节点查看资料，或使用搜索直接定位。你可以随时补充关系，让故事的脉络更清晰。</p><div className="graph-tip"><strong>由你确认，才成为设定。</strong><br />模型提取的候选资料会先进入知识审核，接受后加入正式图谱。</div></div> : <>
              <h2 className="graph-node-title">{selectedNode.label}</h2>
              <div className="graph-node-tags"><Tag>{readableType(selectedNode.type)}</Tag><Tag>{({ active: "活跃", draft: "草稿", retired: "已弃用", deprecated: "已弃用", planned: "计划中", confirmed: "已确认" } as Record<string, string>)[selectedNode.status] || selectedNode.status}</Tag><Tag>重要度 {selectedNode.importance}/10</Tag></div>
              <p className="graph-node-summary">{selectedNode.summary || "还没有描述。补充一段说明，记录它在故事中的位置。"}</p>
              {selectedNode.aliases.length > 0 && <p className="graph-node-aliases">别名 · {selectedNode.aliases.join("、")}</p>}
              <Space wrap>{selectedNode.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</Space>
              <Space wrap className="graph-node-actions"><Button icon={<EditOutlined />} disabled={!canEdit} onClick={() => openEditNode(selectedNode.id)}>编辑</Button><Button icon={<LinkOutlined />} disabled={!canEdit || nodes.length < 2} onClick={() => openCreateEdge(selectedNode.id)}>连接</Button><Button type="text" danger aria-label={`删除节点${selectedNode.label}`} disabled={!canEdit} icon={<DeleteOutlined />} onClick={() => confirmDelete("node", selectedNode.id, selectedNode.label)} /></Space>
              <div className="graph-relations-heading">关联关系 <span>{relatedEdges.length}</span></div>
              {relatedEdges.length === 0 ? <p className="graph-node-aliases">这个节点还没有关系。为它寻找一条故事线索。</p> : <div className="graph-relations">{relatedEdges.map((edge) => {
                const outbound = edge.source === selectedNode.id;
                const otherId = outbound ? edge.target : edge.source;
                return <div className="graph-relation" key={edge.id}><button className="graph-relation-link" onClick={() => setSelectedNodeId(otherId)}><small>{outbound ? "出向" : "入向"} · {edge.label || edge.type}</small><strong>{outbound ? "→ " : "← "}{nodeMap.get(otherId)?.label ?? "未知节点"}</strong>{edge.summary && <span>{edge.summary}</span>}</button><Button size="small" type="text" danger aria-label={`删除关系${edge.label || edge.type}`} icon={<DeleteOutlined />} disabled={!canEdit} onClick={() => confirmDelete("edge", edge.id, edge.label || edge.type)} /></div>;
              })}</div>}
              {selectedNode.notes && <div className="graph-tip">{selectedNode.notes}</div>}
              <details className="graph-source"><summary>查看资料属性</summary><Descriptions size="small" column={1}><Descriptions.Item label="层级">{selectedNode.layer}</Descriptions.Item><Descriptions.Item label="节点 ID">{selectedNode.id}</Descriptions.Item></Descriptions>{Object.keys(selectedNode.properties).length > 0 && <pre>{JSON.stringify(selectedNode.properties, null, 2)}</pre>}</details>
            </>}
          </aside>
        </div>
      </>}
      <Modal title={nodeModal?.mode === "edit" ? "编辑故事节点" : "添加故事节点"} open={Boolean(nodeModal)} onCancel={() => { if (!saving) setNodeModal(null); }} onOk={() => void handleNodeSave()} okText="保存节点" cancelText="取消" confirmLoading={saving} destroyOnHidden>
        <Form form={nodeForm} layout="vertical" style={{ marginTop: 24 }}>
          <Form.Item name="label" label="名称" rules={[{ required: true, whitespace: true, message: "请输入节点名称" }]}><Input maxLength={200} placeholder="这个角色、地点或线索叫什么？" /></Form.Item>
          <div className="graph-form-row"><Form.Item name="type" label="类型" rules={[{ required: true }]}><Select options={NODE_TYPES} /></Form.Item><Form.Item name="importance" label="重要度" rules={[{ required: true }]}><InputNumber min={1} max={10} style={{ width: "100%" }} /></Form.Item></div>
          <Form.Item name="status" label="状态"><Select options={[{ value: "active", label: "活跃" }, { value: "draft", label: "草稿" }, { value: "retired", label: "已弃用" }]} /></Form.Item>
          <Form.Item name="summary" label="描述"><Input.TextArea rows={4} placeholder="记录它的特点，以及它在故事中的作用。" /></Form.Item>
        </Form>
      </Modal>
      <Drawer title="建立故事关系" open={edgeOpen} onClose={() => { if (!saving) setEdgeOpen(false); }} size={420} extra={<Button type="primary" loading={saving} onClick={() => void handleCreateEdge()}>建立关系</Button>}>
        <p className="graph-node-summary">选择关系的起点与终点，说明两者如何相连。</p>
        <Form form={edgeForm} layout="vertical">
          <Form.Item name="source" label="从哪个节点出发" rules={[{ required: true, message: "请选择起点" }]}><Select showSearch optionFilterProp="label" options={nodeOptions} placeholder="选择起点" /></Form.Item>
          <Form.Item name="target" label="连接到哪个节点" dependencies={["source"]} rules={[{ required: true, message: "请选择终点" }, ({ getFieldValue }) => ({ validator(_, value) { return !value || value !== getFieldValue("source") ? Promise.resolve() : Promise.reject(new Error("请选择另一个节点")); } })]}><Select showSearch optionFilterProp="label" options={nodeOptions} placeholder="选择终点" /></Form.Item>
          <Form.Item name="type" label="关系类型" rules={[{ required: true }]}><Select options={EDGE_TYPES} /></Form.Item>
          <Form.Item name="label" label="关系名称"><Input maxLength={200} placeholder="例如：守护、追查、曾经的同伴" /></Form.Item>
          <Form.Item name="summary" label="关系说明"><Input.TextArea rows={4} placeholder="补充这段关系的来由与变化。" /></Form.Item>
        </Form>
      </Drawer>
    </div>
  );
}
