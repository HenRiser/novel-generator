import type { ContextPack, ContextPackEdge, ContextPackNode } from "../types";

type ContextPackCreatorPreviewProps = {
  pack: ContextPack;
  promptExpanded: boolean;
  promptText: string;
  onTogglePrompt: () => void;
};

type NodeSection = {
  key: string;
  title: string;
  description: string;
  nodes: ContextPackNode[];
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

function nodeSummary(node: ContextPackNode): string {
  return node.summary || node.notes || "暂无摘要。";
}

function edgeSummary(edge: ContextPackEdge): string {
  return edge.summary || edge.notes || "暂无关系说明。";
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

function uniqueNodes(nodes: ContextPackNode[]): ContextPackNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.id)) {
      return false;
    }
    seen.add(node.id);
    return true;
  });
}

function nodeSections(pack: ContextPack): NodeSection[] {
  const sections: NodeSection[] = [
    {
      key: "characters",
      title: "本章将参考的人物",
      description: "会影响下一章行动、视角、关系判断的人物。",
      nodes: uniqueNodes(pack.sections.characters || []),
    },
    {
      key: "events",
      title: "本章将参考的事件 / 场景",
      description: "下一章可能承接或回避的关键事件与场景。",
      nodes: uniqueNodes([...(pack.sections.events || []), ...(pack.sections.scenes || [])]),
    },
    {
      key: "foreshadowing",
      title: "本章将参考的伏笔",
      description: "可能继续埋设、推进或回收的叙事钩子。",
      nodes: uniqueNodes(pack.sections.foreshadowing || []),
    },
    {
      key: "world_facts",
      title: "本章将参考的世界规则",
      description: "下一章不能违背的规则、限制和稳定设定。",
      nodes: uniqueNodes([...(pack.sections.core_facts || []), ...(pack.sections.world_facts || [])]),
    },
    {
      key: "plot_directions",
      title: "本章将参考的剧情方向",
      description: "当前处于 planned 或下一阶段可推进的方向。",
      nodes: uniqueNodes(pack.sections.plot_directions || []),
    },
  ];

  const displayed = new Set(sections.flatMap((section) => section.nodes.map((node) => node.id)));
  const otherNodes = uniqueNodes(pack.selected_nodes.filter((node) => !displayed.has(node.id)));
  sections.push({
    key: "other",
    title: "其他参考资料",
    description: "物品、组织或尚未归入上述分区的上下文。",
    nodes: otherNodes,
  });

  return sections.map((section) => ({ ...section, nodes: sortByImportance(section.nodes) }));
}

function importantReminders(pack: ContextPack): Array<{ id: string; title: string; text: string }> {
  const nodeReminders = pack.selected_nodes
    .filter((node) => Number(node.importance || 0) >= 8)
    .map((node) => ({
      id: `node:${node.id}`,
      title: node.label || node.id,
      text: nodeSummary(node),
    }));
  const edgeReminders = pack.selected_edges
    .filter((edge) => Number(edge.importance || 0) >= 8)
    .map((edge) => ({
      id: `edge:${edge.id}`,
      title: `${edge.source_label || "未知节点"} --${edge.label || readableEdgeType(edge.type)}--> ${
        edge.target_label || "未知节点"
      }`,
      text: edgeSummary(edge),
    }));

  return [...nodeReminders, ...edgeReminders].slice(0, 8);
}

export function ContextPackCreatorPreview({
  pack,
  promptExpanded,
  promptText,
  onTogglePrompt,
}: ContextPackCreatorPreviewProps) {
  const sections = nodeSections(pack);
  const reminders = importantReminders(pack);
  const hasContent = pack.selected_nodes.length > 0 || pack.selected_edges.length > 0;

  return (
    <div className="context-pack-preview">
      <section className="context-pack-creator-summary">
        <div>
          <span>选中资料</span>
          <strong>{pack.stats.nodes_selected}</strong>
          <small>候选 {pack.stats.nodes_considered}</small>
        </div>
        <div>
          <span>选中关系</span>
          <strong>{pack.stats.edges_selected}</strong>
          <small>候选 {pack.stats.edges_considered}</small>
        </div>
        <div>
          <span>最低重要度</span>
          <strong>{pack.options.min_importance}</strong>
          <small>高于阈值优先进入上下文</small>
        </div>
        <div>
          <span>关系邻居</span>
          <strong>{pack.options.include_neighbors ? "已包含" : "未包含"}</strong>
          <small>用于补齐一阶关联</small>
        </div>
      </section>

      {!hasContent && (
        <p className="empty-state">
          当前上下文包为空。生成章节、运行 Story Delta，并接受有价值的 Knowledge Draft 后，
          这里会显示人物、事件、伏笔、世界规则和叙事关系。
        </p>
      )}

      <p className="context-pack-freshness-note">
        系统暂时无法判断这个上下文包是否是最新状态。你仍然可以预览和使用它；
        如果刚刚审核过 Knowledge Draft，建议重新生成一次 Context Pack。
      </p>

      {pack.warnings.length > 0 && (
        <section className="context-pack-warnings">
          {pack.warnings.map((warning) => (
            <p key={warning} className="state-text warning-text">
              {warning}
            </p>
          ))}
        </section>
      )}

      {reminders.length > 0 && (
        <section className="context-pack-section">
          <div className="context-pack-section-heading">
            <h3>关键约束 / 高优先级提醒</h3>
            <span>{reminders.length} items</span>
          </div>
          <div className="context-pack-card-list">
            {reminders.map((reminder) => (
              <article className="context-pack-reminder" key={reminder.id}>
                <strong>{reminder.title}</strong>
                <p>{reminder.text}</p>
              </article>
            ))}
          </div>
        </section>
      )}

      {sections.map((section) => (
        <section className="context-pack-section" key={section.key}>
          <div className="context-pack-section-heading">
            <div>
              <h3>{section.title}</h3>
              <p>{section.description}</p>
            </div>
            <span>{section.nodes.length} items</span>
          </div>
          {section.nodes.length === 0 && <p className="empty-state">暂无记录。</p>}
          <div className="context-pack-card-list">
            {section.nodes.map((node) => (
              <article className="context-pack-creator-card" key={node.id}>
                <div>
                  <span>{readableNodeType(node.type)}</span>
                  <strong>{node.label || node.id}</strong>
                </div>
                <p>{nodeSummary(node)}</p>
                <dl className="context-pack-meta">
                  <div>
                    <dt>重要度</dt>
                    <dd>{node.importance || "未标注"}</dd>
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
                    <dt>选择原因</dt>
                    <dd>{node.reasons.length ? node.reasons.join(" / ") : "未记录"}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        </section>
      ))}

      <section className="context-pack-section">
        <div className="context-pack-section-heading">
          <div>
            <h3>本章将参考的叙事关系</h3>
            <p>这些关系会进入下一章上下文，帮助章节承接人物、事件和规则之间的联系。</p>
          </div>
          <span>{pack.selected_edges.length} relationships</span>
        </div>
        {pack.selected_edges.length === 0 && <p className="empty-state">当前上下文包没有选中叙事关系。</p>}
        <div className="context-pack-card-list">
          {sortByImportance(pack.selected_edges).map((edge) => (
            <article className="context-pack-relationship-card" key={edge.id}>
              <div className="context-pack-relation-line">
                <strong>{edge.source_label || "未知节点"}</strong>
                <span>--{edge.label || readableEdgeType(edge.type)}--&gt;</span>
                <strong>{edge.target_label || "未知节点"}</strong>
              </div>
              <p>{edgeSummary(edge)}</p>
              <dl className="context-pack-meta">
                <div>
                  <dt>关系</dt>
                  <dd>{readableEdgeType(edge.type)}</dd>
                </div>
                <div>
                  <dt>重要度</dt>
                  <dd>{edge.importance || "未标注"}</dd>
                </div>
                <div>
                  <dt>状态</dt>
                  <dd>{readableStatus(edge.status)}</dd>
                </div>
                <div>
                  <dt>选择原因</dt>
                  <dd>{edge.reasons.length ? edge.reasons.join(" / ") : "未记录"}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      </section>

      <details className="context-pack-raw-details" open={promptExpanded}>
        <summary onClick={(event) => {
          event.preventDefault();
          onTogglePrompt();
        }}>
          原始 Prompt / Debug
        </summary>
        {promptExpanded && (
          <pre className="context-pack-prompt">{promptText || "当前 context pack 为空，未生成 prompt_text。"}</pre>
        )}
      </details>
    </div>
  );
}
