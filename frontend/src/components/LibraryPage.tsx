import { useEffect, useMemo, useState, type FormEvent } from "react";

import {
  createNarrativeGraphEdge,
  createNarrativeGraphNode,
  createNarrativeGraphTag,
  getNarrativeGraph,
  safePublicMessage,
} from "../api";
import type {
  ApiStatus,
  NarrativeGraphDocument,
  NarrativeGraphEdge,
  NarrativeGraphEdgeRequest,
  NarrativeGraphLayer,
  NarrativeGraphNode,
  NarrativeGraphNodeRequest,
  NarrativeGraphNodeType,
  NarrativeGraphTagCategory,
  NarrativeGraphTagEntry,
  ProjectSummary,
} from "../types";

type LibraryPageProps = {
  selectedProject: ProjectSummary | null;
  apiStatus: ApiStatus;
};

type TagForm = {
  name: string;
  category: NarrativeGraphTagCategory;
  description: string;
  aliases: string;
};

type NodeForm = {
  type: NarrativeGraphNodeType;
  label: string;
  summary: string;
  importance: string;
  layer: NarrativeGraphLayer;
  status: string;
  aliases: string;
  tags: string[];
  properties: string;
  notes: string;
};

type EdgeForm = {
  source: string;
  target: string;
  type: string;
  label: string;
  summary: string;
  importance: string;
  layer: NarrativeGraphLayer;
  status: string;
  properties: string;
  notes: string;
};

type SelectedEntity =
  | { entityType: "node"; id: string }
  | { entityType: "edge"; id: string }
  | null;

const NODE_TYPES: NarrativeGraphNodeType[] = [
  "character",
  "scene",
  "item",
  "foreshadowing",
  "relationship_note",
  "plot_direction",
  "world_fact",
  "event",
  "organization",
];
const TAG_CATEGORIES: NarrativeGraphTagCategory[] = [
  "plot_scope",
  "organization",
  "narrative_function",
  "theme",
  "custom",
];
const LAYERS: NarrativeGraphLayer[] = ["core", "major", "detail", "background"];

const DEFAULT_TAG_FORM: TagForm = {
  name: "",
  category: "custom",
  description: "",
  aliases: "",
};
const DEFAULT_NODE_FORM: NodeForm = {
  type: "character",
  label: "",
  summary: "",
  importance: "5",
  layer: "detail",
  status: "active",
  aliases: "",
  tags: [],
  properties: "{}",
  notes: "",
};
const DEFAULT_EDGE_FORM: EdgeForm = {
  source: "",
  target: "",
  type: "related_to",
  label: "",
  summary: "",
  importance: "5",
  layer: "detail",
  status: "active",
  properties: "{}",
  notes: "",
};

function parseList(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => {
      if (!item || seen.has(item)) {
        return false;
      }
      seen.add(item);
      return true;
    });
}

function parseProperties(value: string): Record<string, unknown> | string {
  const text = value.trim();
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return "properties 必须是 JSON object。";
  } catch {
    return "properties JSON 格式不正确。";
  }
}

function parseImportance(value: string): number | string {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    return "importance 必须是 1 到 10 之间的整数。";
  }
  return parsed;
}

function nodeLabelMap(nodes: NarrativeGraphNode[]): Map<string, string> {
  return new Map(nodes.map((node) => [node.id, node.label || node.id]));
}

function formatJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function updateGraphFromResponse(response: { graph: NarrativeGraphDocument }): NarrativeGraphDocument {
  return response.graph;
}

export function LibraryPage({ selectedProject, apiStatus }: LibraryPageProps) {
  const [graph, setGraph] = useState<NarrativeGraphDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [tagForm, setTagForm] = useState<TagForm>(DEFAULT_TAG_FORM);
  const [nodeForm, setNodeForm] = useState<NodeForm>(DEFAULT_NODE_FORM);
  const [edgeForm, setEdgeForm] = useState<EdgeForm>(DEFAULT_EDGE_FORM);
  const [selectedEntity, setSelectedEntity] = useState<SelectedEntity>(null);
  const [typeFilter, setTypeFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [minImportanceFilter, setMinImportanceFilter] = useState("1");

  useEffect(() => {
    let ignore = false;

    async function load(projectRef: string) {
      setLoading(true);
      setLoadError("");
      setActionError("");
      setActionMessage("");
      setGraph(null);
      setSelectedEntity(null);
      try {
        const response = await getNarrativeGraph(projectRef);
        if (!ignore) {
          setGraph(response.graph);
        }
      } catch (error) {
        if (!ignore) {
          setLoadError(safePublicMessage(error instanceof Error ? error.message : "", "Narrative Graph 加载失败。"));
        }
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    }

    if (selectedProject && apiStatus === "online") {
      void load(selectedProject.project_ref);
    } else {
      setGraph(null);
      setLoadError("");
      setSelectedEntity(null);
    }

    return () => {
      ignore = true;
    };
  }, [apiStatus, selectedProject]);

  const nodes = graph?.graph.nodes ?? [];
  const edges = graph?.graph.edges ?? [];
  const tags = graph?.tag_registry ?? {};
  const tagEntries = useMemo(
    () => Object.entries(tags).sort(([left], [right]) => left.localeCompare(right)),
    [tags],
  );
  const activeTagNames = tagEntries
    .filter(([, entry]) => (entry.status || "active") === "active")
    .map(([name]) => name);
  const labels = useMemo(() => nodeLabelMap(nodes), [nodes]);
  const minImportance = Math.max(1, Math.min(10, Number(minImportanceFilter) || 1));
  const filteredNodes = nodes.filter((node) => {
    if (typeFilter && node.type !== typeFilter) {
      return false;
    }
    if (tagFilter && !node.tags.includes(tagFilter)) {
      return false;
    }
    return Number(node.importance || 0) >= minImportance;
  });
  const highImportanceCount =
    nodes.filter((node) => Number(node.importance || 0) >= 7).length +
    edges.filter((edge) => Number(edge.importance || 0) >= 7).length;
  const selectedNode =
    selectedEntity?.entityType === "node"
      ? nodes.find((node) => node.id === selectedEntity.id) ?? null
      : null;
  const selectedEdge =
    selectedEntity?.entityType === "edge"
      ? edges.find((edge) => edge.id === selectedEntity.id) ?? null
      : null;
  const inspectorEdges = selectedNode
    ? edges.filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id)
    : [];
  const inspectorRelatedNodes = selectedNode
    ? nodes.filter((node) =>
        inspectorEdges.some((edge) => edge.source === node.id || edge.target === node.id),
      )
    : [];
  const canWrite = Boolean(selectedProject && graph && apiStatus === "online");

  async function handleAddTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProject) {
      return;
    }
    const name = tagForm.name.trim();
    if (!name) {
      setActionError("tag name 不能为空。");
      setActionMessage("");
      return;
    }
    setActionError("");
    setActionMessage("");
    try {
      const response = await createNarrativeGraphTag(selectedProject.project_ref, {
        name,
        category: tagForm.category,
        description: tagForm.description.trim(),
        aliases: parseList(tagForm.aliases),
      });
      setGraph(updateGraphFromResponse(response));
      setTagForm(DEFAULT_TAG_FORM);
      setActionMessage("Tag 已保存。");
    } catch (error) {
      setActionError(safePublicMessage(error instanceof Error ? error.message : "", "Tag 保存失败。"));
    }
  }

  async function handleAddNode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProject) {
      return;
    }
    const label = nodeForm.label.trim();
    if (!label) {
      setActionError("node label 不能为空。");
      setActionMessage("");
      return;
    }
    const importance = parseImportance(nodeForm.importance);
    if (typeof importance === "string") {
      setActionError(importance);
      setActionMessage("");
      return;
    }
    const properties = parseProperties(nodeForm.properties);
    if (typeof properties === "string") {
      setActionError(properties);
      setActionMessage("");
      return;
    }

    const request: NarrativeGraphNodeRequest = {
      type: nodeForm.type,
      label,
      aliases: parseList(nodeForm.aliases),
      summary: nodeForm.summary.trim(),
      importance,
      layer: nodeForm.layer,
      parent_id: null,
      status: nodeForm.status.trim() || "active",
      tags: nodeForm.tags,
      properties,
      notes: nodeForm.notes.trim(),
    };

    setActionError("");
    setActionMessage("");
    try {
      const response = await createNarrativeGraphNode(selectedProject.project_ref, request);
      setGraph(updateGraphFromResponse(response));
      setNodeForm(DEFAULT_NODE_FORM);
      setSelectedEntity({ entityType: "node", id: response.node.id });
      setActionMessage("Node 已保存。");
    } catch (error) {
      setActionError(safePublicMessage(error instanceof Error ? error.message : "", "Node 保存失败。"));
    }
  }

  async function handleAddEdge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProject) {
      return;
    }
    if (!edgeForm.source || !edgeForm.target) {
      setActionError("source 和 target 必须选择已有 node。");
      setActionMessage("");
      return;
    }
    if (edgeForm.source === edgeForm.target) {
      setActionError("source 和 target 不能相同。");
      setActionMessage("");
      return;
    }
    const label = edgeForm.label.trim();
    if (!label) {
      setActionError("edge label 不能为空。");
      setActionMessage("");
      return;
    }
    const type = edgeForm.type.trim();
    if (!type) {
      setActionError("edge type 不能为空。");
      setActionMessage("");
      return;
    }
    const importance = parseImportance(edgeForm.importance);
    if (typeof importance === "string") {
      setActionError(importance);
      setActionMessage("");
      return;
    }
    const properties = parseProperties(edgeForm.properties);
    if (typeof properties === "string") {
      setActionError(properties);
      setActionMessage("");
      return;
    }

    const request: NarrativeGraphEdgeRequest = {
      source: edgeForm.source,
      target: edgeForm.target,
      type,
      label,
      summary: edgeForm.summary.trim(),
      importance,
      layer: edgeForm.layer,
      status: edgeForm.status.trim() || "active",
      properties,
      notes: edgeForm.notes.trim(),
    };

    setActionError("");
    setActionMessage("");
    try {
      const response = await createNarrativeGraphEdge(selectedProject.project_ref, request);
      setGraph(updateGraphFromResponse(response));
      setEdgeForm(DEFAULT_EDGE_FORM);
      setSelectedEntity({ entityType: "edge", id: response.edge.id });
      setActionMessage("Edge 已保存。");
    } catch (error) {
      setActionError(safePublicMessage(error instanceof Error ? error.message : "", "Edge 保存失败。"));
    }
  }

  return (
    <section className="workspace-single-page" aria-labelledby="library-title">
      <section className="panel page-intro-panel">
        <span className="section-kicker">Library</span>
        <h1 id="library-title">创作资料库</h1>
        <p>
          Narrative Graph foundation 用于手动管理人物、场景、物品、伏笔、世界观事实和剧情走向。
          本阶段只做本地结构化资料，不接入章节生成 prompt，也不提供 2D/3D 图谱。
        </p>
        <p className="state-text">
          当前项目：{selectedProject ? selectedProject.title || selectedProject.project_ref : "尚未选择项目"}
        </p>
      </section>

      {!selectedProject && <p className="empty-state">请先在创作页创建或选择一个项目。</p>}
      {selectedProject && apiStatus !== "online" && <p className="empty-state">API Offline，资料库暂时无法加载。</p>}
      {loading && <p className="state-text loading-text">正在加载 Narrative Graph...</p>}
      {loadError && <p className="state-text error-text">{loadError}</p>}

      {selectedProject && graph && !loading && !loadError && (
        <section className="library-workspace" aria-label="Narrative Graph workspace">
          <section className="library-main">
            <div className="library-stats-grid" aria-label="Narrative Graph 统计">
              <article className="panel library-stat-card">
                <span>Nodes</span>
                <strong>{nodes.length}</strong>
              </article>
              <article className="panel library-stat-card">
                <span>Edges</span>
                <strong>{edges.length}</strong>
              </article>
              <article className="panel library-stat-card">
                <span>Tags</span>
                <strong>{tagEntries.length}</strong>
              </article>
              <article className="panel library-stat-card">
                <span>Importance &gt;= 7</span>
                <strong>{highImportanceCount}</strong>
              </article>
            </div>

            {nodes.length === 0 && (
              <p className="empty-state">
                当前项目还没有创作资料。你可以先添加人物、场景、特殊物品、伏笔或世界观事实。
              </p>
            )}

            {actionMessage && <p className="state-text success-text">{actionMessage}</p>}
            {actionError && <p className="state-text error-text">{actionError}</p>}

            <section className="library-forms-grid" aria-label="新增 Narrative Graph 数据">
              <form className="panel graph-form" noValidate onSubmit={(event) => void handleAddTag(event)}>
                <div className="panel-header">
                  <div>
                    <span className="section-kicker">Tag Registry</span>
                    <h2>新增 tag</h2>
                  </div>
                </div>
                <label className="form-field">
                  <span>tag name</span>
                  <input
                    value={tagForm.name}
                    onChange={(event) => setTagForm((current) => ({ ...current, name: event.target.value }))}
                    disabled={!canWrite}
                  />
                </label>
                <label className="form-field">
                  <span>category</span>
                  <select
                    value={tagForm.category}
                    onChange={(event) =>
                      setTagForm((current) => ({
                        ...current,
                        category: event.target.value as NarrativeGraphTagCategory,
                      }))
                    }
                    disabled={!canWrite}
                  >
                    {TAG_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="form-field">
                  <span>description</span>
                  <textarea
                    value={tagForm.description}
                    onChange={(event) => setTagForm((current) => ({ ...current, description: event.target.value }))}
                    disabled={!canWrite}
                  />
                </label>
                <label className="form-field">
                  <span>aliases（逗号或换行分隔）</span>
                  <input
                    value={tagForm.aliases}
                    onChange={(event) => setTagForm((current) => ({ ...current, aliases: event.target.value }))}
                    disabled={!canWrite}
                  />
                </label>
                <button className="button primary-button" type="submit" disabled={!canWrite}>
                  保存 tag
                </button>
              </form>

              <form className="panel graph-form" noValidate onSubmit={(event) => void handleAddNode(event)}>
                <div className="panel-header">
                  <div>
                    <span className="section-kicker">Node</span>
                    <h2>新增 node</h2>
                  </div>
                </div>
                <div className="form-grid">
                  <label className="form-field">
                    <span>type</span>
                    <select
                      value={nodeForm.type}
                      onChange={(event) =>
                        setNodeForm((current) => ({ ...current, type: event.target.value as NarrativeGraphNodeType }))
                      }
                      disabled={!canWrite}
                    >
                      {NODE_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="form-field">
                    <span>label</span>
                    <input
                      value={nodeForm.label}
                      onChange={(event) => setNodeForm((current) => ({ ...current, label: event.target.value }))}
                      disabled={!canWrite}
                    />
                  </label>
                </div>
                <label className="form-field">
                  <span>summary</span>
                  <textarea
                    value={nodeForm.summary}
                    onChange={(event) => setNodeForm((current) => ({ ...current, summary: event.target.value }))}
                    disabled={!canWrite}
                  />
                </label>
                <div className="form-grid">
                  <label className="form-field">
                    <span>importance 1-10</span>
                    <input
                      type="number"
                      min="1"
                      max="10"
                      step="1"
                      value={nodeForm.importance}
                      onChange={(event) => setNodeForm((current) => ({ ...current, importance: event.target.value }))}
                      disabled={!canWrite}
                    />
                  </label>
                  <label className="form-field">
                    <span>layer</span>
                    <select
                      value={nodeForm.layer}
                      onChange={(event) =>
                        setNodeForm((current) => ({ ...current, layer: event.target.value as NarrativeGraphLayer }))
                      }
                      disabled={!canWrite}
                    >
                      {LAYERS.map((layer) => (
                        <option key={layer} value={layer}>
                          {layer}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="form-field">
                    <span>status</span>
                    <input
                      value={nodeForm.status}
                      onChange={(event) => setNodeForm((current) => ({ ...current, status: event.target.value }))}
                      disabled={!canWrite}
                    />
                  </label>
                </div>
                <label className="form-field">
                  <span>aliases（逗号或换行分隔）</span>
                  <input
                    value={nodeForm.aliases}
                    onChange={(event) => setNodeForm((current) => ({ ...current, aliases: event.target.value }))}
                    disabled={!canWrite}
                  />
                </label>
                <label className="form-field">
                  <span>tags（来自 tag registry）</span>
                  <select
                    multiple
                    value={nodeForm.tags}
                    onChange={(event) =>
                      setNodeForm((current) => ({
                        ...current,
                        tags: Array.from(event.target.selectedOptions).map((option) => option.value),
                      }))
                    }
                    disabled={!canWrite || activeTagNames.length === 0}
                  >
                    {activeTagNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="form-field">
                  <span>properties JSON object</span>
                  <textarea
                    className="json-field"
                    value={nodeForm.properties}
                    onChange={(event) => setNodeForm((current) => ({ ...current, properties: event.target.value }))}
                    disabled={!canWrite}
                  />
                </label>
                <p className="form-note">
                  tags 是受控分类；aliases 是别名；notes 是自由说明。item 可记录 appearance、current_location、defined_functions、narrative_functions。
                </p>
                <label className="form-field">
                  <span>notes</span>
                  <textarea
                    value={nodeForm.notes}
                    onChange={(event) => setNodeForm((current) => ({ ...current, notes: event.target.value }))}
                    disabled={!canWrite}
                  />
                </label>
                <button className="button primary-button" type="submit" disabled={!canWrite}>
                  保存 node
                </button>
              </form>

              <form className="panel graph-form" noValidate onSubmit={(event) => void handleAddEdge(event)}>
                <div className="panel-header">
                  <div>
                    <span className="section-kicker">Edge</span>
                    <h2>新增 edge</h2>
                  </div>
                </div>
                {nodes.length < 2 && <p className="form-note">至少需要 2 个 node 才能创建 edge。</p>}
                <div className="form-grid">
                  <label className="form-field">
                    <span>source node</span>
                    <select
                      value={edgeForm.source}
                      onChange={(event) => setEdgeForm((current) => ({ ...current, source: event.target.value }))}
                      disabled={!canWrite || nodes.length < 2}
                    >
                      <option value="">请选择 source</option>
                      {nodes.map((node) => (
                        <option key={node.id} value={node.id}>
                          {node.label || node.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="form-field">
                    <span>target node</span>
                    <select
                      value={edgeForm.target}
                      onChange={(event) => setEdgeForm((current) => ({ ...current, target: event.target.value }))}
                      disabled={!canWrite || nodes.length < 2}
                    >
                      <option value="">请选择 target</option>
                      {nodes.map((node) => (
                        <option key={node.id} value={node.id}>
                          {node.label || node.id}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="form-grid">
                  <label className="form-field">
                    <span>type</span>
                    <input
                      value={edgeForm.type}
                      onChange={(event) => setEdgeForm((current) => ({ ...current, type: event.target.value }))}
                      disabled={!canWrite}
                    />
                  </label>
                  <label className="form-field">
                    <span>label</span>
                    <input
                      value={edgeForm.label}
                      onChange={(event) => setEdgeForm((current) => ({ ...current, label: event.target.value }))}
                      disabled={!canWrite}
                    />
                  </label>
                </div>
                <label className="form-field">
                  <span>summary</span>
                  <textarea
                    value={edgeForm.summary}
                    onChange={(event) => setEdgeForm((current) => ({ ...current, summary: event.target.value }))}
                    disabled={!canWrite}
                  />
                </label>
                <div className="form-grid">
                  <label className="form-field">
                    <span>importance 1-10</span>
                    <input
                      type="number"
                      min="1"
                      max="10"
                      step="1"
                      value={edgeForm.importance}
                      onChange={(event) => setEdgeForm((current) => ({ ...current, importance: event.target.value }))}
                      disabled={!canWrite}
                    />
                  </label>
                  <label className="form-field">
                    <span>layer</span>
                    <select
                      value={edgeForm.layer}
                      onChange={(event) =>
                        setEdgeForm((current) => ({ ...current, layer: event.target.value as NarrativeGraphLayer }))
                      }
                      disabled={!canWrite}
                    >
                      {LAYERS.map((layer) => (
                        <option key={layer} value={layer}>
                          {layer}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="form-field">
                    <span>status</span>
                    <input
                      value={edgeForm.status}
                      onChange={(event) => setEdgeForm((current) => ({ ...current, status: event.target.value }))}
                      disabled={!canWrite}
                    />
                  </label>
                </div>
                <label className="form-field">
                  <span>properties JSON object</span>
                  <textarea
                    className="json-field"
                    value={edgeForm.properties}
                    onChange={(event) => setEdgeForm((current) => ({ ...current, properties: event.target.value }))}
                    disabled={!canWrite}
                  />
                </label>
                <label className="form-field">
                  <span>notes</span>
                  <textarea
                    value={edgeForm.notes}
                    onChange={(event) => setEdgeForm((current) => ({ ...current, notes: event.target.value }))}
                    disabled={!canWrite}
                  />
                </label>
                <button className="button primary-button" type="submit" disabled={!canWrite || nodes.length < 2}>
                  保存 edge
                </button>
              </form>
            </section>

            <section className="library-browser-grid" aria-label="Narrative Graph 浏览">
              <section className="panel graph-list-panel">
                <div className="panel-header">
                  <div>
                    <span className="section-kicker">Browse</span>
                    <h2>Node 列表</h2>
                  </div>
                </div>
                <div className="graph-filter-bar" aria-label="node 筛选">
                  <label className="form-field">
                    <span>type 筛选</span>
                    <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
                      <option value="">全部 type</option>
                      {NODE_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="form-field">
                    <span>importance &gt;=</span>
                    <input
                      type="number"
                      min="1"
                      max="10"
                      step="1"
                      value={minImportanceFilter}
                      onChange={(event) => setMinImportanceFilter(event.target.value)}
                    />
                  </label>
                  <label className="form-field">
                    <span>tag 筛选</span>
                    <select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}>
                      <option value="">全部 tag</option>
                      {activeTagNames.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="graph-list">
                  {filteredNodes.length === 0 && <p className="empty-state">没有符合当前筛选条件的 node。</p>}
                  {filteredNodes.map((node) => (
                    <button
                      className={`graph-list-item ${selectedEntity?.entityType === "node" && selectedEntity.id === node.id ? "selected" : ""}`}
                      key={node.id}
                      type="button"
                      onClick={() => setSelectedEntity({ entityType: "node", id: node.id })}
                    >
                      <strong>{node.label || node.id}</strong>
                      <span>{node.type} · importance {node.importance} · {node.layer}</span>
                      {node.tags.length > 0 && <small>{node.tags.join(" / ")}</small>}
                    </button>
                  ))}
                </div>
              </section>

              <section className="panel graph-list-panel">
                <div className="panel-header">
                  <div>
                    <span className="section-kicker">Edges</span>
                    <h2>Edge 列表</h2>
                  </div>
                </div>
                <div className="graph-list">
                  {edges.length === 0 && <p className="empty-state">暂无 edge。先创建至少两个 node。</p>}
                  {edges.map((edge) => (
                    <button
                      className={`graph-list-item ${selectedEntity?.entityType === "edge" && selectedEntity.id === edge.id ? "selected" : ""}`}
                      key={edge.id}
                      type="button"
                      onClick={() => setSelectedEntity({ entityType: "edge", id: edge.id })}
                    >
                      <strong>{edge.label || edge.id}</strong>
                      <span>
                        {labels.get(edge.source) || edge.source} → {labels.get(edge.target) || edge.target}
                      </span>
                      <small>{edge.type} · importance {edge.importance} · {edge.layer}</small>
                    </button>
                  ))}
                </div>
              </section>

              <section className="panel graph-list-panel">
                <div className="panel-header">
                  <div>
                    <span className="section-kicker">Tags</span>
                    <h2>Tag Registry</h2>
                  </div>
                </div>
                <div className="graph-list">
                  {tagEntries.length === 0 && <p className="empty-state">暂无 tag。创建 node 前可先建立受控分类。</p>}
                  {tagEntries.map(([name, entry]: [string, NarrativeGraphTagEntry]) => (
                    <article className="tag-registry-item" key={name}>
                      <strong>{name}</strong>
                      <span>{entry.category} · {entry.status || "active"}</span>
                      {entry.description && <p>{entry.description}</p>}
                      {entry.aliases?.length > 0 && <small>aliases: {entry.aliases.join(" / ")}</small>}
                    </article>
                  ))}
                </div>
              </section>
            </section>
          </section>

          <EntityInspector
            edge={selectedEdge}
            edges={edges}
            labels={labels}
            node={selectedNode}
            relatedNodes={inspectorRelatedNodes}
            selectedEntity={selectedEntity}
          />
        </section>
      )}
    </section>
  );
}

function EntityInspector({
  edge,
  edges,
  labels,
  node,
  relatedNodes,
  selectedEntity,
}: {
  edge: NarrativeGraphEdge | null;
  edges: NarrativeGraphEdge[];
  labels: Map<string, string>;
  node: NarrativeGraphNode | null;
  relatedNodes: NarrativeGraphNode[];
  selectedEntity: SelectedEntity;
}) {
  if (!selectedEntity) {
    return (
      <aside className="panel entity-inspector" aria-label="Entity Inspector">
        <span className="section-kicker">Entity Inspector</span>
        <h2>选择 node 或 edge</h2>
        <p>点击列表中的对象后，这里会展示摘要、标签、properties 和一阶关联。</p>
      </aside>
    );
  }

  if (node) {
    const linkedEdges = edges.filter((item) => item.source === node.id || item.target === node.id);
    return (
      <aside className="panel entity-inspector" aria-label="Entity Inspector">
        <span className="section-kicker">Node Inspector</span>
        <h2>{node.label || node.id}</h2>
        <dl className="inspector-list">
          <div><dt>id</dt><dd>{node.id}</dd></div>
          <div><dt>type</dt><dd>{node.type}</dd></div>
          <div><dt>importance</dt><dd>{node.importance}</dd></div>
          <div><dt>layer</dt><dd>{node.layer}</dd></div>
          <div><dt>status</dt><dd>{node.status}</dd></div>
          <div><dt>tags</dt><dd>{node.tags.length ? node.tags.join(" / ") : "-"}</dd></div>
          <div><dt>aliases</dt><dd>{node.aliases.length ? node.aliases.join(" / ") : "-"}</dd></div>
        </dl>
        {node.summary && <p className="inspector-summary">{node.summary}</p>}
        {node.notes && <p className="inspector-note">{node.notes}</p>}
        <section className="inspector-section">
          <h3>Properties</h3>
          <pre>{formatJson(node.properties)}</pre>
        </section>
        <section className="inspector-section">
          <h3>入边 / 出边</h3>
          {linkedEdges.length === 0 && <p>暂无一阶 edge。</p>}
          {linkedEdges.map((item) => (
            <p key={item.id}>
              {labels.get(item.source) || item.source} → {labels.get(item.target) || item.target}：{item.label}
            </p>
          ))}
        </section>
        <section className="inspector-section">
          <h3>关联 node</h3>
          {relatedNodes.filter((item) => item.id !== node.id).length === 0 && <p>暂无一阶关联 node。</p>}
          {relatedNodes
            .filter((item) => item.id !== node.id)
            .map((item) => (
              <p key={item.id}>{item.label || item.id}</p>
            ))}
        </section>
      </aside>
    );
  }

  if (edge) {
    return (
      <aside className="panel entity-inspector" aria-label="Entity Inspector">
        <span className="section-kicker">Edge Inspector</span>
        <h2>{edge.label || edge.id}</h2>
        <dl className="inspector-list">
          <div><dt>id</dt><dd>{edge.id}</dd></div>
          <div><dt>type</dt><dd>{edge.type}</dd></div>
          <div><dt>source</dt><dd>{labels.get(edge.source) || edge.source}</dd></div>
          <div><dt>target</dt><dd>{labels.get(edge.target) || edge.target}</dd></div>
          <div><dt>importance</dt><dd>{edge.importance}</dd></div>
          <div><dt>layer</dt><dd>{edge.layer}</dd></div>
          <div><dt>status</dt><dd>{edge.status}</dd></div>
        </dl>
        {edge.summary && <p className="inspector-summary">{edge.summary}</p>}
        {edge.notes && <p className="inspector-note">{edge.notes}</p>}
        <section className="inspector-section">
          <h3>Properties</h3>
          <pre>{formatJson(edge.properties)}</pre>
        </section>
      </aside>
    );
  }

  return (
    <aside className="panel entity-inspector" aria-label="Entity Inspector">
      <span className="section-kicker">Entity Inspector</span>
      <h2>对象不存在</h2>
      <p>当前选中的对象已经不在 graph 中。</p>
    </aside>
  );
}
