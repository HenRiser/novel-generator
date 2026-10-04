"""Two explicit text protocols over a request-scoped, restricted transport."""
from __future__ import annotations
import asyncio
import json
from dataclasses import dataclass, field
from time import monotonic
from typing import Any
import httpx
from deepseek_client import DeepSeekClientError, _quiet_provider_logging, _capture_usage
from provider_catalog import normalize_connection
from provider_transport import SafeTransport, DestinationRejected
from structured_schemas import SCHEMAS, validate_schema

MODEL_TIMEOUT_SECONDS = 120.0
MAX_JSON_BYTES = 4 * 1024 * 1024
MAX_STREAM_BYTES = 8 * 1024 * 1024
MAX_EVENT_BYTES = 256 * 1024

@dataclass(frozen=True)
class ModelConfig:
    connection: dict
    api_key: str = field(repr=False)
    operation: str = ""
    response_schema: dict | None = field(default=None, repr=False)
    def __post_init__(self):
        normalized = normalize_connection(self.connection, verify=True)
        object.__setattr__(self, 'connection', normalized)
        if not isinstance(self.api_key, str) or len(self.api_key) > 4096 or any(ord(c) < 32 or ord(c) > 126 for c in self.api_key):
            raise ValueError('API Key 必须是不包含控制字符的有效认证文本。')
        if normalized['auth_mode'] == 'key' and not self.api_key.strip(): raise ValueError('请先填写或解锁此连接的API Key。')
        if normalized['auth_mode'] == 'none' and self.api_key: raise ValueError('无认证连接不能携带Key。')


def _client(config):
    _quiet_provider_logging()
    return httpx.AsyncClient(transport=SafeTransport(config.connection['base_url'], config.connection['preset'] == 'custom'),
                            timeout=MODEL_TIMEOUT_SECONDS, follow_redirects=False, trust_env=False)


def _headers(config):
    headers = {'Content-Type': 'application/json', 'Accept-Encoding': 'identity'}
    if config.connection['protocol'] == 'messages':
        headers['anthropic-version'] = '2023-06-01'
        if config.api_key: headers['x-api-key'] = config.api_key
    elif config.api_key: headers['Authorization'] = 'Bearer ' + config.api_key
    return headers


def _status(response):
    status = response.status_code
    messages = {401: 'API Key 无效或已过期。', 403: '此Key无模型权限或地域不匹配。', 404: 'API路径或模型不存在；模型目录不可用时可以手填模型。',
                429: '上游限流或额度不足，请检查后手动重试。', 400: '模型拒绝参数，请检查协议、额度字段及能力设置。', 402:'上游额度不足。'}
    if 300 <= status < 400: raise DeepSeekClientError('模型服务返回重定向，未跟随；请填写最终API Base URL。')
    if status >= 400: raise DeepSeekClientError(messages.get(status, '模型服务未完成请求，请稍后手动重试。'))
    if response.headers.get('content-encoding', 'identity').lower() not in {'', 'identity'}:
        raise DeepSeekClientError('上游返回压缩响应，安全出口不接受，请关闭网关压缩。')


def _body(config, messages, temperature, max_tokens, json_mode, stream):
    c = config.connection; policy = c['policy']
    if not c['model']: raise ValueError('请选择或输入模型ID，再调用模型。')
    payload = {'model': c['model'], policy['token_field']: max_tokens, 'stream': stream}
    if policy['temperature'] == 'range':
        if not policy['temperature_min'] <= temperature <= policy['temperature_max']: raise ValueError('温度超出此模型允许范围。')
        payload['temperature'] = temperature
    elif policy['temperature'] == 'fixed': payload['temperature'] = policy['temperature_fixed']
    if c['protocol'] == 'messages':
        payload['system'] = '\n\n'.join(m['content'] for m in messages if m['role']=='system')
        payload['messages'] = [m for m in messages if m['role'] != 'system']
    else:
        payload['messages'] = messages
        if stream and policy['stream_usage']: payload['stream_options'] = {'include_usage': True}
    if json_mode:
        mode = policy['structured']
        if mode == 'unsupported': raise ValueError('此连接尚未启用结构化输出，请设置能力或显式启用提示词兼容模式。')
        if mode == 'json_schema':
            schema = config.response_schema if config.response_schema is not None else SCHEMAS.get(config.operation)
            if schema is None: raise ValueError('此操作缺少结构化格式。')
            validate_schema(schema)
            if c['protocol'] == 'messages': payload['output_config'] = {'format': {'type': 'json_schema', 'schema': schema}}
            else: payload['response_format'] = {'type': 'json_schema', 'json_schema': {'name': config.operation, 'strict': True, 'schema': schema}}
        elif mode == 'json_object': payload['response_format'] = {'type': 'json_object'}
    return payload


def _usage(raw, config, usage):
    if config.connection['protocol'] == 'chat_completions': _capture_usage(raw, usage)
    else:
        value = raw.get('usage') or raw.get('message', {}).get('usage') or {}
        # Anthropic input_tokens excludes cache; show the full input count and native cache categories.
        if type(value.get('input_tokens')) is int:
            usage['prompt_tokens'] = value['input_tokens'] + value.get('cache_creation_input_tokens', 0) + value.get('cache_read_input_tokens', 0)
        if type(value.get('input_tokens')) is int and (type(value.get('cache_creation_input_tokens')) is int or type(value.get('cache_read_input_tokens')) is int):
            usage['prompt_cache_miss_tokens'] = value['input_tokens'] + value.get('cache_creation_input_tokens', 0)
        for native, key in [('output_tokens','completion_tokens'), ('cache_read_input_tokens','prompt_cache_hit_tokens')]:
            if type(value.get(native)) is int: usage[key] = value[native]


def _merge(metrics, usage):
    if metrics is not None:
        for k,v in usage.items():
            if type(v) is int and v >= 0: metrics[k] = metrics.get(k,0) + v


def _started(metrics):
    if metrics is not None: metrics['call_count'] = metrics.get('call_count',0) + 1


async def request_text(config, messages, *, temperature=.7, max_tokens=4000, json_mode=False, usage_metrics=None):
    body = _body(config, messages, temperature, max_tokens, json_mode, False)
    path = '/messages' if config.connection['protocol']=='messages' else '/chat/completions'
    usage = {}
    async def run():
        async with _client(config) as client:
            _started(usage_metrics)
            async with client.stream('POST', config.connection['base_url'] + path, headers=_headers(config), json=body) as response:
                _status(response); data = bytearray()
                async for chunk in response.aiter_raw():
                    if len(data) + len(chunk) > MAX_JSON_BYTES: raise DeepSeekClientError('模型响应过大，未保存。')
                    data.extend(chunk)
            parsed = json.loads(data)
            _usage(parsed,config,usage)
            if config.connection['protocol']=='messages':
                if parsed.get('stop_reason') not in {'end_turn','stop_sequence'}: raise DeepSeekClientError('模型输出截断或拒绝，未保存为完整结果。')
                text = ''.join(b.get('text','') for b in parsed.get('content',[]) if b.get('type')=='text')
            else:
                choice = parsed.get('choices',[{}])[0]
                if choice.get('finish_reason') != 'stop' or choice.get('message',{}).get('refusal'): raise DeepSeekClientError('模型输出截断或拒绝，未保存为完整结果。')
                text = choice.get('message',{}).get('content','')
            if not isinstance(text,str) or not text.strip(): raise DeepSeekClientError('模型未返回完整文字。')
            return text.strip()
    try: return await asyncio.wait_for(run(),MODEL_TIMEOUT_SECONDS)
    except (DeepSeekClientError, asyncio.TimeoutError, DestinationRejected): raise
    except Exception: raise DeepSeekClientError('上游响应协议无效或网络中断，请检查配置后手动重试。') from None
    finally: _merge(usage_metrics,usage)


async def request_text_stream(config, messages, *, temperature=.7, max_tokens=4000, usage_metrics=None):
    payload = _body(config,messages,temperature,max_tokens,False,True)
    path = '/messages' if config.connection['protocol']=='messages' else '/chat/completions'
    usage = {}; seen=False; finished=False; stopped=False; truncated=False; total=0; buffer=b''; event_lines=[]; event_bytes=0
    deadline=monotonic()+MODEL_TIMEOUT_SECONDS
    async def timed(coro): return await asyncio.wait_for(coro,max(0,deadline-monotonic()))
    try:
        async with _client(config) as client:
            _started(usage_metrics)
            request=client.build_request('POST',config.connection['base_url']+path,headers=_headers(config),json=payload)
            response=await timed(client.send(request,stream=True))
            try:
                _status(response)
                chunks=response.aiter_raw().__aiter__()
                while True:
                    try: chunk=await timed(chunks.__anext__())
                    except StopAsyncIteration: break
                    total+=len(chunk)
                    if total>MAX_STREAM_BYTES: raise DeepSeekClientError('流式响应超过容量限制。')
                    buffer+=chunk
                    while b'\n' in buffer:
                        line,buffer=buffer.split(b'\n',1);line=line.rstrip(b'\r')
                        event_bytes+=len(line)
                        if event_bytes>MAX_EVENT_BYTES: raise DeepSeekClientError('流式事件超过容量限制。')
                        if line:
                            if line.startswith(b'data:'): event_lines.append(line[5:].lstrip())
                            continue
                        data=b'\n'.join(event_lines);event_lines=[];event_bytes=0
                        if not data: continue
                        if data==b'[DONE]':
                            if config.connection['protocol']!='chat_completions' or finished or not stopped: raise DeepSeekClientError('模型缺少合法终止原因。')
                            finished=True; continue
                        raw=json.loads(data)
                        if finished: raise DeepSeekClientError('模型在完成事件之后继续输出，未保存。')
                        if raw.get('error') or raw.get('type')=='error': raise DeepSeekClientError('模型流返回错误，未作为完整结果保存。')
                        _usage(raw,config,usage)
                        if config.connection['protocol']=='messages':
                            if raw.get('type')=='message_stop':
                                if not stopped: raise DeepSeekClientError('模型缺少合法终止原因。')
                                finished=True
                            delta=raw.get('delta',{})
                            if delta.get('stop_reason') is not None:
                                stopped=True
                                if delta['stop_reason'] not in {'end_turn','stop_sequence'}: truncated=True
                            if stopped and delta.get('type') in {'text_delta','thinking_delta','input_json_delta'}: raise DeepSeekClientError('终止之后收到额外内容。')
                            text=delta.get('text','') if delta.get('type')=='text_delta' else ''
                            reasoning=delta.get('thinking','') if delta.get('type')=='thinking_delta' else ''
                        else:
                            choices=raw.get('choices') or [];choice=choices[0] if choices else {};delta=choice.get('delta') or {}
                            if stopped and (delta.get('content') or delta.get('reasoning_content') or delta.get('tool_calls')): raise DeepSeekClientError('终止之后收到额外内容。')
                            if choice.get('finish_reason') is not None:
                                stopped=True
                                if choice['finish_reason']!='stop': truncated=True
                            if delta.get('refusal') or delta.get('tool_calls'): truncated=True
                            text=delta.get('content') or '';reasoning=delta.get('reasoning_content') or ''
                        if reasoning and isinstance(reasoning,str): yield {'kind':'reasoning','text':reasoning}
                        if text and isinstance(text,str): seen=True;yield {'kind':'content','text':text}
                    if len(buffer)+event_bytes>MAX_EVENT_BYTES: raise DeepSeekClientError('流式事件超过容量限制。')
                if truncated or not finished or not stopped or not seen: raise DeepSeekClientError('模型流截断、拒绝或缺少完成标记；未保存为完整结果。')
            finally: await response.aclose()
    except (DeepSeekClientError,asyncio.TimeoutError,DestinationRejected): raise
    except Exception: raise DeepSeekClientError('模型流协议无效或网络中断，请手动重试。') from None
    finally: _merge(usage_metrics,usage)


async def list_models(config):
    async def run():
        async with _client(config) as client:
            async with client.stream('GET',config.connection['base_url']+'/models',headers=_headers(config)) as response:
                _status(response);data=bytearray()
                async for chunk in response.aiter_raw():
                    if len(data)+len(chunk)>MAX_JSON_BYTES: raise DeepSeekClientError('模型目录过大，请手动输入模型ID。')
                    data.extend(chunk)
            parsed=json.loads(data);items=parsed.get('data',[])
            if not isinstance(items,list): raise DeepSeekClientError('模型目录格式不支持，请手动输入模型ID。')
            return {'models':[{'id':m['id'],'name':m.get('display_name') or m.get('name') or m['id']} for m in items[:500] if isinstance(m,dict) and isinstance(m.get('id'),str) and len(m['id'])<=200],
                    'truncated':len(items)>500 or bool(parsed.get('has_more')), 'message':'目录不保证所有模型都支持文字和结构化操作。'}
    try: return await asyncio.wait_for(run(),30)
    except (DeepSeekClientError,asyncio.TimeoutError,DestinationRejected): raise
    except Exception: raise DeepSeekClientError('模型目录读取失败，仍可手动输入模型ID。') from None
