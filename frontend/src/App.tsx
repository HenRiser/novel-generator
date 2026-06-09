import { useCallback, useEffect, useMemo, useState } from "react";

import {
  API_BASE_URL,
  exportChapterUrl,
  exportFullBookUrl,
  getChapter,
  getChapters,
  getHealth,
  getProject,
  getProjects,
} from "./api";
import type { ApiStatus, ChapterContent, ChapterSummary, ProjectDetail, ProjectSummary } from "./types";

function asText(value: unknown, fallback = "未填写"): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return fallback;
}

function configValue(config: Record<string, unknown> | undefined, key: string): unknown {
  return config ? config[key] : undefined;
}

function settingOptionValue(config: Record<string, unknown> | undefined, key: string): unknown {
  const options = configValue(config, "setting_generation_options");
  if (options && typeof options === "object" && key in options) {
    return (options as Record<string, unknown>)[key];
  }
  return undefined;
}

function statusText(status: ApiStatus): string {
  if (status === "online") {
    return "API online";
  }
  if (status === "offline") {
    return "API offline";
  }
  return "loading";
}

export function App() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>("loading");
  const [apiError, setApiError] = useState("");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState("");
  const [selectedProjectRef, setSelectedProjectRef] = useState("");
  const [projectDetail, setProjectDetail] = useState<ProjectDetail | null>(null);
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectError, setProjectError] = useState("");
  const [chapters, setChapters] = useState<ChapterSummary[]>([]);
  const [chaptersLoading, setChaptersLoading] = useState(false);
  const [chaptersError, setChaptersError] = useState("");
  const [selectedChapterNumber, setSelectedChapterNumber] = useState<number | null>(null);
  const [chapterContent, setChapterContent] = useState<ChapterContent | null>(null);
  const [chapterLoading, setChapterLoading] = useState(false);
  const [chapterError, setChapterError] = useState("");

  const selectedProject = useMemo(
    () => projects.find((project) => project.project_ref === selectedProjectRef) ?? null,
    [projects, selectedProjectRef],
  );

  const selectedChapter = useMemo(
    () =>
      selectedChapterNumber === null
        ? null
        : chapters.find((chapter) => chapter.chapter_number === selectedChapterNumber) ?? null,
    [chapters, selectedChapterNumber],
  );

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    setProjectsError("");
    try {
      const nextProjects = await getProjects();
      setProjects(nextProjects);
      setSelectedProjectRef((currentProjectRef) =>
        currentProjectRef && !nextProjects.some((project) => project.project_ref === currentProjectRef)
          ? ""
          : currentProjectRef,
      );
    } catch (error) {
      setProjectsError(error instanceof Error ? error.message : "项目列表加载失败。");
      setProjects([]);
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    let ignore = false;

    async function boot() {
      setApiStatus("loading");
      setApiError("");
      try {
        const health = await getHealth();
        if (ignore) {
          return;
        }
        if (health.status !== "ok") {
          throw new Error("API health check failed.");
        }
        setApiStatus("online");
        await loadProjects();
      } catch (error) {
        if (ignore) {
          return;
        }
        setApiStatus("offline");
        setApiError(error instanceof Error ? error.message : "无法连接 API。");
      }
    }

    void boot();

    return () => {
      ignore = true;
    };
  }, [loadProjects]);

  useEffect(() => {
    let ignore = false;

    async function loadProjectData(projectRef: string) {
      setProjectLoading(true);
      setChaptersLoading(true);
      setProjectError("");
      setChaptersError("");
      setProjectDetail(null);
      setChapters([]);
      setSelectedChapterNumber(null);
      setChapterContent(null);
      setChapterError("");
      try {
        const [detail, nextChapters] = await Promise.all([getProject(projectRef), getChapters(projectRef)]);
        if (ignore) {
          return;
        }
        setProjectDetail(detail);
        setChapters(nextChapters);
        if (nextChapters.length > 0) {
          setSelectedChapterNumber(nextChapters[0].chapter_number);
        }
      } catch (error) {
        if (ignore) {
          return;
        }
        const message = error instanceof Error ? error.message : "项目读取失败。";
        setProjectError(message);
        setChaptersError(message);
      } finally {
        if (!ignore) {
          setProjectLoading(false);
          setChaptersLoading(false);
        }
      }
    }

    if (selectedProjectRef) {
      void loadProjectData(selectedProjectRef);
    } else {
      setProjectDetail(null);
      setProjectError("");
      setChapters([]);
      setChaptersError("");
      setSelectedChapterNumber(null);
      setChapterContent(null);
      setChapterError("");
    }

    return () => {
      ignore = true;
    };
  }, [selectedProjectRef]);

  useEffect(() => {
    let ignore = false;

    async function loadChapter(projectRef: string, chapterNumber: number) {
      setChapterLoading(true);
      setChapterError("");
      setChapterContent(null);
      try {
        const content = await getChapter(projectRef, chapterNumber);
        if (!ignore) {
          setChapterContent(content);
        }
      } catch (error) {
        if (!ignore) {
          setChapterError(error instanceof Error ? error.message : "章节正文加载失败。");
        }
      } finally {
        if (!ignore) {
          setChapterLoading(false);
        }
      }
    }

    if (selectedProjectRef && selectedChapterNumber !== null) {
      void loadChapter(selectedProjectRef, selectedChapterNumber);
    }

    return () => {
      ignore = true;
    };
  }, [selectedProjectRef, selectedChapterNumber]);

  const projectConfig = projectDetail?.config;

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <h1>Novel Generator Reader</h1>
          <p>React reader foundation for local project browsing and TXT exports.</p>
        </div>
        <div className={`status-pill status-${apiStatus}`}>{statusText(apiStatus)}</div>
      </header>

      {apiStatus === "offline" && (
        <section className="notice error-notice">
          <strong>无法连接 API。</strong>
          <span>{apiError || "请先启动后端服务。"}</span>
          <code>python -m uvicorn api.main:app --host 127.0.0.1 --port 8000</code>
          <span>当前 API 地址：{API_BASE_URL}</span>
        </section>
      )}

      <section className="reader-layout">
        <aside className="panel project-list">
          <div className="panel-header">
            <h2>项目列表</h2>
            <button type="button" onClick={() => void loadProjects()} disabled={projectsLoading || apiStatus !== "online"}>
              刷新
            </button>
          </div>

          {projectsLoading && <p className="muted">正在加载项目...</p>}
          {projectsError && <p className="error-text">{projectsError}</p>}
          {!projectsLoading && !projectsError && projects.length === 0 && <p className="muted">暂无项目。</p>}

          <div className="project-items">
            {projects.map((project) => (
              <button
                className={`project-item ${project.project_ref === selectedProjectRef ? "selected" : ""}`}
                key={project.project_ref}
                type="button"
                onClick={() => setSelectedProjectRef(project.project_ref)}
              >
                <strong>{project.title || "未命名小说"}</strong>
                <span>{project.storage_type || "unknown"}</span>
                <span>{project.updated_at || "无更新时间"}</span>
                <code>{project.project_ref}</code>
              </button>
            ))}
          </div>
        </aside>

        <section className="panel project-detail">
          <h2>项目详情</h2>
          {!selectedProjectRef && <p className="muted">请选择一个项目。</p>}
          {projectLoading && <p className="muted">正在加载项目详情...</p>}
          {projectError && <p className="error-text">{projectError}</p>}
          {selectedProject && projectDetail && (
            <div className="detail-grid">
              <div>
                <span>标题</span>
                <strong>{projectDetail.title || selectedProject.title || "未命名小说"}</strong>
              </div>
              <div>
                <span>project_ref</span>
                <code>{projectDetail.project_ref}</code>
              </div>
              <div>
                <span>类型</span>
                <strong>{asText(configValue(projectConfig, "genre"))}</strong>
              </div>
              <div>
                <span>风格</span>
                <strong>{asText(configValue(projectConfig, "style"))}</strong>
              </div>
              <div>
                <span>写作模式</span>
                <strong>{asText(settingOptionValue(projectConfig, "writing_mode"))}</strong>
              </div>
              <div>
                <span>期望章节数</span>
                <strong>{asText(settingOptionValue(projectConfig, "expected_chapters"))}</strong>
              </div>
            </div>
          )}

          <div className="section-header">
            <h3>章节列表</h3>
            {selectedProjectRef && (
              <a className="text-link" href={exportFullBookUrl(selectedProjectRef)}>
                下载整本 TXT
              </a>
            )}
          </div>
          {chaptersLoading && <p className="muted">正在加载章节...</p>}
          {chaptersError && <p className="error-text">{chaptersError}</p>}
          {!chaptersLoading && !chaptersError && selectedProjectRef && chapters.length === 0 && (
            <p className="muted">当前项目暂无章节。</p>
          )}
          <div className="chapter-list">
            {chapters.map((chapter) => (
              <button
                className={`chapter-item ${
                  chapter.chapter_number === selectedChapterNumber ? "selected" : ""
                }`}
                key={`${chapter.chapter_number}-${chapter.filename}`}
                type="button"
                onClick={() => setSelectedChapterNumber(chapter.chapter_number)}
              >
                <strong>{chapter.display_label || chapter.title || `第 ${chapter.chapter_number} 章`}</strong>
                <span>{chapter.filename}</span>
                <span>{chapter.is_version ? `版本 v${chapter.version}` : "主版本"}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="panel chapter-reader">
          <div className="reader-header">
            <div>
              <h2>{chapterContent?.title || selectedChapter?.title || "章节正文"}</h2>
              <p>{chapterContent?.filename || selectedChapter?.filename || "选择章节后显示正文。"}</p>
            </div>
            {selectedProjectRef && selectedChapterNumber !== null && (
              <a className="download-button" href={exportChapterUrl(selectedProjectRef, selectedChapterNumber)}>
                下载本章 TXT
              </a>
            )}
          </div>

          {chapterLoading && <p className="muted">正在加载章节正文...</p>}
          {chapterError && <p className="error-text">{chapterError}</p>}
          {!chapterLoading && !chapterError && chapterContent && (
            <pre className="chapter-content">{chapterContent.content}</pre>
          )}
          {!chapterLoading && !chapterError && selectedProjectRef && selectedChapterNumber === null && (
            <p className="muted">请选择一个章节。</p>
          )}
        </section>
      </section>
    </main>
  );
}
