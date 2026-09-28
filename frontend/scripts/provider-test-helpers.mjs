// Test control-plane fixtures use the real Python normalizer; never call an upstream service.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
export function providerFixtures(root){
  const cwd=resolve(root,'..'),python=process.env.BRAIPEN_TEST_PYTHON||resolve(cwd,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
  const run=(code,input)=>{const r=spawnSync(python,['-c',code],{cwd,input:JSON.stringify(input),encoding:'utf8',env:{...process.env,PYTHONIOENCODING:'utf-8'}});if(r.status!==0)throw new Error(r.stderr);return JSON.parse(r.stdout);};
  const catalog=run('import json; from provider_catalog import catalog; print(json.dumps({"protocol_version":2,"providers":catalog(),"supported_protocols":["chat_completions","messages"]}))');
  const normalize=raw=>run('import json,sys; from provider_catalog import normalize_connection; print(json.dumps(normalize_connection(json.load(sys.stdin))))',raw);
  const requestFingerprint=(p,operation)=>run('import json,sys; from provider_catalog import request_fingerprint; p=json.load(sys.stdin); print(json.dumps(request_fingerprint(p["connection"],p["operation"],p["input"])))',{connection:p.connection,operation,input:p.input});
  return {catalog,normalize,requestFingerprint};
}
export function identity(p){return{run_id:p.run_id,step_id:p.step_id,attempt_id:p.attempt_id,input_revision:p.input_revision,...(p.connection?{protocol_version:2,request_fingerprint:p.request_fingerprint,destination_fingerprint:p.connection.destination_fingerprint,execution_fingerprint:p.connection.execution_fingerprint}:{})};}
export function wrapFulfill(route,p){
  const original=route.fulfill.bind(route);route.fulfill=async options=>{
    const extra=identity(p);const enrich=e=>e&&e.run_id?{...extra,...e}:e;
    if(options.json)options={...options,json:enrich(options.json)};
    else if(typeof options.body==='string'&&options.contentType==='application/x-ndjson')options={...options,body:options.body.split('\n').map(line=>line.trim()?JSON.stringify(enrich(JSON.parse(line))):line).join('\n')};
    return original(options);
  };
}
