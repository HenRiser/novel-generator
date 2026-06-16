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

function readableNodeType(type: string): string {
  return NODE_TYPE_LABELS[type] || type || "其他";
}

function readableEdgeType(type: string): string {
  return EDGE_TYPE_LABELS[type] || type || "关系";
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

export function GraphNarrativeView({
  edges,
  nodes,
  selectedEntity,
  onSelectEntity,
}: GraphNarrativeViewProps) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const sections = groupedNodeSections(nodes);
  const edgeGroups = groupEdgesByType(edges);

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

      {nodes.length === 0 && (
        <p className="empty-state">
          当前还没有故事资产。生成章节并完成 Story Delta / Review & Merge 后，
          这里会出现人物、事件、伏笔和世界规则。
        </p>
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
                        <dd>{node.status || "active"}</dd>
                      </div>
                      <div>
                        <dt>层级</dt>
                        <dd>{node.layer || "detail"}</dd>
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
            <span className="section-kicker">{edges.length} relationships</span>
            <h3>关系</h3>
          </div>
        </div>
        {edges.length === 0 && (
          <p className="empty-state">
            当前还没有记录关系。随着你接受人物、事件、伏笔之间的关系候选，
            这里会形成故事关系网。
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
                    <button type="button" onClick={() => onSelectEntity({ entityType: "edge", id: edge.id })}>
                      <strong>
                        {nodeLabel(nodeById, edge.source)} --{edge.label || readableEdgeType(edge.type)}--&gt;{" "}
                        {nodeLabel(nodeById, edge.target)}
                      </strong>
                    </button>
                    <p>{edgeSummary(edge)}</p>
                    <dl className="narrative-card-meta compact">
                      <div>
                        <dt>重要度</dt>
                        <dd>{edge.importance || "-"}</dd>
                      </div>
                      <div>
                        <dt>状态</dt>
                        <dd>{edge.status || "active"}</dd>
                      </div>
                      <div>
                        <dt>层级</dt>
                        <dd>{edge.layer || "detail"}</dd>
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
