import { useEffect, useRef, useState } from "react";
import { Alert, Button, Space, Tooltip } from "antd";
import { FullscreenOutlined, MinusOutlined, PlusOutlined } from "@ant-design/icons";
import type { Graph } from "@antv/g6";
import type { NarrativeGraphDocument } from "../../types";

type GraphCanvasProps = {
  projectRef: string; graph: NarrativeGraphDocument | null; loading: boolean;
  selectedNodeId?: string | null;
  onNodeClick: (nodeId: string) => void; onNodeDoubleClick: (nodeId: string) => void; onBlankClick: () => void;
};
export const NODE_COLORS: Record<string, string> = {
  character: "#326451", scene: "#809987", item: "#7390a1", foreshadowing: "#bd6d45",
  relationship_note: "#957980", plot_direction: "#8481a0", world_fact: "#9b9376", event: "#b89856", organization: "#496777",
};
function dataField(value: unknown, key: string): string | number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = (value as { data?: Record<string, unknown> }).data;
  return typeof data?.[key] === "string" || typeof data?.[key] === "number" ? data[key] as string | number : undefined;
}

export default function GraphCanvas({ projectRef, graph, loading, selectedNodeId, onNodeClick, onNodeDoubleClick, onBlankClick }: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const callbacks = useRef({ onNodeClick, onNodeDoubleClick, onBlankClick });
  callbacks.current = { onNodeClick, onNodeDoubleClick, onBlankClick };
  const [ready, setReady] = useState(false);
  const [renderError, setRenderError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let instance: Graph | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let resizeFrame = 0;
    setReady(false); setRenderError("");
    if (!graph || !containerRef.current) return;
    async function mountGraph() {
      try {
        // 图谱库只在进入画布时加载，不占用首屏和开场动画的加载预算。
        const { Graph: GraphConstructor } = await import("@antv/g6");
        if (cancelled || !containerRef.current) return;
        const container = containerRef.current;
        instance = new GraphConstructor({
          container, width: container.clientWidth, height: container.clientHeight,
          padding: 50, autoFit: "view", animation: false,
          layout: { type: "d3-force", manyBody: { strength: -340 }, link: { distance: 165 }, collide: { radius: 46 } },
          behaviors: ["drag-canvas", "zoom-canvas", "drag-element"],
          node: { style: {
            labelText: (d: unknown) => String(dataField(d, "label") ?? ""), labelPlacement: "bottom", labelOffsetY: 10,
            labelFill: "#263e35", labelFontSize: 12, labelFontFamily: "Segoe UI, Microsoft YaHei, sans-serif",
            fill: (d: unknown) => NODE_COLORS[String(dataField(d, "type"))] ?? "#869185",
            stroke: "#ffffff", lineWidth: 3,
            size: (d: unknown) => 24 + Math.max(1, Math.min(10, Number(dataField(d, "importance") ?? 5))) * 3,
            shadowColor: "rgba(28, 63, 49, 0.12)", shadowBlur: 12,
          } },
          edge: { style: {
            stroke: "#b5c1b5", lineWidth: 1, labelText: (d: unknown) => String(dataField(d, "label") ?? ""),
            labelFontSize: 10, labelFill: "#7b877d", labelBackground: true, labelBackgroundFill: "#fafbf7", endArrow: true,
          } },
          data: {
            nodes: graph!.graph.nodes.map((node) => ({ id: node.id, data: node })),
            edges: graph!.graph.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, data: edge })),
          },
        });
        const active = instance;
        active.on("node:click", (event) => { const id = (event as unknown as { target?: { id?: string } }).target?.id; if (id) callbacks.current.onNodeClick(id); });
        active.on("node:dblclick", (event) => { const id = (event as unknown as { target?: { id?: string } }).target?.id; if (id) callbacks.current.onNodeDoubleClick(id); });
        active.on("canvas:click", () => callbacks.current.onBlankClick());
        graphRef.current = active;
        await active.render();
        if (cancelled) return;
        if (graph!.graph.nodes.length) await active.fitView();
        if (cancelled) return;
        setReady(true);
        resizeObserver = new ResizeObserver(() => {
          cancelAnimationFrame(resizeFrame);
          resizeFrame = requestAnimationFrame(() => {
            if (!cancelled && container.clientWidth && container.clientHeight) active.resize(container.clientWidth, container.clientHeight);
          });
        });
        resizeObserver.observe(container);
      } catch {
        if (!cancelled) setRenderError("画布暂时无法显示。仍可通过搜索查看和编辑节点。");
      }
    }
    void mountGraph();
    return () => {
      cancelled = true; resizeObserver?.disconnect(); cancelAnimationFrame(resizeFrame);
      if (graphRef.current === instance) graphRef.current = null;
      instance?.destroy();
    };
  }, [graph, projectRef, retry]);

  useEffect(() => {
    if (ready && selectedNodeId && graph?.graph.nodes.some((node) => node.id === selectedNodeId)) {
      void graphRef.current?.focusElement(selectedNodeId, false).catch(() => undefined);
    }
  }, [selectedNodeId, ready, graph]);

  const viewport = (action: "in" | "out" | "fit") => {
    const instance = graphRef.current;
    if (!instance || !ready) return;
    void (action === "fit" ? instance.fitView() : instance.zoomBy(action === "in" ? 1.2 : 1 / 1.2)).catch(() => undefined);
  };
  return <div className="graph-canvas-shell">
    <div ref={containerRef} className="graph-canvas" role="img" aria-label={`叙事关系图，${graph?.graph.nodes.length ?? 0} 个节点。可使用上方搜索选择节点查看详情。`} />
    {renderError && <Alert className="graph-render-error" type="warning" message={renderError} action={<Button size="small" onClick={() => setRetry((current) => current + 1)}>重载画布</Button>} />}
    {Boolean(graph?.graph.nodes.length) && <div className="graph-canvas-controls"><Space.Compact><Tooltip title="放大"><Button aria-label="放大图谱" disabled={!ready || loading} icon={<PlusOutlined />} onClick={() => viewport("in")} /></Tooltip><Tooltip title="缩小"><Button aria-label="缩小图谱" disabled={!ready || loading} icon={<MinusOutlined />} onClick={() => viewport("out")} /></Tooltip><Tooltip title="显示完整图谱"><Button aria-label="显示完整图谱" disabled={!ready || loading} icon={<FullscreenOutlined />} onClick={() => viewport("fit")} /></Tooltip></Space.Compact></div>}
  </div>;
}
