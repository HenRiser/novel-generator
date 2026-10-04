"""Versioned public provider presets and strict, secret-free connection contracts."""
from __future__ import annotations
import hashlib
import ipaddress
import json
import re
import struct
from urllib.parse import urlsplit

CATALOG_VERSION = 1
PROTOCOLS = ("chat_completions", "messages")
STRUCTURED_OPERATIONS = {"expand_setting", "story_delta", "import_chapter", "import_synthesis", "plan_chapter"}
CATALOG = [
    {"id": "deepseek", "name": "DeepSeek", "protocol": "chat_completions", "url": "https://api.deepseek.com", "structured": "json_object"},
    {"id": "qwen", "name": "阿里云百炼 / Qwen", "protocol": "chat_completions", "url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "structured": "json_object", "regions": [
        {"id": "beijing", "name": "北京", "url": "https://dashscope.aliyuncs.com/compatible-mode/v1"},
        {"id": "singapore", "name": "新加坡", "url": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"},
        {"id": "virginia", "name": "弗吉尼亚", "url": "https://dashscope-us.aliyuncs.com/compatible-mode/v1"},
        {"id": "tokyo", "name": "东京", "url": "https://dashscope-jp.aliyuncs.com/compatible-mode/v1"}]},
    {"id": "kimi", "name": "Kimi", "protocol": "chat_completions", "url": "https://api.moonshot.cn/v1", "structured": "json_object"},
    {"id": "glm", "name": "智谱 / GLM", "protocol": "chat_completions", "url": "https://open.bigmodel.cn/api/paas/v4", "structured": "json_object"},
    {"id": "openai", "name": "OpenAI", "protocol": "chat_completions", "url": "https://api.openai.com/v1", "structured": "json_schema"},
    {"id": "gemini", "name": "Google Gemini", "protocol": "chat_completions", "url": "https://generativelanguage.googleapis.com/v1beta/openai", "structured": "json_schema"},
    {"id": "claude", "name": "Anthropic Claude", "protocol": "messages", "url": "https://api.anthropic.com/v1", "structured": "json_schema"},
    {"id": "openrouter", "name": "OpenRouter", "protocol": "chat_completions", "url": "https://openrouter.ai/api/v1", "structured": "unsupported"},
]


def canonical_url(raw: str) -> str:
    if not isinstance(raw, str) or not raw.strip() or len(raw) > 2048:
        raise ValueError("API Base URL 必须是有效 HTTPS 地址。")
    raw = raw.strip()
    if any(ord(c) < 33 or ord(c) == 127 for c in raw) or any(c in raw for c in ("\\", "?", "#", "%")):
        raise ValueError("地址不能含空白、查询、片段、反斜杠或歧义百分号编码。")
    parsed = urlsplit(raw)
    if parsed.scheme.lower() != "https" or not parsed.hostname or parsed.username is not None or parsed.password is not None:
        raise ValueError("仅接受不带用户名、密码的公网 HTTPS API 地址。")
    host = parsed.hostname.rstrip(".").encode("idna").decode("ascii").lower()
    try:
        ip = ipaddress.ip_address(host)
        host = ip.compressed
        if ip.version == 6:
            host = "[" + host + "]"
    except ValueError:
        if not re.fullmatch(r"(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", host) or ".." in host:
            raise ValueError("主机名无效。") from None
    port = parsed.port
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("端口无效。")
    path = parsed.path.rstrip("/")
    if "//" in path or any(p in {".", ".."} for p in path.split("/")) or not re.fullmatch(r"[A-Za-z0-9/_~.!$&'()*+,;=:@-]*", path):
        raise ValueError("API路径无效，请使用服务商提供的标准 Base URL。")
    if path.endswith(("/chat/completions", "/messages", "/models")):
        raise ValueError("请填写 API Base URL，不包含 /chat/completions、/messages 或 /models。")
    return "https://" + host + (":" + str(port) if port and port != 443 else "") + path


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


# A finite rule set, not a promise that every model offered by a provider supports JSON.
MODEL_RULES = {
    'deepseek': {'deepseek-chat':'json_object','deepseek-reasoner':'json_object'},
    'qwen': {'qwen-plus':'json_object','qwen-turbo':'json_object','qwen-max':'json_object'},
    'kimi': {'moonshot-v1-8k':'json_object','moonshot-v1-32k':'json_object','moonshot-v1-128k':'json_object'},
    'glm': {'glm-4-plus':'json_object','glm-4-flash':'json_object'},
    'openai': {'gpt-4o':'json_schema','gpt-4o-mini':'json_schema'},
    'gemini': {'gemini-2.5-flash':'json_schema','gemini-2.5-pro':'json_schema'},
    'claude': {'claude-sonnet-4-5':'json_schema','claude-opus-4-5':'json_schema','claude-haiku-4-5':'json_schema'},
}


def default_policy(preset: str, model: str = "") -> dict:
    return {"version": 1, "source": "official_catalog" if preset in {p['id'] for p in CATALOG} else "user_override",
            "token_field": "max_completion_tokens" if preset == "openai" else "max_tokens",
            "temperature": "omit", "temperature_min": 0, "temperature_max": 2, "temperature_fixed": 1,
            "stream_usage": False, "structured": MODEL_RULES.get(preset, {}).get(model, 'unsupported')}


def validate_policy(raw: dict, protocol: str) -> dict:
    if not isinstance(raw, dict) or set(raw) != set(default_policy("custom")):
        raise ValueError("能力策略字段无效。")
    p = dict(raw)
    if p["version"] != 1 or p["source"] not in {"official_catalog", "user_override"}:
        raise ValueError("能力策略版本无效。")
    if p["token_field"] not in {"max_tokens", "max_completion_tokens"} or (protocol == "messages" and p["token_field"] != "max_tokens"):
        raise ValueError("输出额度字段与协议不匹配。")
    if p["temperature"] not in {"omit", "range", "fixed"} or type(p["stream_usage"]) is not bool:
        raise ValueError("温度或usage设置无效。")
    for k in ("temperature_min", "temperature_max", "temperature_fixed"):
        if type(p[k]) not in (int, float) or not 0 <= p[k] <= 2:
            raise ValueError("温度范围无效。")
        p[k] = float(p[k]) if p[k] % 1 else int(p[k])
    if p["temperature_min"] > p["temperature_max"]:
        raise ValueError("温度下限超过上限。")
    if p["structured"] not in {"json_schema", "json_object", "prompt_only", "unsupported"} or (protocol == "messages" and p["structured"] == "json_object"):
        raise ValueError("结构化模式与协议不匹配。")
    return p


def normalize_connection(raw: dict, *, verify: bool = False) -> dict:
    fields = {"profile_id", "revision", "preset", "protocol", "base_url", "model", "policy", "destination_fingerprint", "execution_fingerprint", "auth_mode"}
    if not isinstance(raw, dict) or set(raw) - fields:
        raise ValueError("连接字段无效。")
    if not isinstance(raw.get("profile_id"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", raw["profile_id"]) or type(raw.get("revision")) is not int or raw["revision"] < 1:
        raise ValueError("连接标识无效。")
    protocol = raw.get("protocol")
    if protocol not in PROTOCOLS:
        raise ValueError("不支持此API协议。")
    url = canonical_url(raw.get("base_url"))
    preset = raw.get("preset", "custom")
    if preset != "custom":
        entry = next((p for p in CATALOG if p["id"] == preset), None)
        workspace_url = preset == 'qwen' and bool(re.fullmatch(r'https://[a-z0-9-]{1,80}\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com/compatible-mode/v1', url))
        if entry is None or protocol != entry["protocol"] or (url not in {entry["url"], *(r["url"] for r in entry.get("regions", []))} and not workspace_url):
            raise ValueError("预设与目的地址不匹配；修改地址请创建 Custom 连接。")
    model = raw.get("model", "")
    if not isinstance(model, str) or len(model) > 200 or (model and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/~+-]*", model)):
        raise ValueError("请输入API模型ID，允许组织/模型与常见别名。")
    policy = validate_policy(raw.get("policy", default_policy(preset, model)), protocol)
    if policy['source']=='official_catalog':
        policy = default_policy(preset, model)
    auth = raw.get("auth_mode", "key")
    if auth not in {"key", "none"} or (preset != "custom" and auth != "key"):
        raise ValueError("仅Custom可显式选择无认证。")
    destination = digest("endpoint-v1\n" + protocol + "\n" + url)
    execution = digest(json.dumps({"destination": destination, "model": model, "policy": policy, "auth_mode": auth}, sort_keys=True, separators=(",", ":"), ensure_ascii=False))
    if verify and (raw.get("destination_fingerprint") != destination or raw.get("execution_fingerprint") != execution):
        raise ValueError("连接指纹不匹配，请重新保存连接。")
    return {"profile_id": raw["profile_id"], "revision": raw["revision"], "preset": preset, "protocol": protocol, "base_url": url,
            "model": model, "policy": policy, "auth_mode": auth, "destination_fingerprint": destination, "execution_fingerprint": execution}


def catalog() -> list[dict]:
    return [{**p, "policy": default_policy(p["id"]), "model_rules": MODEL_RULES.get(p["id"], {})} for p in CATALOG]


def request_fingerprint(connection, operation, data):
    """Bind the selected policy and effective model-call parameters (including repair budget).

    Floating point values use IEEE-754 bytes so browser/Python exponent formatting cannot differ.
    """
    request, config = data.get('request') or {}, data.get('config') or {}
    if operation in {'generate_chapter','continue_chapter','generate_outline','generate_characters','expand_setting'}:
        pairs = [(int(request.get('max_tokens', config.get('max_tokens', 4000))), float(request.get('temperature', config.get('temperature', .7))))]
    elif operation == 'summarize_chapter': pairs = [(1800 if data.get('review_scope')=='semantic_and_rules' else 512, .2)]
    elif operation == 'story_delta': pairs = [(8000,.2),(8000,0)]
    elif operation == 'plan_chapter': pairs = [(4000,.3),(4000,.1)]
    elif operation == 'import_chapter': pairs = [(6000,.2)]
    elif operation == 'import_synthesis': pairs = [(8000,.2)]
    elif operation == 'connection_test': pairs = [(512,1)] * (1 if connection['policy']['structured']=='unsupported' else 2)
    else: pairs = []
    policy = connection['policy']
    parameters = [{'tokens':tokens,'temperature': None if policy['temperature']=='omit' else struct.pack('>d', float(policy['temperature_fixed'] if policy['temperature']=='fixed' else temp)).hex()} for tokens,temp in pairs]
    return digest(json.dumps({'execution':connection['execution_fingerprint'],'operation':operation,'parameters':parameters},sort_keys=True,separators=(',',':'),ensure_ascii=False))
