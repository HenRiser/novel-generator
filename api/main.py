from __future__ import annotations

import os
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Receive, Scope, Send

from api.routers import (
    audit,
    chapter_function_reviews,
    chapter_status,
    chapter_tasks,
    chapter_workflow,
    context_pack,
    compute,
    continue_writing,
    generation,
    health,
    knowledge_drafts,
    narrative_graph,
    projects,
    scene_plans,
    settings,
    story_delta,
)
from services.chapter_workflow_service import WorkflowError


PUBLIC_MODE = os.getenv("BRAIPEN_PUBLIC_MODE", "").strip().lower() in {"1", "true", "yes", "on"}
PUBLIC_PATHS = {"/api/health", "/api/capabilities"}

app = FastAPI(
    title="novel-generator API",
    docs_url=None if PUBLIC_MODE else "/docs",
    redoc_url=None if PUBLIC_MODE else "/redoc",
    openapi_url=None if PUBLIC_MODE else "/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "https://braipen.world",
        "https://www.braipen.world",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(compute.router)
app.include_router(projects.router)
app.include_router(settings.router)
app.include_router(audit.router)
app.include_router(chapter_function_reviews.router)
app.include_router(chapter_status.router)
app.include_router(chapter_tasks.router)
app.include_router(scene_plans.router)
app.include_router(narrative_graph.router)
app.include_router(context_pack.router)
app.include_router(continue_writing.router)
app.include_router(story_delta.router)
app.include_router(knowledge_drafts.router)
app.include_router(generation.router)
app.include_router(chapter_workflow.router)


class PublicBoundaryMiddleware:
    """Keep the real ASGI send under the compute response's lifetime deadline."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and PUBLIC_MODE and scope["path"].startswith("/api/"):
            path = scope["path"]
            allowed = path in PUBLIC_PATHS or path.startswith("/api/compute/") or scope["method"] == "OPTIONS"
            if not allowed:
                response = JSONResponse(
                    status_code=404,
                    content={"error": {"code": "public_mode", "message": "该接口在浏览器本地数据模式下不可用。"}},
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


app.add_middleware(PublicBoundaryMiddleware)


@app.exception_handler(WorkflowError)
async def workflow_exception_handler(request: Request, exc: WorkflowError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": {"code": exc.code, "message": exc.message}})


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    if isinstance(exc.detail, dict) and "error" in exc.detail:
        return JSONResponse(status_code=exc.status_code, content=exc.detail, headers=exc.headers)

    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": "http_error", "message": str(exc.detail)}},
        headers=exc.headers,
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=400,
        content={"error": {"code": "invalid_request", "message": "Request parameters are invalid."}},
    )


@app.exception_handler(Exception)
async def unexpected_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(
        status_code=500,
        content={"error": {"code": "internal_error", "message": "Internal server error."}},
    )
