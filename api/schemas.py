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
