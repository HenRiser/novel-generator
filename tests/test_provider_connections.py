from __future__ import annotations
import asyncio
import ipaddress
import json
import os
import shutil
import socket
import ssl
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
import httpx
import httpcore
from fastapi.testclient import TestClient
from api.main import app
from provider_catalog import CATALOG, canonical_url, default_policy, normalize_connection, request_fingerprint
from provider_transport import PinnedBackend, SafeTransport, ClosingStream, DestinationRejected, public_addresses, configured_self_addresses
import model_client as models
from services import compute_service


def connection(preset='custom', protocol='chat_completions', model='org/model:free', **changes):
    entry=next((p for p in CATALOG if p['id']==preset),None)
    return normalize_connection({'profile_id':'test-profile','revision':1,'preset':preset,'protocol':entry['protocol'] if entry else protocol,
        'base_url':entry['url'] if entry else 'https://provider.example/v1','model':model,'policy':default_policy(preset),'auth_mode':'key',**changes})


def request(conn, key='non-sk-key'):
    return {'protocol_version':2,'connection':conn,'credentials':{'api_key':key},'input':{},'run_id':'run','step_id':'step','attempt_id':'attempt','input_revision':0}


def response(data, status=200, headers=None):
    return httpx.Response(status,headers=headers,stream=httpx.ByteStream(data if isinstance(data,bytes) else json.dumps(data).encode()))


def client_factory(handler):
    return lambda _:httpx.AsyncClient(transport=httpx.MockTransport(handler),follow_redirects=False,trust_env=False)


class ConnectionContracts(unittest.TestCase):
    def test_eight_presets_and_custom_canonical_fingerprints(self):
        self.assertEqual(len(CATALOG),8)
        for p in CATALOG:
            with self.subTest(preset=p['id']):
                c=connection(p['id']);self.assertEqual(normalize_connection(c,verify=True),c)
        self.assertEqual(canonical_url(' HTTPS://EXAMPLE.COM.:443/v1/ '),'https://example.com/v1')
        self.assertEqual(canonical_url('https://例子.com/v1'),'https://xn--fsqu00a.com/v1')
        for url in ['http://example.com','https://u:p@example.com','https://example.com/v1?key=x','https://example.com/v1#x','https://example.com/%2e%2e/a','https://example.com/../a','https://example.com//v1','https://example.com/v1/chat/completions']:
            with self.subTest(url=url),self.assertRaises(ValueError):canonical_url(url)
        c=connection();c['base_url']='https://different.example/v1'
        with self.assertRaises(ValueError):normalize_connection(c,verify=True)

    def test_v2_never_falls_back_to_v1_and_fingerprints_are_recomputed(self):
        client=TestClient(app)
        for payload in [request(connection()),{**request(connection()),'connection':None},{**request(connection()),'protocol_version':3}]:
            if payload.get('connection'):payload['connection']['execution_fingerprint']='forged'
            with patch('services.compute_service.compute',new_callable=AsyncMock) as compute:
                r=client.post('/api/compute/connection_test',json=payload)
                self.assertEqual(r.status_code,400);compute.assert_not_awaited()
        body=request(connection());del body['connection']
        self.assertEqual(client.post('/api/compute/connection_test',json=body).status_code,400)
        c=connection();c['destination_fingerprint']='';c['execution_fingerprint']=''
        r=client.post('/api/compute/validate_connection',json=request(c,key=''))
        self.assertEqual(r.status_code,200);self.assertEqual(r.json()['result']['connection'],connection())

    def test_unknown_models_have_no_official_structured_promise(self):
        for preset in CATALOG:
            self.assertEqual(default_policy(preset['id'],'unknown-model')['structured'],'unsupported')
        self.assertEqual(default_policy('claude','claude-sonnet-4-5')['structured'],'json_schema')
        with patch.dict(os.environ,{'BRAIPEN_SELF_ADDRESSES':'invalid'}):configured_self_addresses(False)

    def test_presets_cannot_be_redirected_and_non_sk_keys_are_accepted(self):
        with self.assertRaises(ValueError):connection('deepseek',base_url='https://gateway.example/v1')
        models.ModelConfig(connection(), 'token.with.dots-not-sk')
        for key in ['abc\r\nx:evil','', 'a'*4097]:
            with self.assertRaises(ValueError):models.ModelConfig(connection(),key)


class NetworkBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_all_records_checked_before_connect_and_special_ranges_rejected(self):
        backend=PinnedBackend('provider.example',443,{ipaddress.ip_address('8.8.8.8')})
        delegate=AsyncMock();backend.delegate=delegate
        loop=asyncio.get_running_loop()
        denied=['127.0.0.1','10.0.0.1','169.254.169.254','100.64.1.1','192.0.0.8','224.0.0.1','8.8.8.8','::1','fe80::1','::ffff:127.0.0.1','::ffff:8.8.8.8','2002:7f00:1::','64:ff9b::7f00:1','2001:db8::1']
        for address in denied:
            with self.subTest(address=address),patch.object(loop,'getaddrinfo',AsyncMock(return_value=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('1.1.1.1',443)),(socket.AF_INET6 if ':' in address else socket.AF_INET,socket.SOCK_STREAM,6,'',(address,443))])):
                with self.assertRaises(DestinationRejected):await backend.connect_tcp('provider.example',443)
        delegate.connect_tcp.assert_not_awaited()

    async def test_resolved_numeric_ip_pinned_and_each_socket_resolves_again(self):
        backend=PinnedBackend('provider.example',443,set());backend.delegate=AsyncMock()
        resolver=AsyncMock(side_effect=[['1.1.1.1'],['9.9.9.9']])
        with patch('provider_transport.public_addresses',resolver):
            await backend.connect_tcp('provider.example',443);await backend.connect_tcp('provider.example',443)
        self.assertEqual([c.args[0] for c in backend.delegate.connect_tcp.call_args_list],['1.1.1.1','9.9.9.9'])
        self.assertEqual(resolver.await_count,2)

    async def test_missing_self_config_blocks_custom_but_not_presets(self):
        with patch.dict(os.environ,{'BRAIPEN_SELF_ADDRESSES':''}):
            with self.assertRaises(DestinationRejected):configured_self_addresses(True)
            configured_self_addresses(False)
        with patch.dict(os.environ,{'BRAIPEN_SELF_ADDRESSES':'not an ip'}):
            with self.assertRaises(DestinationRejected):configured_self_addresses(True)

    async def test_cancel_tls_closes_raw_stream(self):
        began=asyncio.Event();closed=asyncio.Event()
        class Raw:
            async def start_tls(self,*args):began.set();await asyncio.Event().wait()
            async def aclose(self):closed.set()
        task=asyncio.create_task(ClosingStream(Raw()).start_tls(ssl.create_default_context(),'provider.example'))
        await began.wait();task.cancel()
        with self.assertRaises(asyncio.CancelledError):await task
        self.assertTrue(closed.is_set())

    async def test_real_tls_preserves_host_sni_and_certificate_verification(self):
        openssl=shutil.which('openssl')
        if not openssl:self.skipTest('OpenSSL executable required for ephemeral controlled TLS certificate')
        with tempfile.TemporaryDirectory() as tmp:
            cert=Path(tmp)/'cert.pem';key=Path(tmp)/'key.pem';conf=Path(tmp)/'openssl.cnf'
            conf.write_text('[req]\ndistinguished_name=dn\n[dn]\nCN=provider.example\n',encoding='ascii')
            subprocess.run([openssl,'req','-config',str(conf),'-x509','-newkey','rsa:2048','-nodes','-keyout',str(key),'-out',str(cert),'-days','1','-subj','/CN=provider.example','-addext','subjectAltName=DNS:provider.example'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            server_ssl=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);server_ssl.load_cert_chain(cert,key)
            names=[];server_ssl.set_servername_callback(lambda _,name,__:names.append(name))
            requests=[]
            async def serve(reader,writer):
                try:
                    data=await reader.readuntil(b'\r\n\r\n');requests.append(data)
                    writer.write(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK');await writer.drain()
                except (OSError,asyncio.IncompleteReadError):pass
                finally:writer.close();await writer.wait_closed()
            server=await asyncio.start_server(serve,'127.0.0.1',0,ssl=server_ssl);port=server.sockets[0].getsockname()[1]
            context=ssl.create_default_context(cafile=str(cert))
            real=httpcore.AnyIOBackend();connected=[]
            class Delegate:
                async def connect_tcp(self,host,p,timeout=None,**kwargs):
                    connected.append(host);return await real.connect_tcp('127.0.0.1',port,timeout)
            expired=Path(tmp)/'expired.pem'
            subprocess.run([openssl,'x509','-in',str(cert),'-signkey',str(key),'-days','-1','-out',str(expired)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            try:
                for host,trust,should_pass in [('provider.example',context,True),('wrong.example',context,False),('provider.example',ssl.create_default_context(),False),('provider.example',ssl.create_default_context(cafile=str(expired)),False)]:
                    if trust is not context and host=='provider.example' and trust.get_ca_certs() and len(trust.get_ca_certs())==1:
                        server_ssl.load_cert_chain(expired,key)
                    with patch.dict(os.environ,{'BRAIPEN_SELF_ADDRESSES':'8.8.8.8','HTTPS_PROXY':'http://127.0.0.1:1','SSL_CERT_FILE':'missing'}),patch('provider_transport.httpx.create_ssl_context',return_value=trust),patch('provider_transport.public_addresses',AsyncMock(return_value=['1.1.1.1'])):
                        transport=SafeTransport('https://'+host,True);transport.backend.delegate=Delegate()
                        async with httpx.AsyncClient(transport=transport,trust_env=False) as client:
                            if should_pass:self.assertEqual((await client.get('https://'+host,headers={'Authorization':'Bearer FAKE'})).text,'OK')
                            else:
                                with self.assertRaises(httpcore.ConnectError):await client.get('https://'+host,headers={'Authorization':'Bearer FAKE'})
                self.assertEqual(connected,['1.1.1.1']*4);self.assertEqual(names,['provider.example','wrong.example','provider.example','provider.example'])
                self.assertEqual(len(requests),1);self.assertIn(b'Host: provider.example',requests[0]);self.assertIn(b'Bearer FAKE',requests[0])
            finally:server.close();await server.wait_closed()


class ProtocolAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_all_presets_text_path_and_no_optional_parameters_by_default(self):
        for p in CATALOG:
            with self.subTest(preset=p['id']):
                seen=[]
                async def upstream(req):
                    seen.append(req)
                    if p['protocol']=='messages':return response({'content':[{'type':'text','text':'正文'}],'stop_reason':'end_turn','usage':{'input_tokens':2,'output_tokens':3}})
                    return response({'choices':[{'message':{'content':'正文'},'finish_reason':'stop'}],'usage':{'prompt_tokens':2,'completion_tokens':3}})
                with patch.object(models,'_client',client_factory(upstream)):
                    metrics={};text=await models.request_text(models.ModelConfig(connection(p['id']),'KEY'),[{'role':'system','content':'system'},{'role':'user','content':'user'}],usage_metrics=metrics)
                self.assertEqual(text,'正文');body=json.loads(seen[0].content)
                self.assertNotIn('temperature',body);self.assertEqual(metrics['call_count'],1);self.assertEqual(metrics['completion_tokens'],3)
                self.assertEqual(seen[0].url.host,httpx.URL(p['url']).host)
                if p['protocol']=='messages':self.assertEqual(seen[0].headers['x-api-key'],'KEY');self.assertNotIn('authorization',seen[0].headers);self.assertEqual(body['system'],'system')
                else:self.assertEqual(seen[0].headers['authorization'],'Bearer KEY')

    async def test_structured_modes_and_native_claude_schema(self):
        for protocol,mode in [('chat_completions','json_schema'),('chat_completions','json_object'),('chat_completions','prompt_only'),('messages','json_schema')]:
            c=connection(protocol=protocol,policy={**default_policy('custom'),'structured':mode});seen=[]
            async def upstream(req):
                seen.append(json.loads(req.content));return response({'choices':[{'message':{'content':'{"ok":true}'},'finish_reason':'stop'}]} if protocol=='chat_completions' else {'content':[{'type':'text','text':'{"ok":true}'}],'stop_reason':'end_turn'})
            with patch.object(models,'_client',client_factory(upstream)):
                await models.request_text(models.ModelConfig(c,'KEY','connection_test'),[{'role':'user','content':'JSON'}],json_mode=True)
            body=seen[0]
            if protocol=='messages':self.assertEqual(body['output_config']['format']['type'],'json_schema')
            elif mode=='prompt_only':self.assertNotIn('response_format',body)
            else:self.assertEqual(body['response_format']['type'],mode)
        with patch.object(models,'_client') as network:
            with self.assertRaises(ValueError):await models.request_text(models.ModelConfig(connection(),'KEY','story_delta'),[],json_mode=True)
            network.assert_not_called()

    async def test_sse_claude_and_chat_return_identical_text_semantics(self):
        for protocol in ('chat_completions','messages'):
            events=([{'choices':[{'delta':{'reasoning_content':'思考'}}]},{'choices':[{'delta':{'content':'正文'},'finish_reason':'stop'}],'usage':{'prompt_tokens':2,'completion_tokens':3}},'[DONE]'] if protocol=='chat_completions' else [{'type':'content_block_delta','delta':{'type':'thinking_delta','thinking':'思考'}},{'type':'content_block_delta','delta':{'type':'text_delta','text':'正文'}},{'type':'message_delta','delta':{'stop_reason':'end_turn'},'usage':{'output_tokens':3}},{'type':'message_stop'}])
            wire=''.join('data: '+(e if isinstance(e,str) else json.dumps(e))+'\n\n' for e in events).encode()
            with patch.object(models,'_client',client_factory(lambda req:response(wire))):
                result=[e async for e in models.request_text_stream(models.ModelConfig(connection(protocol=protocol),'KEY'),[{'role':'user','content':'hi'}])]
            self.assertEqual(result,[{'kind':'reasoning','text':'思考'},{'kind':'content','text':'正文'}])

    async def test_redirect_and_response_limits_and_truncation(self):
        c=models.ModelConfig(connection(),'KEY')
        for result in [response(b'',302,{'location':'https://untrusted.example'}),response(b'compressed',headers={'content-encoding':'gzip'}),response(b'x'*100)]:
            seen=[]
            def upstream(req):seen.append(req);return result
            with patch.object(models,'_client',client_factory(upstream)),patch.object(models,'MAX_JSON_BYTES',50):
                with self.assertRaises(Exception):await models.request_text(c,[{'role':'user','content':'hi'}])
            self.assertEqual(len(seen),1)
        for wire in [b'data: '+b'x'*80+b'\n\n', b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']:
            with patch.object(models,'_client',client_factory(lambda req:response(wire))),patch.object(models,'MAX_EVENT_BYTES',70):
                with self.assertRaises(models.DeepSeekClientError):[e async for e in models.request_text_stream(c,[{'role':'user','content':'hi'}])]

    async def test_missing_unknown_tool_and_late_termination_are_rejected(self):
        c=models.ModelConfig(connection(),'KEY')
        bad_streams=[
            [{'choices':[{'delta':{'content':'partial'}}]},'[DONE]'],
            [{'choices':[{'delta':{'content':'tool'},'finish_reason':'tool_calls'}]},'[DONE]'],
            [{'choices':[{'delta':{'content':'text'},'finish_reason':'stop'}]},'[DONE]',{'choices':[{'delta':{'content':'late'}}]}],
        ]
        for events in bad_streams:
            wire=''.join('data: '+(e if isinstance(e,str) else json.dumps(e))+'\n\n' for e in events).encode()
            with patch.object(models,'_client',client_factory(lambda req:response(wire))):
                with self.assertRaises(models.DeepSeekClientError):[e async for e in models.request_text_stream(c,[{'role':'user','content':'hi'}])]
        for reason in (None,'tool_calls','content_filter','unknown'):
            with patch.object(models,'_client',client_factory(lambda req:response({'choices':[{'message':{'content':'partial'},'finish_reason':reason}]}))):
                with self.assertRaises(models.DeepSeekClientError):await models.request_text(c,[{'role':'user','content':'hi'}])

    async def test_provider_specific_preflight_happens_before_started(self):
        c=connection(policy={**default_policy('custom'),'temperature':'range','temperature_max':.5})
        from tests.test_compute_reliability import body_input
        events=[]
        with patch.object(models,'_client') as network:
            with self.assertRaises(ValueError):
                async for e in compute_service.stream_compute('generate_chapter',body_input(),{'api_key':'KEY','_connection':c},{}):events.append(e)
        self.assertEqual(events,[]);network.assert_not_called()

    async def test_strict_schema_preserves_two_new_nodes_and_reviewed_edge_references(self):
        from structured_schemas import SCHEMAS
        from tests.test_story_delta_json_mode import valid_payload
        from tests.test_compute_reliability import body_input
        def fill(schema):
            kind=schema['type']
            if kind=='object':return {k:fill(v) for k,v in schema['properties'].items()}
            return [] if kind=='array' else '' if kind=='string' else True if kind=='boolean' else 5 if kind=='integer' else .5
        shape=SCHEMAS['story_delta'];data=fill(shape);data['next_chapter_proposal']['target_chapter_number']=2
        for ident,label in [('a','甲'),('b','乙')]:
            change=fill(shape['properties']['candidate_changes']['items']);change.update(id=ident,operation='create_node',source='story_delta',target='narrative_graph',evidence='甲遇到乙')
            change['payload'].update(type='character',label=label,summary=label+'登场',status='active',layer='detail',importance=5);data['candidate_changes'].append(change)
        edge=fill(shape['properties']['candidate_changes']['items']);edge.update(id='edge',operation='create_edge',source='story_delta',target='narrative_graph',evidence='甲遇到乙');edge['payload'].update(type='related_to',label='相遇',summary='甲遇到乙',status='active',layer='detail',importance=5,source_change_id='a',target_change_id='b');data['candidate_changes'].append(edge)
        with patch.object(compute_service,'request_text',AsyncMock(return_value=json.dumps(data))):
            result=await compute_service.compute('story_delta',{**body_input(),'chapter':{'content':'甲遇到乙'}},{'api_key':'sk-'+'a'*32},{})
        draft=result['knowledge_draft'];graph=body_input()['graph']
        for change in draft['candidate_changes']:
            result=await compute_service.compute('review_change',{**body_input(),'graph':graph,'draft':draft,'change_id':change['id'],'action':'accept'},{},{})
            draft,graph=result['draft'],result['graph']
        self.assertEqual(len(graph['graph']['nodes']),2);self.assertEqual(len(graph['graph']['edges']),1)

    async def test_native_cache_usage_distinguishes_cache_creation_from_misses(self):
        usage={};c=models.ModelConfig(connection('claude'),'KEY')
        models._usage({'usage':{'input_tokens':2,'cache_creation_input_tokens':4,'cache_read_input_tokens':6,'output_tokens':3}},c,usage)
        self.assertEqual(usage,{'prompt_tokens':12,'completion_tokens':3,'prompt_cache_hit_tokens':6,'prompt_cache_miss_tokens':6})
        missing={};models._usage({'usage':{'input_tokens':2,'output_tokens':3}},c,missing)
        self.assertNotIn('prompt_cache_hit_tokens',missing);self.assertNotIn('prompt_cache_miss_tokens',missing)

    async def test_v2_domain_call_uses_supplied_connection(self):
        c=connection('claude');body=request(c);body['input']={'chapter_number':1,'chapter':{'content':'原文'},'review_scope':'rules_only'}
        async def upstream(req):return response({'content':[{'type':'text','text':'摘要'}],'stop_reason':'end_turn'})
        with patch.object(models,'_client',client_factory(upstream)):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:body['request_fingerprint']=request_fingerprint(c,'summarize_chapter',body['input']);r=await client.post('/api/compute/summarize_chapter',json=body)
        self.assertEqual(r.status_code,200,r.text);self.assertEqual(r.json()['result']['summary'],'摘要');self.assertEqual(r.json()['execution_fingerprint'],c['execution_fingerprint'])

if __name__=='__main__':unittest.main()
