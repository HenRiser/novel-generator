import { useEffect, useRef } from "react";
import { Graph } from "@antv/g6";
import type { NarrativeGraphDocument } from "../../types";

type GraphCanvasProps = {
  projectRef: string;
  graph: NarrativeGraphDocument | null;
  loading: boolean;
  onNodeClick: (nodeId: string) => void;
  onNodeDoubleClick: (nodeId: string) => void;
  onBlankClick: () => void;
};

/** 节点类型 → 颜色（暖色系，与主题一致） */
const NODE_COLORS: Record<string, string> = {
  character: "#d85a30",
  scene: "#1d9e75",
  item: "#378add",
  foreshadowing: "#ba7517",
  relationship_note: "#993556",
  plot_direction: "#534ab7",
  world_fact: "#5f5e5a",
  event: "#639922",
  organization: "#185fa5",
};

function nodeColor(type: string): string {
  return NODE_COLORS[type] ?? "#888780";
}

function nodeSizeByImportance(importance: number): number {
  return 32 + Math.min(28, Math.max(0, (importance - 1) * 3));
}

/** G6 v5 的 data 字段是 Record<string, unknown>，这里安全取值 */
function dataField(d: unknown, key: string): string | number | undefined {
  if (!d || typeof d !== "object") {
    return undefined;
  }
  const record = d as Record<string, unknown>;
  if (typeof record.data !== "object" || record.data === null) {
    return undefined;
  }
  const value = (record.data as Record<string, unknown>)[key];
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

/**
 * 叙事图谱画布：G6 v5 渲染，支持拖拽布局、滚轮缩放、点击/双击节点。
 * 只负责可视化；增删改通过回调交给页面调用后端接口。
 */
export default function GraphCanvas({
  projectRef,
  graph,
  loading,
  onNodeClick,
  onNodeDoubleClick,
  onBlankClick,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const callbacksRef = useRef({ onNodeClick, onNodeDoubleClick, onBlankClick });

  // 回调保持最新引用
  useEffect(() => {
    callbacksRef.current = { onNodeClick, onNodeDoubleClick, onBlankClick };
  }, [onNodeClick, onNodeDoubleClick, onBlankClick]);

  // 初始化画布（一次）
  useEffect(() => {
    if (!containerRef.current || graphRef.current) {
      return;
    }

    const graph = new Graph({
      container: containerRef.current,
      autoFit: "view",
      behaviors: ["drag-canvas", "zoom-canvas", "drag-element", "click-select"],
      node: {
        style: {
          labelText: (d: unknown) => String(dataField(d, "label") ?? ""),
          labelPlacement: "bottom",
          labelFill: "#5f4b32",
          labelFontSize: 11,
          fill: (d: unknown) => nodeColor(String(dataField(d, "type") ?? "")),
          stroke: "#ffffff",
          lineWidth: 1.5,
          size: (d: unknown) => nodeSizeByImportance(Number(dataField(d, "importance") ?? 1)),
        },
      },
      edge: {
        style: {
          stroke: "#c8b897",
          lineWidth: 1,
          labelText: (d: unknown) => String(dataField(d, "label") ?? ""),
          labelFontSize: 10,
          labelFill: "#8a7a63",
          labelBackground: true,
          labelBackgroundFill: "#fffdf8",
          endArrow: true,
        },
      },
    });

    graph.on("node:click", (event) => {
      const id = (event as unknown as { target?: { id?: string } }).target?.id;
      if (id) {
        callbacksRef.current.onNodeClick(id);
      }
    });
    graph.on("node:dblclick", (event) => {
      const id = (event as unknown as { target?: { id?: string } }).target?.id;
      if (id) {
        callbacksRef.current.onNodeDoubleClick(id);
      }
    });
    graph.on("canvas:click", () => {
      callbacksRef.current.onBlankClick();
    });

    graphRef.current = graph;
    return () => {
      graph.destroy();
      graphRef.current = null;
    };
  }, []);

  // 数据变化 → 更新画布
  useEffect(() => {
    const g = graphRef.current;
    if (!g || loading) {
      return;
    }

    const nodes = (graph?.graph.nodes ?? []).map((node) => ({
      id: node.id,
      data: node,
    }));
    const edges = (graph?.graph.edges ?? []).map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      data: edge,
    }));

    g.setData({ nodes, edges });
    void g.render().then(() => {
      g.fitView();
    });
  }, [graph, loading, projectRef]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: 560,
        borderRadius: 8,
        border: "1px solid #e6dccb",
        background: "#fffdf8",
        overflow: "hidden",
      }}
    />
  );
}
