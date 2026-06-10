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


class GenerateChapterRequest(BaseModel):
    model: str | None = None
    max_tokens: int | None = Field(default=None, ge=512, le=32768)
    writing_mode: str | None = None
