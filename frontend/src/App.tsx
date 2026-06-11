import { useCallback, useEffect, useMemo, useState } from "react";

import {
  API_BASE_URL,
  exportChapterUrl,
  exportFullBookUrl,
  generateChapter,
  generateChapterStream,
  generateOutlineCharacters,
  getChapter,
  getChapters,
  getGenerationStatus,
  getHealth,
  getProject,
  getProjects,
  ApiRequestError,
} from "./api";
import type {
  ApiStatus,
  ChapterContent,
  ChapterGenerationResponse,
  ChapterSummary,
  ChapterStreamDoneEvent,
  GenerationRequest,
  GenerationStatus,
  OutlineCharactersGenerationResponse,
  ProjectDetail,
  ProjectSummary,
} from "./types";

const DEFAULT_GENERATION_REQUEST: GenerationRequest = {
  model: "deepseek-v4-pro",
  max_tokens: 4000,
};

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

function generationStatusText(status: GenerationStatus | null): string {
  if (!status) {
    return "Loading";
  }
  if (status.running) {
    return "Running";
  }
  if (status.last_error) {
    return "Last error";
  }
  if (status.last_result) {
    return "Last success";
  }
  return "Idle";
}

function publicErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 409) {
      return "已有生成任务正在运行，请稍后再试。";
    }
    if (error.code === "setting_assets_missing") {
      return "缺少大纲或人物卡，请先生成 / 更新大纲与人物卡。";
    }
    if (error.code === "project_config_incomplete") {
      return `项目配置不完整：${error.message}`;
    }
    if (error.code === "model_config_missing") {
      return "模型配置缺失，请先在本地旧前端或环境配置中设置模型凭据。";
    }
    return error.message || fallback;
  }

  return error instanceof Error ? error.message : fallback;
}

function nextChapterSuggestion(chapters: ChapterSummary[]): number {
  if (chapters.length === 0) {
    return 1;
  }
  return Math.max(...chapters.map((chapter) => chapter.chapter_number)) + 1;
}

function generationResultSummary(result: Record<string, unknown> | null): string {
  if (!result) {
    return "";
  }

  const parts = [
    asText(result.message, ""),
    asText(result.outline_file, ""),
    asText(result.characters_file, ""),
    asText(result.chapter_file, ""),
    asText(result.summary_file, ""),
  ].filter(Boolean);

  return parts.join(" · ");
}

function outlineSuccessMessage(result: OutlineCharactersGenerationResponse): string {
  return `${result.message || "大纲与人物卡生成完成。"} ${result.outline_file} ${result.characters_file}`.trim();
}

function chapterSuccessMessage(result: ChapterGenerationResponse): string {
  return `${result.message || "章节生成完成。"} 第 ${result.chapter_number} 章 ${result.title} ${result.chapter_file}`.trim();
}

function chapterStreamSuccessMessage(result: ChapterStreamDoneEvent): string {
  return `${result.message || "章节生成完成。"} 第 ${result.chapter_number} 章 ${result.title} ${result.chapter_file}`.trim();
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
  const [generationStatus, setGenerationStatus] = useState<GenerationStatus | null>(null);
  const [generationStatusLoading, setGenerationStatusLoading] = useState(false);
  const [generationStatusError, setGenerationStatusError] = useState("");
  const [generationMessage, setGenerationMessage] = useState("");
  const [generationError, setGenerationError] = useState("");
  const [outlineGenerating, setOutlineGenerating] = useState(false);
  const [chapterGenerating, setChapterGenerating] = useState(false);
  const [chapterStreaming, setChapterStreaming] = useState(false);
  const [chapterNumberInput, setChapterNumberInput] = useState("1");
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingPreviewVisible, setStreamingPreviewVisible] = useState(false);
  const [streamingError, setStreamingError] = useState("");
  const [streamingSaved, setStreamingSaved] = useState(false);

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

  const suggestedChapterNumber = useMemo(() => nextChapterSuggestion(chapters), [chapters]);
  const generationBusy =
    Boolean(generationStatus?.running) || outlineGenerating || chapterGenerating || chapterStreaming;

  const refreshGenerationStatus = useCallback(async () => {
    setGenerationStatusLoading(true);
    setGenerationStatusError("");
    try {
      const status = await getGenerationStatus();
      setGenerationStatus(status);
      return status;
    } catch (error) {
      const message = publicErrorMessage(error, "生成状态读取失败。");
      setGenerationStatusError(message);
      return null;
    } finally {
      setGenerationStatusLoading(false);
    }
  }, []);

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
        void refreshGenerationStatus();
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
  }, [loadProjects, refreshGenerationStatus]);

  useEffect(() => {
    if (apiStatus !== "online") {
      return;
    }
    void refreshGenerationStatus();
  }, [apiStatus, refreshGenerationStatus]);

  useEffect(() => {
    if (apiStatus !== "online" || !generationStatus?.running) {
      return;
    }

    let ignore = false;
    const intervalId = window.setInterval(() => {
      void getGenerationStatus()
        .then((status) => {
          if (!ignore) {
            setGenerationStatus(status);
            setGenerationStatusError("");
          }
        })
        .catch((error) => {
          if (!ignore) {
            setGenerationStatusError(publicErrorMessage(error, "生成状态读取失败。"));
          }
        });
    }, 2000);

    return () => {
      ignore = true;
      window.clearInterval(intervalId);
    };
  }, [apiStatus, generationStatus?.running]);

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
      setStreamingContent("");
      setStreamingError("");
      setStreamingSaved(false);
      setStreamingPreviewVisible(false);
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
      setStreamingContent("");
      setStreamingError("");
      setStreamingSaved(false);
      setStreamingPreviewVisible(false);
    }

    return () => {
      ignore = true;
    };
  }, [selectedProjectRef]);

  useEffect(() => {
    setChapterNumberInput(String(suggestedChapterNumber));
  }, [selectedProjectRef, suggestedChapterNumber]);

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

  const refreshProjectAndChapters = useCallback(async (projectRef: string) => {
    const [detail, nextChapters] = await Promise.all([getProject(projectRef), getChapters(projectRef)]);
    setProjectDetail(detail);
    setChapters(nextChapters);
    return nextChapters;
  }, []);

  const loadChapterAfterGeneration = useCallback(async (projectRef: string, chapterNumber: number) => {
    setSelectedChapterNumber(chapterNumber);
    setChapterLoading(true);
    setChapterError("");
    setChapterContent(null);
    try {
      const content = await getChapter(projectRef, chapterNumber);
      setChapterContent(content);
      return true;
    } catch (error) {
      setChapterError(publicErrorMessage(error, "生成后章节读取失败。"));
      return false;
    } finally {
      setChapterLoading(false);
    }
  }, []);

  const ensureGenerationIdle = useCallback(async () => {
    const status = await refreshGenerationStatus();
    if (!status) {
      setGenerationError("无法读取生成状态，请确认 API 正常运行。");
      return false;
    }
    if (status.running) {
      setGenerationError("已有生成任务正在运行，请稍后再试。");
      return false;
    }
    return true;
  }, [refreshGenerationStatus]);

  const handleGenerateOutlineCharacters = useCallback(async () => {
    if (!selectedProjectRef) {
      setGenerationError("请先选择项目。");
      return;
    }

    setGenerationMessage("");
    setGenerationError("");
    if (!(await ensureGenerationIdle())) {
      return;
    }

    setOutlineGenerating(true);
    try {
      const result = await generateOutlineCharacters(selectedProjectRef, DEFAULT_GENERATION_REQUEST);
      setGenerationMessage(outlineSuccessMessage(result));
      await refreshGenerationStatus();
    } catch (error) {
      setGenerationError(publicErrorMessage(error, "大纲与人物卡生成失败。"));
      await refreshGenerationStatus();
    } finally {
      setOutlineGenerating(false);
    }
  }, [ensureGenerationIdle, refreshGenerationStatus, selectedProjectRef]);

  const handleGenerateChapterStream = useCallback(async () => {
    if (!selectedProjectRef) {
      setGenerationError("请选择项目后再生成章节。");
      return;
    }

    const chapterNumber = Number.parseInt(chapterNumberInput, 10);
    if (!Number.isInteger(chapterNumber) || chapterNumber < 1) {
      setGenerationError("章节号必须是正整数。");
      return;
    }

    setGenerationMessage("");
    setGenerationError("");
    if (!(await ensureGenerationIdle())) {
      return;
    }
    setStreamingContent("");
    setStreamingError("");
    setStreamingSaved(false);
    setStreamingPreviewVisible(true);

    setChapterStreaming(true);
    try {
      const result = await generateChapterStream(selectedProjectRef, chapterNumber, DEFAULT_GENERATION_REQUEST, {
        onDelta: (text) => {
          setStreamingContent((current) => `${current}${text}`);
        },
        onDone: () => {
          setStreamingSaved(true);
          setStreamingError("");
        },
        onError: (error) => {
          setStreamingSaved(false);
          setStreamingError(`${error.message || "章节流式生成失败。"} 当前预览未保存。`);
        },
      });
      setStreamingSaved(true);
      setGenerationMessage(chapterStreamSuccessMessage(result));
      await refreshProjectAndChapters(selectedProjectRef);
      const loaded = await loadChapterAfterGeneration(selectedProjectRef, result.chapter_number || chapterNumber);
      if (!loaded) {
        setGenerationError("章节已生成，但自动读取正文失败，请手动刷新或重新选择章节。");
      }
      await refreshGenerationStatus();
    } catch (error) {
      const message = publicErrorMessage(error, "章节流式生成失败。");
      setStreamingSaved(false);
      setStreamingError(`${message} 当前预览未保存。`);
      setGenerationError(message);
      await refreshGenerationStatus();
    } finally {
      setChapterStreaming(false);
    }
  }, [
    chapterNumberInput,
    ensureGenerationIdle,
    loadChapterAfterGeneration,
    refreshGenerationStatus,
    refreshProjectAndChapters,
    selectedProjectRef,
  ]);

  const handleGenerateChapter = useCallback(async () => {
    if (!selectedProjectRef) {
      setGenerationError("请先选择项目。");
      return;
    }

    const chapterNumber = Number.parseInt(chapterNumberInput, 10);
    if (!Number.isInteger(chapterNumber) || chapterNumber < 1) {
      setGenerationError("章节号必须是正整数。");
      return;
    }

    setGenerationMessage("");
    setGenerationError("");
    if (!(await ensureGenerationIdle())) {
      return;
    }

    setChapterGenerating(true);
    try {
      const result = await generateChapter(selectedProjectRef, chapterNumber, DEFAULT_GENERATION_REQUEST);
      setGenerationMessage(chapterSuccessMessage(result));
      await refreshProjectAndChapters(selectedProjectRef);
      const loaded = await loadChapterAfterGeneration(selectedProjectRef, result.chapter_number || chapterNumber);
      if (!loaded) {
        setGenerationError("章节已生成，但自动读取正文失败，请手动刷新或重新选择章节。");
      }
      await refreshGenerationStatus();
    } catch (error) {
      setGenerationError(publicErrorMessage(error, "章节生成失败。"));
      await refreshGenerationStatus();
    } finally {
      setChapterGenerating(false);
    }
  }, [
    chapterNumberInput,
    ensureGenerationIdle,
    loadChapterAfterGeneration,
    refreshGenerationStatus,
    refreshProjectAndChapters,
    selectedProjectRef,
  ]);

  const projectConfig = projectDetail?.config;

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <h1>Novel Generator</h1>
          <p>React reader and basic generation foundation for local projects.</p>
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

      {apiStatus === "online" && (
        <section className="generation-status-bar" aria-live="polite">
          <div>
            <span>Generation</span>
            <strong>{generationStatusLoading ? "Loading" : generationStatusText(generationStatus)}</strong>
          </div>
          <div>
            <span>task_type</span>
            <strong>{generationStatus?.task_type || "-"}</strong>
          </div>
          <div>
            <span>target</span>
            <strong>{generationStatus?.target || "-"}</strong>
          </div>
          <div>
            <span>started_at</span>
            <strong>{generationStatus?.started_at || "-"}</strong>
          </div>
          <div>
            <span>finished_at</span>
            <strong>{generationStatus?.finished_at || "-"}</strong>
          </div>
          {(generationStatusError || generationStatus?.last_error) && (
            <p className="error-text">{generationStatusError || generationStatus?.last_error}</p>
          )}
          {!generationStatus?.last_error && generationStatus?.last_result && (
            <p className="success-text">{generationResultSummary(generationStatus.last_result)}</p>
          )}
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

          <section className="generation-controls">
            <div className="section-header">
              <h3>基础生成</h3>
              <button
                type="button"
                onClick={() => void refreshGenerationStatus()}
                disabled={generationStatusLoading || apiStatus !== "online"}
              >
                刷新状态
              </button>
            </div>
            <div className="generation-actions">
              <button
                type="button"
                onClick={() => void handleGenerateOutlineCharacters()}
                disabled={!selectedProjectRef || apiStatus !== "online" || generationBusy}
              >
                {outlineGenerating ? "正在生成大纲与人物卡..." : "生成 / 更新大纲与人物卡"}
              </button>
              <label className="chapter-number-field">
                <span>章节号</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={chapterNumberInput}
                  onChange={(event) => setChapterNumberInput(event.target.value)}
                  disabled={!selectedProjectRef || generationBusy}
                />
              </label>
              <button
                type="button"
                onClick={() => void handleGenerateChapterStream()}
                disabled={!selectedProjectRef || apiStatus !== "online" || generationBusy}
              >
                {chapterStreaming ? "正在流式生成章节..." : "生成章节"}
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => void handleGenerateChapter()}
                disabled={!selectedProjectRef || apiStatus !== "online" || generationBusy}
              >
                {chapterGenerating ? "正在同步生成章节..." : "同步生成（备用）"}
              </button>
            </div>
            <p className="muted">
              建议下一章：第 {suggestedChapterNumber} 章；当前模型：{DEFAULT_GENERATION_REQUEST.model}，
              max_tokens：{DEFAULT_GENERATION_REQUEST.max_tokens}
            </p>
            {generationMessage && <p className="success-text">{generationMessage}</p>}
            {generationError && <p className="error-text">{generationError}</p>}
            {streamingPreviewVisible && (
              <section
                className={`streaming-preview ${
                  streamingSaved ? "streaming-preview-saved" : streamingError ? "streaming-preview-error" : ""
                }`}
                aria-live="polite"
              >
                <div className="streaming-preview-header">
                  <h4>实时正文预览</h4>
                  <span>
                    {chapterStreaming
                      ? "生成中"
                      : streamingSaved
                        ? "已保存"
                        : streamingError
                          ? "未保存"
                          : "等待内容"}
                  </span>
                </div>
                {streamingError && <p className="error-text">{streamingError}</p>}
                {streamingSaved && <p className="success-text">流式生成已完成，章节已保存。</p>}
                <pre className="streaming-content">
                  {streamingContent || (chapterStreaming ? "等待模型返回内容..." : "暂无预览内容。")}
                </pre>
              </section>
            )}
          </section>

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
