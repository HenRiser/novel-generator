import { API_BASE_URL, safePublicMessage } from './api';
import { getSetting, setSetting, listSettings, commitSettings, assertConnectionGuard } from './localStore';
import { profileKey, loadProfileKey, restoreProfileKey, keyStorageMode, decryptLegacyProfileKey, notifyConnection, onConnectionRevoked, validateKey } from './keyVault';
import { LEGACY_CONNECTION, type ConnectionProfile, type ConnectionSnapshot, type ConnectionGuard, type ProviderCapabilities, type CapabilityPolicy } from './providerTypes';

export const hash = async (text:string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
export function stable(value:unknown):unknown { return Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b,'en')).map(([k,v])=>[k,stable(v)])):value; }
export function defaultPolicy(): CapabilityPolicy { return {version:1,source:'user_override',token_field:'max_tokens',temperature:'omit',temperature_min:0,temperature_max:2,temperature_fixed:1,stream_usage:false,structured:'unsupported'}; }
export async function legacySnapshot(model='deepseek-v4-flash'):Promise<ConnectionSnapshot> {
  const protocol='chat_completions',base_url='https://api.deepseek.com',policy={...defaultPolicy(),source:'user_override' as const,structured:'json_object' as const};
  const destination_fingerprint=await hash('endpoint-v1\n'+protocol+'\n'+base_url);
  return {profile_id:LEGACY_CONNECTION,revision:1,preset:'deepseek',protocol,base_url,model,policy,auth_mode:'key',destination_fingerprint,
    execution_fingerprint:await hash(JSON.stringify(stable({destination:destination_fingerprint,model,policy,auth_mode:'key'})))};
}
export async function connectionLock<T>(id:string,task:()=>Promise<T>):Promise<T> {
  if(!navigator.locks)throw new Error('当前浏览器不支持安全连接锁。');
  return navigator.locks.request('braipen:connection:'+id,task);
}
export async function ensureConnections() {
  if(await getSetting('connection:'+LEGACY_CONNECTION))return;
  await connectionLock('bootstrap',async()=>{
    if(await getSetting('connection:'+LEGACY_CONNECTION))return;
    const snapshot=await legacySnapshot(String(await getSetting('default_model')||'deepseek-v4-flash'));
    await setSetting('connection:'+LEGACY_CONNECTION,{id:LEGACY_CONNECTION,name:'DeepSeek',enabled:true,deleted:false,epoch:0,key_version:'legacy',head:1,revisions:[snapshot]} satisfies ConnectionProfile);
  });
}
export async function connections() { await ensureConnections(); const profiles=(await listSettings<ConnectionProfile>('connection:')).filter(p=>!p.deleted&&['chat_completions','messages'].includes((p.draft||p.revisions.find(r=>r.revision===p.head))?.protocol||''));await Promise.all(profiles.map(async p=>{const s=p.revisions.find(r=>r.revision===p.head);if(s)await restoreProfileKey(p,s);}));return profiles; }
export async function getConnection(id:string) { await ensureConnections(); const p=await getSetting<ConnectionProfile>('connection:'+id);if(!p)throw new Error('此连接不存在，请重新关联相同目的地。');const s=p.revisions.find(r=>r.revision===p.head);if(s)await restoreProfileKey(p,s);return p; }
export async function defaultConnectionId() { return await getSetting<string>('default_connection')||LEGACY_CONNECTION; }
export async function setDefaultConnection(id:string) { const p=await getConnection(id);if(!p.enabled||p.deleted)throw new Error('请先启用连接。');await setSetting('default_connection',id);notifyConnection(id); }

export async function capabilities(refresh=false,signal?:AbortSignal):Promise<ProviderCapabilities> {
  signal?.throwIfAborted();
  try { const response=await fetch(API_BASE_URL+'/api/capabilities',{cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});if(!response.ok)throw new Error();const c=await response.json();
    if(c.protocol_version!==2||!Array.isArray(c.providers))throw new Error('后端需升级到连接协议v2，未发送任何Key。');
    signal?.throwIfAborted();
    await setSetting('provider-catalog',c);return c;
  }catch(e){ signal?.throwIfAborted();if(!refresh){const cached=await getSetting<ProviderCapabilities>('provider-catalog');if(cached)return cached;}throw e instanceof Error&&e.message?e:new Error('无法读取连接能力，请检查计算服务。'); }
}
export async function validateConnection(raw:ConnectionSnapshot, signal?:AbortSignal):Promise<ConnectionSnapshot> {
  await capabilities(true); // Never send a non-DeepSeek Key to a v1-only backend.
  const response=await fetch(API_BASE_URL+'/api/compute/validate_connection',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',signal:signal||AbortSignal.timeout(15000),
    body:JSON.stringify({protocol_version:2,run_id:crypto.randomUUID(),step_id:crypto.randomUUID(),attempt_id:crypto.randomUUID(),input_revision:0,connection:raw,credentials:{},input:{}})});
  const data=await response.json();if(!response.ok||!data.result?.connection)throw new Error(safePublicMessage(data.error?.message,'连接地址或能力设置无效。'));
  return data.result.connection;
}
export async function saveConnection(name:string, raw:ConnectionSnapshot, asDraft=false):Promise<ConnectionProfile> {
  if(!name.trim()||name.length>80)throw new Error('连接名称为1–80字符。');
  return connectionLock(raw.profile_id,async()=>{
    const old=await getSetting<ConnectionProfile>('connection:'+raw.profile_id);
    if(old?.deleted)throw new Error('此连接已删除，请新建连接。');
    if(old&&(old.draft?.revision??old.head)!==raw.revision)throw new Error('连接已在另一处修改，请重新加载。');
    const candidate={...raw,revision:old?old.head+1:1};
    const normalized=asDraft?candidate:await validateConnection(candidate);
    if(old?.revisions.length&&(normalized.base_url!==old.revisions[0].base_url||normalized.protocol!==old.revisions[0].protocol||normalized.auth_mode!==old.revisions[0].auth_mode))throw new Error('地址或协议变更必须复制为新连接，并重新填写Key。');
    const p:ConnectionProfile={...(old||{id:raw.profile_id,epoch:0,key_version:crypto.randomUUID(),revisions:[],deleted:false}),name:name.trim(),enabled:!asDraft&&(old?.revisions.length?old.enabled:true),head:asDraft?(old?.head||0):normalized.revision,
      revisions:asDraft?(old?.revisions||[]):[...(old?.revisions||[]),normalized],draft:asDraft?candidate:undefined,test:undefined};
    await setSetting('connection:'+p.id,p);notifyConnection(p.id);return p;
  });
}
export async function renameConnection(id:string,name:string){return connectionLock(id,async()=>{const p=await getConnection(id);p.name=name.trim().slice(0,80)||p.name;await setSetting('connection:'+id,p);notifyConnection(id);return p;});}
export async function manageConnection(id:string,action:'lock'|'forget'|'disable'|'delete'|'enable') {
  return connectionLock(id,async()=>{
    const p=await getConnection(id);p.epoch++;p.test=undefined;
    if(action==='delete')p.deleted=true;
    if(action==='disable'||action==='delete')p.enabled=false;
    if(action==='enable'){if(!p.revisions.length)throw new Error('请先验证并保存连接。');p.enabled=true;}
    // Legacy programmatic lock must also stop automatic plaintext restoration.
    const removeRemembered=action==='lock'&&(await getSetting<{version:number}>('vault:'+id))?.version===3;
    await commitSettings([{key:'connection:'+id,value:p},...(['forget','delete'].includes(action)||removeRemembered?[{key:'vault:'+id,remove:true},...(id===LEGACY_CONNECTION?[{key:'deepseek-key-vault.v1',remove:true}]:[])]:[])]);
    notifyConnection(id,true);return p;
  });
}
async function storeKeyLocked(p:ConnectionProfile,snapshot:ConnectionSnapshot,key:string,remember:boolean){
  if(profileKey(p,snapshot)===key.trim()&&await keyStorageMode(p,snapshot)===(remember?'remembered':'session'))return p;
  const updated={...p,epoch:p.epoch+1,key_version:crypto.randomUUID(),test:undefined};
  const value=remember?{version:3,api_key:key.trim(),destination:snapshot.destination_fingerprint,key_version:updated.key_version}:undefined;
  await commitSettings([{key:'connection:'+p.id,value:updated},{key:'vault:'+p.id,...(value?{value}:{remove:true})},...(p.id===LEGACY_CONNECTION?[{key:'deepseek-key-vault.v1',remove:true}]:[])]);
  notifyConnection(p.id,true);loadProfileKey(updated,snapshot,key);return updated;
}
export async function storeConnectionKey(id:string,key:string,remember=false){
  if(typeof remember!=='boolean')throw new Error('请选择是否在此浏览器记住 API Key。');
  validateKey(key);return connectionLock(id,async()=>{
    const p=await getConnection(id),snapshot=p.revisions.find(r=>r.revision===p.head);if(!snapshot)throw new Error('请先保存连接。');
    if(p.deleted)throw new Error('此连接已删除。');
    return storeKeyLocked(p,snapshot,key,remember);
  });
}
export async function migrateEncryptedConnectionKey(id:string,passphrase:string){return connectionLock(id,async()=>{const p=await getConnection(id);if(!p.enabled||p.deleted)throw new Error('请先启用连接，再迁移旧版 Key。');const s=p.revisions.find(r=>r.revision===p.head);if(!s)throw new Error('连接没有可用修订。');const key=await decryptLegacyProfileKey(p,s,passphrase);return storeKeyLocked(p,s,key,true);});}
export async function resolveConnection(id?:string,model?:string):Promise<ConnectionSnapshot>{
  const p=await getConnection(id||await defaultConnectionId());if(!p.enabled||p.deleted)throw new Error('连接未启用或已删除。');
  const s=p.revisions.find(r=>r.revision===p.head);if(!s)throw new Error('请先验证连接草稿。');
  return !model||model===s.model?s:validateConnection({...s,model});
}
export type ConnectionLease={snapshot:ConnectionSnapshot;guard:ConnectionGuard;apiKey:string;signal:AbortSignal;check:()=>Promise<void>;close:()=>void};
export async function acquireConnection(snapshot:ConnectionSnapshot,external?:AbortSignal,temporaryKey?:string):Promise<ConnectionLease>{
  return connectionLock(snapshot.profile_id,async()=>{
    const p=await getConnection(snapshot.profile_id);
    const original=p.revisions.find(r=>r.revision===snapshot.revision);
    if(!p.enabled||p.deleted||!original||original.destination_fingerprint!==snapshot.destination_fingerprint||original.auth_mode!==snapshot.auth_mode||original.base_url!==snapshot.base_url||original.protocol!==snapshot.protocol||(JSON.stringify(stable(original.policy))!==JSON.stringify(stable(snapshot.policy))&&!(original.policy.source==='official_catalog'&&snapshot.policy.source==='official_catalog'&&original.policy.version===snapshot.policy.version)))throw new Error('原连接修订不可用，不能静默切换目的地。');
    const key=snapshot.auth_mode==='none'?'':temporaryKey??profileKey(p,snapshot);
    if(snapshot.auth_mode==='key') {
      if (!key.trim()) {
        const mode=await keyStorageMode(p,snapshot),settings=snapshot.protocol.endsWith('_images')?'图片模型连接':'模型连接';
        throw new Error(mode==='legacy'
          ? `模型连接「${p.name}」保存的是旧版加密 Key。请前往「偏好设置 → ${settings}」迁移旧版 Key，或重新填写 API Key 并保存。`
          : mode==='invalid'?`模型连接「${p.name}」的本地 Key 记录已损坏或与当前连接不匹配。请前往「偏好设置 → ${settings}」重新填写 API Key 并保存。`
          : `模型连接「${p.name}」没有可用的 API Key。请前往「偏好设置 → ${settings}」填写并保存；勾选「在此浏览器记住 API Key」后，重新打开网页会自动使用。`);
      }
      validateKey(key);
    }
    const guard={profile_id:p.id,epoch:p.epoch,destination_fingerprint:snapshot.destination_fingerprint,key_version:p.key_version};
    const controller=new AbortController();const unsubscribe=onConnectionRevoked(id=>{if(id===p.id)controller.abort(new Error('连接凭据已撤销。'));});
    const check=()=>assertConnectionGuard(guard);
    return {snapshot,guard,apiKey:key,signal:external?AbortSignal.any([external,controller.signal]):controller.signal,check,close:unsubscribe};
  });
}
export async function connectionConfigured(id:string){const p=await getConnection(id),s=p.revisions.find(r=>r.revision===p.head);return !!s&&p.enabled&&!p.deleted&&(s.auth_mode==='none'||Boolean(profileKey(p,s)));}

export async function recordConnectionResult(lease: ConnectionLease, kind:'models'|'test', result:Record<string,unknown>, cacheTest=true){
  return connectionLock(lease.guard.profile_id,async()=>{
    await lease.check();const p=await getConnection(lease.guard.profile_id);
    if(p.head!==lease.snapshot.revision)throw new Error('检测期间配置已修改，旧检测结果未应用。');
    if(kind==='models')p.models=result.models as ConnectionProfile['models'];
    else if(cacheTest)p.test={revision:lease.snapshot.revision,key_version:p.key_version,at:new Date().toISOString(),result};
    await setSetting('connection:'+p.id,p);
  });
}

export async function requestFingerprint(connection:ConnectionSnapshot,operation:string,input:Record<string,unknown>){
  if(operation==='cover_generate'||operation==='cover_edit') {
    const text=input.text_connection as ConnectionSnapshot, image=input.image as {data_base64:string}|undefined;
    if(!text?.execution_fingerprint)throw new Error('请选择整理描述的文字连接。');
    const bytes=operation==='cover_edit'&&image?Uint8Array.from(atob(image.data_base64),c=>c.charCodeAt(0)):null;
    const image_digest=bytes?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join(''):null;
    const buffer=new ArrayBuffer(8),temperature=text.policy.temperature==='fixed'?text.policy.temperature_fixed:Math.max(text.policy.temperature_min,Math.min(text.policy.temperature_max,.3));
    new DataView(buffer).setFloat64(0,temperature===0?0:temperature);
    return hash(JSON.stringify(stable({execution:connection.execution_fingerprint,operation,cover_protocol:2,template_version:2,text_execution:text.execution_fingerprint,
      style_id:input.style_id,count:input.count,size:'2K',edit_kind:operation==='cover_edit'?input.edit_kind:null,source_digest:await hash(JSON.stringify(stable(input.source))),image_digest,
      text_parameters:{tokens:6000,temperature:text.policy.temperature==='omit'?null:Array.from(new Uint8Array(buffer),b=>b.toString(16).padStart(2,'0')).join('')}})));
  }
  const request=(input.request||{}) as Record<string,unknown>,config=(input.config||{}) as Record<string,unknown>;
  let pairs:Array<[number,number]>=[];
  if(['generate_chapter','continue_chapter','generate_outline','generate_characters','expand_setting'].includes(operation))pairs=[[Math.trunc(Number(request.max_tokens??config.max_tokens??4000)),Number(request.temperature??config.temperature??.7)]];
  else if(operation==='summarize_chapter')pairs=[[input.review_scope==='semantic_and_rules'?1800:512,.2]];
  else if(operation==='story_delta')pairs=[[8000,.2],[8000,0]];
  else if(operation==='plan_chapter')pairs=[[4000,.3],[4000,.1]];
  else if(operation==='import_chapter')pairs=[[6000,.2]];
  else if(operation==='import_synthesis')pairs=[[8000,.2]];
  else if(operation==='connection_test')pairs=connection.policy.structured==='unsupported'?[[512,1]]:[[512,1],[512,1]];
  const hex=(number:number)=>{const bytes=new ArrayBuffer(8);new DataView(bytes).setFloat64(0,number===0?0:number);return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');};
  const parameters=pairs.map(([tokens,temp])=>({tokens,temperature:connection.policy.temperature==='omit'?null:hex(connection.policy.temperature==='fixed'?connection.policy.temperature_fixed:temp)}));
  return hash(JSON.stringify(stable({execution:connection.execution_fingerprint,operation,parameters})));
}
