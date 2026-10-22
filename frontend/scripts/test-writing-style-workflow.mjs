import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import ts from 'typescript';
import { memoryStyleStore } from './writing-style-test-helpers.mjs';

function fixture() {
  const f = memoryStyleStore(), calls = [];
  let supported = true, streamHandler, prepareConnection;
  const connection = { profile_id: 'synthetic', model: 'synthetic-model' };
  const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort().map(([k, x]) => [k, stable(x)])) : v;
  const client = {
    MODEL_OPERATIONS: new Set(['generate_chapter', 'continue_chapter', 'summarize_chapter']), newIdentity: input_revision => ({ run_id: webcrypto.randomUUID(), step_id: webcrypto.randomUUID(), attempt_id: webcrypto.randomUUID(), input_revision }), prepareCompute: () => '{}',
    compute: async (operation, input) => { calls.push({ operation, input: structuredClone(input) }); return { result: { summary: '模拟摘要', warnings: [], review_status: 'ready' }, metrics: {} }; },
    computeStream: async (operation, input, identity, handlers) => {
      calls.push({ operation, input: structuredClone(input) });
      if (streamHandler) return streamHandler(operation, input, identity, handlers);
      const frozen_context = { writing_style_context: structuredClone(input.writing_style_context) };
      await handlers.onStarted?.(frozen_context); await handlers.onDelta?.('模拟正文');
      return { result: { content: '模拟正文', title: '模拟章节', frozen_context }, metrics: {} };
    },
  };
  const provider = { stable, resolveConnection: async () => { if (prepareConnection) await prepareConnection(); return connection; }, legacySnapshot: async () => connection,
    acquireConnection: async () => ({ snapshot: connection, signal: new AbortController().signal, close() {}, check: async () => {} }) };
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../src/localWorkflow.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, crypto: webcrypto, structuredClone, AbortController, AbortSignal, Event, CustomEvent: class { constructor(type) { this.type = type; } },
    window: { addEventListener() {}, dispatchEvent() {} }, navigator: { locks: { request: async (_name, options, fn) => (fn || options)({}) } },
    require: name => {
      if (name === './localStore') return f.store; if (name === './writingStyle') return f.style;
      if (name === './workspaceActivity') return f.activity;
      if (name === './computeClient') return client; if (name === './providerConnections') return provider;
      if (name === './writingStyleClient') return { requireWritingStyleSupport: async () => { if (!supported) throw new Error('当前服务尚未支持文风卡'); } };
      return {};
    },
  });
  const api = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../src/localApi.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports: api, URL, require: name => name === './localStore' ? f.store : name === './localWorkflow' ? exports : name === './providerConnections' ? { ...provider, connectionConfigured: async () => true } : {},
  });
  return { ...f, workflow: exports, api, calls, support: value => { supported = value; }, setStream: handler => { streamHandler = handler; }, setConnectionPreparation: handler => { prepareConnection = handler; },
    async project() { const p = f.types.emptyProject('模拟作品'); p.assets = { outline: '大纲', characters: '人物卡', setting_expansion: '' }; await f.store.putProject(p); return p; },
    card: (name = '文风A') => f.style.createWritingStyle(name, `${name}规则`), request: { model: 'synthetic-model', temperature: .7, max_tokens: 4000 } };
}

test('单章覆盖不改项目默认，请求剥离完整范例库与本地选择', async () => {
  const f = fixture(), p = await f.project(), a = f.card(), b = f.card('文风B');
  b.examples = Array.from({ length: 5 }, (_, i) => ({ id: `sample_${i}`, text: `范例${i}`, source: b.source, scene_tags: [], pov: '', pace: '' }));
  await f.store.selectProjectWritingStyle(p.project_ref, a);
  await f.workflow.generateLocalChapter(p.project_ref, 1, { ...f.request, writing_style: b });
  const saved = await f.store.getProject(p.project_ref), wire = f.calls[0].input;
  assert.equal(saved.writing_style.id, a.id); assert.equal(saved.chapters[1].frozen_context.writing_style_context.card.id, b.id);
  assert.equal(wire.request.writing_style, undefined); assert.equal(wire.writing_style_context.examples.length, 3);
  assert.equal(JSON.stringify(wire).includes('范例4'), false);
});
test('禁用文风卡记录null，后续续写不重新启用项目默认', async () => {
  const f = fixture(), p = await f.project(); await f.store.selectProjectWritingStyle(p.project_ref, f.card());
  await f.workflow.generateLocalChapter(p.project_ref, 1, { ...f.request, writing_style: 'none' });
  const saved = await f.store.getProject(p.project_ref);
  assert.equal(saved.chapters[1].frozen_context.writing_style_context, null);
  assert.equal(f.workflow.contextInput(saved, 1, {}, 'continue').writing_style_context, null);
});
test('旧服务明确拒绝选卡生成，零模型调用且不建立任务', async () => {
  const f = fixture(), p = await f.project(); await f.store.selectProjectWritingStyle(p.project_ref, f.card()); f.support(false);
  await assert.rejects(f.workflow.generateLocalChapter(p.project_ref, 1, f.request), /尚未支持/);
  assert.equal(f.calls.length, 0); assert.equal((await f.store.getProject(p.project_ref)).runs.length, 0);
});
test('请求取消不产生模型调用，服务不确认文风时不保存正文', async () => {
  const f = fixture(), p = await f.project(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.workflow.generateLocalChapter(p.project_ref, 1, f.request, {}, controller.signal)); assert.equal(f.calls.length, 0);
  await f.store.selectProjectWritingStyle(p.project_ref, f.card());
  f.setStream(async (_op, _input, _id, handlers) => { await handlers.onStarted({}); throw new Error('unexpected'); });
  await assert.rejects(f.workflow.generateLocalChapter(p.project_ref, 1, f.request), /未确认/);
  assert.equal((await f.store.getProject(p.project_ref)).chapters[1], undefined);
});
test('中断任务重试使用原文风，库内新版不替换原输入', async () => {
  const f = fixture(), p = await f.project(), a = await f.store.saveWritingStyle(f.card()); await f.store.selectProjectWritingStyle(p.project_ref, a);
  f.setStream(async (_op, input, _id, handlers) => { await handlers.onStarted({ writing_style_context: input.writing_style_context }); throw new Error('模拟断线'); });
  await assert.rejects(f.workflow.generateLocalChapter(p.project_ref, 1, f.request));
  const interrupted = await f.store.getProject(p.project_ref); await f.store.saveWritingStyle({ ...a, rules: '新版规则' }, 1);
  f.setStream(undefined); await f.workflow.resumeLocalRun(p.project_ref, interrupted.runs[0].run_id);
  const saved = await f.store.getProject(p.project_ref); assert.equal(saved.writing_style.id, a.id);
  assert.equal(saved.chapters[1].frozen_context.writing_style_context.card.id, a.id);
  assert.equal(saved.chapters[1].frozen_context.writing_style_context.card.rules, a.rules);
});
test('项目默认变更后旧任务拒绝覆盖，保留输入与中断草稿', async () => {
  const f = fixture(), p = await f.project(); await f.store.selectProjectWritingStyle(p.project_ref, f.card());
  f.setStream(async (_op, input, _id, handlers) => { await handlers.onStarted({ writing_style_context: input.writing_style_context }); await handlers.onDelta('未完成草稿'); throw new Error('模拟断线'); });
  await assert.rejects(f.workflow.generateLocalChapter(p.project_ref, 1, f.request));
  const old = await f.store.getProject(p.project_ref); await f.store.selectProjectWritingStyle(p.project_ref, f.card('新默认'));
  await assert.rejects(f.workflow.resumeLocalRun(p.project_ref, old.runs[0].run_id), /输入已变更/);
  const saved = await f.store.getProject(p.project_ref); assert.equal(saved.chapters[1], undefined); assert.equal(saved.runs[0].partial, '未完成草稿');
});
test('重新生成保留旧版本文风快照，续写继承该章实际使用版本', async () => {
  const f = fixture(), p = await f.project(), a = f.card(), b = f.card('另一文风');
  await f.workflow.generateLocalChapter(p.project_ref, 1, { ...f.request, writing_style: a });
  await f.workflow.generateLocalChapter(p.project_ref, 1, { ...f.request, writing_style: b });
  const saved = await f.store.getProject(p.project_ref);
  assert.equal(saved.chapters[1].versions[0].frozen_context.writing_style_context.card.id, a.id);
  assert.equal(f.workflow.contextInput(saved, 1, {}, 'continue').writing_style_context.card.id, b.id);
});
test('连续生成固定文风池，库内修订不影响后续章节', async () => {
  const f = fixture(), p = await f.project(), a = await f.store.saveWritingStyle(f.card()); await f.store.selectProjectWritingStyle(p.project_ref, a);
  let changed = false;
  f.setStream(async (_op, input, _id, handlers) => {
    if (!changed) { changed = true; await f.store.saveWritingStyle({ ...a, rules: '库内新版规则' }, a.revision); }
    const frozen_context = { writing_style_context: input.writing_style_context };
    await handlers.onStarted(frozen_context); return { result: { content: '批次模拟正文', title: '批次', frozen_context }, metrics: {} };
  });
  await f.workflow.startLocalBatch(p.project_ref, { ...f.request, start_chapter: 1, end_chapter: 2 });
  let saved;
  for (let i = 0; i < 300; i++) { saved = await f.store.getProject(p.project_ref); if (!['running', 'stopping'].includes(saved.batch.status)) break; await new Promise(r => setImmediate(r)); }
  assert.equal(saved.batch.status, 'completed', saved.batch.error);
  assert.equal(saved.chapters[1].frozen_context.writing_style_context.card.rules, a.rules);
  assert.equal(saved.chapters[2].frozen_context.writing_style_context.card.rules, a.rules);
  assert.equal((await f.store.listWritingStyles())[0].revision, 2);
});
test('旧章首次续写中断后保存草稿，记录实际卡或显式禁用，再改项目默认也不漂移', async () => {
  for (const choice of ['project', 'none']) {
    const f = fixture(), p = await f.project(), a = f.card();
    await f.store.selectProjectWritingStyle(p.project_ref, a);
    await f.store.updateProject(p.project_ref, d => f.workflow.setChapter(d, 1, '旧章节正文'));
    f.setStream(async (_op, input, _id, handlers) => { await handlers.onStarted({ writing_style_context: input.writing_style_context }); await handlers.onDelta('中断续写草稿'); throw new Error('断线'); });
    const before = await f.store.getProject(p.project_ref), input = f.workflow.contextInput(before, 1, { ...f.request, writing_style: choice }, 'continue');
    await assert.rejects(f.workflow.runOperation(before, 'continue_chapter', input, { stream: true }));
    const interrupted = await f.store.getProject(p.project_ref); await f.workflow.resolveLocalRun(p.project_ref, interrupted.runs[0].run_id, true);
    await f.store.selectProjectWritingStyle(p.project_ref, f.card('后来默认'));
    const saved = await f.store.getProject(p.project_ref), next = f.workflow.contextInput(saved, 1, {}, 'continue').writing_style_context;
    assert.match(saved.chapters[1].content, /中断续写草稿/);
    if (choice === 'none') assert.equal(next, null); else assert.equal(next.card.id, a.id);
  }
});
test('实际就绪判断支持项目卡和单章覆盖，none仍检查旧style，大纲要求独立', async () => {
  const f = fixture(), p = await f.project();
  for (const k of ['protagonist', 'supporting_characters', 'worldview', 'core_conflict', 'genre', 'word_count_range']) p.config[k] = '已填写';
  p.config.style = ''; p.writing_style = f.card();
  assert.equal((await f.api.readiness(p, 1)).ready, true);
  assert.equal((await f.api.readiness(p, 1, 'none')).ready, false);
  delete p.writing_style;
  assert.equal((await f.api.readiness(p, 1, 'selected')).ready, true);
  assert.equal((await f.api.readiness(p, 1)).ready, false);
  p.assets.outline = ''; const assets = await f.api.readiness(p, 1, 'selected');
  assert.equal(assets.ready, false); assert.equal(assets.can_generate_assets, false); assert.ok(assets.blockers.some(b => b.code === 'assets_style_missing'));
});


test('生成预检明确拒绝缺失前章和无效编号，已完成前文后允许顺序推进', async () => {
  const f = fixture(), p = await f.project();
  for (const key of ['protagonist', 'supporting_characters', 'worldview', 'core_conflict', 'genre', 'style', 'word_count_range']) p.config[key] = '已填写';
  const gap = await f.api.readiness(p, 3);
  assert.equal(gap.ready, false); assert.equal(gap.blockers.find(b => b.code === 'chapter_missing').chapter_number, 1);
  for (const number of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.ok((await f.api.readiness(p, number)).blockers.some(b => b.code === 'chapter_number_invalid'));
  }
  f.workflow.setChapter(p, 1, '第一章');
  Object.assign(p.chapters[1].workflow, { status: 'confirmed', summary_status: 'ready' });
  assert.equal((await f.api.readiness(p, 2)).ready, true);
  assert.equal((await f.api.readiness(p, 3)).blockers.find(b => b.code === 'chapter_missing').chapter_number, 2);
  assert.equal(f.calls.length, 0);
});

test('连续生成的当前章后停止完成该章确认与摘要，且不会调用下一章', async () => {
  const f = fixture(), p = await f.project();
  f.setStream(async (_op, input, _identity, handlers) => {
    const frozen_context = { writing_style_context: input.writing_style_context };
    await handlers.onStarted(frozen_context);
    await f.workflow.stopLocalBatch(p.project_ref);
    return { result: { content: '当前章完整正文', frozen_context }, metrics: {} };
  });
  await f.workflow.startLocalBatch(p.project_ref, { ...f.request, start_chapter: 1, end_chapter: 2 });
  let saved;
  for (let i = 0; i < 300; i++) {
    saved = await f.store.getProject(p.project_ref);
    if (!['running', 'stopping'].includes(saved.batch.status)) break;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(saved.batch.status, 'stopped');
  assert.deepEqual([...saved.batch.completed_chapters], [1]);
  assert.equal(saved.chapters[1].workflow.status, 'confirmed');
  assert.equal(saved.chapters[1].workflow.summary_status, 'ready');
  assert.equal(saved.chapters[2], undefined);
  assert.deepEqual(f.calls.map(call => call.operation), ['generate_chapter', 'summarize_chapter']);
});

test('立即中断连续生成保留正文片段，不继续确认或调用摘要', async () => {
  const f = fixture(), p = await f.project();
  f.setStream(async (_op, input, _identity, handlers) => {
    await handlers.onStarted({ writing_style_context: input.writing_style_context });
    await handlers.onDelta('中断时已收到的正文片段');
    await f.workflow.stopLocalBatch(p.project_ref, true);
    throw new DOMException('请求已中断', 'AbortError');
  });
  await f.workflow.startLocalBatch(p.project_ref, { ...f.request, start_chapter: 1, end_chapter: 2 });
  let saved;
  for (let i = 0; i < 300; i++) {
    saved = await f.store.getProject(p.project_ref);
    if (!['running', 'stopping'].includes(saved.batch.status)) break;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(saved.batch.status, 'stopped');
  assert.equal(saved.runs[0].partial, '中断时已收到的正文片段');
  assert.equal(saved.chapters[1], undefined);
  assert.deepEqual(f.calls.map(call => call.operation), ['generate_chapter']);
});


test('生成在连接准备窗口禁止切换工作区，准备失败完成清理后释放', async () => {
  const f = fixture(), p = await f.project(), backup = JSON.stringify(await f.store.createBackup());
  let release, started;
  const entering = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.setConnectionPreparation(async () => { started(); await gate; throw new Error('模拟连接准备失败'); });
  const running = f.workflow.generateLocalChapter(p.project_ref, 1, f.request);
  const failed = assert.rejects(running, /模拟连接准备失败/);
  await entering;
  assert.equal((await f.store.getProject(p.project_ref)).runs.length, 0);
  assert.equal(f.activity.hasWorkspaceActivity(f.store.getWorkspaceEpoch()), true);
  await assert.rejects(f.store.openWorkspace(backup, true), /任务|结束|切换/);
  release(); await failed;
  assert.equal(f.activity.hasWorkspaceActivity(f.store.getWorkspaceEpoch()), false);
  await f.store.openWorkspace(backup, true);
  assert.equal(f.calls.length, 0);
});

test('封面连接准备阶段登记活动，取消后保持锁定直到清理完成', async () => {
  const f = memoryStyleStore(), p = f.types.emptyProject('合成封面活动');
  p.assets.characters = '姓名：勇者；外貌特征：黑发'; await f.store.putProject(p);
  const backup = JSON.stringify(await f.store.createBackup());
  let release, entered; const controller = { current: null };
  const gate = new Promise(resolve => { release = resolve; });
  const starting = new Promise(resolve => { entered = resolve; });
  const source = readFileSync(new URL('../src/components/CoverPanel.tsx', import.meta.url), 'utf8');
  const method = source.slice(source.indexOf('  async function generate('), source.indexOf('  async function applyVersion('));
  const exports = {}, noop = () => {};
  const sandbox = { exports, crypto: webcrypto, AbortController, project: p, projectRef: p.project_ref, busy:false,
    navigator:{locks:{request:async (_key,_options,fn)=>fn({})}}, preview:undefined, fallbackId:'', connectionId:'synthetic-image', model:'synthetic-model', fallbackOptions:[],
    chosenText:{id:'synthetic-text'}, selectedTextModel:'synthetic-text-model', coverEnabled:true, versions:[], count:1, MAX_COVER_VERSIONS:30,
    setError:noop, setBusy:noop, setStage:noop, setNotice:noop, setUnsavedImage:noop, setFallbackRequest:noop, controller, live:{current:true},
    getProject:f.store.getProject, getWorkspaceEpoch:f.store.getWorkspaceEpoch, beginWorkspaceActivity:f.activity.beginWorkspaceActivity,
    coverSource: current=>({idea:'合成故事',characters:current.assets.characters}),
    resolveImageConnection:async()=>{entered(); await gate; throw new Error('模拟连接准备失败');},
    CoverRequestError:class extends Error {}, canOfferSeedreamFallback:()=>false, snapshot:undefined,
  };
  runInNewContext(ts.transpileModule(method+'\nexports.generate=generate;',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,sandbox);
  const running = exports.generate(false); await starting;
  assert.equal((await f.store.getProject(p.project_ref)).cover, undefined);
  await assert.rejects(f.store.openWorkspace(backup,true), /任务|结束|切换/);
  controller.current.abort();
  await assert.rejects(f.store.openWorkspace(backup,true), /任务|结束|切换/);
  release(); await running;
  assert.equal(f.activity.hasWorkspaceActivity(f.store.getWorkspaceEpoch()),false);
  assert.equal(controller.current,null);
  await f.store.openWorkspace(backup,true);
});
