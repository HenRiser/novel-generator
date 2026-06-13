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
