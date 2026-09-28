"""SSRF-safe HTTPX transport using HTTPCore's public network backend extension."""
from __future__ import annotations
import asyncio
import ipaddress
import os
import socket
import ssl
import httpcore
import anyio
import httpx


class DestinationRejected(ValueError):
    pass


def _address(value: str):
    ip = ipaddress.ip_address(value)
    return ip.ipv4_mapped if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped else ip


def configured_self_addresses(custom: bool) -> set:
    raw = os.environ.get("BRAIPEN_SELF_ADDRESSES", "")
    if custom and not raw.strip():
        raise DestinationRejected("Custom尚未启用：管理员需配置 BRAIPEN_SELF_ADDRESSES。")
    try:
        values = {_address(v.strip()) for v in raw.split(",") if v.strip()}
    except ValueError:
        if custom: raise DestinationRejected("服务器自身地址配置无效，Custom不能执行。") from None
        values = set()
    try:
        values.update(_address(row[4][0]) for row in socket.getaddrinfo(socket.gethostname(), None))
    except OSError:
        if custom:
            raise DestinationRejected("无法确认服务器本机地址，Custom不能执行。") from None
    return values


async def public_addresses(host: str, port: int, denied: set) -> list[str]:
    # One bounded resolution per socket; the delegate receives only validated numeric IPs.
    try:
        rows = await asyncio.wait_for(asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM), 5)
    except (OSError, asyncio.TimeoutError):
        raise DestinationRejected("无法解析模型服务域名。") from None
    addresses = list(dict.fromkeys(row[4][0] for row in rows))
    if not addresses or len(addresses) > 32:
        raise DestinationRejected("域名解析结果无效。")
    for text in addresses:
        original = ipaddress.ip_address(text)
        ip = _address(text)
        if any(original.version == network.version and original in network for network in SPECIAL) or not ip.is_global or ip.is_multicast or ip.is_reserved or ip.is_loopback or ip.is_link_local or ip in denied:
            raise DestinationRejected("模型地址解析到禁止访问的网络，请使用公网HTTPS API。")
    return addresses


SPECIAL = [ipaddress.ip_network(cidr) for cidr in ('192.0.0.0/24', '192.0.2.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '100.64.0.0/10', '0.0.0.0/8', '240.0.0.0/4', '64:ff9b::/96', '64:ff9b:1::/48', '2002::/16', '2001::/32', '2001:db8::/32', '::ffff:0:0/96')]


class ClosingStream(httpcore.AsyncNetworkStream):
    def __init__(self, stream): self.stream = stream
    async def read(self, max_bytes, timeout=None): return await self.stream.read(max_bytes, timeout)
    async def write(self, buffer, timeout=None): return await self.stream.write(buffer, timeout)
    async def aclose(self): await self.stream.aclose()
    def get_extra_info(self, info): return self.stream.get_extra_info(info)
    async def start_tls(self, ssl_context, server_hostname=None, timeout=None):
        try:
            return ClosingStream(await self.stream.start_tls(ssl_context, server_hostname, timeout))
        except BaseException:
            with anyio.move_on_after(2, shield=True):
                await self.stream.aclose()
            raise


class PinnedBackend(httpcore.AsyncNetworkBackend):
    def __init__(self, host: str, port: int, denied: set):
        self.host, self.port, self.denied = host, port, denied
        self.delegate = httpcore.AnyIOBackend()

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        if host != self.host or port != self.port or local_address is not None:
            raise DestinationRejected("请求目标与连接不一致。")
        addresses = await public_addresses(host, port, self.denied)
        # No retry to a re-resolved hostname. TLS start_tls is subsequently called by httpcore
        # with the original URL hostname, never the IP passed to connect_tcp here.
        return ClosingStream(await self.delegate.connect_tcp(addresses[0], port, timeout, socket_options=socket_options))

    async def connect_unix_socket(self, *args, **kwargs):
        raise DestinationRejected("不允许Unix socket。")

    async def sleep(self, seconds):
        await asyncio.sleep(seconds)


class ResponseStream(httpx.AsyncByteStream):
    def __init__(self, stream): self.stream = stream
    async def __aiter__(self):
        async for chunk in self.stream: yield chunk
    async def aclose(self): await self.stream.aclose()


class SafeTransport(httpx.AsyncBaseTransport):
    def __init__(self, base_url: str, custom: bool):
        self.url = httpx.URL(base_url)
        self.backend = PinnedBackend(self.url.host, self.url.port or 443, configured_self_addresses(custom))
        self.pool = httpcore.AsyncConnectionPool(ssl_context=httpx.create_ssl_context(trust_env=False), network_backend=self.backend,
                                               retries=0, max_connections=1, max_keepalive_connections=0, http2=False)

    async def handle_async_request(self, request):
        if request.url.scheme != 'https' or request.url.host != self.url.host or (request.url.port or 443) != (self.url.port or 443):
            raise DestinationRejected("网络出口拒绝未授权目标。")
        response = await self.pool.handle_async_request(httpcore.Request(
            method=request.method, url=httpcore.URL(scheme=request.url.raw_scheme, host=request.url.raw_host,
            port=request.url.port, target=request.url.raw_path), headers=request.headers.raw,
            content=request.stream, extensions=request.extensions))
        return httpx.Response(response.status, headers=response.headers, stream=ResponseStream(response.stream), extensions=response.extensions)

    async def aclose(self): await self.pool.aclose()
