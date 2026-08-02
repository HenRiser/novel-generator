from __future__ import annotations

import json
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Path
from fastapi.responses import StreamingResponse

from api.schemas import ContinueSaveRequest, ContinueSaveResponse, ContinueWritingRequest
from config import PROJECT_ROOT
from config_manager import get_current_default_model, has_api_key
from deepseek_client import DeepSeekClientError, stream_generate_text_events
from file_manager import read_chapter, save_chapter, update_chapter_index
from services.common import resolve_workspace_context
from services.project_service import load_project_detail


router = APIRouter(prefix="/api", tags=["continue-writing"])

ChapterNumber = Annotated[int, Path(gt=0)]

DEFAULT_TEMPERATURE = 0.9
# 推理模型流式续写同样会先消耗推理 token，2048 不足（实测仅推理无正文）。
# 与章节生成保持一致，使用 16384 保证稳定产出正文。
DEFAULT_MAX_TOKENS = 16384
PROJECT_ROOT_TEXT = str(PROJECT_ROOT)


def _error(status_code: int, code: str, message: str) -> None:
    raise HTTPException(
        status_code=status_code,
        detail={"error": {"code": code, "message": message}},
    )


def public_message(message: str) -> str:
    text = str(message or "")
    if PROJECT_ROOT_TEXT and PROJECT_ROOT_TEXT in text:
        text = text.replace(PROJECT_ROOT_TEXT, "[project_root]")
    normalized_root = PROJECT_ROOT_TEXT.replace("\\", "/")
    if normalized_root and normalized_root in text:
        text = text.replace(normalized_root, "[project_root]")
    return text


def _json_line(event: dict[str, Any]) -> str:
    return json.dumps(event, ensure_ascii=False) + "\n"


def _build_prompt(request: ContinueWritingRequest) -> list[dict[str, str]]:
    """构造对话式续写的 prompt：上下文 + 锚点 + 指令。"""
    system = (
        "你是小说创作助手。请根据给定的上下文继续创作，保持叙事风格、人称与节奏一致。"
        "只输出续写正文，不要解释，不要重复已有内容。"
    )
    parts: list[str] = []
    if request.context_text.strip():
        parts.append("【当前章节正文】\n" + request.context_text.strip())
    if request.anchor_text and request.anchor_text.strip():
        parts.append("【需要紧跟其后续写的锚点文本】\n" + request.anchor_text.strip())
    if request.instruction.strip():
        parts.append("【用户指令】\n" + request.instruction.strip())
    parts.append("【续写】")
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": "\n\n".join(parts)},
    ]


@router.post("/projects/{project_ref}/chapters/{chapter_number}/continue")
def continue_writing_stream(
    project_ref: str,
    chapter_number: ChapterNumber,
    payload: ContinueWritingRequest | None = None,
) -> StreamingResponse:
    request = payload or ContinueWritingRequest()

    if not has_api_key():
        _error(
            400,
            "model_config_missing",
            "Model config is missing. Configure the API key in the local settings panel or environment config before generation.",
        )

    detail = load_project_detail(project_ref)
    if not detail.ok:
        _error(404, "project_not_found", "Project not found or unreadable.")

    if not request.anchor_text and not request.context_text and not request.instruction:
        _error(400, "empty_request", "Provide context_text, anchor_text or instruction to continue writing.")

    model = str(request.model or "").strip() or get_current_default_model()
    temperature = float(DEFAULT_TEMPERATURE if request.temperature is None else request.temperature)
    max_tokens = int(request.max_tokens or DEFAULT_MAX_TOKENS)
    messages = _build_prompt(request)

    def stream_events():
        partial_length = 0
        try:
            for event in stream_generate_text_events(
                messages=messages,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
            ):
                if event["kind"] == "content":
                    delta = event["text"]
                    partial_length += len(delta)
                    yield _json_line({"type": "delta", "text": delta})
                else:
                    # 推理过程：仅透传展示，不进入正文
                    yield _json_line({"type": "reasoning", "text": event["text"]})

            yield _json_line(
                {
                    "type": "done",
                    "ok": True,
                    "project_ref": project_ref,
                    "chapter_number": chapter_number,
                    "message": "Continue writing completed.",
                    "partial_length": partial_length,
                }
            )
        except GeneratorExit:
            raise
        except DeepSeekClientError as exc:
            message = public_message(str(exc) or "Continue writing failed.")
            yield _json_line(
                {
                    "type": "error",
                    "ok": False,
                    "code": "generation_failed",
                    "message": message,
                    "partial_length": partial_length,
                }
            )
        except Exception as exc:
            message = public_message(str(exc) or "Continue writing failed.")
            yield _json_line(
                {
                    "type": "error",
                    "ok": False,
                    "code": "generation_failed",
                    "message": message,
                    "partial_length": partial_length,
                }
            )

    return StreamingResponse(
        stream_events(),
        media_type="application/x-ndjson; charset=utf-8",
    )


@router.post("/projects/{project_ref}/chapters/{chapter_number}/continue/save")
def save_continue_result(
    project_ref: str,
    chapter_number: ChapterNumber,
    request: ContinueSaveRequest,
) -> ContinueSaveResponse:
    """把对话式续写的结果保存回章节文件。

    - mode="append"（默认）：把 content 追加到当前章节正文末尾
    - mode="replace"：用 content 替换整个章节正文
    保存后更新章节索引（追加一行记录），返回落盘的文件名。
    """
    ctx, message, status_code, error_code = resolve_workspace_context(project_ref)
    if ctx is None:
        _error(status_code or 404, error_code or "project_not_found", message or "Project not found.")

    content = str(request.content or "").strip()
    if not content:
        _error(400, "empty_content", "Provide content to save.")

    # 读取当前章节正文（replace 模式下无章节也允许——直接创建）
    existing_content, existing_path = read_chapter(project_ref, chapter_number)
    if request.mode == "append":
        base = existing_content or ""
        new_content = (base.rstrip() + "\n\n" + content).strip() if base else content
    else:
        new_content = content

    chapter_path = save_chapter(project_ref, chapter_number, new_content)

    # 标题：优先请求传入，其次取现有章节标题（从文件第一行），否则占位
    chapter_title = str(request.chapter_title or "").strip()
    if not chapter_title and existing_path:
        first_line = existing_path.read_text(encoding="utf-8").splitlines()[0:1]
        if first_line and first_line[0].startswith("# "):
            chapter_title = first_line[0][2:].strip()

    update_chapter_index(
        title=project_ref,
        chapter_number=chapter_number,
        chapter_title=chapter_title or f"第 {chapter_number} 章（续写）",
        chapter_path=chapter_path,
        model="continue-writing",
        summary=f"续写保存（{request.mode}）",
    )

    return ContinueSaveResponse(
        ok=True,
        project_ref=project_ref,
        chapter_number=int(chapter_number),
        chapter_file=public_message(str(chapter_path)),
        message="续写内容已保存到章节文件。",
    )
