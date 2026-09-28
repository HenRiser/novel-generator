import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {providerFixtures,identity} from './provider-test-helpers.mjs';
const require=createRequire(import.meta.url),runtime=process.env.BRAIPEN_PLAYWRIGHT_PATH;
const {chromium}=runtime?await import(pathToFileURL(join(runtime,'index.mjs')).href):require('playwright');
const root=fileURLToPath(new URL('../',import.meta.url)).replace(/[\\/]+$/,'');
const fixtures=providerFixtures(root),report=resolve(root,'../reports/provider-connections-2026-09-28');await mkdir(report,{recursive:true});
const server=await createServer({root,define:{'import.meta.env.VITE_API_BASE_URL':'""'},logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{name:'provider-test',configureServer(s){s.middlewares.use('/__provider_test',(_,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>provider tests</title>');});}}]});
await server.listen();const origin=server.resolvedUrls.local[0].replace(/\/$/,'');
const browser=await chromium.launch({channel:'msedge',headless:true});let results=[];
async function test(name,fn){
 if(process.env.BRAIPEN_TEST_FILTER&&!name.includes(process.env.BRAIPEN_TEST_FILTER))return;
 const ctx=await browser.newContext({acceptDownloads:true}),calls=[];let handler;
 await ctx.route('**/api/**',async route=>{const req=route.request();
  if(req.url().endsWith('/health'))return route.fulfill({json:{status:'ok'}});
  if(req.url().endsWith('/capabilities'))return route.fulfill({json:fixtures.catalog});
  const p=req.postDataJSON();
  if(req.url().endsWith('/validate_connection')){try{return route.fulfill({json:{...identity(p),result:{connection:fixtures.normalize(p.connection)}}});}catch{return route.fulfill({status:400,json:{error:{message:'地址/协议格式无效'}}});}}
  assert.equal(p.request_fingerprint,fixtures.requestFingerprint(p,req.url().split('/compute/')[1].split('/')[0]));
  calls.push(p);if(handler)return handler(route,p);
  let result;
  if(req.url().endsWith('/list_models'))result={models:[{id:'org/fiction:fast',name:'Fiction Fast'}]};
  else if(req.url().endsWith('/connection_test'))result={ok:true,text:'passed',structured:'passed',errors:[]};
  else if(req.url().endsWith('/summarize_chapter'))result={summary:'来自 '+p.connection.model,review_status:'ready',warnings:[]};
  else result={content:'第一章\n生成的正文',title:'正文',frozen_context:{narrative_context_text:'原连接约束'}};
  if(req.url().endsWith('/stream'))return route.fulfill({contentType:'application/x-ndjson',body:[{...identity(p),type:'started',frozen_context:result.frozen_context},{...identity(p),type:'delta',text:result.content},{...identity(p),type:'done',result,metrics:{}}].map(e=>JSON.stringify(e)).join('\n')+'\n'});
  return route.fulfill({json:{...identity(p),result,metrics:{}}});
 });
 const page=await ctx.newPage();await page.goto(origin+'/__provider_test');
 async function load(target=page){await target.evaluate(async()=>{
   window.store=await import('/src/localStore.ts');window.pc=await import('/src/providerConnections.ts');window.vault=await import('/src/keyVault.ts');window.wf=await import('/src/localWorkflow.ts');window.types=await import('/src/localTypes.ts');window.compute=await import('/src/computeClient.ts');window.api=await import('/src/localApi.ts');
   window.wait=async pred=>{for(let i=0;i<300;i++){if(await pred())return;await new Promise(r=>setTimeout(r,20));}throw new Error('condition timed out');};
   window.newProfile=async(url='https://a.example/v1',model='org/model:fast',key='NON_SK_KEY_A')=>{const raw={profile_id:crypto.randomUUID(),revision:1,preset:'custom',protocol:'chat_completions',base_url:url,model,policy:{...pc.defaultPolicy(),structured:'prompt_only'},auth_mode:'key',destination_fingerprint:'',execution_fingerprint:''};const p=await pc.saveConnection('测试连接',raw);await pc.storeConnectionKey(p.id,key);return pc.getConnection(p.id);};
   window.newProject=async profile=>{const s=profile.revisions.find(r=>r.revision===profile.head);const p=types.emptyProject('测试作品',{connection_id:profile.id,model:s.model,...Object.fromEntries(['protagonist','supporting_characters','worldview','core_conflict','genre','style'].map(k=>[k,'设定']))});p.assets={outline:'大纲',characters:'人物',setting_expansion:''};await store.putProject(p);return p.project_ref;};
 });}
 try{await fn({page,ctx,load,calls,setHandler:h=>{handler=h;}});results.push({name,status:'passed'});console.log('PASS '+name);}catch(e){results.push({name,status:'failed',error:e.message});console.error('FAIL '+name+'\n'+e.stack);throw e;}finally{await ctx.close();}
}
try{
await test('Custom非sk Key、组织/模型ID、独立密钥与冻结目的地',async({page,load,calls})=>{
 await load();await page.evaluate(async()=>{const a=await newProfile(),b=await newProfile('https://b.example/v1','org/other~fast','DIFFERENT_KEY_B');const ref=await newProject(a);await pc.setDefaultConnection(b.id);await wf.generateLocalChapter(ref,1,{model:'org/model:fast',temperature:.7,max_tokens:4000});const c=(await store.getProject(ref)).chapters[1];await wf.confirmLocalChapter(ref,1,c.content,c.revision);await wait(async()=>(await store.getProject(ref)).chapters[1].workflow.summary_status==='ready');});
 assert.equal(calls.length,2);assert.ok(calls.every(p=>p.connection.base_url==='https://a.example/v1'&&p.credentials.api_key==='NON_SK_KEY_A'&&p.connection.model==='org/model:fast'));
});

await test('旧DB升级2、旧标签写入屏障、旧vault解锁迁移事务失败可恢复',async({page,ctx,load})=>{
 const old=await page.evaluate(async()=>{
   const db=await new Promise((ok,bad)=>{const r=indexedDB.open('braipen.local.v1',1);r.onupgradeneeded=()=>{for(const [s,k]of[['projects','project_ref'],['settings','key'],['imports','id']])r.result.createObjectStore(s,{keyPath:k});};r.onsuccess=()=>ok(r.result);r.onerror=()=>bad(r.error);});window.oldDB=db;window.oldClosed=false;db.onversionchange=()=>{db.close();window.oldClosed=true;};
   const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),pw='old-passphrase';const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveKey']);const key=await crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:600000,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt']);const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode('sk-'+'a'.repeat(32)));
   await new Promise((ok,bad)=>{const tx=db.transaction(['settings'],'readwrite');tx.objectStore('settings').put({key:'deepseek-key-vault.v1',value:{version:1,iterations:600000,salt:[...salt],iv:[...iv],ciphertext:[...new Uint8Array(cipher)]}});tx.oncomplete=ok;tx.onabort=()=>bad(tx.error);});return true;
 });assert.equal(old,true);
 const next=await ctx.newPage();await next.goto(origin+'/__provider_test');await load(next);await next.evaluate(()=>pc.connections());
 assert.equal(await page.evaluate(()=>window.oldClosed),true);
 assert.equal(await page.evaluate(()=>new Promise(ok=>{const r=indexedDB.open('braipen.local.v1',1);r.onerror=()=>ok(r.error.name);r.onsuccess=()=>{r.result.close();ok('UNSAFE');};})),'VersionError');
 const migrated=await next.evaluate(async()=>{
   const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(v,...args){if(v.key==='vault:legacy-deepseek')throw new DOMException('quota','QuotaExceededError');return put.call(this,v,...args);};let failed=false;
   try{await pc.unlockConnection('legacy-deepseek','old-passphrase');}catch{failed=true;}finally{IDBObjectStore.prototype.put=put;}
   const preserved=Boolean(await store.getSetting('deepseek-key-vault.v1'));await pc.unlockConnection('legacy-deepseek','old-passphrase');return{failed,preserved,old:await store.getSetting('deepseek-key-vault.v1'),current:await store.getSetting('vault:legacy-deepseek')};
 });assert.equal(migrated.failed,true);assert.equal(migrated.preserved,true);assert.equal(migrated.old,undefined);assert.equal(migrated.current.version,2);
});

await test('换地址必须新连接、Key不复制、同地址修订保留旧任务策略',async({page,load})=>{
 await load();const result=await page.evaluate(async()=>{
   const a=await newProfile(),original=a.revisions[0];let blocked=false;try{await pc.saveConnection('错误改地址',{...original,base_url:'https://other.example/v1'});}catch{blocked=true;}
   const newer=await pc.saveConnection('修改模型',{...original,model:'different/model',policy:{...original.policy,temperature:'fixed',temperature_fixed:1}});
   const lease=await pc.acquireConnection(original);const oldModel=lease.snapshot.model;lease.close();
   const copy=await pc.saveConnection('复制',{...original,profile_id:crypto.randomUUID(),revision:1,base_url:'https://new.example/v1'});let missing=false;try{await pc.acquireConnection(copy.revisions[0]);}catch{missing=true;}
   return{blocked,missing,oldModel,revisions:newer.revisions.length};
 });assert.deepEqual(result,{blocked:true,missing:true,oldModel:'org/model:fast',revisions:2});
});

await test('跨标签撤销取消活动请求，撤销后晚到结果不能进入检查点',async({page,ctx,load,setHandler})=>{
 await load();let release;const gate=new Promise(r=>{release=r;});setHandler(async(route,p)=>{await gate;await route.fulfill({json:{...identity(p),result:{content:'REVOKED_RESULT'},metrics:{}}}).catch(()=>{});});
 const state=await page.evaluate(async()=>{const profile=await newProfile(),ref=await newProject(profile);window.pending=wf.runOperation(await store.getProject(ref),'generate_outline',{config:(await store.getProject(ref)).config}).catch(e=>e.message);await wait(async()=>(await store.getProject(ref)).runs.some(r=>r.status==='running'));return{id:profile.id,ref};});
 const other=await ctx.newPage();await other.goto(origin+'/__provider_test');await load(other);await other.evaluate(id=>pc.manageConnection(id,'forget'),state.id);release();await page.evaluate(()=>window.pending);
 const p=await page.evaluate(ref=>store.getProject(ref),state.ref);assert.equal(p.assets.outline,'大纲');assert.ok(!p.runs[0].result);assert.equal(p.runs[0].status,'interrupted');
});

await test('已提交完整result在连接删除后仍可无Key应用，未提交结果不能救援复活',async({page,load})=>{
 await load();const result=await page.evaluate(async()=>{
   const profile=await newProfile(),ref=await newProject(profile);const id=compute.newIdentity((await store.getProject(ref)).revision);
   await store.updateProject(ref,p=>p.runs.push({...id,operation:'generate_outline',status:'interrupted',input:{},partial:'',started_at:new Date().toISOString(),error:'',connection:profile.revisions[0],result:{content:'已保存模型结果'},result_revision:p.revision}),undefined,false);
   await pc.manageConnection(profile.id,'delete');await wf.resumeLocalRun(ref,id.run_id);return(await store.getProject(ref)).assets.outline;
 });assert.equal(result,'已保存模型结果');
});

await test('备份不含凭据；Custom恢复副本默认禁用直到显式绑定',async({page,load})=>{
 await load();await page.evaluate(async()=>{const p=await newProfile();await pc.storeConnectionKey(p.id,'NON_SK_KEY_A','new-passphrase');await newProject(await pc.getConnection(p.id));});
 const downloaded=page.waitForEvent('download');await page.evaluate(()=>store.exportBackup());const text=await readFile(await(await downloaded).path(),'utf8');assert.ok(!text.includes('NON_SK_KEY_A'));assert.ok(!text.includes('ciphertext'));
 const outcome=await page.evaluate(async text=>{const[ref]=await store.restoreBackup(text),p=await store.getProject(ref),c=await pc.getConnection(String(p.config.connection_id));return{enabled:c.enabled,id:c.id,snapshotId:c.revisions[0].profile_id};},text);assert.equal(outcome.enabled,false);assert.equal(outcome.id,outcome.snapshotId);
});

await test('实际设置界面八预设＋Custom，保存不调用模型，列表404仍可手填',async({page,load,calls,setHandler})=>{
 await page.evaluate(()=>localStorage.setItem('braipen:intro-hidden','true'));await page.goto(origin+'/settings');await load();
 await page.getByRole('button',{name:'添加连接',exact:true}).click();await page.getByLabel('连接名称',{exact:true}).fill('我的中转');await page.getByLabel('API Base URL',{exact:true}).fill('https://ui.example/v1');await page.getByLabel('连接 API Key',{exact:true}).fill('UI_NON_SK_KEY');
 await page.getByRole('combobox',{name:'默认模型ID'}).fill('org/fiction:fast');await page.getByRole('button',{name:'保存连接',exact:true}).click();
 await page.evaluate(()=>wait(async()=>(await pc.connections()).some(p=>p.name==='我的中转')));assert.equal(calls.length,0);
 setHandler((route,p)=>route.fulfill({status:404,json:{error:{message:'目录不可用，请手动输入模型ID。'}}}));await page.getByRole('button',{name:'获取模型列表',exact:true}).click();await page.getByText('目录不可用，请手动输入模型ID。',{exact:true}).waitFor({state:'visible'});
 await page.getByRole('combobox',{name:'默认模型ID'}).fill('org/manual-model');await page.getByRole('button',{name:'保存连接',exact:true}).click();
 await page.evaluate(()=>wait(async()=>(await pc.connections()).some(p=>p.name==='我的中转'&&p.revisions.some(r=>r.model==='org/manual-model'))));
 await page.evaluate(()=>wait(()=>!Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='保存连接'&&b.disabled)));
 await page.getByRole('heading',{name:'偏好设置',exact:true}).click();await page.evaluate(()=>window.scrollTo(0,0));await page.waitForFunction(()=>document.querySelectorAll('.ant-message-notice').length===0);
 await page.screenshot({path:join(report,'connections-ui.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(report,'connections-mobile.png'),fullPage:true});
 const width=await page.evaluate(()=>({w:document.documentElement.scrollWidth,v:innerWidth}));assert.ok(width.w<=width.v+2,JSON.stringify(width));
});
await test('修复Custom结构化策略后，实际恢复入口创建新摘要而不重写正文',async({page,load,calls})=>{
 await load();const state=await page.evaluate(async()=>{
   let profile=await newProfile();profile=await pc.saveConnection('待修复',{...profile.revisions[0],policy:{...profile.revisions[0].policy,structured:'unsupported'}});const ref=await newProject(profile);
   await wf.generateLocalChapter(ref,1,{model:profile.revisions[1].model,max_tokens:4000,temperature:.7});const c=(await store.getProject(ref)).chapters[1];await wf.confirmLocalChapter(ref,1,c.content+'修改',c.revision);
   await wait(async()=>(await store.getProject(ref)).chapters[1].workflow.summary_status==='failed');
   const snapshot=profile.revisions.find(r=>r.revision===profile.head);profile=await pc.saveConnection('已修复',{...snapshot,policy:{...snapshot.policy,structured:'prompt_only'}});return{id:profile.id,ref,content:c.content+'修改'};
 });
 await page.evaluate(()=>localStorage.setItem('braipen:intro-hidden','true'));await page.goto(origin+'/settings');await load();await page.evaluate(id=>pc.storeConnectionKey(id,'NON_SK_KEY_A'),state.id);
 await page.evaluate(async({ref})=>{const{useAppStore}=await import('/src/store/useAppStore.ts');useAppStore.getState().setProjects([{project_ref:ref,title:'测试作品',storage_type:'browser'}]);useAppStore.getState().selectProject(ref);},state);
 await page.getByText(/任务与恢复/).first().click();await page.getByText(/修复连接关联或采用新配置/).click();await page.getByRole('combobox',{name:'恢复连接关联'}).click();await page.getByTitle('已修复',{exact:true}).last().click();
 await page.getByRole('button',{name:'采用所选连接新建摘要检查',exact:true}).first().click();await page.getByRole('button',{name:/确.*定|OK/}).last().click();
 await page.evaluate(ref=>wait(async()=>(await store.getProject(ref)).chapters[1].workflow.summary_status==='ready'),state.ref);
 const c=await page.evaluate(async ref=>(await store.getProject(ref)).chapters[1],state.ref);assert.equal(c.content,state.content);assert.equal(c.summary_connection.policy.structured,'prompt_only');assert.equal(c.connection.policy.structured,'unsupported');
 assert.equal(calls.filter(p=>p.input.review_scope==='semantic_and_rules').length,1);assert.equal(calls.filter(p=>p.input.chapter_number===1&&!p.input.review_scope).length,1);
});

await test('删除原连接后明确重新关联相同目标，恢复原任务且不自动换服务',async({page,load,calls})=>{
 await load();const result=await page.evaluate(async()=>{
   const profile=await newProfile(),ref=await newProject(profile),p=await store.getProject(ref),id=compute.newIdentity(p.revision);await store.updateProject(ref,d=>d.runs.push({...id,operation:'generate_outline',status:'interrupted',input:{config:p.config},connection:profile.revisions[0],partial:'',error:'',started_at:new Date().toISOString()}),p.revision,false);
   await pc.manageConnection(profile.id,'delete');let blocked=false;try{await wf.resumeLocalRun(ref,id.run_id);}catch{blocked=true;}
   const same=await newProfile();await wf.rebindFrozenConnection(ref,same.id);await wf.resumeLocalRun(ref,id.run_id);const done=await store.getProject(ref);return{blocked,status:done.runs[0].status,newId:done.runs[0].connection.profile_id,expected:same.id};
 });assert.equal(result.blocked,true);assert.equal(result.status,'completed');assert.equal(result.newId,result.expected);assert.equal(calls.length,1);
});

await test('无模型ID可先获取目录；离线草稿可转为验证连接',async({page,load,calls})=>{
 await load();const result=await page.evaluate(async()=>{
   const raw={profile_id:crypto.randomUUID(),revision:1,preset:'custom',protocol:'chat_completions',base_url:'https://draft.example/v1',model:'',policy:pc.defaultPolicy(),auth_mode:'key',destination_fingerprint:'',execution_fingerprint:''};
   const draft=await pc.saveConnection('离线草稿',raw,true);const saved=await pc.saveConnection('目录连接',draft.draft);await pc.storeConnectionKey(saved.id,'APIKEY');const snapshot=await pc.resolveConnection(saved.id);const lease=await pc.acquireConnection(snapshot);
   try{return(await compute.compute('list_models',{},undefined,undefined,undefined,lease)).result;}finally{lease.close();}
 });assert.equal(result.models[0].id,'org/fiction:fast');assert.equal(calls.length,1);
});

await test('导入草稿可显式关联同一目的地的新连接，原文和已存进度保留',async({page,load,calls})=>{
 await load();const state=await page.evaluate(async()=>{
   const old=await newProfile(),next=await newProfile();next.name='导入替代连接';await store.setSetting('connection:'+next.id,next);
   const parser=await import('/src/novelImport.ts');const draft=await parser.createImportDraft('待恢复小说.txt',new TextEncoder().encode('第一章 开始\n甲来到城里。\n第二章 后文\n秘密在后面。'));
   draft.connection=old.revisions[0];draft.phase='extract';await store.putImport(draft.id,draft);await pc.manageConnection(old.id,'delete');return{id:draft.id,newId:next.id,source:draft.original_base64};
 });
 await page.evaluate(()=>localStorage.setItem('braipen:intro-hidden','true'));await page.goto(origin+'/library');await load();
 await page.getByRole('combobox',{name:'恢复导入草稿'}).click();await page.getByTitle(/待恢复小说/).last().click();await page.getByText('恢复时原连接失效或需要采用修复后的能力？',{exact:true}).click();
 await page.getByRole('combobox',{name:'导入恢复连接'}).click();await page.getByTitle('导入替代连接',{exact:true}).last().click();await page.getByRole('button',{name:'明确采用此连接当前配置',exact:true}).click();
 await page.evaluate(({id,newId})=>wait(async()=>(await store.getImport(id)).connection.profile_id===newId),state);
 const draft=await page.evaluate(id=>store.getImport(id),state.id);assert.equal(draft.original_base64,state.source);assert.equal(draft.connection_history.length,1);assert.equal(calls.length,0);
});

console.log('PASS '+results.length+' provider browser scenarios');
}finally{await writeFile(join(report,'browser-connections.json'),JSON.stringify(results,null,2));await browser.close();await server.close();}
