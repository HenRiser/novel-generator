import { useCallback, useEffect, useRef, useState } from "react";
import type { ChapterSummary, ProjectDetail } from "../types";
import { getChapter, getChapters, getHealth, getProject, getProjects } from "../api";
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

  const refreshProject = useCallback(async () => {
    if (!projectRef) {
      setSelectedProject(null);
      return;
    }
    setProjectLoading(true);
    setDetailError("");
    try {
      const detail: ProjectDetail = await getProject(projectRef);
      setSelectedProject(detail);
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : "加载项目详情失败。");
    } finally {
      setProjectLoading(false);
    }
  }, [projectRef, setProjectLoading, setSelectedProject]);

  const refreshChapters = useCallback(async () => {
    if (!projectRef) {
      setChapters([]);
      return;
    }
    setChaptersLoading(true);
    setChaptersError("");
    try {
      const list: ChapterSummary[] = await getChapters(projectRef);
      setChapters(list);
    } catch (e) {
      setChaptersError(e instanceof Error ? e.message : "加载章节列表失败。");
    } finally {
      setChaptersLoading(false);
    }
  }, [projectRef, setChapters, setChaptersLoading]);

  useEffect(() => {
    void refreshProject();
    void refreshChapters();
  }, [refreshChapters, refreshProject]);

  return { detailError, chaptersError, refreshChapters, refreshProject };
}

/** 章节正文加载 */
export function useChapterContent(
  projectRef: string | null,
  chapterNumber: number | null,
  refreshToken = 0,
): {
  content: string | null;
  title: string;
  loading: boolean;
  error: string;
} {
  const [content, setContent] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestKey = `${projectRef ?? ""}#${chapterNumber ?? ""}#${refreshToken}`;
  const requestKeyRef = useRef(requestKey);

  useEffect(() => {
    requestKeyRef.current = requestKey;
    setContent(null);
    setTitle("");
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
      })
      .catch((e) => {
        if (cancelled || requestKeyRef.current !== requestKey) {
          return;
        }
        setError(e instanceof Error ? e.message : "加载章节正文失败。");
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

  return { content, title, loading, error };
}
