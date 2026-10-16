import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import ts from 'typescript';
import { memoryStyleStore } from './writing-style-test-helpers.mjs';

function fixture() {
  const f = memoryStyleStore(), calls = [];
  let supported = true, streamHandler;
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
  const provider = { stable, resolveConnection: async () => connection, legacySnapshot: async () => connection,
    acquireConnection: async () => ({ snapshot: connection, signal: new AbortController().signal, close() {}, check: async () => {} }) };
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../src/localWorkflow.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, crypto: webcrypto, structuredClone, AbortController, AbortSignal, Event, CustomEvent: class { constructor(type) { this.type = type; } },
    window: { addEventListener() {}, dispatchEvent() {} }, navigator: { locks: { request: async (_name, options, fn) => (fn || options)({}) } },
    require: name => {
      if (name === './localStore') return f.store; if (name === './writingStyle') return f.style;
      if (name === './computeClient') return client; if (name === './providerConnections') return provider;
      if (name === './writingStyleClient') return { requireWritingStyleSupport: async () => { if (!supported) throw new Error('当前服务尚未支持文风卡'); } };
      return {};
    },
  });
  const api = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../src/localApi.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports: api, URL, require: name => name === './localStore' ? f.store : name === './localWorkflow' ? exports : name === './providerConnections' ? { ...provider, connectionConfigured: async () => true } : {},
  });
  return { ...f, workflow: exports, api, calls, support: value => { supported = value; }, setStream: handler => { streamHandler = handler; },
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
