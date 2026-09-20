import { useEffect } from "react";
import { getBatchGeneration, getChapters } from "../api";
import { useAppStore } from "../store/useAppStore";

/** Keep server-owned batch state available while navigating between workspaces. */
export function useBatchGeneration(): void {
  const { selectedProjectRef, apiStatus } = useAppStore();
  useEffect(() => {
    if (!selectedProjectRef || apiStatus !== "online") return;
    const projectRef = selectedProjectRef;
    let disposed = false;
    let sequence = 0;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    let previous = "";
    useAppStore.getState().setBatchStatusLoading(true);
    const refresh = async () => {
      const request = ++sequence;
      window.clearTimeout(timer);
      controller?.abort();
      controller = new AbortController();
      const current = () => !disposed && request === sequence && useAppStore.getState().selectedProjectRef === projectRef;
      let active = false;
      try {
        const status = await getBatchGeneration(projectRef, controller.signal);
        if (!current()) return;
        const store = useAppStore.getState();
        store.setBatchStatus(status);
        store.setBatchStatusError("");
        active = status.status === "running" || status.status === "stopping";
        const signature = `${status.id}:${status.status}:${status.stage}:${status.current_chapter}:${status.completed_chapters.join(",")}`;
        if (signature !== previous && (status.id || previous)) {
          previous = signature;
          window.dispatchEvent(new CustomEvent("braipen:workflow-changed", { detail: { projectRef } }));
          const chapters = await getChapters(projectRef);
          if (current()) store.setChapters(chapters);
        }
      } catch (error) {
        if (current()) useAppStore.getState().setBatchStatusError(error instanceof Error ? error.message : "连续生成状态读取失败。");
      } finally {
        if (current()) {
          useAppStore.getState().setBatchStatusLoading(false);
          timer = window.setTimeout(() => void refresh(), active ? 1800 : 5000);
        }
      }
    };
    const handleChange = () => void refresh();
    window.addEventListener("braipen:batch-changed", handleChange);
    void refresh();
    return () => {
      disposed = true;
      ++sequence;
      controller?.abort();
      window.clearTimeout(timer);
      window.removeEventListener("braipen:batch-changed", handleChange);
      // Unmounting never cancels a server task or clears its busy state.
    };
  }, [apiStatus, selectedProjectRef]);
}
