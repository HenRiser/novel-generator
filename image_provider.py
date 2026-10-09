"""Four explicit image protocols; images and credentials stay request scoped."""
from __future__ import annotations

import asyncio
import base64
import binascii
from dataclasses import dataclass, field
import json
import re
import struct
from urllib.parse import urlsplit
import zlib

import httpx

from deepseek_client import DeepSeekClientError, _quiet_provider_logging
from model_client import _status
from provider_catalog import canonical_url, default_policy, digest, validate_policy
from provider_transport import DestinationRejected, SafeTransport

IMAGE_PROTOCOLS = ("seedream_images", "openai_images", "gemini_images", "qwen_images")
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_JSON_BYTES = 24 * 1024 * 1024
MAX_MODEL_SECONDS = 120.0
MAX_PROMPT_CHARS = 6000
IMAGE_PROVIDERS = [
    {"id": "seedream", "name": "火山方舟 / Seedream", "protocol": "seedream_images", "url": "https://ark.cn-beijing.volces.com/api/v3",
     "model": "doubao-seedream-5-0-flash-260915", "models": ["doubao-seedream-5-0-flash-260915", "doubao-seedream-4-5-251128"]},
    {"id": "openai", "name": "OpenAI", "protocol": "openai_images", "url": "https://api.openai.com/v1",
     "model": "gpt-image-1.5", "models": ["gpt-image-1.5", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2"]},
    {"id": "gemini", "name": "Google Gemini", "protocol": "gemini_images", "url": "https://generativelanguage.googleapis.com/v1beta",
     "model": "gemini-3.1-flash-image", "models": ["gemini-3.1-flash-image"]},
    {"id": "qwen", "name": "阿里云百炼 / Qwen Image", "protocol": "qwen_images", "url": "https://dashscope.aliyuncs.com/api/v1",
     "model": "qwen-image-3.0-pro", "models": ["qwen-image-3.0-pro", "qwen-image-3.0", "qwen-image-2.1-pro", "qwen-image-2.0-pro"],
     "regions": [{"id": "beijing", "name": "北京", "url": "https://dashscope.aliyuncs.com/api/v1"},
                 {"id": "singapore", "name": "新加坡", "url": "https://dashscope-intl.aliyuncs.com/api/v1"}]},
]
_MODEL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/~+-]{0,199}")
_DOWNLOAD_DOMAINS = {"seedream": ("volces.com",), "openai": ("openai.com", "oaiusercontent.com", "blob.core.windows.net"),
                     "qwen": ("aliyuncs.com",), "gemini": ()}
IMAGE_ERRORS = {
    "image_auth_error": (401, "图片 API Key 认证失败，请检查完整 Key 与连接。"),
    "image_permission_denied": (403, "图片连接没有所需权限，请检查模型、地域及账号配置。"),
    "image_quota_or_rate_limited": (429, "图片服务限流或额度不足，未自动重试；请检查额度后决定是否手动切换连接。"),
    "image_invalid_request": (400, "图片服务拒绝请求参数，请检查模型与协议配置。"),
    "image_unavailable": (503, "图片服务暂不可用，未自动重试；请检查服务状态。"),
    "image_content_rejected": (422, "图片服务拒绝此内容，请调整素材；不要切换供应商绕过审核。"),
    "image_outcome_unknown": (502, "图片服务未返回可确认的完整结果，可能已产生费用；请核对上游记录，勿自动重试。"),
}
_GEMINI_STATUSES = {"UNAUTHENTICATED": "image_auth_error", "PERMISSION_DENIED": "image_permission_denied",
                    "RESOURCE_EXHAUSTED": "image_quota_or_rate_limited", "INVALID_ARGUMENT": "image_invalid_request",
                    "FAILED_PRECONDITION": "image_invalid_request", "OUT_OF_RANGE": "image_invalid_request",
                    "NOT_FOUND": "image_invalid_request", "UNAVAILABLE": "image_unavailable", "INTERNAL": "image_unavailable"}
_GEMINI_HTTP_ERRORS = {400: "image_invalid_request", 401: "image_auth_error", 403: "image_permission_denied",
                       404: "image_invalid_request", 429: "image_quota_or_rate_limited", 500: "image_unavailable",
                       502: "image_unavailable", 503: "image_unavailable"}
_GEMINI_BLOCK_REASONS = {"SAFETY", "OTHER", "BLOCKLIST", "PROHIBITED_CONTENT", "IMAGE_SAFETY"}
_GEMINI_REJECTED_FINISHES = {"SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY",
                            "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION", "ESCALATION", "PUP_LIMITED_DISABLED"}


class ImageProviderError(DeepSeekClientError):
    """Only fixed public codes and messages; never retain upstream response text."""

    def __init__(self, code):
        self.code = code if code in IMAGE_ERRORS else "image_outcome_unknown"
        super().__init__(IMAGE_ERRORS[self.code][1])


def _gemini_error(raw, status):
    error = raw.get("error") if isinstance(raw, dict) else None
    if status >= 400 or error:
        upstream_status = error.get("status") if isinstance(error, dict) else None
        code = _GEMINI_STATUSES.get(upstream_status) if isinstance(upstream_status, str) else None
        raise ImageProviderError(code or _GEMINI_HTTP_ERRORS.get(status, "image_outcome_unknown"))
    feedback = raw.get("promptFeedback") if isinstance(raw, dict) else None
    reason = feedback.get("blockReason") if isinstance(feedback, dict) else None
    if isinstance(reason, str) and reason in _GEMINI_BLOCK_REASONS:
        raise ImageProviderError("image_content_rejected")
    if reason not in (None, "", "BLOCK_REASON_UNSPECIFIED"):
        raise ImageProviderError("image_outcome_unknown")


def image_catalog():
    return [{**entry, "default_model": entry["model"], "models": [{"id": model, "name": model} for model in entry["models"]]}
            for entry in IMAGE_PROVIDERS]


def normalize_image_connection(raw: dict, *, verify=False) -> dict:
    fields = {"profile_id", "revision", "preset", "protocol", "base_url", "model", "policy", "destination_fingerprint", "execution_fingerprint", "auth_mode"}
    if not isinstance(raw, dict) or set(raw) - fields:
        raise ValueError("图片连接字段无效。")
    if not isinstance(raw.get("profile_id"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", raw["profile_id"]) or type(raw.get("revision")) is not int or raw["revision"] < 1:
        raise ValueError("图片连接标识无效。")
    protocol = raw.get("protocol")
    if protocol not in IMAGE_PROTOCOLS:
        raise ValueError("不支持此图片API协议。")
    url = canonical_url(raw.get("base_url"))
    if url.endswith(("/images/generations", "/images/edits", "/generation")) or ":generateContent" in url:
        raise ValueError("请填写图片 API Base URL，不包含生成或编辑路径。")
    preset = raw.get("preset", "custom")
    if preset != "custom":
        entry = next((p for p in IMAGE_PROVIDERS if p["id"] == preset), None)
        workspace = preset == "qwen" and bool(re.fullmatch(r"https://[a-z0-9-]{1,80}\.(cn-beijing|ap-southeast-1|us-east-1|eu-central-1|ap-northeast-1|cn-hongkong)\.maas\.aliyuncs\.com/api/v1", url))
        if entry is None or protocol != entry["protocol"] or (url not in {entry["url"], *(r["url"] for r in entry.get("regions", []))} and not workspace):
            raise ValueError("图片预设与目的地址不匹配；修改地址请创建 Custom 连接。")
    model = raw.get("model", "")
    if not isinstance(model, str) or (model and not _MODEL_RE.fullmatch(model)):
        raise ValueError("图片模型ID无效。")
    # The shared policy participates in fingerprints; image APIs do not consume text-generation fields.
    policy = validate_policy(raw.get("policy", default_policy("custom")), protocol)
    auth = raw.get("auth_mode", "key")
    if auth not in {"key", "none"} or (preset != "custom" and auth != "key"):
        raise ValueError("仅Custom可显式选择无认证。")
    destination = digest("endpoint-v1\n" + protocol + "\n" + url)
    execution = digest(json.dumps({"destination": destination, "model": model, "policy": policy, "auth_mode": auth}, sort_keys=True, separators=(",", ":"), ensure_ascii=False))
    if verify and (raw.get("destination_fingerprint") != destination or raw.get("execution_fingerprint") != execution):
        raise ValueError("图片连接指纹不匹配，请重新保存连接。")
    return {"profile_id": raw["profile_id"], "revision": raw["revision"], "preset": preset, "protocol": protocol, "base_url": url,
            "model": model, "policy": policy, "auth_mode": auth, "destination_fingerprint": destination, "execution_fingerprint": execution}


@dataclass(frozen=True)
class ImageConfig:
    connection: dict
    api_key: str = field(repr=False)

    def __post_init__(self):
        connection = normalize_image_connection(self.connection, verify=True)
        object.__setattr__(self, "connection", connection)
        if not isinstance(self.api_key, str) or len(self.api_key) > 4096 or any(ord(c) < 32 or ord(c) > 126 for c in self.api_key):
            raise ValueError("API Key 必须是不包含控制字符的认证文本。")
        if connection["auth_mode"] == "key" and not self.api_key.strip():
            raise ValueError("请填写或解锁此图片连接的 API Key。")
        if connection["auth_mode"] == "none" and self.api_key:
            raise ValueError("无认证图片连接不能携带 Key。")


def _client(url, custom=False):
    _quiet_provider_logging()
    return httpx.AsyncClient(transport=SafeTransport(url, custom), timeout=MAX_MODEL_SECONDS, follow_redirects=False, trust_env=False)


def _headers(config):
    headers = {"Accept-Encoding": "identity"}
    if config.api_key:
        if config.connection["protocol"] == "gemini_images":
            headers["x-goog-api-key"] = config.api_key
        else:
            headers["Authorization"] = "Bearer " + config.api_key
    return headers


async def _read(response, limit, *, gemini_error=False):
    if gemini_error and response.status_code >= 400:
        # Read a bounded error object only to classify structured status, never its text.
        limit = min(limit, 64 * 1024)
        if response.headers.get("content-encoding", "identity").lower() not in {"", "identity"}:
            raise ImageProviderError("image_outcome_unknown")
    else:
        _status(response)
    length = response.headers.get("content-length")
    if length and (not length.isdigit() or int(length) > limit):
        raise DeepSeekClientError("图片响应超过容量限制或长度无效。")
    content = bytearray()
    async for chunk in response.aiter_raw():
        if len(content) + len(chunk) > limit:
            raise DeepSeekClientError("图片响应超过容量限制。")
        content.extend(chunk)
    return bytes(content)


def _decode(value):
    if not isinstance(value, str) or not value or len(value) > ((MAX_IMAGE_BYTES + 2) // 3) * 4:
        raise ValueError("图片 Base64 无效或图片超过 8 MiB。")
    try:
        content = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError("图片必须为有效 Base64。") from None
    if not content or len(content) > MAX_IMAGE_BYTES:
        raise ValueError("图片为空或超过 8 MiB。")
    return content


def image_info(content: bytes, expected_mime=None):
    """Inspect bounded raster headers without decoding pixels or adding an imaging dependency."""
    mime = None
    width = height = 0
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        mime = "image/png"
        offset = 8
        seen_data = False
        while offset + 12 <= len(content):
            length = int.from_bytes(content[offset:offset + 4], "big")
            kind = content[offset + 4:offset + 8]
            end = offset + 12 + length
            if end > len(content) or zlib.crc32(content[offset + 4:end - 4]) != int.from_bytes(content[end - 4:end], "big"):
                raise ValueError("PNG 图片损坏。")
            if offset == 8:
                if kind != b"IHDR" or length != 13:
                    raise ValueError("PNG 图片头无效。")
                width, height = struct.unpack(">II", content[offset + 8:offset + 16])
            if kind == b"IDAT":
                seen_data = True
            if kind == b"IEND":
                if length or end != len(content) or not seen_data:
                    raise ValueError("PNG 图片不完整。")
                break
            offset = end
        else:
            raise ValueError("PNG 图片不完整。")
    elif content.startswith(b"\xff\xd8") and content.endswith(b"\xff\xd9"):
        mime = "image/jpeg"
        offset = 2
        while offset + 4 <= len(content):
            if content[offset] != 255:
                raise ValueError("JPEG 图片头无效。")
            while offset < len(content) and content[offset] == 255:
                offset += 1
            if offset >= len(content):
                break
            marker = content[offset]
            offset += 1
            if marker in {0xD8, 0xD9, 0x01} or 0xD0 <= marker <= 0xD7:
                continue
            length = int.from_bytes(content[offset:offset + 2], "big")
            if length < 2 or offset + length > len(content):
                raise ValueError("JPEG 图片损坏。")
            if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF} and length >= 8:
                height, width = struct.unpack(">HH", content[offset + 3:offset + 7])
            if marker == 0xDA:
                break
            offset += length
    elif len(content) >= 30 and content[:4] == b"RIFF" and content[8:12] == b"WEBP" and int.from_bytes(content[4:8], "little") + 8 == len(content):
        mime = "image/webp"
        kind = content[12:16]
        if kind == b"VP8X":
            width = 1 + int.from_bytes(content[24:27], "little")
            height = 1 + int.from_bytes(content[27:30], "little")
        elif kind == b"VP8 " and content[23:26] == b"\x9d\x01\x2a":
            width, height = (v & 0x3FFF for v in struct.unpack("<HH", content[26:30]))
        elif kind == b"VP8L" and content[20] == 0x2F:
            bits = int.from_bytes(content[21:25], "little")
            width, height = 1 + (bits & 0x3FFF), 1 + ((bits >> 14) & 0x3FFF)
    if mime is None or not 1 <= width <= 16384 or not 1 <= height <= 16384 or width * height > 40_000_000:
        raise ValueError("只接受尺寸有效的 PNG、JPEG 或 WebP 图片。")
    if expected_mime is not None and expected_mime != mime:
        raise ValueError("图片内容与 MIME 类型不匹配。")
    return mime, width, height


def strip_image_metadata(content: bytes, expected_mime=None) -> bytes:
    """Remove descriptive metadata and ICC profiles without re-encoding pixels.

    ICC names/tags can contain prompts. Privacy takes priority over embedded color
    management; numeric color hints and required encoding transforms remain.
    """
    mime, _, _ = image_info(content, expected_mime)
    if mime == "image/png":
        # Keep only standardized rendering, color and animation chunks. Unknown
        # ancillary chunks can contain arbitrary provider prompts or user text.
        render_chunks = {b"IHDR", b"PLTE", b"IDAT", b"IEND", b"tRNS", b"cHRM", b"gAMA", b"sBIT", b"sRGB",
                         b"cICP", b"mDCv", b"cLLi", b"bKGD", b"hIST", b"pHYs", b"acTL", b"fcTL", b"fdAT"}
        cleaned = bytearray(content[:8])
        offset = 8
        while offset < len(content):
            kind = content[offset + 4:offset + 8]
            end = offset + 12 + int.from_bytes(content[offset:offset + 4], "big")
            if kind in render_chunks:
                cleaned.extend(content[offset:end])
            elif not kind[0] & 0x20:
                raise ValueError("PNG 图片含不支持的关键数据块。")
            offset = end
        return bytes(cleaned)
    if mime == "image/jpeg":
        cleaned = bytearray(content[:2])
        offset = 2
        in_scan = False
        while offset < len(content):
            if in_scan:
                start = offset
                while True:
                    marker_start = content.find(b"\xff", offset)
                    if marker_start < 0:
                        raise ValueError("JPEG 图片不完整。")
                    offset = marker_start + 1
                    while offset < len(content) and content[offset] == 0xFF:
                        offset += 1
                    if offset >= len(content):
                        raise ValueError("JPEG 图片不完整。")
                    if content[offset] == 0 or 0xD0 <= content[offset] <= 0xD7:
                        offset += 1
                        continue
                    cleaned.extend(content[start:marker_start])
                    offset = marker_start
                    in_scan = False
                    break
            start = offset
            if content[offset] != 0xFF:
                raise ValueError("JPEG 图片损坏。")
            while offset < len(content) and content[offset] == 0xFF:
                offset += 1
            if offset >= len(content):
                raise ValueError("JPEG 图片不完整。")
            marker = content[offset]
            offset += 1
            if marker == 0xD9:
                if offset != len(content):
                    raise ValueError("JPEG 图片含额外尾部数据。")
                cleaned.extend(content[start:offset])
                return bytes(cleaned)
            if marker == 0x01 or 0xD0 <= marker <= 0xD7:
                cleaned.extend(content[start:offset])
                continue
            if marker in {0, 0xD8} or offset + 2 > len(content):
                raise ValueError("JPEG 图片损坏。")
            length = int.from_bytes(content[offset:offset + 2], "big")
            end = offset + length
            if length < 2 or end > len(content):
                raise ValueError("JPEG 图片损坏。")
            body = content[offset + 2:end]
            keep = marker != 0xFE and not 0xE0 <= marker <= 0xEF
            # Preserve fixed-layout JFIF and the Adobe encoding transform. ICC
            # profiles can carry arbitrary descriptions, so every APP2 is removed.
            keep |= marker == 0xE0 and body.startswith(b"JFIF\0") and len(body) >= 14 and len(body) == 14 + 3 * body[12] * body[13]
            keep |= marker == 0xEE and body.startswith(b"Adobe") and len(body) == 12
            if keep:
                cleaned.extend(content[start:end])
            offset = end
            in_scan = marker == 0xDA
        raise ValueError("JPEG 图片不完整。")
    chunks = _strip_webp_chunks(content[12:])
    return b"RIFF" + struct.pack("<I", len(chunks) + 4) + b"WEBP" + chunks


def _strip_webp_chunks(content: bytes, *, frame=False) -> bytes:
    cleaned = bytearray()
    offset = 0
    allowed = {b"ALPH", b"VP8 ", b"VP8L"} if frame else {b"VP8X", b"ANIM", b"ANMF", b"ALPH", b"VP8 ", b"VP8L"}
    while offset < len(content):
        if offset + 8 > len(content):
            raise ValueError("WebP 图片数据块不完整。")
        kind = content[offset:offset + 4]
        length = int.from_bytes(content[offset + 4:offset + 8], "little")
        end = offset + 8 + length
        if end + (length & 1) > len(content):
            raise ValueError("WebP 图片数据块不完整。")
        body = content[offset + 8:end]
        if kind in allowed:
            if kind == b"VP8X":
                if length != 10:
                    raise ValueError("WebP 图片头无效。")
                body = bytes([body[0] & ~0x2C]) + body[1:]
            elif kind == b"ANMF":
                if length < 16:
                    raise ValueError("WebP 动画帧无效。")
                body = body[:16] + _strip_webp_chunks(body[16:], frame=True)
            cleaned.extend(kind + struct.pack("<I", len(body)) + body + (b"\0" if len(body) & 1 else b""))
        offset = end + (length & 1)
    return bytes(cleaned)


def validate_input(operation, data):
    if not isinstance(data, dict) or set(data) - {"prompt", "size", "image"}:
        raise ValueError("图片输入字段无效。")
    if operation in {"validate_connection", "models"}:
        if data:
            raise ValueError("连接校验和模型列表 input 必须为空。")
        return None
    prompt = data.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > MAX_PROMPT_CHARS:
        raise ValueError("请填写不超过 6000 字的图片提示词。")
    if data.get("size", "2K") != "2K":
        raise ValueError("当前图片任务仅支持 2K 预设。")
    image = data.get("image")
    if operation == "generate":
        if image is not None:
            raise ValueError("生成请求不能包含原图，请使用编辑。")
        return None
    if not isinstance(image, dict) or set(image) != {"mime_type", "data_base64"}:
        raise ValueError("图片编辑需要原图的 MIME 类型与 Base64。")
    content = _decode(image["data_base64"])
    return strip_image_metadata(content, image["mime_type"])


def _download_url(config, raw):
    if not isinstance(raw, str) or len(raw) > 8192 or any(ord(c) < 33 or ord(c) == 127 for c in raw) or "\\" in raw:
        raise DestinationRejected("图片下载地址无效。")
    parsed = urlsplit(raw)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username is not None or parsed.password is not None or parsed.fragment or (parsed.port or 443) != 443:
        raise DestinationRejected("图片下载仅允许无认证的公网 HTTPS 地址。")
    host = parsed.hostname.rstrip(".").encode("idna").decode("ascii").lower()
    same = httpx.URL(config.connection["base_url"]).host == host
    roots = _DOWNLOAD_DOMAINS.get(config.connection["preset"], ())
    if not same and not any(host == domain or host.endswith("." + domain) for domain in roots):
        raise DestinationRejected("图片下载域名不属于此连接的允许范围。")
    return str(httpx.URL(raw))


async def _download(config, raw):
    url = _download_url(config, raw)
    # Separate client: never forward Authorization, API keys, cookies or provider headers to storage.
    async with _client(url, config.connection["preset"] == "custom") as client:
        async with client.stream("GET", url, headers={"Accept-Encoding": "identity"}) as response:
            content = await _read(response, MAX_IMAGE_BYTES)
            declared = response.headers.get("content-type", "").split(";")[0].strip().lower()
            return content, declared if declared.startswith("image/") else None


def _usage(raw):
    value = raw.get("usage") or raw.get("usageMetadata") or {}
    allowed = {"input_tokens", "output_tokens", "total_tokens", "image_tokens", "text_tokens", "input_tokens_details", "output_tokens_details",
               "promptTokenCount", "candidatesTokenCount", "totalTokenCount", "thoughtsTokenCount", "image_count", "output_image_count", "input_image_count", "output_height", "output_width", "width", "height"}
    if not isinstance(value, dict):
        return {}
    return {k: v if type(v) in (int, float) and v >= 0 else {child: count for child, count in v.items() if child in allowed and type(count) is int and count >= 0}
            for k, v in value.items() if k in allowed and (type(v) in (int, float) and 0 <= v < 2**53 or isinstance(v, dict))}


async def list_models(config):
    connection = config.connection if isinstance(config, ImageConfig) else config
    entry = next((p for p in IMAGE_PROVIDERS if p["id"] == connection["preset"]), None)
    if entry:
        return {"models": [{"id": model, "name": model} for model in entry["models"]], "catalog_supported": False}
    if connection["protocol"] != "openai_images":
        return {"models": [], "catalog_supported": False}
    try:
        async with _client(connection["base_url"], True) as client:
            async with client.stream("GET", connection["base_url"] + "/models", headers=_headers(config)) as response:
                if response.status_code in {404, 405, 501}:
                    return {"models": [], "catalog_supported": False}
                raw = json.loads(await _read(response, 1024 * 1024))
        models = raw.get("data")
        if not isinstance(models, list):
            raise DeepSeekClientError("图片模型目录格式无效。")
        ids = sorted({m["id"] for m in models if isinstance(m, dict) and isinstance(m.get("id"), str) and _MODEL_RE.fullmatch(m["id"]) and (not config.api_key or config.api_key not in m["id"])})
        return {"models": [{"id": model, "name": model} for model in ids[:1000]], "catalog_supported": True, "truncated": len(ids) > 1000}
    except (DeepSeekClientError, DestinationRejected, asyncio.TimeoutError):
        raise
    except Exception:
        raise DeepSeekClientError("图片模型目录格式无效或网络中断。") from None


async def request_image(config, operation, data, metrics):
    content = validate_input(operation, data)
    connection = config.connection
    if not connection["model"]:
        raise ValueError("请选择或填写图片模型ID。")
    protocol, model = connection["protocol"], connection["model"]
    headers = _headers(config)
    image = data.get("image")
    image_base64 = base64.b64encode(content).decode("ascii") if image else None
    data_url = "data:" + image["mime_type"] + ";base64," + image_base64 if image else None
    path = "/images/generations"
    kwargs = {}
    if protocol == "seedream_images":
        body = {"model": model, "prompt": data["prompt"], "response_format": "url", "size": "2K", "stream": False, "watermark": True,
                "sequential_image_generation": "disabled"}
        if data_url:
            body["image"] = data_url
        kwargs["json"] = body
    elif protocol == "openai_images":
        body = {"model": model, "prompt": data["prompt"], "size": "1024x1536", "n": 1}
        if operation == "edit":
            path = "/images/edits"
            kwargs = {"data": {k: str(v) for k, v in body.items()}, "files": {"image": ("original." + image["mime_type"].split("/")[1], content, image["mime_type"])}}
        else:
            kwargs["json"] = body
    elif protocol == "gemini_images":
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}", model):
            raise ValueError("Gemini 图片模型ID不允许路径字符。")
        path = "/models/" + model + ":generateContent"
        parts = [{"text": data["prompt"]}]
        if image:
            parts.insert(0, {"inlineData": {"mimeType": image["mime_type"], "data": image_base64}})
        kwargs["json"] = {"contents": [{"role": "user", "parts": parts}], "generationConfig": {"responseModalities": ["TEXT", "IMAGE"], "responseFormat": {"image": {"aspectRatio": "2:3", "imageSize": "2K"}}}}
    else:
        path = "/services/aigc/multimodal-generation/generation"
        parts = [{"text": data["prompt"]}]
        if data_url:
            parts.insert(0, {"image": data_url})
        kwargs["json"] = {"model": model, "input": {"messages": [{"role": "user", "content": parts}]}, "parameters": {"size": "1536*2048", "n": 1}}

    async def run():
        async with _client(connection["base_url"], connection["preset"] == "custom") as client:
            metrics["call_count"] = metrics.get("call_count", 0) + 1
            async with client.stream("POST", connection["base_url"] + path, headers=headers, **kwargs) as response:
                raw = json.loads(await _read(response, MAX_JSON_BYTES, gemini_error=protocol == "gemini_images"))
                if protocol == "gemini_images":
                    _gemini_error(raw, response.status_code)
        if not isinstance(raw, dict) or raw.get("error") or raw.get("code"):
            raise DeepSeekClientError("图片服务返回错误，未保存图片。")
        declared = None
        if protocol == "gemini_images":
            candidates = raw.get("candidates") or []
            candidate = candidates[0] if candidates else {}
            finish = candidate.get("finishReason")
            if isinstance(finish, str) and finish in _GEMINI_REJECTED_FINISHES:
                raise ImageProviderError("image_content_rejected")
            if finish not in {None, "STOP"}:
                raise ImageProviderError("image_outcome_unknown")
            output = next((p.get("inlineData") or p.get("inline_data") for p in candidate.get("content", {}).get("parts", []) if not p.get("thought") and (p.get("inlineData") or p.get("inline_data"))), None)
            if not output:
                raise ImageProviderError("image_outcome_unknown")
            content = _decode(output.get("data"))
            declared = output.get("mimeType") or output.get("mime_type")
        elif protocol == "qwen_images":
            choices = raw.get("output", {}).get("choices") or []
            choice = choices[0] if choices else {}
            if choice.get("finish_reason") != "stop":
                raise DeepSeekClientError("图片输出被拒绝或未完整结束。")
            url = next((p.get("image") for p in choice.get("message", {}).get("content", []) if p.get("image")), None)
            content, declared = await _download(config, url)
        else:
            outputs = raw.get("data") or []
            output = outputs[0] if outputs else {}
            if output.get("error"):
                raise DeepSeekClientError("图片输出被拒绝。")
            if output.get("b64_json"):
                content = _decode(output["b64_json"])
            else:
                content, declared = await _download(config, output.get("url"))
        content = strip_image_metadata(content, declared)
        mime, width, height = image_info(content, declared)
        usage = _usage(raw)
        result = {"image": {"mime_type": mime, "data_base64": base64.b64encode(content).decode("ascii"), "width": width, "height": height}, "model": model}
        if usage:
            result["usage"] = usage
            for source, target in (("input_tokens", "prompt_tokens"), ("output_tokens", "completion_tokens"), ("promptTokenCount", "prompt_tokens"), ("candidatesTokenCount", "completion_tokens")):
                if type(usage.get(source)) is int:
                    metrics[target] = usage[source]
        return result

    try:
        return await asyncio.wait_for(run(), MAX_MODEL_SECONDS)
    except (ImageProviderError, DestinationRejected, asyncio.TimeoutError):
        raise
    except httpx.TimeoutException:
        if protocol == "gemini_images":
            raise asyncio.TimeoutError() from None
        raise DeepSeekClientError("图片响应格式无效或网络中断，请检查连接后手动重试。") from None
    except DeepSeekClientError:
        if protocol == "gemini_images":
            raise ImageProviderError("image_outcome_unknown") from None
        raise
    except Exception:
        if protocol == "gemini_images":
            raise ImageProviderError("image_outcome_unknown") from None
        raise DeepSeekClientError("图片响应格式无效或网络中断，请检查连接后手动重试。") from None
