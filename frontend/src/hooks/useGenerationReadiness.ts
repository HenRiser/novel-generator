import { useCallback, useEffect, useState } from "react";
import { getGenerationReadiness } from "../api";
import type { ApiStatus, GenerationReadiness } from "../types";

/** A read-only preflight; submission remains guarded by the server. */
export function useGenerationReadiness(projectRef: string | null, chapterNumber: number, apiStatus: ApiStatus) {
  const [value, setValue] = useState<GenerationReadiness | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((previous) => previous + 1), []);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const controller = new AbortController();
    setValue(null); setError("");
    if (!projectRef || apiStatus !== "online") return;
    const check = async () => {
      let delay = 5000;
      try {
        const response = await getGenerationReadiness(projectRef, chapterNumber, controller.signal);
        if (cancelled) return;
        setValue(response); setError("");
        if (!response.ready) delay = 1800;
      } catch (cause) {
        if (cancelled) return;
        // Never keep a stale "ready" result after a failed refresh.
        setValue(null); setError(cause instanceof Error ? cause.message : "生成准备状态读取失败。");
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void check(), delay);
      }
    };
    void check();
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timer); };
  }, [projectRef, chapterNumber, apiStatus, revision]);

  useEffect(() => {
    window.addEventListener("braipen:workflow-changed", refresh);
    window.addEventListener("braipen:batch-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("braipen:workflow-changed", refresh);
      window.removeEventListener("braipen:batch-changed", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  const current = value?.project_ref === projectRef && value.chapter_number === chapterNumber && apiStatus === "online" ? value : null;
  return { value: current, loading: Boolean(projectRef && apiStatus === "online" && !current && !error), error, refresh };
}
