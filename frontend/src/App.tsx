import { useCallback, useEffect, useMemo, useState } from "react";

import {
  API_BASE_URL,
  analyzeStoryDelta,
  checkWorkflowGuard,
  createProject,
  exportChapterUrl,
  exportFullBookUrl,
  generateChapter,
  generateChapterStream,
  generateOutlineCharacters,
  getChapter,
  getChapterFunctionReview,
  getChapters,
  getChapterStatus,
  getGenerationStatus,
  getHealth,
  getProject,
  getProjects,
  previewContextPack,
  updateGenerationSettings,
  ApiRequestError,
  safePublicMessage,
} from "./api";
import { AppHeader, type ActivePage } from "./components/AppHeader";
import { ChapterStatusPanel } from "./components/ChapterStatusPanel";
import { ChapterTaskSheetPanel } from "./components/ChapterTaskSheetPanel";
import { ContextPackCreatorPreview } from "./components/ContextPackCreatorPreview";
import { DebugDrawer } from "./components/DebugDrawer";
import { EffectiveInputsSummary } from "./components/EffectiveInputsSummary";
import { LibraryPage } from "./components/LibraryPage";
import { NoRevealReviewPanel } from "./components/NoRevealReviewPanel";
import { ProjectSettingsPage } from "./components/ProjectSettingsPage";
import { ScenePlanPanel } from "./components/ScenePlanPanel";
import { SystemSettingsPage } from "./components/SystemSettingsPage";
import { WorkflowRail, type WorkflowRailStep } from "./components/WorkflowRail";
import type {
  ApiStatus,
  ChapterContent,
  ChapterGenerationResponse,
  ChapterFunctionReviewResponse,
  ChapterSummary,
  ChapterStatus,
  ChapterTaskSheet,
  ChapterStreamDoneEvent,
  ConsistencyWarning,
  ContextPackPreviewRequest,
  ContextPackPreviewResponse,
  CreateProjectRequest,
  GenerationRequest,
  GenerationSettingsRequest,
  GenerationStatus,
  OutlineCharactersGenerationResponse,
  ProjectOnboardingState,
  ProjectDetail,
  ProjectSummary,
  ScenePlan,
  StoryDeltaAnalyzeResponse,
  WorkflowGuardWarning,
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

const DEFAULT_CONTEXT_PACK_FORM: ContextPackPreviewRequest = {
  chapter_number: 1,
  chapter_goal: "",
  min_importance: 5,
  max_nodes: 20,
  max_edges: 30,
  include_unresolved_foreshadowing: true,
  include_neighbors: true,
};

type StreamingPreviewStatus = "idle" | "streaming" | "saved" | "failed_unsaved";
type CreateProjectPanelTarget = "" | "sidebar" | "detail" | "reader";
type ContextPackUsageSummary = {
  nodeCount: number | null;
  edgeCount: number | null;
  hardConstraintCount: number | null;
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

function countValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function contextItemImportance(item: { importance?: unknown }): number | null {
  const value = item.importance;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isHardContextItem(item: { status?: unknown; importance?: unknown }): boolean {
  return String(item.status || "").trim().toLowerCase() === "confirmed" && (contextItemImportance(item) ?? 0) >= 8;
}

function contextPackUsageSummary(preview: ContextPackPreviewResponse | null): ContextPackUsageSummary {
  const pack = preview?.context_pack;
  if (!pack) {
    return { nodeCount: null, edgeCount: null, hardConstraintCount: null };
  }

  const nodes = Array.isArray(pack.selected_nodes) ? pack.selected_nodes : [];
  const edges = Array.isArray(pack.selected_edges) ? pack.selected_edges : [];
  const nodeCount = countValue(pack.stats?.nodes_selected) ?? nodes.length;
  const edgeCount = countValue(pack.stats?.edges_selected) ?? edges.length;
  const hardConstraintCount =
    Array.isArray(pack.selected_nodes) && Array.isArray(pack.selected_edges)
      ? [...nodes, ...edges].filter(isHardContextItem).length
      : null;

  return { nodeCount, edgeCount, hardConstraintCount };
}

function displayCount(value: number | null): string {
  return value === null ? "未知" : `${value} 条`;
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

function consistencyWarningTypeLabel(code: string): string {
  if (code === "possible_date_conflict") {
    return "日期 / 时间冲突";
  }
  if (code === "possible_life_state_conflict") {
    return "死亡 / 存活状态冲突";
  }
  if (code === "possible_identity_state_conflict") {
    return "身份状态冲突";
  }
  if (code === "possible_organization_affiliation_conflict") {
    return "组织归属冲突";
  }
  return "一致性提醒";
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

function jsonPreview(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value ?? "");
  }
}

function storyDeltaItemCount(result: StoryDeltaAnalyzeResponse | null): number {
  if (!result) {
    return 0;
  }
  return Object.values(result.story_delta || {}).reduce((total, value) => {
    return total + (Array.isArray(value) ? value.length : 0);
  }, 0);
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
            React 会创建 workspace 项目；创建项目不会调用模型。Braipen 的正式入口是
            <code>start-react.bat</code>；<code>start.bat</code> 仅作为废弃兼容跳转。
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
  const [activePage, setActivePage] = useState<ActivePage>("dashboard");
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
  const [chapterStatus, setChapterStatus] = useState<ChapterStatus | null>(null);
  const [chapterStatusLoading, setChapterStatusLoading] = useState(false);
  const [chapterStatusError, setChapterStatusError] = useState("");
  const [noRevealReview, setNoRevealReview] = useState<ChapterFunctionReviewResponse | null>(null);
  const [noRevealReviewLoading, setNoRevealReviewLoading] = useState(false);
  const [noRevealReviewError, setNoRevealReviewError] = useState("");
  const [workflowGuardWarnings, setWorkflowGuardWarnings] = useState<WorkflowGuardWarning[]>([]);
  const [consistencyWarnings, setConsistencyWarnings] = useState<ConsistencyWarning[]>([]);
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
  const [contextPackForm, setContextPackForm] = useState<ContextPackPreviewRequest>(DEFAULT_CONTEXT_PACK_FORM);
  const [contextPackPreview, setContextPackPreview] = useState<ContextPackPreviewResponse | null>(null);
  const [contextPackLoading, setContextPackLoading] = useState(false);
  const [contextPackError, setContextPackError] = useState("");
  const [contextPackPromptExpanded, setContextPackPromptExpanded] = useState(false);
  const [useContextPackForGeneration, setUseContextPackForGeneration] = useState(false);
  const [storyDeltaChapterInput, setStoryDeltaChapterInput] = useState("1");
  const [storyDeltaIncludeNext, setStoryDeltaIncludeNext] = useState(true);
  const [storyDeltaIncludeDraft, setStoryDeltaIncludeDraft] = useState(true);
  const [storyDeltaDryRun, setStoryDeltaDryRun] = useState(true);
  const [storyDeltaLoading, setStoryDeltaLoading] = useState(false);
  const [storyDeltaError, setStoryDeltaError] = useState("");
  const [storyDeltaMessage, setStoryDeltaMessage] = useState("");
  const [storyDeltaResult, setStoryDeltaResult] = useState<StoryDeltaAnalyzeResponse | null>(null);
  const [approvedChapterTask, setApprovedChapterTask] = useState<ChapterTaskSheet | null>(null);
  const [latestChapterTaskDraft, setLatestChapterTaskDraft] = useState<ChapterTaskSheet | null>(null);
  const [approvedScenePlan, setApprovedScenePlan] = useState<ScenePlan | null>(null);
  const [latestScenePlanDraft, setLatestScenePlanDraft] = useState<ScenePlan | null>(null);

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

  const contextPackSummary = useMemo(() => contextPackUsageSummary(contextPackPreview), [contextPackPreview]);
  const contextPackPromptText = contextPackPreview?.prompt_text?.trim() ?? "";
  const contextPackHasPreview = Boolean(contextPackPreview);
  const contextPackCanInject = Boolean(contextPackPromptText);
  const contextPackWillBeUsed = Boolean(useContextPackForGeneration && contextPackCanInject);
  const suggestedChapterNumber = useMemo(() => nextChapterSuggestion(chapters), [chapters]);
  const currentChapterNumber = Number.parseInt(chapterNumberInput, 10);
  const validCurrentChapterNumber = Number.isInteger(currentChapterNumber) && currentChapterNumber > 0 ? currentChapterNumber : 1;
  const currentChapterExists = chapters.some((chapter) => chapter.chapter_number === validCurrentChapterNumber);
  const streamingCharacterCount = streamingContent.length;
  const generationBusy =
    Boolean(generationStatus?.running) || outlineGenerating || chapterGenerating || chapterStreaming;
  const projectOnboardingState = useMemo(
    () => onboardingStateForProject(selectedProjectRef, chapters, assetReadyProjectRefs),
    [assetReadyProjectRefs, chapters, selectedProjectRef],
  );
  const projectConfig = projectDetail?.config;
  const generationRequest = useMemo(() => generationRequestFromConfig(projectConfig), [projectConfig]);

  useEffect(() => {
    setContextPackPreview(null);
    setContextPackError("");
    setContextPackPromptExpanded(false);
    setUseContextPackForGeneration(false);
    setStoryDeltaResult(null);
    setStoryDeltaError("");
    setStoryDeltaMessage("");
    setChapterStatus(null);
    setChapterStatusError("");
    setWorkflowGuardWarnings([]);
    setConsistencyWarnings([]);
    setApprovedChapterTask(null);
    setLatestChapterTaskDraft(null);
    setApprovedScenePlan(null);
    setLatestScenePlanDraft(null);
  }, [selectedProjectRef]);

  const handleChapterTaskStateChange = useCallback((approved: ChapterTaskSheet | null, latestDraft: ChapterTaskSheet | null) => {
    setApprovedChapterTask(approved);
    setLatestChapterTaskDraft(latestDraft);
  }, []);

  const handleScenePlanStateChange = useCallback((approved: ScenePlan | null, latestDraft: ScenePlan | null) => {
    setApprovedScenePlan(approved);
    setLatestScenePlanDraft(latestDraft);
  }, []);

  const contextPackState = contextPackWillBeUsed
    ? "attached"
    : contextPackHasPreview && contextPackCanInject
      ? "available"
      : contextPackHasPreview
        ? "not_ready"
        : "unknown";

  const scenePlanBoundToApprovedTask = Boolean(
    approvedScenePlan &&
      approvedChapterTask &&
      approvedScenePlan.source_chapter_task_id === approvedChapterTask.id &&
      approvedScenePlan.source_chapter_task_revision === approvedChapterTask.revision,
  );
  const latestWorkflowReview = chapterStatus?.latest_function_review ?? noRevealReview?.latest ?? null;
  const latestWorkflowReviewVerdict = String(latestWorkflowReview?.verdict || "").toLowerCase();
  const noRevealReviewFailed = latestWorkflowReviewVerdict === "fail";
  const noRevealReviewWarn = latestWorkflowReviewVerdict === "warn";

  const effectiveInputWarnings = useMemo(() => {
    const warnings: string[] = [];
    if (!approvedChapterTask && latestChapterTaskDraft) {
      warnings.push("Chapter Task draft exists, but no approved task will be used.");
    }
    if (!approvedScenePlan && latestScenePlanDraft) {
      warnings.push("Scene Plan draft exists, but no approved Scene Plan will be used.");
    }
    if (approvedScenePlan && approvedChapterTask && !scenePlanBoundToApprovedTask) {
      warnings.push("Approved Scene Plan is not bound to the current approved Chapter Task.");
    }
    if (!contextPackWillBeUsed) {
      warnings.push("Context Pack is not attached to generation.");
    }
    return warnings;
  }, [
    approvedChapterTask,
    approvedScenePlan,
    contextPackWillBeUsed,
    latestChapterTaskDraft,
    latestScenePlanDraft,
    scenePlanBoundToApprovedTask,
  ]);

  const workflowSteps: WorkflowRailStep[] = useMemo(() => {
    const taskReady = Boolean(approvedChapterTask);
    const sceneReady = Boolean(approvedScenePlan);
    const contextReady = Boolean(contextPackWillBeUsed);
    const reviewPending = Boolean((chapterStatus?.review?.pending_count ?? 0) > 0);
    const reviewFailed = latestWorkflowReviewVerdict === "fail";
    const reviewWarned = latestWorkflowReviewVerdict === "warn";
    const reviewPassed = latestWorkflowReviewVerdict === "pass";
    const reviewStatus: WorkflowRailStep["status"] = reviewFailed || reviewWarned
      ? "warning"
      : reviewPending
        ? "warning"
        : reviewPassed && currentChapterExists
          ? "done"
          : currentChapterExists
            ? "current"
            : "pending";
    const reviewDescription = reviewFailed
      ? "No-Reveal review failed. Manual review is required before treating this chapter as trusted context."
      : reviewWarned
        ? "No-Reveal review has warnings. Review evidence before continuing."
        : reviewPending
          ? "Review queue has pending items."
          : reviewPassed
            ? "No-Reveal review passed. Continue Review / Merge as appropriate."
            : "Inspect Story Delta and Knowledge Drafts after generation.";
    return [
      {
        key: "task",
        label: "Plan Task",
        status: taskReady ? "done" : latestChapterTaskDraft ? "warning" : "current",
        description: taskReady ? "Approved Chapter Task is active." : "Approve the chapter task before generation.",
      },
      {
        key: "scene",
        label: "Plan Scenes",
        status: sceneReady ? "done" : latestScenePlanDraft ? "warning" : taskReady ? "current" : "pending",
        description: sceneReady ? "Approved Scene Plan is active." : "Draft scenes do not enter generation.",
      },
      {
        key: "context",
        label: "Prepare Context",
        status: contextReady ? "done" : contextPackHasPreview ? "warning" : sceneReady ? "current" : "pending",
        description: contextReady ? "Context Pack will be attached." : "Preview and attach Context Pack when needed.",
      },
      {
        key: "generate",
        label: "Generate Draft",
        status: currentChapterExists ? "done" : contextReady || sceneReady ? "current" : "pending",
        description: currentChapterExists ? "A chapter file exists for this number." : "Generate only after effective inputs are clear.",
      },
      {
        key: "review",
        label: "Review Output",
        status: reviewStatus,
        description: reviewDescription,
      },
      {
        key: "memory",
        label: "Merge Memory",
        status: chapterStatus?.knowledge_drafts?.status === "accepted" ? "done" : reviewPending ? "current" : "pending",
        description: "Accepted changes become formal Memory.",
      },
    ];
  }, [
    approvedChapterTask,
    approvedScenePlan,
    chapterStatus,
    contextPackHasPreview,
    contextPackWillBeUsed,
    currentChapterExists,
    latestChapterTaskDraft,
    latestScenePlanDraft,
    latestWorkflowReviewVerdict,
  ]);

  const nextActions = useMemo(() => {
    if (chapterStatus?.next_actions && chapterStatus.next_actions.length > 0) {
      return chapterStatus.next_actions;
    }
    if (noRevealReviewFailed) {
      return [
        "当前章节 No-Reveal 审核失败，请人工复核。",
        "不建议直接进入下一章。",
        "不建议将本章作为可信上下文继续推进，除非你确认接受风险。",
      ];
    }
    if (noRevealReviewWarn) {
      return ["当前章节存在 No-Reveal 风险，请快速复核 evidence。"];
    }
    if (!approvedChapterTask) {
      return [latestChapterTaskDraft ? "Approve Chapter Task Sheet." : "Create and approve Chapter Task Sheet."];
    }
    if (!approvedScenePlan) {
      return [latestScenePlanDraft ? "Approve Scene Plan." : "Create and approve Scene Plan."];
    }
    if (!contextPackWillBeUsed) {
      return ["Prepare and attach Context Pack."];
    }
    if (!currentChapterExists) {
      return ["Generate chapter draft."];
    }
    return ["Check Review after generation.", "Merge accepted memory changes."];
  }, [
    approvedChapterTask,
    approvedScenePlan,
    chapterStatus,
    contextPackWillBeUsed,
    currentChapterExists,
    latestChapterTaskDraft,
    latestScenePlanDraft,
    noRevealReviewFailed,
    noRevealReviewWarn,
  ]);

  useEffect(() => {
    const parsed = Number.parseInt(chapterNumberInput, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      setContextPackForm((current) => ({ ...current, chapter_number: parsed }));
    }
  }, [chapterNumberInput]);

  useEffect(() => {
    const number = selectedChapterNumber ?? Number.parseInt(chapterNumberInput, 10);
    if (Number.isInteger(number) && number > 0) {
      setStoryDeltaChapterInput(String(number));
    }
  }, [chapterNumberInput, selectedChapterNumber]);

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

  const refreshChapterStatus = useCallback(
    async (chapterNumber?: number) => {
      if (!selectedProjectRef) {
        setChapterStatus(null);
        setChapterStatusError("");
        return null;
      }
      const number = chapterNumber ?? Number.parseInt(chapterNumberInput, 10);
      if (!Number.isInteger(number) || number < 1) {
        setChapterStatus(null);
        setChapterStatusError("");
        return null;
      }
      setChapterStatusLoading(true);
      setChapterStatusError("");
      try {
        const result = await getChapterStatus(selectedProjectRef, number);
        setChapterStatus(result.chapter_status);
        return result.chapter_status;
      } catch (error) {
        setChapterStatus(null);
        setChapterStatusError(publicErrorMessage(error, "Chapter status load failed."));
        return null;
      } finally {
        setChapterStatusLoading(false);
      }
    },
    [chapterNumberInput, selectedProjectRef],
  );

  const refreshNoRevealReview = useCallback(
    async (chapterNumber?: number) => {
      if (!selectedProjectRef) {
        setNoRevealReview(null);
        setNoRevealReviewError("");
        return null;
      }
      const number = chapterNumber ?? Number.parseInt(chapterNumberInput, 10);
      if (!Number.isInteger(number) || number < 1) {
        setNoRevealReview(null);
        setNoRevealReviewError("");
        return null;
      }
      setNoRevealReviewLoading(true);
      setNoRevealReviewError("");
      try {
        const result = await getChapterFunctionReview(selectedProjectRef, number);
        setNoRevealReview(result);
        return result;
      } catch (error) {
        setNoRevealReview(null);
        setNoRevealReviewError(publicErrorMessage(error, "No-Reveal review load failed."));
        return null;
      } finally {
        setNoRevealReviewLoading(false);
      }
    },
    [chapterNumberInput, selectedProjectRef],
  );

  useEffect(() => {
    setWorkflowGuardWarnings([]);
    if (apiStatus === "online") {
      void refreshChapterStatus();
      void refreshNoRevealReview();
    }
  }, [apiStatus, chapterNumberInput, refreshChapterStatus, refreshNoRevealReview]);

  useEffect(() => {
    if (apiStatus !== "online" || !selectedProjectRef) {
      setNoRevealReview(null);
      setNoRevealReviewError("");
    }
  }, [apiStatus, selectedProjectRef]);

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
    setConsistencyWarnings([]);
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

  const buildContextPackPayload = useCallback((): ContextPackPreviewRequest | null => {
    const chapterNumber = Number.parseInt(String(contextPackForm.chapter_number), 10);
    const minImportance = Number.parseInt(String(contextPackForm.min_importance), 10);
    const maxNodes = Number.parseInt(String(contextPackForm.max_nodes), 10);
    const maxEdges = Number.parseInt(String(contextPackForm.max_edges), 10);
    if (!Number.isInteger(chapterNumber) || chapterNumber < 1) {
      setContextPackError("chapter_number must be a positive integer.");
      return null;
    }
    if (!Number.isInteger(minImportance) || minImportance < 1 || minImportance > 10) {
      setContextPackError("min_importance must be between 1 and 10.");
      return null;
    }
    if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 100) {
      setContextPackError("max_nodes must be between 1 and 100.");
      return null;
    }
    if (!Number.isInteger(maxEdges) || maxEdges < 0 || maxEdges > 200) {
      setContextPackError("max_edges must be between 0 and 200.");
      return null;
    }
    return {
      chapter_number: chapterNumber,
      chapter_goal: contextPackForm.chapter_goal,
      min_importance: minImportance,
      max_nodes: maxNodes,
      max_edges: maxEdges,
      include_unresolved_foreshadowing: contextPackForm.include_unresolved_foreshadowing,
      include_neighbors: contextPackForm.include_neighbors,
    };
  }, [contextPackForm]);

  const handlePreviewContextPack = useCallback(async () => {
    if (!selectedProjectRef) {
      setContextPackError("Please select a workspace project before building a context pack.");
      return;
    }
    if (apiStatus !== "online") {
      setContextPackError("API Offline. Start FastAPI before previewing the context pack.");
      return;
    }
    const payload = buildContextPackPayload();
    if (!payload) {
      return;
    }
    setContextPackLoading(true);
    setContextPackError("");
    try {
      const result = await previewContextPack(selectedProjectRef, payload);
      setContextPackPreview(result);
      setContextPackPromptExpanded(false);
    } catch (error) {
      setContextPackPreview(null);
      setContextPackError(publicErrorMessage(error, "Context pack preview failed."));
    } finally {
      setContextPackLoading(false);
    }
  }, [apiStatus, buildContextPackPayload, selectedProjectRef]);

  const handleAnalyzeStoryDelta = useCallback(async () => {
    if (!selectedProjectRef) {
      setStoryDeltaError("Please select a workspace project before analyzing chapter changes.");
      return;
    }
    if (apiStatus !== "online") {
      setStoryDeltaError("API Offline. Start FastAPI before analyzing Story Delta.");
      return;
    }
    const chapterNumber = Number.parseInt(storyDeltaChapterInput, 10);
    if (!Number.isInteger(chapterNumber) || chapterNumber < 1) {
      setStoryDeltaError("chapter_number must be a positive integer.");
      return;
    }
    if (!chapters.some((chapter) => chapter.chapter_number === chapterNumber)) {
      setStoryDeltaError(`Chapter ${chapterNumber} does not exist in the current project.`);
      return;
    }

    setStoryDeltaLoading(true);
    setStoryDeltaError("");
    setStoryDeltaMessage("");
    try {
      const result = await analyzeStoryDelta(selectedProjectRef, chapterNumber, {
        include_next_chapter_proposal: storyDeltaIncludeNext,
        include_knowledge_draft: storyDeltaIncludeDraft,
        dry_run: storyDeltaDryRun,
        context_pack_summary: contextPackPreview?.prompt_text || "",
      });
      setStoryDeltaResult(result);
      setStoryDeltaMessage(
        storyDeltaDryRun
          ? "Dry-run analysis saved as pending_review draft. No DeepSeek call was made."
          : "Story Delta analysis saved as pending_review draft.",
      );
      await refreshChapterStatus(chapterNumber);
    } catch (error) {
      setStoryDeltaResult(null);
      setStoryDeltaError(publicErrorMessage(error, "Story Delta analysis failed."));
    } finally {
      setStoryDeltaLoading(false);
    }
  }, [
    apiStatus,
    chapters,
    contextPackPreview,
    selectedProjectRef,
    storyDeltaChapterInput,
    storyDeltaDryRun,
    storyDeltaIncludeDraft,
    storyDeltaIncludeNext,
    refreshChapterStatus,
  ]);

  const generationRequestWithOptionalContext = useCallback((chapterNumber: number): GenerationRequest => {
    const promptText = contextPackPreview?.prompt_text?.trim();
    const request: GenerationRequest = { ...generationRequest };
    if (useContextPackForGeneration && promptText) {
      request.narrative_context_text = promptText;
    }
    if (approvedChapterTask?.chapter_number === chapterNumber) {
      request.chapter_task_id = approvedChapterTask.id;
    }
    if (approvedScenePlan?.chapter_number === chapterNumber) {
      request.scene_plan_id = approvedScenePlan.id;
    }
    return request;
  }, [approvedChapterTask, approvedScenePlan, contextPackPreview, generationRequest, useContextPackForGeneration]);

  const runGenerateChapterGuard = useCallback(
    async (chapterNumber: number) => {
      if (!selectedProjectRef) {
        return false;
      }
      try {
        const result = await checkWorkflowGuard(selectedProjectRef, {
          action: "generate_chapter",
          chapter_number: chapterNumber,
        });
        setWorkflowGuardWarnings(result.warnings || []);
        return !result.blocking;
      } catch (error) {
        setGenerationError(publicErrorMessage(error, "Workflow guard check failed."));
        return false;
      }
    },
    [selectedProjectRef],
  );

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
    if (!(await runGenerateChapterGuard(chapterNumber))) {
      return;
    }
    setStreamingContent("");
    setStreamingError("");
    setStreamingResult(null);
    setConsistencyWarnings([]);
    setStreamingPreviewStatus("streaming");
    setStreamingPreviewVisible(true);

    setChapterStreaming(true);
    try {
      const result = await generateChapterStream(selectedProjectRef, chapterNumber, generationRequestWithOptionalContext(chapterNumber), {
        onDelta: (text) => {
          setStreamingContent((current) => `${current}${text}`);
          setStreamingPreviewStatus("streaming");
        },
        onDone: (doneEvent) => {
          setStreamingResult(doneEvent);
          setConsistencyWarnings(doneEvent.consistency_warnings || []);
          setStreamingPreviewStatus("saved");
          setStreamingError("");
        },
        onError: (error) => {
          setStreamingPreviewStatus("failed_unsaved");
          setStreamingError(`${safePublicMessage(error.message, "章节流式生成失败。")} 当前预览未保存。`);
        },
      });
      setStreamingResult(result);
      setConsistencyWarnings(result.consistency_warnings || []);
      setStreamingPreviewStatus("saved");
      setGenerationMessage(chapterStreamSuccessMessage(result));
      await refreshProjectAndChapters(selectedProjectRef);
      const loaded = await loadChapterAfterGeneration(selectedProjectRef, result.chapter_number || chapterNumber);
      if (!loaded) {
        setGenerationError("章节已生成，但自动读取正文失败，请手动刷新或重新选择章节。");
      }
      await refreshGenerationStatus();
      await refreshChapterStatus(result.chapter_number || chapterNumber);
      await refreshNoRevealReview(result.chapter_number || chapterNumber);
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
    generationRequestWithOptionalContext,
    loadChapterAfterGeneration,
    refreshGenerationStatus,
    refreshChapterStatus,
    refreshNoRevealReview,
    refreshProjectAndChapters,
    runGenerateChapterGuard,
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
    if (!(await runGenerateChapterGuard(chapterNumber))) {
      return;
    }
    setStreamingContent("");
    setStreamingError("");
    setStreamingResult(null);
    setConsistencyWarnings([]);
    setStreamingPreviewStatus("idle");
    setStreamingPreviewVisible(false);

    setChapterGenerating(true);
    try {
      const result = await generateChapter(selectedProjectRef, chapterNumber, generationRequestWithOptionalContext(chapterNumber));
      setConsistencyWarnings(result.consistency_warnings || []);
      setGenerationMessage(chapterSuccessMessage(result));
      await refreshProjectAndChapters(selectedProjectRef);
      const loaded = await loadChapterAfterGeneration(selectedProjectRef, result.chapter_number || chapterNumber);
      if (!loaded) {
        setGenerationError("章节已生成，但自动读取正文失败，请手动刷新或重新选择章节。");
      }
      await refreshGenerationStatus();
      await refreshChapterStatus(result.chapter_number || chapterNumber);
      await refreshNoRevealReview(result.chapter_number || chapterNumber);
    } catch (error) {
      setGenerationError(publicErrorMessage(error, "章节生成失败。"));
      await refreshGenerationStatus();
    } finally {
      setChapterGenerating(false);
    }
  }, [
    chapterNumberInput,
    ensureGenerationIdle,
    generationRequestWithOptionalContext,
    loadChapterAfterGeneration,
    refreshGenerationStatus,
    refreshChapterStatus,
    refreshNoRevealReview,
    refreshProjectAndChapters,
    runGenerateChapterGuard,
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
          <button className="button secondary-button" type="button" onClick={() => setActivePage("writing")}>
            前往创作页
          </button>
        </div>
      )}
    </section>
  );

  const renderContextPackPanel = () => {
    const pack = contextPackPreview?.context_pack ?? null;
    const promptText = contextPackPreview?.prompt_text?.trim() ?? "";
    const contextWillBeUsed = Boolean(useContextPackForGeneration && promptText);
    return (
      <section className="panel context-pack-panel">
        <div className="panel-header">
          <div>
            <span className="section-kicker">Narrative Context</span>
            <h2>叙事上下文包</h2>
          </div>
          <span className={`status-badge ${contextWillBeUsed ? "status-badge-online" : ""}`}>
            {contextWillBeUsed ? "Enabled" : "Preview only"}
          </span>
        </div>

        <div className="context-pack-form">
          <label className="field-stack field-stack-wide">
            <span>chapter_goal</span>
            <textarea
              value={contextPackForm.chapter_goal}
              onChange={(event) =>
                setContextPackForm((current) => ({ ...current, chapter_goal: event.target.value }))
              }
              placeholder="例如：主角进入废弃剧场后台，寻找灰剧团留下的线索。"
              disabled={!selectedProjectRef || contextPackLoading}
            />
          </label>
          <label className="field-stack">
            <span>chapter_number</span>
            <input
              type="number"
              min="1"
              step="1"
              value={contextPackForm.chapter_number}
              onChange={(event) =>
                setContextPackForm((current) => ({ ...current, chapter_number: Number(event.target.value) || 1 }))
              }
              disabled={!selectedProjectRef || contextPackLoading}
            />
          </label>
          <label className="field-stack">
            <span>min_importance</span>
            <input
              type="number"
              min="1"
              max="10"
              step="1"
              value={contextPackForm.min_importance}
              onChange={(event) =>
                setContextPackForm((current) => ({ ...current, min_importance: Number(event.target.value) || 1 }))
              }
              disabled={!selectedProjectRef || contextPackLoading}
            />
          </label>
          <label className="field-stack">
            <span>max_nodes</span>
            <input
              type="number"
              min="1"
              max="100"
              step="1"
              value={contextPackForm.max_nodes}
              onChange={(event) =>
                setContextPackForm((current) => ({ ...current, max_nodes: Number(event.target.value) || 1 }))
              }
              disabled={!selectedProjectRef || contextPackLoading}
            />
          </label>
          <label className="field-stack">
            <span>max_edges</span>
            <input
              type="number"
              min="0"
              max="200"
              step="1"
              value={contextPackForm.max_edges}
              onChange={(event) =>
                setContextPackForm((current) => ({ ...current, max_edges: Number(event.target.value) || 0 }))
              }
              disabled={!selectedProjectRef || contextPackLoading}
            />
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={contextPackForm.include_unresolved_foreshadowing}
              onChange={(event) =>
                setContextPackForm((current) => ({
                  ...current,
                  include_unresolved_foreshadowing: event.target.checked,
                }))
              }
              disabled={!selectedProjectRef || contextPackLoading}
            />
            <span>include unresolved foreshadowing</span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={contextPackForm.include_neighbors}
              onChange={(event) =>
                setContextPackForm((current) => ({ ...current, include_neighbors: event.target.checked }))
              }
              disabled={!selectedProjectRef || contextPackLoading}
            />
            <span>include graph neighbors</span>
          </label>
        </div>

        <div className="context-pack-actions">
          <button
            className="button secondary-button"
            type="button"
            onClick={() => void handlePreviewContextPack()}
            disabled={!selectedProjectRef || apiStatus !== "online" || contextPackLoading}
          >
            {contextPackLoading ? "正在生成预览..." : "生成上下文包预览"}
          </button>
          <label className="checkbox-row context-pack-toggle">
            <input
              type="checkbox"
              checked={useContextPackForGeneration}
              onChange={(event) => setUseContextPackForGeneration(event.target.checked)}
              disabled={!promptText}
            />
            <span>使用叙事上下文包辅助生成</span>
          </label>
        </div>

        {!selectedProjectRef && <p className="empty-state">请先在创作页创建或选择一个 workspace 项目。</p>}
        {apiStatus !== "online" && <p className="state-text error-text">API Offline. 无法预览 context pack。</p>}
        {contextPackError && <p className="state-text error-text">{contextPackError}</p>}
        {pack && (
          <ContextPackCreatorPreview
            pack={pack}
            promptExpanded={contextPackPromptExpanded}
            promptText={promptText}
            onTogglePrompt={() => setContextPackPromptExpanded((current) => !current)}
          />
        )}
      </section>
    );
  };

  const renderStoryDeltaPanel = () => {
    const deltaEntries = storyDeltaResult
      ? Object.entries(storyDeltaResult.story_delta || {}).filter(([, value]) => Array.isArray(value))
      : [];
    const proposal = storyDeltaResult?.next_chapter_proposal ?? null;
    const changes = storyDeltaResult?.knowledge_draft?.candidate_changes ?? [];
    const totalDeltaItems = storyDeltaItemCount(storyDeltaResult);

    return (
      <section className="panel story-delta-panel">
        <div className="panel-header">
          <div>
            <span className="section-kicker">Story Delta</span>
            <h2>章节设定分析</h2>
          </div>
          <span className="status-badge">
            {storyDeltaLoading ? "Analyzing" : storyDeltaResult ? "Draft saved" : "Manual"}
          </span>
        </div>

        <p className="review-notice">
          方案 B：正文保存后再手动触发第二次分析。分析结果只进入 pending_review 草稿层，尚未写入正式人物卡或 Narrative Graph。
        </p>

        <div className="story-delta-controls">
          <label className="field-stack">
            <span>chapter_number</span>
            <input
              type="number"
              min="1"
              step="1"
              value={storyDeltaChapterInput}
              onChange={(event) => setStoryDeltaChapterInput(event.target.value)}
              disabled={!selectedProjectRef || storyDeltaLoading}
            />
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={storyDeltaIncludeNext}
              onChange={(event) => setStoryDeltaIncludeNext(event.target.checked)}
              disabled={!selectedProjectRef || storyDeltaLoading}
            />
            <span>包含下一章预设置建议</span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={storyDeltaIncludeDraft}
              onChange={(event) => setStoryDeltaIncludeDraft(event.target.checked)}
              disabled={!selectedProjectRef || storyDeltaLoading}
            />
            <span>生成 Knowledge Draft</span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={storyDeltaDryRun}
              onChange={(event) => setStoryDeltaDryRun(event.target.checked)}
              disabled={!selectedProjectRef || storyDeltaLoading}
            />
            <span>dry-run（不调用 DeepSeek）</span>
          </label>
        </div>

        <div className="context-pack-actions">
          <button
            className="button secondary-button"
            type="button"
            onClick={() => void handleAnalyzeStoryDelta()}
            disabled={!selectedProjectRef || apiStatus !== "online" || storyDeltaLoading}
          >
            {storyDeltaLoading ? "正在分析本章设定变化..." : "分析本章设定变化"}
          </button>
        </div>

        {!selectedProjectRef && <p className="empty-state">请先在创作页创建或选择一个 workspace 项目。</p>}
        {apiStatus !== "online" && <p className="state-text error-text">API Offline. 无法分析 Story Delta。</p>}
        {storyDeltaMessage && <p className="state-text success-text">{storyDeltaMessage}</p>}
        {storyDeltaError && <p className="state-text error-text">{storyDeltaError}</p>}

        {storyDeltaResult && (
          <div className="story-delta-result">
            <div className="story-delta-stats">
              <div>
                <span>chapter</span>
                <strong>{storyDeltaResult.chapter_number}</strong>
              </div>
              <div>
                <span>story delta items</span>
                <strong>{totalDeltaItems}</strong>
              </div>
              <div>
                <span>candidate changes</span>
                <strong>{changes.length}</strong>
              </div>
              <div>
                <span>draft status</span>
                <strong>{storyDeltaResult.knowledge_draft?.status || "-"}</strong>
              </div>
            </div>

            {storyDeltaResult.warnings.length > 0 && (
              <div className="context-pack-warnings">
                {storyDeltaResult.warnings.map((warning) => (
                  <p key={warning} className="state-text warning-text">{warning}</p>
                ))}
              </div>
            )}

            <div className="story-delta-grid">
              <section className="story-delta-section">
                <h3>Story Delta</h3>
                <p className="section-note">本章已经发生的事实变化。</p>
                {deltaEntries.map(([key, value]) => {
                  const items = Array.isArray(value) ? value : [];
                  return (
                    <article className="story-delta-group" key={key}>
                      <strong>{key}</strong>
                      <span>{items.length} item(s)</span>
                      {items.slice(0, 3).map((item, index) => (
                        <pre className="json-snippet" key={`${key}-${index}`}>{jsonPreview(item)}</pre>
                      ))}
                    </article>
                  );
                })}
              </section>

              <section className="story-delta-section">
                <h3>Next Chapter Proposal</h3>
                <p className="section-note">下一章建议规划，不是已发生事实。</p>
                {proposal && (
                  <>
                    <div className="proposal-goal">
                      <span>target chapter</span>
                      <strong>{proposal.target_chapter_number || "-"}</strong>
                    </div>
                    <pre className="json-snippet">{jsonPreview(proposal)}</pre>
                  </>
                )}
              </section>
            </div>

            <section className="story-delta-section">
              <h3>Knowledge Draft candidate_changes</h3>
              <p className="section-note">候选变更必须人工审核；requires_review 应始终为 true。</p>
              {changes.length === 0 && <p className="empty-state">当前没有 candidate_changes。</p>}
              <div className="candidate-change-list">
                {changes.map((change) => (
                  <article className="candidate-change-card" key={change.id}>
                    <div>
                      <strong>{change.operation}</strong>
                      <span>{change.source} → {change.target}</span>
                    </div>
                    <span className="status-badge">{change.requires_review ? "requires_review" : "review missing"}</span>
                    {(change.evidence || change.rationale) && (
                      <p>{change.evidence || change.rationale}</p>
                    )}
                    <pre className="json-snippet">{jsonPreview(change.payload)}</pre>
                  </article>
                ))}
              </div>
            </section>
          </div>
        )}
      </section>
    );
  };

  const renderContextPackUsageState = () => {
    let markerClass = "context-pack-usage-off";
    let markerText = "不会注入 Context Pack";
    let statusText = "尚未预览 Context Pack。本次生成将不会使用图谱上下文。";

    if (contextPackHasPreview && contextPackWillBeUsed) {
      markerClass = "context-pack-usage-on";
      markerText = "将注入 Context Pack";
      statusText = "本次生成将使用当前 Context Pack。";
    } else if (contextPackHasPreview && contextPackCanInject) {
      markerClass = "context-pack-usage-warning";
      statusText = "已预览 Context Pack，但本次生成不会自动使用。勾选“使用 Context Pack”后，图谱资料才会注入生成。";
    } else if (contextPackHasPreview) {
      statusText = "已预览 Context Pack，但当前预览没有可注入内容。本次生成将不会使用图谱上下文。";
    }

    return (
      <section className={`context-pack-usage-card ${markerClass}`} aria-live="polite">
        <div className="context-pack-usage-heading">
          <div>
            <span>Context Pack 使用状态</span>
            <strong>{markerText}</strong>
          </div>
          <span className="context-pack-usage-marker">{markerText}</span>
        </div>
        <p>{statusText}</p>
        {contextPackHasPreview && (
          <div className="context-pack-usage-summary">
            <span>本次上下文包</span>
            <dl className="context-pack-usage-stats" aria-label="本次上下文包摘要">
              <div>
                <dt>资料</dt>
                <dd>{displayCount(contextPackSummary.nodeCount)}</dd>
              </div>
              <div>
                <dt>关系</dt>
                <dd>{displayCount(contextPackSummary.edgeCount)}</dd>
              </div>
              <div>
                <dt>硬约束</dt>
                <dd>{displayCount(contextPackSummary.hardConstraintCount)}</dd>
              </div>
            </dl>
          </div>
        )}
      </section>
    );
  };

  const renderConsistencyWarnings = () => {
    if (consistencyWarnings.length === 0) {
      return null;
    }

    return (
      <section className="consistency-warning-card" aria-live="polite">
        <div className="consistency-warning-header">
          <span className="section-kicker">Continuity check</span>
          <h3>一致性提醒</h3>
          <p>系统发现正文可能与已确认事实存在冲突。请检查以下内容；这些提醒不会阻断保存。</p>
        </div>
        <div className="consistency-warning-list">
          {consistencyWarnings.map((warning, index) => (
            <article className="consistency-warning-item" key={`${warning.code}-${index}`}>
              <strong>{consistencyWarningTypeLabel(warning.code)}</strong>
              <p>{warning.message}</p>
              <dl>
                <div>
                  <dt>已确认事实</dt>
                  <dd>{warning.constraint || "-"}</dd>
                </div>
                <div>
                  <dt>正文证据</dt>
                  <dd>{warning.evidence || "-"}</dd>
                </div>
                {warning.suggestion && (
                  <div>
                    <dt>建议</dt>
                    <dd>{warning.suggestion}</dd>
                  </div>
                )}
              </dl>
            </article>
          ))}
        </div>
      </section>
    );
  };

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

        {noRevealReviewFailed && (
          <section className="no-reveal-fail-banner" aria-live="polite">
            <strong>No-Reveal FAIL</strong>
            <p>该章违反 No-Reveal / Scene Plan 禁止项，需要人工复核。</p>
            <p>不建议直接进入下一章，也不建议将本章作为可信上下文继续推进。</p>
            <small>
              review_id: {latestWorkflowReview?.id || "-"} · score: {latestWorkflowReview?.score ?? "-"}/5
            </small>
          </section>
        )}

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
            className="button subtle-button debug-only-action"
            type="button"
            onClick={() => void handleGenerateChapter()}
            disabled={!selectedProjectRef || apiStatus !== "online" || generationBusy}
          >
            {chapterGenerating ? "正在同步生成章节..." : "同步生成（备用）"}
          </button>
        </div>
        {renderContextPackUsageState()}
        {latestScenePlanDraft && !approvedScenePlan && (
          <p className="state-text warning-text">Scene Plan 未生效：当前只有 draft，生成章节不会注入 Scene Plan。</p>
        )}
        {approvedScenePlan && (
          <p className="state-text success-text">
            Scene Plan 生效：approved revision {approvedScenePlan.revision}
          </p>
        )}
        <div className="hint-box">
          <p>默认使用流式生成；同步生成仅作为流式异常时的备用 / 调试入口。</p>
          <p>
            建议下一章：第 {suggestedChapterNumber} 章；模型：{generationRequest.model}；
            max_tokens：{generationRequest.max_tokens}；temperature：{generationRequest.temperature}
          </p>
          <p>如果生成内容明显中断，可提高 max_tokens 或重新生成该章节。</p>
        </div>
        <ChapterStatusPanel
          status={chapterStatus}
          loading={chapterStatusLoading}
          error={chapterStatusError}
          workflowWarnings={workflowGuardWarnings}
        />
        <NoRevealReviewPanel
          review={noRevealReview?.latest ?? null}
          loading={noRevealReviewLoading}
          error={noRevealReviewError}
          onRefresh={() => void refreshNoRevealReview()}
          disabled={!selectedProjectRef || apiStatus !== "online"}
        />
        {generationMessage && <p className="state-text success-text">{generationMessage}</p>}
        {renderConsistencyWarnings()}
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

      <ChapterTaskSheetPanel
        projectRef={selectedProjectRef}
        chapterNumber={Number.parseInt(chapterNumberInput, 10) || 1}
        apiStatus={apiStatus}
        disabled={generationBusy}
        onApprovedTaskChange={setApprovedChapterTask}
        onTaskStateChange={handleChapterTaskStateChange}
      />

      <ScenePlanPanel
        projectRef={selectedProjectRef}
        chapterNumber={Number.parseInt(chapterNumberInput, 10) || 1}
        apiStatus={apiStatus}
        disabled={generationBusy}
        approvedChapterTask={approvedChapterTask}
        onScenePlanStateChange={handleScenePlanStateChange}
      />

      {renderContextPackPanel()}

      <DebugDrawer>
        <div className="debug-action-row">
          <button
            className="button subtle-button"
            type="button"
            onClick={() => void handleGenerateChapter()}
            disabled={!selectedProjectRef || apiStatus !== "online" || generationBusy}
          >
            {chapterGenerating ? "Running sync generation..." : "Sync generate (debug fallback)"}
          </button>
          <button
            className="button secondary-button compact-button"
            type="button"
            onClick={() => void refreshGenerationStatus()}
            disabled={generationStatusLoading || apiStatus !== "online"}
          >
            Refresh generation status
          </button>
        </div>
        <section className="debug-snapshot">
          <h3>Generation payload preview</h3>
          <pre className="json-snippet">{jsonPreview(generationRequestWithOptionalContext(validCurrentChapterNumber))}</pre>
          <h3>Raw Context Pack prompt</h3>
          <pre className="json-snippet">{contextPackPromptText || "No Context Pack prompt attached."}</pre>
          <h3>Dry-run state</h3>
          <pre className="json-snippet">{jsonPreview({ storyDeltaDryRun, storyDeltaIncludeNext, storyDeltaIncludeDraft })}</pre>
        </section>

        {renderStoryDeltaPanel()}

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
      </DebugDrawer>
    </aside>
  );

  const renderNextActionsPanel = () => (
    <section className="panel next-actions-panel" aria-labelledby="next-actions-title">
      <div className="panel-header">
        <div>
          <span className="section-kicker">Next Actions</span>
          <h2 id="next-actions-title">Recommended next step</h2>
        </div>
      </div>
      <ol className="next-actions-list">
        {nextActions.map((action) => (
          <li key={action}>{action}</li>
        ))}
      </ol>
    </section>
  );

  const renderCreatePage = () => (
    <section className="workspace-layout workspace-page writing-cockpit-layout">
      <aside className="sidebar-stack" aria-label="项目导航">
        <WorkflowRail steps={workflowSteps} />
        {renderProjectListPanel()}
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
        {renderGenerationPanel()}
      </section>

      <aside className="tool-stack cockpit-inspector" aria-label="Effective inputs and next actions">
        <EffectiveInputsSummary
          approvedChapterTask={approvedChapterTask}
          latestChapterTaskDraft={latestChapterTaskDraft}
          approvedScenePlan={approvedScenePlan}
          latestScenePlanDraft={latestScenePlanDraft}
          contextPackState={contextPackState}
          generationMode="stream"
          generationRequest={generationRequest}
          warnings={effectiveInputWarnings}
        />
        {renderNextActionsPanel()}
      </aside>
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

  const renderDashboardPage = () => (
    <section className="workspace-layout workspace-page dashboard-layout">
      <aside className="sidebar-stack" aria-label="Project navigation">
        {renderProjectListPanel()}
        {renderChapterListPanel()}
      </aside>
      <section className="main-stack">
        <section className="panel dashboard-overview-panel">
          <div className="panel-header">
            <div>
              <span className="section-kicker">Dashboard</span>
              <h1>{selectedProject?.title || "No project selected"}</h1>
              <p>Current chapter: {validCurrentChapterNumber}</p>
            </div>
            <button className="button primary-button" type="button" onClick={() => setActivePage("writing")}>
              Enter Writing Cockpit
            </button>
          </div>
          <dl className="dashboard-summary-grid">
            <div>
              <dt>API</dt>
              <dd>{apiStatus}</dd>
            </div>
            <div>
              <dt>Chapter file</dt>
              <dd>{currentChapterExists ? "exists" : "not generated"}</dd>
            </div>
            <div>
              <dt>Generation</dt>
              <dd>{generationStatusText(generationStatus)}</dd>
            </div>
            <div>
              <dt>Review pending</dt>
              <dd>{chapterStatus?.review?.pending_count ?? 0}</dd>
            </div>
          </dl>
          {noRevealReviewFailed && (
            <div className="dashboard-review-alert">
              <strong>当前章节需要人工复核</strong>
              <p>No-Reveal Review 判定 FAIL。请先复核 evidence，不建议直接进入下一章。</p>
            </div>
          )}
        </section>
        <ChapterStatusPanel
          status={chapterStatus}
          loading={chapterStatusLoading}
          error={chapterStatusError}
          workflowWarnings={workflowGuardWarnings}
        />
        {renderNextActionsPanel()}
      </section>
      <aside className="tool-stack cockpit-inspector" aria-label="Dashboard effective inputs">
        <EffectiveInputsSummary
          approvedChapterTask={approvedChapterTask}
          latestChapterTaskDraft={latestChapterTaskDraft}
          approvedScenePlan={approvedScenePlan}
          latestScenePlanDraft={latestScenePlanDraft}
          contextPackState={contextPackState}
          generationMode="stream"
          generationRequest={generationRequest}
          warnings={effectiveInputWarnings}
        />
      </aside>
    </section>
  );

  const renderReviewPage = () => (
    <section className="workspace-layout workspace-page review-layout">
      <aside className="sidebar-stack" aria-label="Review navigation">
        {renderProjectListPanel()}
        <ChapterStatusPanel
          status={chapterStatus}
          loading={chapterStatusLoading}
          error={chapterStatusError}
          workflowWarnings={workflowGuardWarnings}
        />
      </aside>
      <section className="main-stack">
        <section className="panel">
          <div className="panel-header">
            <div>
              <span className="section-kicker">Review</span>
              <h1>Review & Merge</h1>
              <p>Story Delta stays here as the first Review entry. Knowledge Draft Review remains in Memory for UI-D integration.</p>
            </div>
          </div>
        </section>
        {renderStoryDeltaPanel()}
      </section>
      <aside className="tool-stack cockpit-inspector" aria-label="Review next actions">
        {renderNextActionsPanel()}
      </aside>
    </section>
  );

  const renderSettingsPage = () => (
    <section className="settings-stack">
      <ProjectSettingsPage
        selectedProject={selectedProject}
        projectDetail={projectDetail}
        projectLoading={projectLoading}
        projectError={projectError}
        apiStatus={apiStatus}
        onSaveGenerationSettings={handleUpdateGenerationSettings}
      />
      <SystemSettingsPage
        apiStatus={apiStatus}
        apiError={apiError}
        apiBaseUrl={API_BASE_URL}
        generationStatus={generationStatus}
        generationStatusLoading={generationStatusLoading}
        generationStatusError={generationStatusError}
        onRefreshGenerationStatus={() => void refreshGenerationStatus()}
        onOpenCreatePage={() => setActivePage("writing")}
      />
    </section>
  );

  const renderActivePage = () => {
    if (activePage === "dashboard") {
      return renderDashboardPage();
    }
    if (activePage === "writing") {
      return renderCreatePage();
    }
    if (activePage === "review") {
      return renderReviewPage();
    }
    if (activePage === "memory") {
      return <LibraryPage selectedProject={selectedProject} apiStatus={apiStatus} />;
    }
    return renderSettingsPage();
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
