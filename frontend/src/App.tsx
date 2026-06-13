import { useCallback, useEffect, useMemo, useState } from "react";

import {
  API_BASE_URL,
  createProject,
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
  updateGenerationSettings,
  ApiRequestError,
  safePublicMessage,
} from "./api";
import { AppHeader, type ActivePage } from "./components/AppHeader";
import { HomePage } from "./components/HomePage";
import { LibraryPage } from "./components/LibraryPage";
import { ProjectSettingsPage } from "./components/ProjectSettingsPage";
import { SystemSettingsPage } from "./components/SystemSettingsPage";
import type {
  ApiStatus,
  ChapterContent,
  ChapterGenerationResponse,
  ChapterSummary,
  ChapterStreamDoneEvent,
  CreateProjectRequest,
  GenerationRequest,
  GenerationSettingsRequest,
  GenerationStatus,
  OutlineCharactersGenerationResponse,
  ProjectOnboardingState,
  ProjectDetail,
  ProjectSummary,
} from "./types";

const DEFAULT_GENERATION_REQUEST: GenerationRequest = {
  model: "deepseek-v4-pro",
  max_tokens: 4000,
  temperature: 0.7,
};

const GENERATION_MODEL_OPTIONS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;

const DEFAULT_CREATE_PROJECT_FORM: CreateProjectRequest = {
  title: "",
  seedPrompt: "",
  genre: "",
  style: "",
  model: "deepseek-v4-flash",
  maxTokens: 4000,
  temperature: 0.7,
};

type StreamingPreviewStatus = "idle" | "streaming" | "saved" | "failed_unsaved";
type CreateProjectPanelTarget = "" | "sidebar" | "detail" | "reader";

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

function configNumberValue(
  config: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
): number {
  const value = configValue(config, key);
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function generationRequestFromConfig(config: Record<string, unknown> | undefined): GenerationRequest {
  const modelValue = configValue(config, "model");
  const model =
    typeof modelValue === "string" &&
    (GENERATION_MODEL_OPTIONS as readonly string[]).includes(modelValue)
      ? modelValue
      : DEFAULT_GENERATION_REQUEST.model;
  return {
    model,
    max_tokens: Math.trunc(configNumberValue(config, "max_tokens", DEFAULT_GENERATION_REQUEST.max_tokens)),
    temperature: configNumberValue(config, "temperature", DEFAULT_GENERATION_REQUEST.temperature),
  };
}

function settingOptionValue(config: Record<string, unknown> | undefined, key: string): unknown {
  const options = configValue(config, "setting_generation_options");
  if (options && typeof options === "object" && key in options) {
    return (options as Record<string, unknown>)[key];
  }
  return undefined;
}

function generationStatusText(status: GenerationStatus | null): string {
  if (!status) {
    return "Loading";
  }
  if (status.running) {
    return "Running";
  }
  if (status.last_error) {
    return "Error";
  }
  if (status.last_result) {
    return "Saved";
  }
  return "Idle";
}

function generationStatusClass(status: GenerationStatus | null): string {
  if (!status) {
    return "status-loading";
  }
  if (status.running) {
    return "status-running";
  }
  if (status.last_error) {
    return "status-error";
  }
  if (status.last_result) {
    return "status-success";
  }
  return "status-idle";
}

function publicFileName(value: unknown): string {
  const text = asText(value, "");
  if (!text) {
    return "";
  }
  const parts = text.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : text;
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
    if (error.code === "generation_failed") {
      return `生成失败：${safePublicMessage(error.message, fallback)}`;
    }
    if (error.code === "project_not_found") {
      return "项目不存在或无法读取。";
    }
    return safePublicMessage(error.message, fallback);
  }

  const rawMessage = error instanceof Error ? error.message : "";
  if (/failed to fetch|networkerror|load failed/i.test(rawMessage)) {
    return fallback;
  }
  return safePublicMessage(rawMessage, fallback);
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
    safePublicMessage(asText(result.message, ""), ""),
    publicFileName(result.outline_file),
    publicFileName(result.characters_file),
    publicFileName(result.chapter_file),
    publicFileName(result.summary_file),
  ].filter(Boolean);

  return parts.join(" · ");
}

function generationSavedFiles(result: Record<string, unknown> | null): string {
  if (!result) {
    return "-";
  }

  return (
    [
      publicFileName(result.chapter_file),
      publicFileName(result.summary_file),
      publicFileName(result.outline_file),
      publicFileName(result.characters_file),
    ]
      .filter(Boolean)
      .join(" · ") || "-"
  );
}

function outlineSuccessMessage(result: OutlineCharactersGenerationResponse): string {
  return [
    result.message || "大纲与人物卡生成完成。",
    publicFileName(result.outline_file),
    publicFileName(result.characters_file),
  ]
    .filter(Boolean)
    .join(" ");
}

function chapterSuccessMessage(result: ChapterGenerationResponse): string {
  return [
    result.message || "章节生成完成。",
    `第 ${result.chapter_number} 章`,
    result.title,
    publicFileName(result.chapter_file),
  ]
    .filter(Boolean)
    .join(" ");
}

function chapterStreamSuccessMessage(result: ChapterStreamDoneEvent): string {
  return [
    result.message || "章节生成完成。",
    `第 ${result.chapter_number} 章`,
    result.title,
    publicFileName(result.chapter_file),
    result.summary_file ? `摘要：${publicFileName(result.summary_file)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function streamingStatusLabel(status: StreamingPreviewStatus): string {
  if (status === "streaming") {
    return "生成中";
  }
  if (status === "saved") {
    return "已保存";
  }
  if (status === "failed_unsaved") {
    return "失败未保存";
  }
  return "等待内容";
}

function streamSaveSummary(result: ChapterStreamDoneEvent | null): string {
  if (!result) {
    return "流式生成已完成，章节已保存。";
  }

  return [
    result.chapter_file ? `已保存为 ${publicFileName(result.chapter_file)}` : "章节已保存",
    result.summary_file ? `摘要 ${publicFileName(result.summary_file)}` : "",
  ]
    .filter(Boolean)
    .join("；");
}

function onboardingStateForProject(
  projectRef: string,
  chapters: ChapterSummary[],
  assetReadyProjectRefs: string[],
): ProjectOnboardingState {
  if (!projectRef) {
    return "empty";
  }
  if (chapters.length > 0) {
    return "chapters_ready";
  }
  if (assetReadyProjectRefs.includes(projectRef)) {
    return "ready_for_first_chapter";
  }
  return "needs_assets";
}

function ProjectCreatePanel({
  open,
  onToggle,
  form,
  onChange,
  onSubmit,
  onCancel,
  submitting,
  error,
  message,
  disabled,
  variant = "default",
}: {
  open: boolean;
  onToggle: () => void;
  form: CreateProjectRequest;
  onChange: <K extends keyof CreateProjectRequest>(key: K, value: CreateProjectRequest[K]) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitting: boolean;
  error: string;
  message: string;
  disabled: boolean;
  variant?: "default" | "compact";
}) {
  return (
    <section className={`new-project-placeholder ${variant === "compact" ? "new-project-placeholder-compact" : ""}`}>
      <button
        className="button secondary-button create-project-button"
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        disabled={disabled && !open}
      >
        新建小说项目
      </button>
      {!open && message && <p className="state-text success-text">{message}</p>}
      {open && (
        <form
          className="new-project-card project-create-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <div>
            <strong>新建小说项目</strong>
            <p>先创建项目与基础设定，创建后可继续生成大纲人物卡和第一章。</p>
          </div>
          <label className="form-field">
            <span>小说标题 *</span>
            <input
              type="text"
              value={form.title}
              onChange={(event) => onChange("title", event.target.value)}
              placeholder="例如：废土演员"
              disabled={submitting}
              maxLength={80}
              required
            />
          </label>
          <label className="form-field">
            <span>一句话设定 / 创作种子 *</span>
            <textarea
              value={form.seedPrompt}
              onChange={(event) => onChange("seedPrompt", event.target.value)}
              placeholder="一个在废土剧场中醒来的演员，发现自己正在被世界观看。"
              disabled={submitting}
              maxLength={4000}
              required
            />
          </label>
          <div className="form-grid">
            <label className="form-field">
              <span>题材</span>
              <input
                type="text"
                value={form.genre || ""}
                onChange={(event) => onChange("genre", event.target.value)}
                placeholder="废土 / 科幻"
                disabled={submitting}
                maxLength={200}
              />
            </label>
            <label className="form-field">
              <span>风格</span>
              <input
                type="text"
                value={form.style || ""}
                onChange={(event) => onChange("style", event.target.value)}
                placeholder="冷峻、文学化"
                disabled={submitting}
                maxLength={200}
              />
            </label>
          </div>
          <div className="form-grid">
            <label className="form-field">
              <span>模型</span>
              <select
                value={form.model || "deepseek-v4-flash"}
                onChange={(event) => onChange("model", event.target.value)}
                disabled={submitting}
              >
                <option value="deepseek-v4-flash">deepseek-v4-flash</option>
                <option value="deepseek-v4-pro">deepseek-v4-pro</option>
              </select>
            </label>
            <label className="form-field">
              <span>max_tokens</span>
              <input
                type="number"
                min="512"
                max="32768"
                step="1"
                value={form.maxTokens ?? 4000}
                onChange={(event) => onChange("maxTokens", Number(event.target.value))}
                disabled={submitting}
              />
            </label>
            <label className="form-field">
              <span>temperature</span>
              <input
                type="number"
                min="0"
                max="2"
                step="0.1"
                value={form.temperature ?? 0.7}
                onChange={(event) => onChange("temperature", Number(event.target.value))}
                disabled={submitting}
              />
            </label>
          </div>
          <p className="form-note">
            React 会创建 workspace 项目；创建项目不会调用模型。Streamlit 旧入口仍保留：
            <code>start.bat</code>；React 入口：<code>start-react.bat</code>。
          </p>
          {error && <p className="state-text error-text">{error}</p>}
          {message && <p className="state-text success-text">{message}</p>}
          <div className="form-actions">
            <button className="button subtle-button" type="button" onClick={onCancel} disabled={submitting}>
              取消
            </button>
            <button className="button primary-button" type="submit" disabled={submitting || disabled}>
              {submitting ? "创建中..." : "创建项目"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function ProjectOnboardingPanel({
  state,
  suggestedChapterNumber,
  generationBusy,
  apiStatus,
  onGenerateAssets,
  onGenerateChapter,
}: {
  state: ProjectOnboardingState;
  suggestedChapterNumber: number;
  generationBusy: boolean;
  apiStatus: ApiStatus;
  onGenerateAssets: () => void;
  onGenerateChapter: (chapterNumber: number) => void;
}) {
  if (state === "empty") {
    return null;
  }

  const assetsDone = state === "ready_for_first_chapter" || state === "chapters_ready";
  const firstChapterDone = state === "chapters_ready";
  const nextAction =
    state === "needs_assets"
      ? {
          text: "项目已创建。下一步建议生成大纲与人物卡，用于后续章节生成。",
          button: "生成 / 更新大纲与人物卡",
          onClick: onGenerateAssets,
        }
      : state === "ready_for_first_chapter"
        ? {
            text: "大纲与人物卡已准备好。下一步可以生成第一章。",
            button: "生成第一章",
            onClick: () => onGenerateChapter(1),
          }
        : {
            text: "可以继续生成下一章，或选择已有章节阅读。",
            button: `生成第 ${suggestedChapterNumber} 章`,
            onClick: () => onGenerateChapter(suggestedChapterNumber),
          };

  return (
    <section className="panel onboarding-panel">
      <div className="panel-header">
        <div>
          <span className="section-kicker">Onboarding</span>
          <h2>当前项目进度</h2>
        </div>
      </div>
      <ol className="onboarding-steps">
        <li className="step-item step-complete">
          <span className="step-status">已完成</span>
          <strong>1. 项目已创建</strong>
        </li>
        <li className={`step-item ${assetsDone ? "step-complete" : ""}`}>
          <span className="step-status">{assetsDone ? "已完成" : "待办"}</span>
          <strong>2. 生成大纲与人物卡</strong>
        </li>
        <li className={`step-item ${firstChapterDone ? "step-complete" : ""}`}>
          <span className="step-status">{firstChapterDone ? "已完成" : "待办"}</span>
          <strong>3. 生成第一章</strong>
        </li>
        <li className={`step-item ${state === "chapters_ready" ? "step-current" : ""}`}>
          <span className="step-status">{state === "chapters_ready" ? "可继续" : "待办"}</span>
          <strong>4. 继续章节创作</strong>
        </li>
      </ol>
      <div className="onboarding-next">
        <p>{nextAction.text}</p>
        <button
          className="button secondary-button"
          type="button"
          onClick={nextAction.onClick}
          disabled={generationBusy || apiStatus !== "online"}
        >
          {nextAction.button}
        </button>
      </div>
    </section>
  );
}

export function App() {
  const [activePage, setActivePage] = useState<ActivePage>("home");
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
  const [streamingPreviewStatus, setStreamingPreviewStatus] = useState<StreamingPreviewStatus>("idle");
  const [streamingError, setStreamingError] = useState("");
  const [streamingResult, setStreamingResult] = useState<ChapterStreamDoneEvent | null>(null);
  const [newProjectPanelTarget, setNewProjectPanelTarget] = useState<CreateProjectPanelTarget>("");
  const [createProjectForm, setCreateProjectForm] = useState<CreateProjectRequest>(DEFAULT_CREATE_PROJECT_FORM);
  const [createProjectSubmitting, setCreateProjectSubmitting] = useState(false);
  const [createProjectError, setCreateProjectError] = useState("");
  const [createProjectMessage, setCreateProjectMessage] = useState("");
  const [assetReadyProjectRefs, setAssetReadyProjectRefs] = useState<string[]>([]);

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
  const streamingCharacterCount = streamingContent.length;
  const generationBusy =
    Boolean(generationStatus?.running) || outlineGenerating || chapterGenerating || chapterStreaming;
  const projectOnboardingState = useMemo(
    () => onboardingStateForProject(selectedProjectRef, chapters, assetReadyProjectRefs),
    [assetReadyProjectRefs, chapters, selectedProjectRef],
  );
  const projectConfig = projectDetail?.config;
  const generationRequest = useMemo(() => generationRequestFromConfig(projectConfig), [projectConfig]);

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
      return nextProjects;
    } catch (error) {
      setProjectsError(publicErrorMessage(error, "项目列表加载失败。"));
      setProjects([]);
      return [];
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
        setApiError(publicErrorMessage(error, "无法连接 API，请确认后端服务已启动。"));
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
      setStreamingResult(null);
      setStreamingPreviewStatus("idle");
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
        const message = publicErrorMessage(error, "项目读取失败。");
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
      setStreamingResult(null);
      setStreamingPreviewStatus("idle");
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
          setChapterError(publicErrorMessage(error, "章节正文加载失败。"));
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

  const updateCreateProjectForm = useCallback(
    <K extends keyof CreateProjectRequest>(key: K, value: CreateProjectRequest[K]) => {
      setCreateProjectForm((current) => ({
        ...current,
        [key]: value,
      }));
      setCreateProjectError("");
    },
    [],
  );

  const handleCancelCreateProject = useCallback(() => {
    setNewProjectPanelTarget("");
    setCreateProjectError("");
  }, []);

  const handleCreateProject = useCallback(async () => {
    const title = createProjectForm.title.trim();
    const seedPrompt = createProjectForm.seedPrompt.trim();
    const maxTokens = createProjectForm.maxTokens ?? 4000;
    const temperature = createProjectForm.temperature ?? 0.7;

    if (!title) {
      setCreateProjectError("请填写小说标题。");
      return;
    }
    if (!seedPrompt) {
      setCreateProjectError("请填写一句话设定 / 创作种子。");
      return;
    }
    if (!Number.isFinite(maxTokens) || maxTokens < 512 || maxTokens > 32768) {
      setCreateProjectError("max_tokens 必须是 512 到 32768 之间的整数。");
      return;
    }
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      setCreateProjectError("temperature 必须是 0 到 2 之间的数字。");
      return;
    }

    setCreateProjectSubmitting(true);
    setCreateProjectError("");
    setCreateProjectMessage("");
    try {
      const result = await createProject({
        ...createProjectForm,
        title,
        seedPrompt,
        genre: createProjectForm.genre?.trim(),
        style: createProjectForm.style?.trim(),
        maxTokens,
        temperature,
      });
      setCreateProjectMessage(`项目已创建：${result.title || title}`);
      setCreateProjectForm(DEFAULT_CREATE_PROJECT_FORM);
      setNewProjectPanelTarget("");
      await loadProjects();
      setSelectedProjectRef(result.project_ref);
      setGenerationMessage("项目已创建。下一步建议生成大纲与人物卡。");
      setGenerationError("");
    } catch (error) {
      setCreateProjectError(publicErrorMessage(error, "项目创建失败。"));
    } finally {
      setCreateProjectSubmitting(false);
    }
  }, [createProjectForm, loadProjects]);

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
      const result = await generateOutlineCharacters(selectedProjectRef, generationRequest);
      setGenerationMessage(outlineSuccessMessage(result));
      setAssetReadyProjectRefs((current) =>
        current.includes(selectedProjectRef) ? current : [...current, selectedProjectRef],
      );
      await refreshGenerationStatus();
    } catch (error) {
      setGenerationError(publicErrorMessage(error, "大纲与人物卡生成失败。"));
      await refreshGenerationStatus();
    } finally {
      setOutlineGenerating(false);
    }
  }, [ensureGenerationIdle, generationRequest, refreshGenerationStatus, selectedProjectRef]);

  const handleGenerateChapterStream = useCallback(async (chapterNumberOverride?: number) => {
    if (!selectedProjectRef) {
      setGenerationError("请选择项目后再生成章节。");
      return;
    }

    const chapterNumber = chapterNumberOverride ?? Number.parseInt(chapterNumberInput, 10);
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
    setStreamingResult(null);
    setStreamingPreviewStatus("streaming");
    setStreamingPreviewVisible(true);

    setChapterStreaming(true);
    try {
      const result = await generateChapterStream(selectedProjectRef, chapterNumber, generationRequest, {
        onDelta: (text) => {
          setStreamingContent((current) => `${current}${text}`);
          setStreamingPreviewStatus("streaming");
        },
        onDone: (doneEvent) => {
          setStreamingResult(doneEvent);
          setStreamingPreviewStatus("saved");
          setStreamingError("");
        },
        onError: (error) => {
          setStreamingPreviewStatus("failed_unsaved");
          setStreamingError(`${safePublicMessage(error.message, "章节流式生成失败。")} 当前预览未保存。`);
        },
      });
      setStreamingResult(result);
      setStreamingPreviewStatus("saved");
      setGenerationMessage(chapterStreamSuccessMessage(result));
      await refreshProjectAndChapters(selectedProjectRef);
      const loaded = await loadChapterAfterGeneration(selectedProjectRef, result.chapter_number || chapterNumber);
      if (!loaded) {
        setGenerationError("章节已生成，但自动读取正文失败，请手动刷新或重新选择章节。");
      }
      await refreshGenerationStatus();
    } catch (error) {
      const message = publicErrorMessage(error, "章节流式生成失败。");
      setStreamingPreviewStatus("failed_unsaved");
      setStreamingError(`${message} 当前预览未保存。`);
      setGenerationError(message);
      await refreshGenerationStatus();
    } finally {
      setChapterStreaming(false);
    }
  }, [
    chapterNumberInput,
    ensureGenerationIdle,
    generationRequest,
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
    setStreamingContent("");
    setStreamingError("");
    setStreamingResult(null);
    setStreamingPreviewStatus("idle");
    setStreamingPreviewVisible(false);

    setChapterGenerating(true);
    try {
      const result = await generateChapter(selectedProjectRef, chapterNumber, generationRequest);
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
    generationRequest,
    loadChapterAfterGeneration,
    refreshGenerationStatus,
    refreshProjectAndChapters,
    selectedProjectRef,
  ]);

  const handleUpdateGenerationSettings = useCallback(
    async (settings: GenerationSettingsRequest) => {
      if (!selectedProjectRef) {
        throw new Error("请先选择项目。");
      }
      const result = await updateGenerationSettings(selectedProjectRef, settings);
      const detail = await getProject(selectedProjectRef);
      setProjectDetail(detail);
      await loadProjects();
      return result;
    },
    [loadProjects, selectedProjectRef],
  );

  const renderProjectListPanel = () => (
    <section className="panel project-list">
      <div className="panel-header">
        <div>
          <span className="section-kicker">Projects</span>
          <h2>项目列表</h2>
        </div>
        <button
          className="button secondary-button compact-button"
          type="button"
          onClick={() => void loadProjects()}
          disabled={projectsLoading || apiStatus !== "online"}
        >
          刷新
        </button>
      </div>

      {projectsLoading && <p className="state-text loading-text">正在加载项目...</p>}
      {projectsError && <p className="state-text error-text">{projectsError}</p>}
      {!projectsLoading && !projectsError && projects.length === 0 && (
        <p className="empty-state">暂无项目。可在创作页创建 workspace 小说项目。</p>
      )}

      <div className="project-items">
        {projects.map((project) => (
          <button
            className={`project-item ${project.project_ref === selectedProjectRef ? "selected" : ""}`}
            key={project.project_ref}
            type="button"
            onClick={() => setSelectedProjectRef(project.project_ref)}
          >
            <strong>{project.title || "未命名小说"}</strong>
            <span>{project.storage_type || "unknown"} · {project.updated_at || "无更新时间"}</span>
            <code>{project.project_ref}</code>
          </button>
        ))}
      </div>
    </section>
  );

  const renderChapterListPanel = () => (
    <section className="panel chapter-list-panel">
      <div className="panel-header">
        <div>
          <span className="section-kicker">Chapters</span>
          <h2>章节列表</h2>
        </div>
        {selectedProjectRef && (
          <a className="button secondary-button compact-button" href={exportFullBookUrl(selectedProjectRef)}>
            整本 TXT
          </a>
        )}
      </div>
      {chaptersLoading && <p className="state-text loading-text">正在加载章节...</p>}
      {chaptersError && <p className="state-text error-text">{chaptersError}</p>}
      {!chaptersLoading && !chaptersError && selectedProjectRef && chapters.length === 0 && (
        <p className="empty-state">当前项目暂无章节。可先到创作页生成大纲与人物卡，再生成第 1 章。</p>
      )}
      {!selectedProjectRef && <p className="empty-state">选择项目后显示章节。</p>}
      <div className="chapter-list">
        {chapters.map((chapter) => (
          <button
            className={`chapter-item ${chapter.chapter_number === selectedChapterNumber ? "selected" : ""}`}
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
  );

  const renderProjectDetailPanel = () => (
    <section className="panel project-detail">
      <div className="panel-header">
        <div>
          <span className="section-kicker">Project</span>
          <h2>当前项目</h2>
        </div>
      </div>
      {!selectedProjectRef && (
        <div className="empty-stack">
          <p className="empty-state">请选择一个项目继续创作；没有项目时，可先创建小说项目。</p>
          <ProjectCreatePanel
            open={newProjectPanelTarget === "detail"}
            onToggle={() => setNewProjectPanelTarget((current) => (current === "detail" ? "" : "detail"))}
            form={createProjectForm}
            onChange={updateCreateProjectForm}
            onSubmit={() => void handleCreateProject()}
            onCancel={handleCancelCreateProject}
            submitting={createProjectSubmitting}
            error={createProjectError}
            message={createProjectMessage}
            disabled={apiStatus !== "online"}
            variant="compact"
          />
        </div>
      )}
      {projectLoading && <p className="state-text loading-text">正在加载项目详情...</p>}
      {projectError && <p className="state-text error-text">{projectError}</p>}
      {selectedProject && projectDetail && (
        <div className="detail-grid">
          <div className="detail-item detail-item-wide">
            <span>标题</span>
            <strong>{projectDetail.title || selectedProject.title || "未命名小说"}</strong>
          </div>
          <div className="detail-item">
            <span>类型</span>
            <strong>{asText(configValue(projectConfig, "genre"))}</strong>
          </div>
          <div className="detail-item">
            <span>风格</span>
            <strong>{asText(configValue(projectConfig, "style"))}</strong>
          </div>
          <div className="detail-item">
            <span>写作模式</span>
            <strong>{asText(settingOptionValue(projectConfig, "writing_mode"))}</strong>
          </div>
          <div className="detail-item">
            <span>期望章节数</span>
            <strong>{asText(settingOptionValue(projectConfig, "expected_chapters"))}</strong>
          </div>
          <div className="detail-item detail-item-wide">
            <span>project_ref</span>
            <code>{projectDetail.project_ref}</code>
          </div>
        </div>
      )}
    </section>
  );

  const renderReaderPanel = () => (
    <section className="panel chapter-reader">
      <div className="reader-header">
        <div>
          <span className="section-kicker">Reader</span>
          <h2>{chapterContent?.title || selectedChapter?.title || "章节正文"}</h2>
          <p>{chapterContent?.filename || selectedChapter?.filename || "选择章节后显示正文，阅读区会保留舒适行宽。"}</p>
        </div>
        {selectedProjectRef && selectedChapterNumber !== null && (
          <a className="button secondary-button download-button" href={exportChapterUrl(selectedProjectRef, selectedChapterNumber)}>
            下载本章 TXT
          </a>
        )}
      </div>

      {chapterLoading && <p className="state-text loading-text">正在加载章节正文...</p>}
      {chapterError && <p className="state-text error-text">{chapterError}</p>}
      {!chapterLoading && !chapterError && chapterContent && <pre className="chapter-content">{chapterContent.content}</pre>}
      {!chapterLoading && !chapterError && selectedProjectRef && selectedChapterNumber === null && (
        <p className="empty-state">请选择一个章节。</p>
      )}
      {!chapterLoading && !chapterError && !selectedProjectRef && (
        <div className="empty-stack reader-empty-stack">
          <p className="empty-state">选择项目和章节后，这里显示正文。没有项目时，请先到创作页创建小说项目。</p>
          <button className="button secondary-button" type="button" onClick={() => setActivePage("create")}>
            前往创作页
          </button>
        </div>
      )}
    </section>
  );

  const renderGenerationPanel = () => (
    <aside className="tool-stack" aria-label="生成与状态">
      <section className="panel generation-panel">
        <div className="panel-header">
          <div>
            <span className="section-kicker">Draft control</span>
            <h2>单章生成</h2>
          </div>
          <button
            className="button secondary-button compact-button"
            type="button"
            onClick={() => void refreshGenerationStatus()}
            disabled={generationStatusLoading || apiStatus !== "online"}
          >
            刷新状态
          </button>
        </div>

        <div className="generation-actions">
          <button
            className="button secondary-button"
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
            className="button primary-button"
            type="button"
            onClick={() => void handleGenerateChapterStream()}
            disabled={!selectedProjectRef || apiStatus !== "online" || generationBusy}
          >
            {chapterStreaming ? "正在流式生成章节..." : "生成章节"}
          </button>
          <button
            className="button subtle-button"
            type="button"
            onClick={() => void handleGenerateChapter()}
            disabled={!selectedProjectRef || apiStatus !== "online" || generationBusy}
          >
            {chapterGenerating ? "正在同步生成章节..." : "同步生成（备用）"}
          </button>
        </div>
        <div className="hint-box">
          <p>默认使用流式生成；同步生成仅作为流式异常时的备用 / 调试入口。</p>
          <p>
            建议下一章：第 {suggestedChapterNumber} 章；模型：{generationRequest.model}；
            max_tokens：{generationRequest.max_tokens}；temperature：{generationRequest.temperature}
          </p>
          <p>如果生成内容明显中断，可提高 max_tokens 或重新生成该章节。</p>
        </div>
        {generationMessage && <p className="state-text success-text">{generationMessage}</p>}
        {generationError && <p className="state-text error-text">{generationError}</p>}
        {streamingPreviewVisible && (
          <section
            className={`streaming-preview ${
              streamingPreviewStatus === "saved"
                ? "streaming-preview-saved"
                : streamingPreviewStatus === "failed_unsaved"
                  ? "streaming-preview-error"
                  : ""
            }`}
            aria-live="polite"
          >
            <div className="streaming-preview-header">
              <div>
                <span className="section-kicker">Draft preview</span>
                <h3>手稿实时预览</h3>
                <p>{streamingCharacterCount} 字</p>
              </div>
              <span className={`streaming-status streaming-status-${streamingPreviewStatus}`}>
                {streamingStatusLabel(streamingPreviewStatus)}
              </span>
            </div>
            {streamingError && <p className="state-text error-text">{streamingError}</p>}
            {streamingPreviewStatus === "saved" && <p className="state-text success-text">{streamSaveSummary(streamingResult)}</p>}
            {streamingPreviewStatus === "saved" && streamingResult && (
              <dl className="saved-file-list">
                <div>
                  <dt>章节文件</dt>
                  <dd>{publicFileName(streamingResult.chapter_file) || "-"}</dd>
                </div>
                <div>
                  <dt>摘要文件</dt>
                  <dd>{publicFileName(streamingResult.summary_file) || "-"}</dd>
                </div>
              </dl>
            )}
            <pre className="streaming-content">
              {streamingContent || (streamingPreviewStatus === "streaming" ? "等待模型返回正文..." : "暂无预览内容。")}
            </pre>
          </section>
        )}
      </section>

      {apiStatus === "online" && (
        <section className={`panel generation-status-card ${generationStatusClass(generationStatus)}`} aria-live="polite">
          <div className="panel-header">
            <div>
              <span className="section-kicker">Status</span>
              <h2>生成状态</h2>
            </div>
            <span className="status-badge">{generationStatusLoading ? "Loading" : generationStatusText(generationStatus)}</span>
          </div>
          <div className="status-grid">
            <div>
              <span>任务类型</span>
              <strong>{generationStatus?.task_type || "-"}</strong>
            </div>
            <div>
              <span>目标章节</span>
              <strong>{generationStatus?.target || "-"}</strong>
            </div>
            <div>
              <span>开始时间</span>
              <strong>{generationStatus?.started_at || "-"}</strong>
            </div>
            <div>
              <span>完成时间</span>
              <strong>{generationStatus?.finished_at || "-"}</strong>
            </div>
            <div className="status-grid-wide">
              <span>最近保存</span>
              <strong>{generationSavedFiles(generationStatus?.last_result ?? null)}</strong>
            </div>
          </div>
          {generationStatusError && <p className="state-text error-text">状态读取失败：{generationStatusError}</p>}
          {!generationStatusError && generationStatus?.last_error && (
            <p className="state-text error-text">最近错误：{safePublicMessage(generationStatus.last_error, "生成失败。")}</p>
          )}
          {!generationStatusError && !generationStatus?.last_error && generationStatus?.last_result && (
            <p className="state-text success-text">最近结果：{generationResultSummary(generationStatus.last_result)}</p>
          )}
        </section>
      )}
    </aside>
  );

  const renderCreatePage = () => (
    <section className="workspace-layout workspace-page create-layout">
      <aside className="sidebar-stack" aria-label="项目导航">
        <ProjectCreatePanel
          open={newProjectPanelTarget === "sidebar"}
          onToggle={() => setNewProjectPanelTarget((current) => (current === "sidebar" ? "" : "sidebar"))}
          form={createProjectForm}
          onChange={updateCreateProjectForm}
          onSubmit={() => void handleCreateProject()}
          onCancel={handleCancelCreateProject}
          submitting={createProjectSubmitting}
          error={createProjectError}
          message={createProjectMessage}
          disabled={apiStatus !== "online"}
        />
        {renderProjectListPanel()}
      </aside>

      <section className="main-stack">
        {renderProjectDetailPanel()}
        <ProjectOnboardingPanel
          state={projectOnboardingState}
          suggestedChapterNumber={suggestedChapterNumber}
          generationBusy={generationBusy}
          apiStatus={apiStatus}
          onGenerateAssets={() => void handleGenerateOutlineCharacters()}
          onGenerateChapter={(chapterNumber) => void handleGenerateChapterStream(chapterNumber)}
        />
      </section>

      {renderGenerationPanel()}
    </section>
  );

  const renderReadPage = () => (
    <section className="workspace-layout workspace-page read-layout">
      <aside className="sidebar-stack" aria-label="项目与章节导航">
        {renderProjectListPanel()}
        {renderChapterListPanel()}
      </aside>
      <section className="reader-main-stack">{renderReaderPanel()}</section>
    </section>
  );

  const renderActivePage = () => {
    if (activePage === "home") {
      return <HomePage apiStatus={apiStatus} selectedProject={selectedProject} onNavigate={setActivePage} />;
    }
    if (activePage === "create") {
      return renderCreatePage();
    }
    if (activePage === "read") {
      return renderReadPage();
    }
    if (activePage === "library") {
      return <LibraryPage selectedProject={selectedProject} />;
    }
    if (activePage === "projectSettings") {
      return (
        <ProjectSettingsPage
          selectedProject={selectedProject}
          projectDetail={projectDetail}
          projectLoading={projectLoading}
          projectError={projectError}
          apiStatus={apiStatus}
          onSaveGenerationSettings={handleUpdateGenerationSettings}
        />
      );
    }
    return (
      <SystemSettingsPage
        apiStatus={apiStatus}
        apiError={apiError}
        apiBaseUrl={API_BASE_URL}
        generationStatus={generationStatus}
        generationStatusLoading={generationStatusLoading}
        generationStatusError={generationStatusError}
        onRefreshGenerationStatus={() => void refreshGenerationStatus()}
        onOpenCreatePage={() => setActivePage("create")}
      />
    );
  };

  return (
    <main className={`app-shell app-shell-${activePage}`}>
      <AppHeader activePage={activePage} apiStatus={apiStatus} onNavigate={setActivePage} />

      {apiStatus === "offline" && (
        <section className="notice error-notice">
          <strong>无法连接 API。</strong>
          <span>{apiError || "请先启动 FastAPI 后端服务。"}</span>
          <code>python -m uvicorn api.main:app --host 127.0.0.1 --port 8000</code>
          <span>当前 API 地址：{API_BASE_URL}</span>
        </section>
      )}

      {renderActivePage()}
    </main>
  );
}
