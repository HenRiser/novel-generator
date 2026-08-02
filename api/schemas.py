from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: str


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail


class ProjectSummaryResponse(BaseModel):
    project_ref: str
    title: str
    storage_type: str
    updated_at: str = ""
    description: str = ""


class ProjectDetailResponse(BaseModel):
    project_ref: str
    title: str
    config: dict[str, Any]


class CreateProjectRequest(BaseModel):
    title: str | None = None
    seed_prompt: str | None = None
    genre: str | None = None
    style: str | None = None
    model: str | None = None
    max_tokens: Any = None
    temperature: Any = None


class CreateProjectResponse(BaseModel):
    ok: bool
    project_ref: str
    title: str
    message: str = ""


class DeleteProjectResponse(BaseModel):
    ok: bool
    project_ref: str
    message: str = ""


class UpdateGenerationSettingsRequest(BaseModel):
    model: str | None = None
    max_tokens: Any = None
    temperature: Any = None


class UpdateGenerationSettingsResponse(BaseModel):
    ok: bool
    project_ref: str
    config: dict[str, Any]
    message: str = ""


class NarrativeGraphResponse(BaseModel):
    ok: bool
    project_ref: str
    graph: dict[str, Any]
    views: dict[str, Any]
    message: str = ""


class NarrativeGraphTagRequest(BaseModel):
    name: str | None = None
    category: str | None = None
    description: str | None = None
    aliases: Any = None


class NarrativeGraphTagUpdateRequest(BaseModel):
    category: str | None = None
    description: str | None = None
    aliases: Any = None
    status: str | None = None


class NarrativeGraphTagResponse(NarrativeGraphResponse):
    tag: dict[str, Any]


class NarrativeGraphNodeRequest(BaseModel):
    type: str | None = None
    label: str | None = None
    aliases: Any = None
    summary: str | None = None
    importance: Any = None
    layer: str | None = None
    parent_id: str | None = None
    status: str | None = None
    tags: Any = None
    properties: Any = None
    notes: str | None = None


class NarrativeGraphNodeResponse(NarrativeGraphResponse):
    node: dict[str, Any]


class NarrativeGraphEdgeRequest(BaseModel):
    source: str | None = None
    target: str | None = None
    type: str | None = None
    label: str | None = None
    summary: str | None = None
    importance: Any = None
    layer: str | None = None
    status: str | None = None
    properties: Any = None
    notes: str | None = None


class NarrativeGraphEdgeResponse(NarrativeGraphResponse):
    edge: dict[str, Any]


class ContextPackPreviewRequest(BaseModel):
    chapter_number: Any = None
    chapter_goal: str | None = None
    min_importance: Any = None
    max_nodes: Any = None
    max_edges: Any = None
    include_unresolved_foreshadowing: bool | None = None
    include_neighbors: bool | None = None


class ContextPackPreviewResponse(BaseModel):
    ok: bool
    project_ref: str
    context_pack: dict[str, Any]
    prompt_text: str = ""
    message: str = ""


class StoryDeltaAnalyzeRequest(BaseModel):
    include_next_chapter_proposal: bool | None = True
    include_knowledge_draft: bool | None = True
    dry_run: bool | None = False
    mock_response: Any = None
    context_pack_summary: str | None = None


class StoryDeltaAnalyzeResponse(BaseModel):
    ok: bool
    project_ref: str
    chapter_number: int
    story_delta: dict[str, Any]
    next_chapter_proposal: dict[str, Any]
    knowledge_draft: dict[str, Any]
    warnings: list[str] = []
    message: str = ""
    metadata: dict[str, Any] = {}


class StoryDeltaListResponse(BaseModel):
    ok: bool
    project_ref: str
    items: list[dict[str, Any]]
    message: str = ""


class KnowledgeDraftListResponse(BaseModel):
    ok: bool
    project_ref: str
    drafts: list[dict[str, Any]]
    message: str = ""


class KnowledgeDraftResponse(BaseModel):
    ok: bool
    project_ref: str
    draft: dict[str, Any]
    message: str = ""


class KnowledgeDraftChangeAcceptRequest(BaseModel):
    review_note: str | None = None
    payload_override: Any = None


class KnowledgeDraftChangeRejectRequest(BaseModel):
    review_note: str | None = None


class KnowledgeDraftChangeReviewResponse(BaseModel):
    ok: bool
    project_ref: str
    draft: dict[str, Any]
    change: dict[str, Any]
    graph: dict[str, Any] = {}
    views: dict[str, Any] = {}
    node: dict[str, Any] | None = None
    edge: dict[str, Any] | None = None
    message: str = ""


class EventLogResponse(BaseModel):
    ok: bool
    project_ref: str
    events: list[dict[str, Any]]
    message: str = ""


class SafetySnapshotListResponse(BaseModel):
    ok: bool
    project_ref: str
    snapshots: list[dict[str, Any]]
    message: str = ""


class AIRunListResponse(BaseModel):
    ok: bool
    project_ref: str
    runs: list[dict[str, Any]]
    message: str = ""


class AIRunResponse(BaseModel):
    ok: bool
    project_ref: str
    run: dict[str, Any]
    message: str = ""


class ChapterStatusResponse(BaseModel):
    ok: bool
    project_ref: str
    chapter_status: dict[str, Any]
    message: str = ""


class ChapterStatusOverviewResponse(BaseModel):
    ok: bool
    project_ref: str
    chapters: list[dict[str, Any]]
    summary: dict[str, Any]
    message: str = ""


class WorkflowGuardCheckRequest(BaseModel):
    action: str | None = None
    chapter_number: Any = None


class WorkflowGuardCheckResponse(BaseModel):
    ok: bool
    project_ref: str
    action: str
    chapter_number: int
    blocking: bool = False
    warnings: list[dict[str, Any]] = []
    suggested_actions: list[str] = []
    message: str = ""


class ChapterSummaryResponse(BaseModel):
    chapter_number: int
    title: str
    filename: str
    is_version: bool = False
    version: int = 1
    display_label: str = ""


class ChapterContentResponse(BaseModel):
    chapter_number: int
    title: str
    filename: str
    content: str


class ChapterTaskDraftRequest(BaseModel):
    id: Any = None
    chapter_number: Any = None
    revision: Any = None
    status: Any = None
    primary_function: Any = None
    secondary_functions: Any = None
    intensity: Any = None
    canon_budget: Any = None
    must_carry: Any = None
    allowed_advances: Any = None
    forbidden_advances: Any = None
    required_characters: Any = None
    relationship_goal: Any = None
    decision_goal: Any = None
    allowed_scene_types: Any = None
    forbidden_scene_drivers: Any = None
    ending_state: Any = None
    notes: Any = None


class ChapterTaskApproveRequest(BaseModel):
    task_id: Any = None
    revision: Any = None


class ChapterTaskResponse(BaseModel):
    ok: bool
    project_ref: str
    chapter_number: int
    task: dict[str, Any] | None = None
    approved: dict[str, Any] | None = None
    latest_draft: dict[str, Any] | None = None
    history: list[dict[str, Any]] = Field(default_factory=list)
    message: str = ""


class ScenePlanDraftRequest(BaseModel):
    id: Any = None
    chapter_number: Any = None
    revision: Any = None
    status: Any = None
    source_chapter_task_id: Any = None
    source_chapter_task_revision: Any = None
    scenes: Any = None


class ScenePlanApproveRequest(BaseModel):
    scene_plan_id: Any = None
    revision: Any = None


class ScenePlanResponse(BaseModel):
    ok: bool
    project_ref: str
    chapter_number: int
    plan: dict[str, Any] | None = None
    approved: dict[str, Any] | None = None
    latest_draft: dict[str, Any] | None = None
    history: list[dict[str, Any]] = Field(default_factory=list)
    current_approved_chapter_task: dict[str, Any] | None = None
    message: str = ""


class ChapterFunctionReviewResponse(BaseModel):
    ok: bool
    project_ref: str
    chapter_number: int
    latest: dict[str, Any] | None = None
    history: list[dict[str, Any]] = Field(default_factory=list)
    message: str = ""


class GenerateOutlineCharactersRequest(BaseModel):
    model: str | None = None
    max_tokens: int | None = Field(default=None, ge=512, le=32768)
    temperature: float | None = Field(default=None, ge=0, le=2)


class GenerateChapterRequest(BaseModel):
    model: str | None = None
    max_tokens: int | None = Field(default=None, ge=512, le=32768)
    temperature: float | None = Field(default=None, ge=0, le=2)
    writing_mode: str | None = None
    narrative_context_text: str | None = Field(default=None, max_length=20000)
    chapter_task_id: str | None = Field(default=None, max_length=120)
    scene_plan_id: str | None = Field(default=None, max_length=140)


class ContinueWritingRequest(BaseModel):
    """对话式续写：在章节末尾或选中文本之后继续生成。

    - context_text: 当前章节正文（或选中文本的上下文）
    - instruction: 用户对续写的指示（如“用悬疑的笔调继续”）
    - anchor_text: 可选，用户选中的文本（续写紧跟其后）
    """
    context_text: str = Field(default="", max_length=60000)
    instruction: str = Field(default="", max_length=4000)
    anchor_text: str | None = Field(default=None, max_length=12000)
    model: str | None = None
    max_tokens: int | None = Field(default=None, ge=256, le=32768)
    temperature: float | None = Field(default=None, ge=0, le=2)


class ContinueSaveRequest(BaseModel):
    """把续写结果保存回章节文件。

    - content: 续写生成的正文
    - mode: append 追加到章节末尾（默认）；replace 用续写结果替换整个章节
    - chapter_title: 可选，章节标题（用于更新章节索引）
    """
    content: str = Field(min_length=1, max_length=60000)
    mode: str = Field(default="append", pattern="^(append|replace)$")
    chapter_title: str | None = Field(default=None, max_length=200)


class ContinueSaveResponse(BaseModel):
    ok: bool
    project_ref: str
    chapter_number: int
    chapter_file: str
    message: str = ""
