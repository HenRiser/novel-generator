import { useEffect, useMemo, useState, type FormEvent } from "react";

import {
  createNarrativeGraphEdge,
  createNarrativeGraphNode,
  createNarrativeGraphTag,
  deleteNarrativeGraphEdge,
  deleteNarrativeGraphNode,
  deleteNarrativeGraphTag,
  getNarrativeGraph,
  safePublicMessage,
  updateNarrativeGraphEdge,
  updateNarrativeGraphNode,
  updateNarrativeGraphTag,
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
  NarrativeGraphTagUpdateRequest,
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
  status: string;
};

type NodeForm = {
  type: NarrativeGraphNodeType;
  label: string;
  summary: string;
  importance: string;
  layer: NarrativeGraphLayer;
  parentId: string;
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

type ActiveLibraryPanel = "browse" | "node" | "edge" | "tags";

type SearchResult = {
  entityType: "node" | "edge";
  id: string;
  label: string;
  summary: string;
  score: number;
  reasons: string[];
};

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
  status: "active",
};
const DEFAULT_NODE_FORM: NodeForm = {
  type: "character",
  label: "",
  summary: "",
  importance: "5",
  layer: "detail",
  parentId: "",
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

const PROPERTY_TEMPLATES: Partial<Record<NarrativeGraphNodeType, Record<string, unknown>>> = {
  item: {
    appearance: "",
    current_location: "",
    availability_status: "unknown",
    defined_functions: [],
    narrative_functions: [],
  },
  scene: {
    layout: "",
    visual_style: "",
    atmosphere: "",
    interactive_elements: [],
    narrative_functions: [],
    scene_rules: [],
  },
  foreshadowing: {
    setup: "",
    payoff_plan: "",
    status: "unresolved",
    related_chapters: [],
  },
  plot_direction: {
    direction: "",
    priority: "medium",
    related_characters: [],
    related_scenes: [],
  },
  world_fact: {
    fact: "",
    scope: "",
    source_of_truth: "user",
  },
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

function formatList(values: string[] | undefined): string {
  return (values ?? []).join("\n");
}

function normalize(value: unknown): string {
  return String(value ?? "").toLowerCase();
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => stringValues(item));
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((item) => stringValues(item));
  }
  return [];
}

function textMatches(queryParts: string[], value: unknown): boolean {
  const text = normalize(value);
  return Boolean(text && queryParts.some((part) => text.includes(part)));
}

function addReason(reasons: Set<string>, reason: string): void {
  if (reason) {
    reasons.add(reason);
  }
}

function scoreText(queryParts: string[], value: unknown, weight: number, reason: string, reasons: Set<string>): number {
  if (!textMatches(queryParts, value)) {
    return 0;
  }
  addReason(reasons, reason);
  return weight;
}

function tagSearchText(name: string, entry: NarrativeGraphTagEntry | undefined): string {
  if (!entry) {
    return name;
  }
  return [name, entry.description, ...(entry.aliases ?? []), entry.category, entry.status].join(" ");
}

function searchGraph(
  graph: NarrativeGraphDocument,
  query: string,
  labels: Map<string, string>,
): SearchResult[] {
  const queryParts = normalize(query)
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (queryParts.length === 0) {
    return [];
  }

  const nodes = graph.graph.nodes;
  const edges = graph.graph.edges;
  const tags = graph.tag_registry;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const results: SearchResult[] = [];

  for (const node of nodes) {
    const reasons = new Set<string>();
    let score = 0;
    score += scoreText(queryParts, node.label, 60, "label", reasons);
    score += scoreText(queryParts, node.aliases.join(" "), 50, "alias", reasons);
    score += scoreText(queryParts, node.type, 20, "type", reasons);
    score += scoreText(queryParts, node.summary, 25, "summary", reasons);
    score += scoreText(queryParts, node.notes, 15, "note", reasons);
    score += scoreText(queryParts, stringValues(node.properties).join(" "), 15, "property", reasons);
    score += scoreText(
      queryParts,
      node.tags.map((tag) => tagSearchText(tag, tags[tag])).join(" "),
      40,
      "tag",
      reasons,
    );

    const linkedEdges = edges.filter((edge) => edge.source === node.id || edge.target === node.id);
    const neighborText = linkedEdges
      .flatMap((edge) => {
        const other = nodeById.get(edge.source === node.id ? edge.target : edge.source);
        return [
          edge.label,
          edge.type,
          edge.summary,
          other?.label,
          other?.summary,
          ...(other?.aliases ?? []),
          ...(other?.tags ?? []),
        ];
      })
      .join(" ");
    score += scoreText(queryParts, neighborText, 12, "neighbor", reasons);
    if (score > 0) {
      score += Math.min(10, Number(node.importance || 0));
      results.push({
        entityType: "node",
        id: node.id,
        label: node.label || node.id,
        summary: node.summary,
        score,
        reasons: Array.from(reasons),
      });
    }
  }

  for (const edge of edges) {
    const reasons = new Set<string>();
    let score = 0;
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    score += scoreText(queryParts, edge.label, 60, "label", reasons);
    score += scoreText(queryParts, edge.type, 25, "type", reasons);
    score += scoreText(queryParts, edge.summary, 25, "summary", reasons);
    score += scoreText(queryParts, edge.notes, 15, "note", reasons);
    score += scoreText(queryParts, stringValues(edge.properties).join(" "), 15, "property", reasons);
    score += scoreText(
      queryParts,
      [
        source?.label,
        source?.summary,
        ...(source?.aliases ?? []),
        ...(source?.tags ?? []),
        target?.label,
        target?.summary,
        ...(target?.aliases ?? []),
        ...(target?.tags ?? []),
        labels.get(edge.source),
        labels.get(edge.target),
      ].join(" "),
      20,
      "neighbor",
      reasons,
    );
    if (score > 0) {
      score += Math.min(10, Number(edge.importance || 0));
      results.push({
        entityType: "edge",
        id: edge.id,
        label: edge.label || edge.id,
        summary: edge.summary,
        score,
        reasons: Array.from(reasons),
      });
    }
  }

  return results.sort((left, right) => right.score - left.score);
}

function scoreLevel(score: number): string {
  if (score >= 70) {
    return "高";
  }
  if (score >= 35) {
    return "中";
  }
  return "低";
}

function updateGraphFromResponse(response: { graph: NarrativeGraphDocument }): NarrativeGraphDocument {
  return response.graph;
}

function nodeFormFromNode(node: NarrativeGraphNode): NodeForm {
  return {
    type: NODE_TYPES.includes(node.type as NarrativeGraphNodeType)
      ? (node.type as NarrativeGraphNodeType)
      : "character",
    label: node.label || "",
    summary: node.summary || "",
    importance: String(node.importance || 5),
    layer: LAYERS.includes(node.layer as NarrativeGraphLayer) ? (node.layer as NarrativeGraphLayer) : "detail",
    parentId: node.parent_id || "",
    status: node.status || "active",
    aliases: formatList(node.aliases),
    tags: node.tags ?? [],
    properties: formatJson(node.properties),
    notes: node.notes || "",
  };
}

function edgeFormFromEdge(edge: NarrativeGraphEdge): EdgeForm {
  return {
    source: edge.source || "",
    target: edge.target || "",
    type: edge.type || "related_to",
    label: edge.label || "",
    summary: edge.summary || "",
    importance: String(edge.importance || 5),
    layer: LAYERS.includes(edge.layer as NarrativeGraphLayer) ? (edge.layer as NarrativeGraphLayer) : "detail",
    status: edge.status || "active",
    properties: formatJson(edge.properties),
    notes: edge.notes || "",
  };
}

function tagFormFromEntry(name: string, entry: NarrativeGraphTagEntry): TagForm {
  return {
    name,
    category: TAG_CATEGORIES.includes(entry.category as NarrativeGraphTagCategory)
      ? (entry.category as NarrativeGraphTagCategory)
      : "custom",
    description: entry.description || "",
    aliases: formatList(entry.aliases),
    status: entry.status || "active",
  };
}

function nodeRequestFromForm(form: NodeForm): NarrativeGraphNodeRequest | string {
  const label = form.label.trim();
  if (!label) {
    return "node label 不能为空。";
  }
  const importance = parseImportance(form.importance);
  if (typeof importance === "string") {
    return importance;
  }
  const properties = parseProperties(form.properties);
  if (typeof properties === "string") {
    return properties;
  }
  return {
    type: form.type,
    label,
    aliases: parseList(form.aliases),
    summary: form.summary.trim(),
    importance,
    layer: form.layer,
    parent_id: form.parentId.trim() || null,
    status: form.status.trim() || "active",
    tags: form.tags,
    properties,
    notes: form.notes.trim(),
  };
}

function edgeRequestFromForm(form: EdgeForm): NarrativeGraphEdgeRequest | string {
  if (!form.source || !form.target) {
    return "source 和 target 必须选择已有 node。";
  }
  if (form.source === form.target) {
    return "source 和 target 不能相同。";
  }
  const label = form.label.trim();
  if (!label) {
    return "edge label 不能为空。";
  }
  const type = form.type.trim();
  if (!type) {
    return "edge type 不能为空。";
  }
  const importance = parseImportance(form.importance);
  if (typeof importance === "string") {
    return importance;
  }
  const properties = parseProperties(form.properties);
  if (typeof properties === "string") {
    return properties;
  }
  return {
    source: form.source,
    target: form.target,
    type,
    label,
    summary: form.summary.trim(),
    importance,
    layer: form.layer,
    status: form.status.trim() || "active",
    properties,
    notes: form.notes.trim(),
  };
}

export function LibraryPage({ selectedProject, apiStatus }: LibraryPageProps) {
  const [graph, setGraph] = useState<NarrativeGraphDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [activePanel, setActivePanel] = useState<ActiveLibraryPanel>("browse");
  const [tagForm, setTagForm] = useState<TagForm>(DEFAULT_TAG_FORM);
  const [nodeForm, setNodeForm] = useState<NodeForm>(DEFAULT_NODE_FORM);
  const [edgeForm, setEdgeForm] = useState<EdgeForm>(DEFAULT_EDGE_FORM);
  const [editingTagName, setEditingTagName] = useState<string | null>(null);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editingEdgeId, setEditingEdgeId] = useState<string | null>(null);
  const [selectedEntity, setSelectedEntity] = useState<SelectedEntity>(null);
  const [typeFilter, setTypeFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [layerFilter, setLayerFilter] = useState("");
  const [minImportanceFilter, setMinImportanceFilter] = useState("1");
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    let ignore = false;

    async function load(projectRef: string) {
      setLoading(true);
      setLoadError("");
      setActionError("");
      setActionMessage("");
      setGraph(null);
      setSelectedEntity(null);
      setEditingNodeId(null);
      setEditingEdgeId(null);
      setEditingTagName(null);
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
    if (statusFilter && node.status !== statusFilter) {
      return false;
    }
    if (layerFilter && node.layer !== layerFilter) {
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
  const searchResults = useMemo(
    () => (graph ? searchGraph(graph, searchQuery, labels) : []),
    [graph, labels, searchQuery],
  );
  const canWrite = Boolean(selectedProject && graph && apiStatus === "online" && !busyAction);

  function setSuccess(message: string): void {
    setActionError("");
    setActionMessage(message);
  }

  function setFailure(message: string): void {
    setActionMessage("");
    setActionError(message);
  }

  function applyGraph(response: { graph: NarrativeGraphDocument }): void {
    setGraph(updateGraphFromResponse(response));
  }

  function startNodeEdit(node: NarrativeGraphNode): void {
    setNodeForm(nodeFormFromNode(node));
    setEditingNodeId(node.id);
    setActivePanel("node");
    setSelectedEntity({ entityType: "node", id: node.id });
    setActionError("");
    setActionMessage("");
  }

  function startEdgeEdit(edge: NarrativeGraphEdge): void {
    setEdgeForm(edgeFormFromEdge(edge));
    setEditingEdgeId(edge.id);
    setActivePanel("edge");
    setSelectedEntity({ entityType: "edge", id: edge.id });
    setActionError("");
    setActionMessage("");
  }

  function startTagEdit(name: string, entry: NarrativeGraphTagEntry): void {
    setTagForm(tagFormFromEntry(name, entry));
    setEditingTagName(name);
    setActivePanel("tags");
    setActionError("");
    setActionMessage("");
  }

  function resetNodeForm(): void {
    setNodeForm(DEFAULT_NODE_FORM);
    setEditingNodeId(null);
  }

  function resetEdgeForm(): void {
    setEdgeForm(DEFAULT_EDGE_FORM);
    setEditingEdgeId(null);
  }

  function resetTagForm(): void {
    setTagForm(DEFAULT_TAG_FORM);
    setEditingTagName(null);
  }

  async function handleSaveTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProject) {
      return;
    }
    const name = tagForm.name.trim();
    if (!name) {
      setFailure("tag name 不能为空。");
      return;
    }
    const request: NarrativeGraphTagUpdateRequest = {
      category: tagForm.category,
      description: tagForm.description.trim(),
      aliases: parseList(tagForm.aliases),
      status: tagForm.status.trim() || "active",
    };
    setBusyAction("tag-save");
    try {
      const response = editingTagName
        ? await updateNarrativeGraphTag(selectedProject.project_ref, editingTagName, request)
        : await createNarrativeGraphTag(selectedProject.project_ref, {
            name,
            category: tagForm.category,
            description: tagForm.description.trim(),
            aliases: parseList(tagForm.aliases),
          });
      applyGraph(response);
      resetTagForm();
      setSuccess(editingTagName ? "Tag 已更新。" : "Tag 已保存。");
    } catch (error) {
      setFailure(safePublicMessage(error instanceof Error ? error.message : "", "Tag 保存失败。"));
    } finally {
      setBusyAction("");
    }
  }

  async function handleSaveNode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProject) {
      return;
    }
    const request = nodeRequestFromForm(nodeForm);
    if (typeof request === "string") {
      setFailure(request);
      return;
    }
    setBusyAction("node-save");
    try {
      const response = editingNodeId
        ? await updateNarrativeGraphNode(selectedProject.project_ref, editingNodeId, request)
        : await createNarrativeGraphNode(selectedProject.project_ref, request);
      applyGraph(response);
      resetNodeForm();
      setSelectedEntity({ entityType: "node", id: response.node.id });
      setSuccess(editingNodeId ? "Node 已更新。" : "Node 已保存。");
    } catch (error) {
      setFailure(safePublicMessage(error instanceof Error ? error.message : "", "Node 保存失败。"));
    } finally {
      setBusyAction("");
    }
  }

  async function handleSaveEdge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProject) {
      return;
    }
    const request = edgeRequestFromForm(edgeForm);
    if (typeof request === "string") {
      setFailure(request);
      return;
    }
    setBusyAction("edge-save");
    try {
      const response = editingEdgeId
        ? await updateNarrativeGraphEdge(selectedProject.project_ref, editingEdgeId, request)
        : await createNarrativeGraphEdge(selectedProject.project_ref, request);
      applyGraph(response);
      resetEdgeForm();
      setSelectedEntity({ entityType: "edge", id: response.edge.id });
      setSuccess(editingEdgeId ? "Edge 已更新。" : "Edge 已保存。");
    } catch (error) {
      setFailure(safePublicMessage(error instanceof Error ? error.message : "", "Edge 保存失败。"));
    } finally {
      setBusyAction("");
    }
  }

  async function handleDeleteTag(name: string) {
    if (!selectedProject || !graph) {
      return;
    }
    const usedBy = nodes.filter((node) => node.tags.includes(name)).length;
    if (usedBy > 0) {
      setFailure(`Tag is still used by ${usedBy} nodes. 先从节点中移除该 tag，再删除。`);
      return;
    }
    if (!window.confirm(`删除 tag "${name}"？`)) {
      return;
    }
    setBusyAction(`tag-delete-${name}`);
    try {
      const response = await deleteNarrativeGraphTag(selectedProject.project_ref, name);
      applyGraph(response);
      if (editingTagName === name) {
        resetTagForm();
      }
      setSuccess("Tag 已删除。");
    } catch (error) {
      setFailure(safePublicMessage(error instanceof Error ? error.message : "", "Tag 删除失败。"));
    } finally {
      setBusyAction("");
    }
  }

  async function handleDeleteNode(node: NarrativeGraphNode) {
    if (!selectedProject) {
      return;
    }
    const connectedEdges = edges.filter((edge) => edge.source === node.id || edge.target === node.id);
    const message =
      connectedEdges.length > 0
        ? `该节点存在 ${connectedEdges.length} 条关联关系。删除节点将同时删除这些 edge。`
        : `删除 node "${node.label || node.id}"？`;
    if (!window.confirm(message)) {
      return;
    }
    setBusyAction(`node-delete-${node.id}`);
    try {
      const response = await deleteNarrativeGraphNode(selectedProject.project_ref, node.id, {
        deleteEdges: connectedEdges.length > 0,
      });
      applyGraph(response);
      if (selectedEntity?.entityType === "node" && selectedEntity.id === node.id) {
        setSelectedEntity(null);
      }
      if (editingNodeId === node.id) {
        resetNodeForm();
      }
      setSuccess(connectedEdges.length > 0 ? "Node 与关联 edge 已删除。" : "Node 已删除。");
    } catch (error) {
      setFailure(safePublicMessage(error instanceof Error ? error.message : "", "Node 删除失败。"));
    } finally {
      setBusyAction("");
    }
  }

  async function handleDeleteEdge(edge: NarrativeGraphEdge) {
    if (!selectedProject) {
      return;
    }
    if (!window.confirm(`删除 edge "${edge.label || edge.id}"？`)) {
      return;
    }
    setBusyAction(`edge-delete-${edge.id}`);
    try {
      const response = await deleteNarrativeGraphEdge(selectedProject.project_ref, edge.id);
      applyGraph(response);
      if (selectedEntity?.entityType === "edge" && selectedEntity.id === edge.id) {
        setSelectedEntity(null);
      }
      if (editingEdgeId === edge.id) {
        resetEdgeForm();
      }
      setSuccess("Edge 已删除。");
    } catch (error) {
      setFailure(safePublicMessage(error instanceof Error ? error.message : "", "Edge 删除失败。"));
    } finally {
      setBusyAction("");
    }
  }

  function insertNodeTemplate(type: NarrativeGraphNodeType): void {
    const template = PROPERTY_TEMPLATES[type];
    if (!template) {
      return;
    }
    const current = nodeForm.properties.trim();
    if (current && current !== "{}" && !window.confirm("用推荐模板替换当前 properties？")) {
      return;
    }
    setNodeForm((form) => ({ ...form, properties: formatJson(template) }));
  }

  return (
    <section className="workspace-single-page" aria-labelledby="library-title">
      <section className="panel page-intro-panel">
        <span className="section-kicker">Library</span>
        <h1 id="library-title">创作资料库</h1>
        <p>
          Narrative Graph 用于维护人物、场景、物品、伏笔、世界观事实和剧情走向。本阶段支持手动维护、修正和本地规则检索，
          仍不接入章节生成 prompt，也不提供 2D/3D 图谱。
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

            <nav className="library-tab-bar" aria-label="资料库工作区">
              <button
                className={`library-tab ${activePanel === "browse" ? "selected" : ""}`}
                type="button"
                onClick={() => setActivePanel("browse")}
              >
                浏览 / 检索
              </button>
              <button
                className={`library-tab ${activePanel === "node" ? "selected" : ""}`}
                type="button"
                onClick={() => setActivePanel("node")}
              >
                {editingNodeId ? "编辑节点" : "添加节点"}
              </button>
              <button
                className={`library-tab ${activePanel === "edge" ? "selected" : ""}`}
                type="button"
                onClick={() => setActivePanel("edge")}
              >
                {editingEdgeId ? "编辑关系" : "添加关系"}
              </button>
              <button
                className={`library-tab ${activePanel === "tags" ? "selected" : ""}`}
                type="button"
                onClick={() => setActivePanel("tags")}
              >
                标签管理
              </button>
            </nav>

            {activePanel === "browse" && (
              <section className="library-browser-grid" aria-label="创作资料浏览器">
                <section className="panel graph-list-panel library-browser-wide">
                  <div className="panel-header">
                    <div>
                      <span className="section-kicker">Local browser</span>
                      <h2>创作资料浏览器</h2>
                    </div>
                  </div>
                  <label className="form-field">
                    <span>关键词</span>
                    <input
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      placeholder="按 label、alias、tag、summary、property 或关联节点筛选"
                    />
                  </label>
                  <p className="form-note">匹配度是本地规则分，不是语义相似度模型。</p>
                  {searchQuery.trim() && (
                    <div className="search-results">
                      {searchResults.length === 0 && <p className="empty-state">没有匹配结果。</p>}
                      {searchResults.map((result) => (
                        <button
                          className="search-result-item"
                          key={`${result.entityType}-${result.id}`}
                          type="button"
                          onClick={() => setSelectedEntity({ entityType: result.entityType, id: result.id })}
                        >
                          <strong>{result.label}</strong>
                          <span>{result.entityType} · 匹配度 {scoreLevel(result.score)} · score {result.score}</span>
                          <small>原因：{result.reasons.join(" / ")}</small>
                          {result.summary && <p>{result.summary}</p>}
                        </button>
                      ))}
                    </div>
                  )}
                </section>

                <section className="panel graph-list-panel">
                  <div className="panel-header">
                    <div>
                      <span className="section-kicker">Browse</span>
                      <h2>Node 列表</h2>
                    </div>
                  </div>
                  <div className="graph-filter-bar" aria-label="node 筛选">
                    <label className="form-field">
                      <span>type</span>
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
                      <span>layer</span>
                      <select value={layerFilter} onChange={(event) => setLayerFilter(event.target.value)}>
                        <option value="">全部 layer</option>
                        {LAYERS.map((layer) => (
                          <option key={layer} value={layer}>
                            {layer}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="form-field">
                      <span>status</span>
                      <input value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} />
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
                      <span>tag</span>
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
              </section>
            )}

            {activePanel === "node" && (
              <form className="panel graph-form" noValidate onSubmit={(event) => void handleSaveNode(event)}>
                <div className="panel-header">
                  <div>
                    <span className="section-kicker">Node</span>
                    <h2>{editingNodeId ? "编辑 node" : "新增 node"}</h2>
                  </div>
                  {editingNodeId && (
                    <button className="button subtle-button" type="button" onClick={resetNodeForm}>
                      退出编辑
                    </button>
                  )}
                </div>
                <div className="form-grid">
                  <label className="form-field">
                    <span>type</span>
                    <select
                      value={nodeForm.type}
                      onChange={(event) =>
                        setNodeForm((form) => ({ ...form, type: event.target.value as NarrativeGraphNodeType }))
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
                      onChange={(event) => setNodeForm((form) => ({ ...form, label: event.target.value }))}
                      disabled={!canWrite}
                    />
                  </label>
                </div>
                <label className="form-field">
                  <span>summary</span>
                  <textarea
                    value={nodeForm.summary}
                    onChange={(event) => setNodeForm((form) => ({ ...form, summary: event.target.value }))}
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
                      onChange={(event) => setNodeForm((form) => ({ ...form, importance: event.target.value }))}
                      disabled={!canWrite}
                    />
                  </label>
                  <label className="form-field">
                    <span>layer</span>
                    <select
                      value={nodeForm.layer}
                      onChange={(event) =>
                        setNodeForm((form) => ({ ...form, layer: event.target.value as NarrativeGraphLayer }))
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
                    <span>parent_id</span>
                    <select
                      value={nodeForm.parentId}
                      onChange={(event) => setNodeForm((form) => ({ ...form, parentId: event.target.value }))}
                      disabled={!canWrite}
                    >
                      <option value="">无 parent</option>
                      {nodes
                        .filter((node) => node.id !== editingNodeId)
                        .map((node) => (
                          <option key={node.id} value={node.id}>
                            {node.label || node.id}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="form-field">
                    <span>status</span>
                    <input
                      value={nodeForm.status}
                      onChange={(event) => setNodeForm((form) => ({ ...form, status: event.target.value }))}
                      disabled={!canWrite}
                    />
                  </label>
                </div>
                <label className="form-field">
                  <span>aliases（逗号或换行分隔）</span>
                  <input
                    value={nodeForm.aliases}
                    onChange={(event) => setNodeForm((form) => ({ ...form, aliases: event.target.value }))}
                    disabled={!canWrite}
                  />
                </label>
                <label className="form-field">
                  <span>tags（来自 tag registry）</span>
                  <select
                    multiple
                    value={nodeForm.tags}
                    onChange={(event) =>
                      setNodeForm((form) => ({
                        ...form,
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
                <div className="template-buttons">
                  <span>properties 模板</span>
                  {Object.keys(PROPERTY_TEMPLATES).map((type) => (
                    <button
                      className="button subtle-button compact-button"
                      key={type}
                      type="button"
                      onClick={() => insertNodeTemplate(type as NarrativeGraphNodeType)}
                      disabled={!canWrite}
                    >
                      {type}
                    </button>
                  ))}
                </div>
                <label className="form-field">
                  <span>properties JSON object</span>
                  <textarea
                    className="json-field"
                    value={nodeForm.properties}
                    onChange={(event) => setNodeForm((form) => ({ ...form, properties: event.target.value }))}
                    disabled={!canWrite}
                  />
                </label>
                <p className="form-note">
                  tags 是受控分类；aliases 是别名；notes 是自由说明。特殊物品优先使用 current_location、
                  availability_status、defined_functions、narrative_functions。
                </p>
                <label className="form-field">
                  <span>notes</span>
                  <textarea
                    value={nodeForm.notes}
                    onChange={(event) => setNodeForm((form) => ({ ...form, notes: event.target.value }))}
                    disabled={!canWrite}
                  />
                </label>
                <div className="form-actions">
                  <button className="button primary-button" type="submit" disabled={!canWrite}>
                    {editingNodeId ? "更新 node" : "保存 node"}
                  </button>
                </div>
              </form>
            )}

            {activePanel === "edge" && (
              <form className="panel graph-form" noValidate onSubmit={(event) => void handleSaveEdge(event)}>
                <div className="panel-header">
                  <div>
                    <span className="section-kicker">Edge</span>
                    <h2>{editingEdgeId ? "编辑 edge" : "新增 edge"}</h2>
                  </div>
                  {editingEdgeId && (
                    <button className="button subtle-button" type="button" onClick={resetEdgeForm}>
                      退出编辑
                    </button>
                  )}
                </div>
                {nodes.length < 2 && <p className="form-note">至少需要 2 个 node 才能创建 edge。</p>}
                <div className="form-grid">
                  <label className="form-field">
                    <span>source node</span>
                    <select
                      value={edgeForm.source}
                      onChange={(event) => setEdgeForm((form) => ({ ...form, source: event.target.value }))}
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
                      onChange={(event) => setEdgeForm((form) => ({ ...form, target: event.target.value }))}
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
                      onChange={(event) => setEdgeForm((form) => ({ ...form, type: event.target.value }))}
                      disabled={!canWrite}
                    />
                  </label>
                  <label className="form-field">
                    <span>label</span>
                    <input
                      value={edgeForm.label}
                      onChange={(event) => setEdgeForm((form) => ({ ...form, label: event.target.value }))}
                      disabled={!canWrite}
                    />
                  </label>
                </div>
                <label className="form-field">
                  <span>summary</span>
                  <textarea
                    value={edgeForm.summary}
                    onChange={(event) => setEdgeForm((form) => ({ ...form, summary: event.target.value }))}
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
                      onChange={(event) => setEdgeForm((form) => ({ ...form, importance: event.target.value }))}
                      disabled={!canWrite}
                    />
                  </label>
                  <label className="form-field">
                    <span>layer</span>
                    <select
                      value={edgeForm.layer}
                      onChange={(event) =>
                        setEdgeForm((form) => ({ ...form, layer: event.target.value as NarrativeGraphLayer }))
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
                      onChange={(event) => setEdgeForm((form) => ({ ...form, status: event.target.value }))}
                      disabled={!canWrite}
                    />
                  </label>
                </div>
                <label className="form-field">
                  <span>properties JSON object</span>
                  <textarea
                    className="json-field"
                    value={edgeForm.properties}
                    onChange={(event) => setEdgeForm((form) => ({ ...form, properties: event.target.value }))}
                    disabled={!canWrite}
                  />
                </label>
                <label className="form-field">
                  <span>notes</span>
                  <textarea
                    value={edgeForm.notes}
                    onChange={(event) => setEdgeForm((form) => ({ ...form, notes: event.target.value }))}
                    disabled={!canWrite}
                  />
                </label>
                <div className="form-actions">
                  <button className="button primary-button" type="submit" disabled={!canWrite || nodes.length < 2}>
                    {editingEdgeId ? "更新 edge" : "保存 edge"}
                  </button>
                </div>
              </form>
            )}

            {activePanel === "tags" && (
              <section className="library-browser-grid">
                <form className="panel graph-form" noValidate onSubmit={(event) => void handleSaveTag(event)}>
                  <div className="panel-header">
                    <div>
                      <span className="section-kicker">Tag Registry</span>
                      <h2>{editingTagName ? "编辑 tag" : "新增 tag"}</h2>
                    </div>
                    {editingTagName && (
                      <button className="button subtle-button" type="button" onClick={resetTagForm}>
                        退出编辑
                      </button>
                    )}
                  </div>
                  <label className="form-field">
                    <span>tag name</span>
                    <input
                      value={tagForm.name}
                      onChange={(event) => setTagForm((form) => ({ ...form, name: event.target.value }))}
                      disabled={!canWrite || Boolean(editingTagName)}
                    />
                  </label>
                  <label className="form-field">
                    <span>category</span>
                    <select
                      value={tagForm.category}
                      onChange={(event) =>
                        setTagForm((form) => ({
                          ...form,
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
                    <span>status</span>
                    <input
                      value={tagForm.status}
                      onChange={(event) => setTagForm((form) => ({ ...form, status: event.target.value }))}
                      disabled={!canWrite}
                    />
                  </label>
                  <label className="form-field">
                    <span>description</span>
                    <textarea
                      value={tagForm.description}
                      onChange={(event) => setTagForm((form) => ({ ...form, description: event.target.value }))}
                      disabled={!canWrite}
                    />
                  </label>
                  <label className="form-field">
                    <span>aliases（逗号或换行分隔）</span>
                    <input
                      value={tagForm.aliases}
                      onChange={(event) => setTagForm((form) => ({ ...form, aliases: event.target.value }))}
                      disabled={!canWrite}
                    />
                  </label>
                  <div className="form-actions">
                    <button className="button primary-button" type="submit" disabled={!canWrite}>
                      {editingTagName ? "更新 tag" : "保存 tag"}
                    </button>
                  </div>
                </form>

                <section className="panel graph-list-panel">
                  <div className="panel-header">
                    <div>
                      <span className="section-kicker">Tags</span>
                      <h2>Tag Registry</h2>
                    </div>
                  </div>
                  <div className="graph-list">
                    {tagEntries.length === 0 && <p className="empty-state">暂无 tag。创建 node 前可先建立受控分类。</p>}
                    {tagEntries.map(([name, entry]) => {
                      const usedBy = nodes.filter((node) => node.tags.includes(name)).length;
                      return (
                        <article className="tag-registry-item" key={name}>
                          <div className="tag-registry-header">
                            <strong>{name}</strong>
                            <span>{entry.category} · {entry.status || "active"} · used by {usedBy}</span>
                          </div>
                          {entry.description && <p>{entry.description}</p>}
                          {entry.aliases?.length > 0 && <small>aliases: {entry.aliases.join(" / ")}</small>}
                          <div className="inline-actions">
                            <button
                              className="button subtle-button compact-button"
                              type="button"
                              onClick={() => startTagEdit(name, entry)}
                              disabled={!canWrite}
                            >
                              编辑
                            </button>
                            <button
                              className="button danger-button compact-button"
                              type="button"
                              onClick={() => void handleDeleteTag(name)}
                              disabled={!canWrite}
                            >
                              删除
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              </section>
            )}
          </section>

          <EntityInspector
            edge={selectedEdge}
            edges={edges}
            labels={labels}
            node={selectedNode}
            nodes={nodes}
            relatedNodes={inspectorRelatedNodes}
            selectedEntity={selectedEntity}
            onDeleteEdge={(edge) => void handleDeleteEdge(edge)}
            onDeleteNode={(node) => void handleDeleteNode(node)}
            onEditEdge={startEdgeEdit}
            onEditNode={startNodeEdit}
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
  nodes,
  relatedNodes,
  selectedEntity,
  onDeleteEdge,
  onDeleteNode,
  onEditEdge,
  onEditNode,
}: {
  edge: NarrativeGraphEdge | null;
  edges: NarrativeGraphEdge[];
  labels: Map<string, string>;
  node: NarrativeGraphNode | null;
  nodes: NarrativeGraphNode[];
  relatedNodes: NarrativeGraphNode[];
  selectedEntity: SelectedEntity;
  onDeleteEdge: (edge: NarrativeGraphEdge) => void;
  onDeleteNode: (node: NarrativeGraphNode) => void;
  onEditEdge: (edge: NarrativeGraphEdge) => void;
  onEditNode: (node: NarrativeGraphNode) => void;
}) {
  if (!selectedEntity) {
    return (
      <aside className="panel entity-inspector" aria-label="Entity Inspector">
        <span className="section-kicker">Entity Inspector</span>
        <h2>选择 node 或 edge</h2>
        <p>点击列表或检索结果后，这里会展示摘要、标签、properties、一阶关联，以及编辑/删除操作。</p>
      </aside>
    );
  }

  if (node) {
    const linkedEdges = edges.filter((item) => item.source === node.id || item.target === node.id);
    const relatedForeshadowing = relatedNodes.filter((item) => item.id !== node.id && item.type === "foreshadowing");
    const relatedScenes = relatedNodes.filter((item) => item.id !== node.id && item.type === "scene");
    const relatedItems = relatedNodes.filter((item) => item.id !== node.id && item.type === "item");
    return (
      <aside className="panel entity-inspector" aria-label="Entity Inspector">
        <span className="section-kicker">Node Inspector</span>
        <h2>{node.label || node.id}</h2>
        <div className="inspector-actions">
          <button className="button subtle-button compact-button" type="button" onClick={() => onEditNode(node)}>
            编辑
          </button>
          <button className="button danger-button compact-button" type="button" onClick={() => onDeleteNode(node)}>
            删除
          </button>
        </div>
        <dl className="inspector-list">
          <div><dt>id</dt><dd>{node.id}</dd></div>
          <div><dt>type</dt><dd>{node.type}</dd></div>
          <div><dt>importance</dt><dd>{node.importance}</dd></div>
          <div><dt>layer</dt><dd>{node.layer}</dd></div>
          <div><dt>parent_id</dt><dd>{node.parent_id || "-"}</dd></div>
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
        <RelatedGroup title="关联伏笔" nodes={relatedForeshadowing} />
        <RelatedGroup title="关联场景" nodes={relatedScenes} />
        <RelatedGroup title="关联物品" nodes={relatedItems} />
      </aside>
    );
  }

  if (edge) {
    return (
      <aside className="panel entity-inspector" aria-label="Entity Inspector">
        <span className="section-kicker">Edge Inspector</span>
        <h2>{edge.label || edge.id}</h2>
        <div className="inspector-actions">
          <button className="button subtle-button compact-button" type="button" onClick={() => onEditEdge(edge)}>
            编辑
          </button>
          <button className="button danger-button compact-button" type="button" onClick={() => onDeleteEdge(edge)}>
            删除
          </button>
        </div>
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
      <p>当前 graph 共有 {nodes.length} 个 node。</p>
    </aside>
  );
}

function RelatedGroup({ nodes, title }: { nodes: NarrativeGraphNode[]; title: string }) {
  return (
    <section className="inspector-section">
      <h3>{title}</h3>
      {nodes.length === 0 && <p>暂无。</p>}
      {nodes.map((node) => (
        <p key={node.id}>{node.label || node.id}</p>
      ))}
    </section>
  );
}
