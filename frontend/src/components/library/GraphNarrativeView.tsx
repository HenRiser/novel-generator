import { useMemo, useState } from "react";
import type { NarrativeGraphEdge, NarrativeGraphNode } from "../../types";

type SelectedEntity =
  | { entityType: "node"; id: string }
  | { entityType: "edge"; id: string }
  | null;

type GraphNarrativeViewProps = {
  edges: NarrativeGraphEdge[];
  nodes: NarrativeGraphNode[];
  selectedEntity: SelectedEntity;
  onSelectEntity: (entity: SelectedEntity) => void;
};

type NodeSection = {
  key: string;
  title: string;
  description: string;
  nodes: NarrativeGraphNode[];
};

type GraphTypeFilter =
  | "all"
  | "character"
  | "events"
  | "foreshadowing"
  | "world_fact"
  | "plot_direction"
  | "relationship_note"
  | "other"
  | "relationships";

type ImportanceFilter = "all" | "gte5" | "gte8" | "high";
type StatusFilter = "all" | "confirmed" | "planned" | "active" | "deprecated" | "unknown";
type LayerFilter = "all" | "core" | "major" | "detail" | "background" | "unknown";

const NODE_TYPE_LABELS: Record<string, string> = {
  character: "人物",
  event: "事件",
  scene: "场景",
  foreshadowing: "伏笔",
  world_fact: "世界规则",
  plot_direction: "剧情方向",
  relationship_note: "关系备注",
  item: "物品",
  organization: "组织",
};

const EDGE_TYPE_LABELS: Record<string, string> = {
  appears_in: "出现在",
  causes: "导致",
  leads_to: "引向",
  reveals: "揭示",
  foreshadows: "埋下伏笔",
  monitors: "监视",
  constrains: "限制",
  protects: "保护",
  threatens: "威胁",
  located_at: "位于",
  related_to: "相关",
  changes_status_of: "改变状态",
};

const STATUS_LABELS: Record<string, string> = {
  active: "活跃",
  confirmed: "已确认",
  planned: "计划中",
  draft: "草稿",
  deprecated: "已废弃",
  completed: "已完成",
};

const LAYER_LABELS: Record<string, string> = {
  core: "核心",
  major: "主要",
  detail: "细节",
  background: "背景",
};

const TYPE_FILTERS: Array<{ label: string; value: GraphTypeFilter }> = [
  { label: "全部", value: "all" },
  { label: "人物", value: "character" },
  { label: "事件 / 场景", value: "events" },
  { label: "伏笔", value: "foreshadowing" },
  { label: "世界规则", value: "world_fact" },
  { label: "剧情方向", value: "plot_direction" },
  { label: "关系备注", value: "relationship_note" },
  { label: "其他", value: "other" },
  { label: "关系", value: "relationships" },
];

const IMPORTANCE_FILTERS: Array<{ label: string; value: ImportanceFilter }> = [
  { label: "全部重要度", value: "all" },
  { label: "重要度 >= 5", value: "gte5" },
  { label: "只看重要资料 >= 8", value: "gte8" },
  { label: "核心 / 高优先级", value: "high" },
];

const STATUS_FILTERS: Array<{ label: string; value: StatusFilter }> = [
  { label: "全部状态", value: "all" },
  { label: "已确认", value: "confirmed" },
  { label: "计划中", value: "planned" },
  { label: "活跃", value: "active" },
  { label: "废弃 / 过期", value: "deprecated" },
  { label: "未知状态", value: "unknown" },
];

const LAYER_FILTERS: Array<{ label: string; value: LayerFilter }> = [
  { label: "全部层级", value: "all" },
  { label: "核心", value: "core" },
  { label: "主要", value: "major" },
  { label: "细节", value: "detail" },
  { label: "背景", value: "background" },
  { label: "未知层级", value: "unknown" },
];

function readableNodeType(type: string): string {
  return NODE_TYPE_LABELS[type] || type || "其他";
}

function readableEdgeType(type: string): string {
  return EDGE_TYPE_LABELS[type] || type || "关系";
}

function readableStatus(status: string | undefined): string {
  if (!status) {
    return "未标注";
  }
  return STATUS_LABELS[status] || status;
}

function readableLayer(layer: string | undefined): string {
  if (!layer) {
    return "未标注";
  }
  return LAYER_LABELS[layer] || layer;
}

function nodeSummary(node: NarrativeGraphNode): string {
  return node.summary || node.notes || "暂无摘要。";
}

function edgeSummary(edge: NarrativeGraphEdge): string {
  return edge.summary || edge.notes || "暂无关系说明。";
}

function relationCount(node: NarrativeGraphNode, edges: NarrativeGraphEdge[]): number {
  return edges.filter((edge) => edge.source === node.id || edge.target === node.id).length;
}

function sortByImportance<T extends { importance: number; label?: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    const importanceDiff = Number(right.importance || 0) - Number(left.importance || 0);
    if (importanceDiff !== 0) {
      return importanceDiff;
    }
    return String(left.label || "").localeCompare(String(right.label || ""));
  });
}

function groupedNodeSections(nodes: NarrativeGraphNode[]): NodeSection[] {
  const byType = new Map<string, NarrativeGraphNode[]>();
  for (const node of nodes) {
    const type = node.type || "other";
    byType.set(type, [...(byType.get(type) || []), node]);
  }

  const sections: NodeSection[] = [
    {
      key: "characters",
      title: "人物",
      description: "主要角色、观察者、组织成员和其他会影响剧情的人。",
      nodes: byType.get("character") || [],
    },
    {
      key: "events",
      title: "事件 / 场景",
      description: "已经发生的关键事件，以及可被后续章节复用的场景。",
      nodes: [...(byType.get("event") || []), ...(byType.get("scene") || [])],
    },
    {
      key: "foreshadowing",
      title: "伏笔",
      description: "尚未回收、正在强化或已经揭示的叙事钩子。",
      nodes: byType.get("foreshadowing") || [],
    },
    {
      key: "world_facts",
      title: "世界规则",
      description: "时间线、组织规则、限制条件和稳定设定。",
      nodes: byType.get("world_fact") || [],
    },
    {
      key: "plot_directions",
      title: "剧情方向 / 计划",
      description: "下一阶段可能推进的剧情方向和 planned 设定。",
      nodes: byType.get("plot_direction") || [],
    },
    {
      key: "relationship_notes",
      title: "关系备注",
      description: "人物之间、人物与事件之间的关系状态变化。",
      nodes: byType.get("relationship_note") || [],
    },
  ];

  const handledTypes = new Set([
    "character",
    "event",
    "scene",
    "foreshadowing",
    "world_fact",
    "plot_direction",
    "relationship_note",
  ]);
  const otherNodes = nodes.filter((node) => !handledTypes.has(node.type || ""));
  sections.push({
    key: "other",
    title: "其他",
    description: "物品、组织或尚未归类的故事资产。",
    nodes: otherNodes,
  });

  return sections.map((section) => ({ ...section, nodes: sortByImportance(section.nodes) }));
}

function groupEdgesByType(edges: NarrativeGraphEdge[]): Array<[string, NarrativeGraphEdge[]]> {
  const groups = new Map<string, NarrativeGraphEdge[]>();
  for (const edge of edges) {
    const type = edge.type || "related_to";
    groups.set(type, [...(groups.get(type) || []), edge]);
  }
  return Array.from(groups.entries()).sort(([left], [right]) =>
    readableEdgeType(left).localeCompare(readableEdgeType(right)),
  );
}

function nodeLabel(nodeById: Map<string, NarrativeGraphNode>, nodeId: string): string {
  const node = nodeById.get(nodeId);
  return node?.label || "未知节点";
}

function normalizeSearch(value: unknown): string {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function stringIncludesQuery(value: unknown, query: string): boolean {
  if (!query) {
    return true;
  }
  return normalizeSearch(value).includes(query);
}

function nodeCategory(node: NarrativeGraphNode): GraphTypeFilter {
  if (node.type === "event" || node.type === "scene") {
    return "events";
  }
  if (
    node.type === "character" ||
    node.type === "foreshadowing" ||
    node.type === "world_fact" ||
    node.type === "plot_direction" ||
    node.type === "relationship_note"
  ) {
    return node.type;
  }
  return "other";
}

function sectionKeyForTypeFilter(typeFilter: GraphTypeFilter): string | null {
  if (typeFilter === "character") {
    return "characters";
  }
  if (typeFilter === "events") {
    return "events";
  }
  if (typeFilter === "foreshadowing") {
    return "foreshadowing";
  }
  if (typeFilter === "world_fact") {
    return "world_facts";
  }
  if (typeFilter === "plot_direction") {
    return "plot_directions";
  }
  if (typeFilter === "relationship_note") {
    return "relationship_notes";
  }
  if (typeFilter === "other") {
    return "other";
  }
  return null;
}

function hasKnownImportance(importance: number): boolean {
  const value = Number(importance);
  return Number.isFinite(value) && value > 0;
}

function matchesImportance(
  item: { importance: number; layer?: string },
  importanceFilter: ImportanceFilter,
): boolean {
  const value = Number(item.importance || 0);
  const known = hasKnownImportance(item.importance);
  if (importanceFilter === "all") {
    return true;
  }
  if (importanceFilter === "gte5") {
    return !known || value >= 5;
  }
  if (importanceFilter === "gte8") {
    return known && value >= 8;
  }
  return item.layer === "core" || (known && value >= 8);
}

function matchesStatus(item: { status?: string }, statusFilter: StatusFilter): boolean {
  if (statusFilter === "all") {
    return true;
  }
  const status = item.status || "";
  if (statusFilter === "unknown") {
    return !status || !(status in STATUS_LABELS);
  }
  if (statusFilter === "deprecated") {
    return status === "deprecated";
  }
  return status === statusFilter;
}

function matchesLayer(item: { layer?: string }, layerFilter: LayerFilter): boolean {
  if (layerFilter === "all") {
    return true;
  }
  const layer = item.layer || "";
  if (layerFilter === "unknown") {
    return !layer || !(layer in LAYER_LABELS);
  }
  return layer === layerFilter;
}

function matchesNodeSearch(node: NarrativeGraphNode, query: string): boolean {
  if (!query) {
    return true;
  }
  return [
    node.label,
    node.summary,
    node.notes,
    node.type,
    readableNodeType(node.type),
    node.status,
    readableStatus(node.status),
    node.layer,
    readableLayer(node.layer),
    ...(node.aliases || []),
    ...(node.tags || []),
  ].some((value) => stringIncludesQuery(value, query));
}

function matchesEdgeSearch(
  edge: NarrativeGraphEdge,
  nodeById: Map<string, NarrativeGraphNode>,
  query: string,
): boolean {
  if (!query) {
    return true;
  }
  return [
    edge.label,
    edge.summary,
    edge.notes,
    edge.type,
    readableEdgeType(edge.type),
    edge.status,
    readableStatus(edge.status),
    edge.layer,
    readableLayer(edge.layer),
    nodeLabel(nodeById, edge.source),
    nodeLabel(nodeById, edge.target),
  ].some((value) => stringIncludesQuery(value, query));
}

function matchesTypeFilter(node: NarrativeGraphNode, typeFilter: GraphTypeFilter): boolean {
  if (typeFilter === "all") {
    return true;
  }
  if (typeFilter === "relationships") {
    return false;
  }
  return nodeCategory(node) === typeFilter;
}

function optionLabel<T extends string>(options: Array<{ label: string; value: T }>, value: T): string {
  return options.find((option) => option.value === value)?.label || value;
}

export function GraphNarrativeView({
  edges,
  nodes,
  selectedEntity,
  onSelectEntity,
}: GraphNarrativeViewProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<GraphTypeFilter>("all");
  const [importanceFilter, setImportanceFilter] = useState<ImportanceFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [layerFilter, setLayerFilter] = useState<LayerFilter>("all");

  const trimmedQuery = normalizeSearch(searchQuery);
  const hasActiveFilters =
    Boolean(trimmedQuery) ||
    typeFilter !== "all" ||
    importanceFilter !== "all" ||
    statusFilter !== "all" ||
    layerFilter !== "all";

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const filteredNodes = useMemo(
    () =>
      nodes.filter(
        (node) =>
          matchesNodeSearch(node, trimmedQuery) &&
          matchesTypeFilter(node, typeFilter) &&
          matchesImportance(node, importanceFilter) &&
          matchesStatus(node, statusFilter) &&
          matchesLayer(node, layerFilter),
      ),
    [importanceFilter, layerFilter, nodes, statusFilter, trimmedQuery, typeFilter],
  );
  const filteredNodeIds = useMemo(() => new Set(filteredNodes.map((node) => node.id)), [filteredNodes]);
  const filteredEdges = useMemo(
    () =>
      edges.filter((edge) => {
        if (
          !matchesImportance(edge, importanceFilter) ||
          !matchesStatus(edge, statusFilter) ||
          !matchesLayer(edge, layerFilter)
        ) {
          return false;
        }

        const sourceNode = nodeById.get(edge.source);
        const targetNode = nodeById.get(edge.target);
        const edgeTextMatch = matchesEdgeSearch(edge, nodeById, trimmedQuery);
        const linkedVisibleNode = filteredNodeIds.has(edge.source) || filteredNodeIds.has(edge.target);

        if (typeFilter === "relationships") {
          return edgeTextMatch;
        }
        if (typeFilter === "all") {
          return trimmedQuery ? edgeTextMatch || linkedVisibleNode : true;
        }

        const linkedSelectedType =
          (sourceNode && matchesTypeFilter(sourceNode, typeFilter)) ||
          (targetNode && matchesTypeFilter(targetNode, typeFilter));
        return linkedVisibleNode || (Boolean(trimmedQuery) && edgeTextMatch && linkedSelectedType);
      }),
    [
      edges,
      filteredNodeIds,
      importanceFilter,
      layerFilter,
      nodeById,
      statusFilter,
      trimmedQuery,
      typeFilter,
    ],
  );

  const sections = useMemo(() => {
    const grouped = groupedNodeSections(filteredNodes);
    if (!hasActiveFilters) {
      return grouped;
    }
    const selectedSectionKey = sectionKeyForTypeFilter(typeFilter);
    return grouped.filter((section) => {
      if (selectedSectionKey) {
        return section.key === selectedSectionKey;
      }
      return section.nodes.length > 0;
    });
  }, [filteredNodes, hasActiveFilters, typeFilter]);
  const edgeGroups = useMemo(() => groupEdgesByType(filteredEdges), [filteredEdges]);
  const activeFilterLabels = [
    trimmedQuery ? `关键词“${searchQuery.trim()}”` : "",
    typeFilter !== "all" ? optionLabel(TYPE_FILTERS, typeFilter) : "",
    importanceFilter !== "all" ? optionLabel(IMPORTANCE_FILTERS, importanceFilter) : "",
    statusFilter !== "all" ? optionLabel(STATUS_FILTERS, statusFilter) : "",
    layerFilter !== "all" ? optionLabel(LAYER_FILTERS, layerFilter) : "",
  ].filter(Boolean);
  const noFilteredResults = hasActiveFilters && filteredNodes.length === 0 && filteredEdges.length === 0;

  function clearFilters() {
    setSearchQuery("");
    setTypeFilter("all");
    setImportanceFilter("all");
    setStatusFilter("all");
    setLayerFilter("all");
  }

  return (
    <section className="graph-narrative-view" aria-label="Graph Narrative View">
      <section className="panel graph-narrative-intro">
        <div className="panel-header">
          <div>
            <span className="section-kicker">Narrative View</span>
            <h2>故事资料地图</h2>
          </div>
        </div>
        <p>
          这里按创作语义组织 Graph：人物、事件、伏笔、世界规则和关系。
          结构化 node / edge 数据仍保留在 Raw / Technical View。
        </p>
      </section>

      <section className="panel graph-filter-panel" aria-label="Graph filters">
        <div className="panel-header">
          <div>
            <span className="section-kicker">Filter / Search</span>
            <h3>查找故事资料</h3>
          </div>
          <button
            className="button subtle-button compact-button"
            disabled={!hasActiveFilters}
            type="button"
            onClick={clearFilters}
          >
            清除筛选
          </button>
        </div>

        <label className="form-field graph-search-field">
          <span>关键词</span>
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="搜索人物、事件、伏笔、世界规则或关系……"
          />
        </label>

        <div className="graph-filter-chip-row" aria-label="类型筛选">
          {TYPE_FILTERS.map((option) => (
            <button
              className={`filter-chip ${typeFilter === option.value ? "selected" : ""}`}
              key={option.value}
              type="button"
              onClick={() => setTypeFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="graph-filter-select-grid">
          <label className="form-field">
            <span>重要度</span>
            <select
              value={importanceFilter}
              onChange={(event) => setImportanceFilter(event.target.value as ImportanceFilter)}
            >
              {IMPORTANCE_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span>状态</span>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
              {STATUS_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span>层级</span>
            <select value={layerFilter} onChange={(event) => setLayerFilter(event.target.value as LayerFilter)}>
              {LAYER_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="graph-filter-summary">
          <strong>
            当前显示：{filteredNodes.length} 条资料，{filteredEdges.length} 条关系
          </strong>
          {activeFilterLabels.length > 0 && <span>已筛选：{activeFilterLabels.join(" · ")}</span>}
          {typeFilter !== "all" && typeFilter !== "relationships" && filteredEdges.length > 0 && (
            <span>已显示与当前筛选结果相关的关系。</span>
          )}
        </div>
      </section>

      {nodes.length === 0 && (
        <p className="empty-state">
          当前还没有故事资产。生成章节并完成 Story Delta / Review & Merge 后，
          这里会出现人物、事件、伏笔和世界规则。
        </p>
      )}

      {noFilteredResults && (
        <p className="empty-state">没有找到匹配的故事资料。可以尝试清除筛选，或换一个关键词。</p>
      )}

      <section className="graph-narrative-sections">
        {sections.map((section) => (
          <section className="panel graph-narrative-section" key={section.key}>
            <div className="panel-header">
              <div>
                <span className="section-kicker">{section.nodes.length} items</span>
                <h3>{section.title}</h3>
              </div>
            </div>
            <p className="section-note">{section.description}</p>
            {section.nodes.length === 0 && <p className="empty-state">暂无记录。</p>}
            <div className="graph-narrative-card-grid">
              {section.nodes.map((node) => {
                const linkedCount = relationCount(node, edges);
                const selected = selectedEntity?.entityType === "node" && selectedEntity.id === node.id;
                return (
                  <article className={`narrative-node-card ${selected ? "selected" : ""}`} key={node.id}>
                    <button type="button" onClick={() => onSelectEntity({ entityType: "node", id: node.id })}>
                      <span>{readableNodeType(node.type)}</span>
                      <strong>{node.label || node.id}</strong>
                    </button>
                    <p>{nodeSummary(node)}</p>
                    <dl className="narrative-card-meta">
                      <div>
                        <dt>重要度</dt>
                        <dd>{node.importance || "-"}</dd>
                      </div>
                      <div>
                        <dt>状态</dt>
                        <dd>{readableStatus(node.status)}</dd>
                      </div>
                      <div>
                        <dt>层级</dt>
                        <dd>{readableLayer(node.layer)}</dd>
                      </div>
                      <div>
                        <dt>关联关系</dt>
                        <dd>{linkedCount}</dd>
                      </div>
                    </dl>
                    <details className="debug-details">
                      <summary>调试信息 / Debug</summary>
                      <pre className="json-snippet">{JSON.stringify(node, null, 2)}</pre>
                    </details>
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </section>

      <section className="panel graph-narrative-section">
        <div className="panel-header">
          <div>
            <span className="section-kicker">{filteredEdges.length} relationships</span>
            <h3>关系</h3>
          </div>
        </div>
        {filteredEdges.length === 0 && (
          <p className="empty-state">
            {hasActiveFilters
              ? "当前筛选结果没有相关叙事关系。"
              : "当前还没有记录关系。随着你接受人物、事件、伏笔之间的关系候选，这里会形成故事关系网。"}
          </p>
        )}
        {edgeGroups.map(([type, group]) => (
          <section className="relationship-group" key={type}>
            <h4>{readableEdgeType(type)}</h4>
            <div className="relationship-list">
              {sortByImportance(group).map((edge) => {
                const selected = selectedEntity?.entityType === "edge" && selectedEntity.id === edge.id;
                return (
                  <article className={`relationship-card ${selected ? "selected" : ""}`} key={edge.id}>
                    <button
                      className="narrative-relation-button"
                      type="button"
                      onClick={() => onSelectEntity({ entityType: "edge", id: edge.id })}
                    >
                      <strong>{nodeLabel(nodeById, edge.source)}</strong>
                      <span>--{edge.label || readableEdgeType(edge.type)}--&gt;</span>
                      <strong>{nodeLabel(nodeById, edge.target)}</strong>
                    </button>
                    <p>{edgeSummary(edge)}</p>
                    <dl className="narrative-card-meta compact">
                      <div>
                        <dt>重要度</dt>
                        <dd>{edge.importance || "-"}</dd>
                      </div>
                      <div>
                        <dt>状态</dt>
                        <dd>{readableStatus(edge.status)}</dd>
                      </div>
                      <div>
                        <dt>层级</dt>
                        <dd>{readableLayer(edge.layer)}</dd>
                      </div>
                    </dl>
                    <details className="debug-details">
                      <summary>调试信息 / Debug</summary>
                      <pre className="json-snippet">{JSON.stringify(edge, null, 2)}</pre>
                    </details>
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </section>
    </section>
  );
}
