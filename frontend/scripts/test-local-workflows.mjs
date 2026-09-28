import {providerFixtures,identity as v2Identity,wrapFulfill} from './provider-test-helpers.mjs';
// Real IndexedDB/Web Locks tests with deterministic mock compute responses; no paid API calls.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const runtime = process.env.BRAIPEN_PLAYWRIGHT_PATH;
const { chromium } = runtime ? await import(pathToFileURL(join(runtime, 'index.mjs')).href) : require('playwright');
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]+$/, '');
const fixtures=providerFixtures(root);
let wireHandler; const openResponses = new Set();
const bounded = (promise, label) => Promise.race([promise, new Promise((_,reject) => { const t=setTimeout(()=>reject(new Error(label)),5000);t.unref(); })]);
const server = await createServer({ root, define: { 'import.meta.env.VITE_API_BASE_URL': '""' }, server: {host:'127.0.0.1',port:0}, logLevel:'error',
  plugins:[{name:'workflow-test-http',configureServer(s){
    s.middlewares.use('/api/capabilities',(_,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(fixtures.catalog));});
    s.middlewares.use('/api/compute/validate_connection',async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const p=JSON.parse(text);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...v2Identity(p),result:{connection:fixtures.normalize(p.connection)}}));});
    s.middlewares.use('/api/compute',(req,res)=>{if(wireHandler){openResponses.add(res);res.on('close',()=>openResponses.delete(res));void wireHandler(req,res);return;}res.statusCode=503;res.end('No test handler');});
    s.middlewares.use('/__workflow_test',(_,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Local workflow tests</title>');});
  }}]
});
await server.listen();
await mkdir(resolve(root,'../reports/workflow-reliability-2026-09-24'),{recursive:true});
const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ channel: process.env.BRAIPEN_BROWSER || 'msedge', headless: true });
const KEY = 'sk-' + 'a'.repeat(32);
const spec = { model: 'test-model', max_tokens: 4000, temperature: .7 };
let passed = 0;
const results = [];

async function test(name, fn) {
  if (process.env.BRAIPEN_TEST_FILTER && !name.includes(process.env.BRAIPEN_TEST_FILTER)) return;
  const context = await browser.newContext({ acceptDownloads: true });
  const calls = [];
  let handler;
  await context.route('**/api/**', async route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (req.url().endsWith('/health')) return route.fulfill({ json: { status: 'ok' }, headers: { 'access-control-allow-origin': '*' } });
    if(req.url().endsWith('/capabilities'))return route.fulfill({json:fixtures.catalog,headers:{'access-control-allow-origin':'*'}});
    const requestPayload=req.postDataJSON();
    if(req.url().endsWith('/validate_connection'))return route.fulfill({json:{...v2Identity(requestPayload),result:{connection:fixtures.normalize(requestPayload.connection)}},headers:{'access-control-allow-origin':'*'}});
    if(requestPayload.connection)assert.equal(requestPayload.request_fingerprint,fixtures.requestFingerprint(requestPayload,req.url().split('/compute/')[1].split('/')[0]));
    wrapFulfill(route,requestPayload);
    if (handler) return handler(route);
    const data = req.postDataJSON(); calls.push({ url: req.url(), data });
    const identity = Object.fromEntries(['run_id', 'step_id', 'attempt_id', 'input_revision'].map(key => [key, data[key]]));
    const op = req.url().split('/compute/')[1].split('/')[0];
    const content = `第${data.input.chapter_number || 1}章\n模拟生成正文。`;
    const result = op === 'summarize_chapter' ? { summary: '已确认摘要', warnings: [], review_status: 'ready' } : { content, title: '测试章节', frozen_context: { narrative_context_text: '角色甲不能出门' } };
    if (req.url().endsWith('/stream')) return route.fulfill({ contentType: 'application/x-ndjson', headers: { 'access-control-allow-origin': '*' }, body: [
      { ...identity, type: 'started', frozen_context: result.frozen_context }, { ...identity, type: 'delta', text: content }, { ...identity, type: 'done', result, metrics: { call_count: 1 } },
    ].map(e => JSON.stringify(e)).join('\n') + '\n' });
    return route.fulfill({ json: { ...identity, result, metrics: { call_count: 1 } }, headers: { 'access-control-allow-origin': '*' } });
  });
  const page = await context.newPage(); await page.goto(origin + '/__workflow_test');
  async function load(target = page) {
    await target.evaluate(async key => {
      window.store = await import('/src/localStore.ts'); window.workflow = await import('/src/localWorkflow.ts');
      window.api = await import('/src/localApi.ts'); window.client = await import('/src/computeClient.ts'); window.vault = await import('/src/keyVault.ts');
      window.types = await import('/src/localTypes.ts'); window.vault.setSessionKey(key);
      window.spec = { model: 'test-model', max_tokens: 4000, temperature: .7 };
      window.waitUntil = async check => { for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('condition timed out'); };
      window.makeProject = async () => {
        const p = window.types.emptyProject('可靠性测试', Object.fromEntries(['protagonist', 'supporting_characters', 'worldview', 'core_conflict', 'genre', 'style', 'word_count_range'].map(k => [k, '已有设定'])));
        p.assets = { outline: '大纲', characters: '人物', setting_expansion: '' };
        await window.store.putProject(p); return p.project_ref;
      };
    }, KEY);
  }
  await load();
  try { await fn({ context, page, load, calls, setWire: value => { wireHandler = value; }, setHandler: value => { handler = value; }, origin }); passed++; results.push({ name, status: 'passed' }); console.log('PASS ' + name); }
  catch (e) { results.push({ name, status: 'failed', message: e.message }); console.error('FAIL ' + name + '\n' + e.stack); throw e; }
  finally { wireHandler = undefined; for(const res of openResponses)res.destroy(); await context.close(); }
}

try {
await test('正文→修改确认→冻结约束摘要；重复确认不重复调用', async ({ page, calls }) => {
  await page.evaluate(async () => {
    const ref = await makeProject(); window.ref = ref;
    await workflow.generateLocalChapter(ref, 1, spec);
    const c = (await store.getProject(ref)).chapters[1];
    await workflow.confirmLocalChapter(ref, 1, c.content + '修改文字', c.revision);
    await waitUntil(async () => (await store.getProject(ref)).chapters[1].workflow.summary_status === 'ready');
    await workflow.confirmLocalChapter(ref, 1, c.content + '修改文字', c.revision);
  });
  const summaries = calls.filter(c => c.url.endsWith('/summarize_chapter'));
  assert.equal(summaries.length, 1); assert.equal(summaries[0].data.input.review_scope, 'semantic_and_rules');
  assert.equal(summaries[0].data.input.frozen_context.narrative_context_text, '角色甲不能出门');
});

await test('未解锁Key、输入过大、HTTP429都不提前锁定前章', async ({ page, setHandler }) => {
  setHandler(route => route.fulfill({ status: 429, headers: { 'access-control-allow-origin': '*' }, json: { error: { message: 'busy' } } }));
  const result = await page.evaluate(async () => {
    const ref = await makeProject(); await store.updateProject(ref, p => { workflow.setChapter(p, 1, '前文'); Object.assign(p.chapters[1].workflow, { status: 'confirmed', summary_status: 'ready' }); });
    for (const kind of ['key', 'size', '429']) {
      vault.setSessionKey(kind === 'key' ? '' : 'sk-' + 'a'.repeat(32));
      try { await workflow.generateLocalChapter(ref, 2, { ...spec, narrative_context_text: kind === 'size' ? 'x'.repeat(1100000) : '' }); throw new Error('unexpected success'); } catch (e) { if (e.message === 'unexpected success') throw e; }
      if ((await store.getProject(ref)).chapters[1].workflow.locked_by_chapter) throw new Error('previous chapter wrongly locked');
    }
    return true;
  }); assert.equal(result, true);
});

await test('重复提交由WebLock拒绝；另一标签不会误恢复活任务', async ({ page, context, load, setHandler }) => {
  let release; const gate = new Promise(r => { release = r; });
  setHandler(async route => { await gate; const p = route.request().postDataJSON(); await route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { ...p, credentials: undefined, result: { content: '大纲' }, metrics: {} } }); });
  const ref = await page.evaluate(async () => { const ref = await makeProject(); window.done = workflow.runOperation(await store.getProject(ref), 'generate_outline', {}); return ref; });
  await page.evaluate(ref => waitUntil(async () => (await store.getProject(ref)).runs.some(r => r.status === 'running')), ref);
  const other = await context.newPage(); await other.goto(origin + '/__workflow_test'); await load(other);
  assert.equal(await other.evaluate(async ref => (await workflow.recoverInterrupted(ref)).runs[0].status, ref), 'running');
  assert.match(await other.evaluate(async ref => { try { await workflow.runOperation(await store.getProject(ref), 'generate_outline', {}); } catch (e) { return e.message; } }, ref), /计算/);
  release(); await page.evaluate(() => window.done);
});

await test('旧摘要晚到拒绝覆盖新正文', async ({ page, setHandler }) => {
  let release; const gate = new Promise(r => { release = r; });
  setHandler(async route => { await gate; const p = route.request().postDataJSON(); await route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { ...p, credentials: undefined, result: { summary: '旧摘要', review_status: 'ready', warnings: [] }, metrics: {} } }); });
  const ref = await page.evaluate(async () => {
    const ref = await makeProject(); await store.updateProject(ref, p => { workflow.setChapter(p, 1, '旧文'); p.chapters[1].workflow.status = 'confirmed'; });
    window.done = workflow.summarizeLocalChapter(ref, 1).catch(e => e.message); return ref;
  });
  await page.evaluate(ref => waitUntil(async () => (await store.getProject(ref)).runs.length > 0), ref);
  await page.evaluate(ref => store.updateProject(ref, p => workflow.setChapter(p, 1, '新文')), ref);
  release(); await page.evaluate(() => window.done);
  const c = await page.evaluate(async ref => (await store.getProject(ref)).chapters[1], ref);
  assert.equal(c.content, '新文'); assert.equal(c.workflow.summary, '');
});

await test('模型结果已保存但正式应用失败：刷新后零调用恢复', async ({ page, load, calls }) => {
  const ref = await page.evaluate(async () => {
    const ref = await makeProject(); let writes = 0; const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(...args) { if (this.name === 'projects' && ++writes === 3) throw new DOMException('injected apply failure', 'UnknownError'); return put.apply(this, args); };
    try { await workflow.runOperation(await store.getProject(ref), 'generate_outline', {}); } catch {} finally { IDBObjectStore.prototype.put = put; }
    return ref;
  });
  const count = calls.length;
  await page.reload(); await load();
  await page.evaluate(async ref => { const p = await workflow.recoverInterrupted(ref); await workflow.resumeLocalRun(ref, p.runs[0].run_id); }, ref);
  assert.equal(calls.length, count);
  assert.equal((await page.evaluate(ref => store.getProject(ref), ref)).runs[0].status, 'completed');
});

await test('持续Quota错误最终应急下载保留完整结果，恢复副本可直接应用', async ({ page, load, calls }) => {
  await page.evaluate(async () => {
    const ref = await makeProject(); let writes = 0; const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(...args) { if (this.name === 'projects' && ++writes >= 2) throw new DOMException('quota', 'QuotaExceededError'); return put.apply(this, args); };
    try { await workflow.runOperation(await store.getProject(ref), 'generate_outline', {}); } catch {} finally { IDBObjectStore.prototype.put = put; }
  });
  const downloaded = page.waitForEvent('download'); await page.evaluate(() => store.downloadRescue());
  const download = await downloaded, backup = await readFile(await download.path(), 'utf8');
  const parsed = JSON.parse(backup); assert.equal(parsed.format, 'braipen-backup'); assert.ok(parsed.projects[0].runs[0].result.content); assert.ok(!backup.includes(KEY));
  const count = calls.length;
  await page.reload(); await load();
  await page.evaluate(async backup => { const [ref] = await store.restoreBackup(backup); const p = await workflow.recoverInterrupted(ref); await workflow.resumeLocalRun(ref, p.runs[0].run_id); }, backup);
  assert.equal(calls.length, count);
});

await test('重试遭遇429不丢上次partial；过期delta不进入暂存', async ({ page, setHandler }) => {
  setHandler(route => route.fulfill({ status: 429, headers: { 'access-control-allow-origin': '*' }, json: { error: { message: 'busy' } } }));
  await page.evaluate(async () => {
    const ref = await makeProject(), p = await store.getProject(ref), id = client.newIdentity(p.revision);
    await store.updateProject(ref, d => d.runs.push({ ...id, operation: 'generate_chapter', status: 'interrupted', chapter_number: 1, partial: 'VALUABLE_OLD_DRAFT', input: workflow.contextInput(p, 1, spec), error: '', started_at: new Date().toISOString() }), p.revision, false);
    try { await workflow.resumeLocalRun(ref, id.run_id); } catch {}
    const run = (await store.getProject(ref)).runs[0];
    if (run.attempt_history[0].partial !== 'VALUABLE_OLD_DRAFT') throw new Error('lost previous attempt');
  });
  setHandler(route => { const p = route.request().postDataJSON(); return route.fulfill({ contentType: 'application/x-ndjson', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ...p, credentials: undefined, type: 'delta', text: 'WRONG', attempt_id: 'old' }) + '\n' }); });
  assert.equal(await page.evaluate(async () => { const ref = await makeProject(); try { await workflow.generateLocalChapter(ref, 1, spec); } catch {} return (await store.getProject(ref)).runs[0].partial; }), '');
});

await test('中断正文保存为待确认草稿并保留实际冻结约束', async ({ page, setHandler }) => {
  setHandler(route => { const p = route.request().postDataJSON(), id = { run_id:p.run_id,step_id:p.step_id,attempt_id:p.attempt_id,input_revision:p.input_revision }; return route.fulfill({ contentType: 'application/x-ndjson', headers: { 'access-control-allow-origin': '*' }, body: [
    { ...id, type: 'started', frozen_context: { narrative_context_text: '甲不能复活' } }, { ...id, type: 'delta', text: '中断的正文' },
  ].map(e => JSON.stringify(e)).join('\n') + '\n' }); });
  const c = await page.evaluate(async () => {
    const ref = await makeProject(); try { await workflow.generateLocalChapter(ref, 1, spec); } catch {}
    const p = await workflow.recoverInterrupted(ref); await workflow.resolveLocalRun(ref, p.runs[0].run_id, true);
    return (await store.getProject(ref)).chapters[1];
  }); assert.equal(c.workflow.status, 'awaiting_confirmation'); assert.equal(c.frozen_context.narrative_context_text, '甲不能复活'); assert.equal(c.workflow.summary_status, 'not_requested');
});

await test('成功续写刷新后仍可读取且仅能插入一次', async ({ page, load }) => {
  const ref = await page.evaluate(async () => {
    const ref = await makeProject(); await store.updateProject(ref, p => workflow.setChapter(p, 1, '原文'));
    await api.localContinue(ref, 1, { context_text:'原文',instruction:'继续' }, {}); return ref;
  });
  await page.reload(); await load();
  const c = await page.evaluate(async ref => {
    const p = await workflow.recoverInterrupted(ref), run = p.runs[0]; if (!run.result.content) throw new Error('lost continuation');
    await workflow.resolveLocalRun(ref, run.run_id, true); await workflow.resolveLocalRun(ref, run.run_id, true);
    return (await store.getProject(ref)).chapters[1];
  }, ref); assert.equal(c.content.split('模拟生成正文').length - 1, 1); assert.equal(c.workflow.status, 'awaiting_confirmation');
});

await test('孤立pending摘要刷新转为可手动恢复状态；不自动请求', async ({ page, load, calls }) => {
  const ref = await page.evaluate(async () => { const ref=await makeProject(); await store.updateProject(ref,p=>{workflow.setChapter(p,1,'正文');Object.assign(p.chapters[1].workflow,{status:'confirmed',summary_status:'pending',review_status:'pending'});});return ref; });
  await page.reload(); await load();
  const p=await page.evaluate(ref=>workflow.recoverInterrupted(ref),ref); assert.equal(p.chapters[1].workflow.summary_status,'failed');assert.equal(calls.length,0);
  await page.evaluate(ref=>workflow.summarizeLocalChapter(ref,1),ref);assert.equal(calls.length,1);
});

await test('连续生成成功逐章确认摘要，引用前文后持续锁定', async ({ page, calls }) => {
  const p = await page.evaluate(async () => {const ref=await makeProject();await workflow.startLocalBatch(ref,{...spec,start_chapter:1,end_chapter:3});await waitUntil(async()=>!['running','stopping'].includes((await store.getProject(ref)).batch.status));return store.getProject(ref);});
  assert.equal(p.batch.status,'completed');assert.deepEqual(p.batch.completed_chapters,[1,2,3]);
  assert.equal(p.chapters[1].workflow.locked_by_chapter,2);assert.equal(p.chapters[3].workflow.editable,true);assert.equal(calls.length,6);
});

await test('连续生成在正文已提交后暂停，刷新续跑只补摘要和后续章节', async ({ page, load, calls }) => {
  const ref=await page.evaluate(async()=>{
    const ref=await makeProject();
    const stop=async()=>{const p=await store.getProject(ref);if(p.chapters[1]&&p.batch.status==='running'){window.removeEventListener('braipen:workflow-changed',stop);await workflow.stopLocalBatch(ref);}};
    window.addEventListener('braipen:workflow-changed',stop);
    await workflow.startLocalBatch(ref,{...spec,start_chapter:1,end_chapter:2});await waitUntil(async()=>['stopped','failed','completed'].includes((await store.getProject(ref)).batch.status));return ref;
  });
  await page.reload();await load();
  await page.evaluate(async ref=>{const p=await workflow.recoverInterrupted(ref);if(p.batch.status==='completed')throw new Error('stop missed');await workflow.startLocalBatch(ref,p.batch.request,true);await waitUntil(async()=>(await store.getProject(ref)).batch.status==='completed');},ref);
  assert.equal(calls.filter(c=>c.url.includes('/generate_chapter/')&&c.data.input.chapter_number===1).length,1);
  assert.equal(calls.filter(c=>c.url.endsWith('/summarize_chapter')&&c.data.input.chapter_number===1).length,1);
});

await test('Key保险箱加解密、错误口令与备份排除Key', async ({page})=>{
  const result=await page.evaluate(async()=>{await makeProject();const key=vault.getSessionKey();await vault.rememberKey(key,'test-passphrase');vault.setSessionKey('');let wrong=false;try{await vault.unlockKey('incorrect');}catch{wrong=true;}await vault.unlockKey('test-passphrase');return{wrong,key:vault.getSessionKey(),projects:JSON.stringify(await store.listProjects())};});
  assert.equal(result.wrong,true);assert.equal(result.key,KEY);assert.ok(!result.projects.includes(KEY));
});

await test('真实网络流中刷新：连接取消、部分正文保留、未知请求不自动重发', async ({ context, page, load, setHandler, setWire, calls }) => {
  await context.unroute('**/api/**');
  let closedResolve; const closed = new Promise(r => { closedResolve = r; });
  setHandler(route => route.continue());
  setWire(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const p = JSON.parse(body), id = v2Identity(p);
    res.writeHead(200, { 'Content-Type':'application/x-ndjson' });
    res.write(JSON.stringify({ ...id, type:'started', frozen_context:{narrative_context_text:'冻结规则'} }) + '\n');
    res.write(JSON.stringify({ ...id, type:'delta', text:'已保存的第一段' }) + '\n');
    res.on('close', closedResolve);
  });
  const ref = await page.evaluate(async()=>{const ref=await makeProject();window.pending=workflow.generateLocalChapter(ref,1,spec).catch(()=>undefined);return ref;});
  await page.evaluate(ref=>waitUntil(async()=>(await store.getProject(ref)).runs[0]?.partial==='已保存的第一段'),ref);
  await page.reload();await bounded(closed,'stream connection was not closed on reload');await load();
  const p=await page.evaluate(ref=>workflow.recoverInterrupted(ref),ref);
  assert.equal(p.runs[0].status,'interrupted');assert.equal(p.runs[0].partial,'已保存的第一段');assert.equal(Object.keys(p.chapters).length,0);assert.equal(calls.length,0);
});

await test('真实网络摘要中刷新：批次恢复不重生成已提交正文', async ({context,page,load,setWire,calls})=>{
  await context.unroute('**/api/**');
  let summaryEnteredResolve;const entered=new Promise(r=>{summaryEnteredResolve=r;});
  let closedResolve;const closed=new Promise(r=>{closedResolve=r;});
  let pauseSummary=true;
  setWire(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;const p=JSON.parse(body);
    calls.push({url:req.url,data:p});
    const id=v2Identity(p);
    if(req.url.includes('/summarize_chapter')){
      if(pauseSummary){res.on('close',closedResolve);summaryEnteredResolve();return;}
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...id,result:{summary:'恢复摘要',review_status:'ready',warnings:[]},metrics:{}}));return;
    }
    res.writeHead(200,{'Content-Type':'application/x-ndjson'});
    res.end([{...id,type:'started',frozen_context:{}},{...id,type:'delta',text:'批次正文'},{...id,type:'done',result:{content:'批次正文',title:'正文',frozen_context:{}},metrics:{}}].map(e=>JSON.stringify(e)).join('\n')+'\n');
  });
  const ref=await page.evaluate(async()=>{const ref=await makeProject();await workflow.startLocalBatch(ref,{...spec,start_chapter:1,end_chapter:2});return ref;});
  await bounded(entered,'summary never started');await page.reload();await bounded(closed,'summary connection was not closed on reload');await load();pauseSummary=false;
  await page.evaluate(async ref=>{const p=await workflow.recoverInterrupted(ref);await workflow.startLocalBatch(ref,p.batch.request,true);await waitUntil(async()=>(await store.getProject(ref)).batch.status==='completed');},ref);
  assert.equal(calls.filter(c=>c.url.includes('/generate_chapter/')&&c.data.input.chapter_number===1).length,1);
});

await test('实际页面的任务恢复入口可以应用已保存结果，离线作品仍可读取', async ({page,load,calls})=>{
  const ref=await page.evaluate(async()=>{
    const ref=await makeProject(),p=await store.getProject(ref),id=client.newIdentity(p.revision);
    await store.updateProject(ref,d=>d.runs.push({...id,operation:'generate_outline',status:'interrupted',input:{},partial:'',error:'',started_at:new Date().toISOString(),result:{content:'无需模型调用的已保存大纲'},result_revision:p.revision}),p.revision,false);
    return ref;
  });
  await page.goto(origin+'/dashboard');await load();
  await page.evaluate(async ref=>{
    const config=await import('/src/appConfig.ts');config.setIntroHidden(true);config.markIntroSeen();
    const {useAppStore}=await import('/src/store/useAppStore.ts');
    const p=await store.getProject(ref);useAppStore.getState().setProjects([{project_ref:ref,title:p.title,storage_type:'browser'}]);useAppStore.getState().selectProject(ref);
  },ref);
  // Dismiss the intro if it had already mounted; its visible skip control is user-operable.
  const skip=page.getByRole('button',{name:/跳过/});if(await skip.count())await skip.first().click();
  await page.getByText(/任务与恢复/).first().click();
  await page.getByRole('button',{name:'应用已保存结果',exact:true}).waitFor({state:'visible'});
  await page.screenshot({path:resolve(root,'../reports/workflow-reliability-2026-09-24/recovery-pending-ui.png'),fullPage:true});
  await page.getByRole('button',{name:'应用已保存结果',exact:true}).click();
  await page.getByRole('button',{name:/确.*定|OK/}).last().click();
  await page.evaluate(ref=>waitUntil(async()=>(await store.getProject(ref)).assets.outline==='无需模型调用的已保存大纲'),ref);
  assert.equal(calls.length,0);
  await page.evaluate(async ref=>{
    await store.updateProject(ref,p=>workflow.setChapter(p,1,'离线阅读样例正文'));
    const {useAppStore}=await import('/src/store/useAppStore.ts');useAppStore.getState().setApiStatus('offline');
  },ref);
  await page.getByRole('link',{name:/阅读空间/}).click();
  await page.getByText('离线阅读样例正文',{exact:true}).first().waitFor({state:'visible'});
  await page.screenshot({path:resolve(root,'../reports/workflow-reliability-2026-09-24/recovery-ui.png'),fullPage:true});
});

await test('第二章配额失败的应急副本恢复后，第一章仍持续锁定', async ({page,load})=>{
  await page.evaluate(async()=>{
    const ref=await makeProject();await store.updateProject(ref,p=>{workflow.setChapter(p,1,'确认的前文');Object.assign(p.chapters[1].workflow,{status:'confirmed',summary_status:'ready'});});
    let writes=0;const put=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args){if(this.name==='projects'&&++writes>=4)throw new DOMException('quota','QuotaExceededError');return put.apply(this,args);};
    try{await workflow.generateLocalChapter(ref,2,spec);}catch{}finally{IDBObjectStore.prototype.put=put;}
  });
  const downloaded=page.waitForEvent('download');await page.evaluate(()=>store.downloadRescue());const backup=await readFile(await(await downloaded).path(),'utf8');
  const source=JSON.parse(backup).projects[0];assert.equal(source.chapters[1].workflow.locked_by_chapter,2);assert.ok(source.runs[0].result.content);
  await page.reload();await load();
  const outcome=await page.evaluate(async backup=>{const [ref]=await store.restoreBackup(backup),p=await workflow.recoverInterrupted(ref);await workflow.resumeLocalRun(ref,p.runs[0].run_id);const c=(await store.getProject(ref)).chapters[1];try{await workflow.confirmLocalChapter(ref,1,'试图改写',c.revision);return 'UNSAFE';}catch(e){return e.message;}},backup);
  assert.match(outcome,/锁定/);
});

await test('实际页面可结束过期批次，保留草稿并解除单步操作禁用', async ({page,load})=>{
  const ref=await page.evaluate(async()=>{
    const ref=await makeProject(),p=await store.getProject(ref),id=client.newIdentity(p.revision);
    await store.updateProject(ref,d=>{d.batch={id:'batch',status:'stopped',stage:'interrupted',start_chapter:1,end_chapter:2,current_chapter:1,completed_chapters:[],message:'',error:'',request:{...spec,start_chapter:1,end_chapter:2},input_revision:0};d.runs.push({...id,operation:'generate_chapter',status:'interrupted',input:workflow.contextInput(p,1,spec),chapter_number:1,partial:'保留草稿',error:'',started_at:new Date().toISOString()});});
    return ref;
  });
  await page.evaluate(()=>localStorage.setItem('braipen:intro-hidden','true'));
  await page.goto(origin+'/dashboard');await load();
  await page.evaluate(async ref=>{const{useAppStore}=await import('/src/store/useAppStore.ts');useAppStore.getState().setProjects([{project_ref:ref,title:'可靠性测试',storage_type:'browser'}]);useAppStore.getState().selectProject(ref);},ref);
  await page.getByText(/任务与恢复/).first().click();
  assert.equal(await page.getByRole('button',{name:'重新执行此步骤',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'结束此批次',exact:true}).click();await page.getByRole('button',{name:/确.*定|OK/}).last().click();
  await page.evaluate(ref=>waitUntil(async()=>!(await store.getProject(ref)).batch.request),ref);
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(button=>button.textContent?.trim()==='重新执行此步骤'&&!button.disabled));
  assert.equal(await page.getByRole('button',{name:'重新执行此步骤',exact:true}).isDisabled(),false);
  const p=await page.evaluate(ref=>store.getProject(ref),ref);assert.equal(p.runs[0].partial,'保留草稿');
  await page.screenshot({path:resolve(root,'../reports/workflow-reliability-2026-09-24/stale-batch-ui.png'),fullPage:true});
});

console.log(`PASS ${passed} browser workflow scenarios (${process.env.BRAIPEN_BROWSER||'msedge'})`);
} finally {
  await mkdir(resolve(root,'../reports/workflow-reliability-2026-09-24'),{recursive:true});
  await (await import('node:fs/promises')).writeFile(resolve(root,`../reports/workflow-reliability-2026-09-24/browser-${process.env.BRAIPEN_BROWSER||'msedge'}.json`),JSON.stringify(results,null,2));
  await browser.close();await server.close();
}
