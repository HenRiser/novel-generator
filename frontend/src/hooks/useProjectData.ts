import { useCallback, useEffect, useRef, useState } from "react";
import type { ChapterSummary, ProjectDetail } from "../types";
import { getChapter, getChapters, getChapterStatus, getHealth, getProject, getProjects } from "../api";
import { useAppStore } from "../store/useAppStore";

/** 后端健康轮询，维护 apiStatus */
export function useApiHealth(): void {
  const setApiStatus = useAppStore((state) => state.setApiStatus);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const check = async () => {
      try {
        await getHealth();
        if (!cancelled) {
          setApiStatus("online");
        }
      } catch {
        if (!cancelled) {
          setApiStatus("offline");
        }
      }
    };

    void check();
    timer = window.setInterval(() => void check(), 15_000);

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearInterval(timer);
      }
    };
  }, [setApiStatus]);
}

/** 项目列表加载 */
export function useProjects(): {
  error: string;
  refresh: () => Promise<void>;
} {
  const setProjects = useAppStore((state) => state.setProjects);
  const setProjectsLoading = useAppStore((state) => state.setProjectsLoading);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setProjectsLoading(true);
    setError("");
    try {
      const list = await getProjects();
      setProjects(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载项目列表失败。");
    } finally {
      setProjectsLoading(false);
    }
  }, [setProjects, setProjectsLoading]);

  return { error, refresh };
}

/** 项目详情 + 章节列表加载 */
export function useProjectData(projectRef: string | null): {
  detailError: string;
  chaptersError: string;
  refreshChapters: () => Promise<void>;
  refreshProject: () => Promise<void>;
} {
  const setSelectedProject = useAppStore((state) => state.setSelectedProject);
  const setProjectLoading = useAppStore((state) => state.setProjectLoading);
  const setChapters = useAppStore((state) => state.setChapters);
  const setChaptersLoading = useAppStore((state) => state.setChaptersLoading);
  const [detailError, setDetailError] = useState("");
  const [chaptersError, setChaptersError] = useState("");
  const detailSequence = useRef(0);
  const chaptersSequence = useRef(0);

  const refreshProject = useCallback(async () => {
    if (useAppStore.getState().selectedProjectRef !== projectRef) return;
    const sequence = ++detailSequence.current;
    const current = () => sequence === detailSequence.current && useAppStore.getState().selectedProjectRef === projectRef;
    if (!projectRef) {
      setSelectedProject(null);
      setDetailError("");
      setProjectLoading(false);
      return;
    }
    setProjectLoading(true);
    setDetailError("");
    try {
      const detail: ProjectDetail = await getProject(projectRef);
      if (current()) setSelectedProject(detail);
    } catch (e) {
      if (current()) setDetailError(e instanceof Error ? e.message : "加载项目详情失败。");
    } finally {
      if (current()) setProjectLoading(false);
    }
  }, [projectRef, setProjectLoading, setSelectedProject]);

  const refreshChapters = useCallback(async () => {
    if (useAppStore.getState().selectedProjectRef !== projectRef) return;
    const sequence = ++chaptersSequence.current;
    const current = () => sequence === chaptersSequence.current && useAppStore.getState().selectedProjectRef === projectRef;
    if (!projectRef) {
      setChapters([]);
      setChaptersError("");
      setChaptersLoading(false);
      return;
    }
    setChaptersLoading(true);
    setChaptersError("");
    try {
      const list: ChapterSummary[] = await getChapters(projectRef);
      if (current()) setChapters(list);
    } catch (e) {
      if (current()) setChaptersError(e instanceof Error ? e.message : "加载章节列表失败。");
    } finally {
      if (current()) setChaptersLoading(false);
    }
  }, [projectRef, setChapters, setChaptersLoading]);

  useEffect(() => {
    void refreshProject();
    void refreshChapters();
    return () => {
      ++detailSequence.current;
      ++chaptersSequence.current;
    };
  }, [refreshChapters, refreshProject]);

  return { detailError, chaptersError, refreshChapters, refreshProject };
}

/** 状态跟随项目及章节加载，旧请求不会覆盖新章节。 */
export function useChapterStatus(projectRef: string | null, chapterNumber: number | null, refreshToken = 0) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const sequenceRef = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++sequenceRef.current;
    const current = () => sequence === sequenceRef.current && useAppStore.getState().selectedProjectRef === projectRef;
    setError("");
    useAppStore.getState().setChapterStatus(null);
    if (!projectRef?.startsWith("book:") || chapterNumber === null) {
      setLoading(false);
      useAppStore.getState().setChapterStatusLoading(false);
      return;
    }
    setLoading(true);
    useAppStore.getState().setChapterStatusLoading(true);
    try {
      const result = await getChapterStatus(projectRef, chapterNumber);
      if (current()) useAppStore.getState().setChapterStatus(result);
    } catch (e) {
      if (current()) setError(e instanceof Error ? e.message : "章节状态加载失败。");
    } finally {
      if (current()) {
        setLoading(false);
        useAppStore.getState().setChapterStatusLoading(false);
      }
    }
  }, [chapterNumber, projectRef]);
  useEffect(() => {
    void refresh();
    return () => { ++sequenceRef.current; };
  }, [refresh, refreshToken]);
  return { error, loading, refresh };
}

/** 章节正文加载 */
export function useChapterContent(
  projectRef: string | null,
  chapterNumber: number | null,
  refreshToken = 0,
): {
  content: string | null;
  title: string;
  filename: string;
  loading: boolean;
  error: string;
} {
  const [content, setContent] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [filename, setFilename] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestKey = `${projectRef ?? ""}#${chapterNumber ?? ""}#${refreshToken}`;
  const requestKeyRef = useRef(requestKey);
  const [settledRequestKey, setSettledRequestKey] = useState("");

  useEffect(() => {
    requestKeyRef.current = requestKey;
    setContent(null);
    setTitle("");
    setFilename("");
    setError("");
    if (!projectRef || chapterNumber === null) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    getChapter(projectRef, chapterNumber)
      .then((chapter) => {
        if (cancelled || requestKeyRef.current !== requestKey) {
          return;
        }
        setContent(chapter.content);
        setTitle(chapter.title);
        setFilename(chapter.filename);
        setSettledRequestKey(requestKey);
      })
      .catch((e) => {
        if (cancelled || requestKeyRef.current !== requestKey) {
          return;
        }
        setError(e instanceof Error ? e.message : "加载章节正文失败。");
        setSettledRequestKey(requestKey);
      })
      .finally(() => {
        if (!cancelled && requestKeyRef.current === requestKey) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [chapterNumber, projectRef, requestKey]);

  // 切项目/章节的首帧不能把旧正文当作新章节交给阅读位置记忆。
  const current = settledRequestKey === requestKey;
  return {
    content: current ? content : null,
    title: current ? title : "",
    filename: current ? filename : "",
    loading: Boolean(projectRef && chapterNumber !== null) && (!current || loading),
    error: current ? error : "",
  };
}
