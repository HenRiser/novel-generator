import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import ts from 'typescript';
import { loadStyleModule } from './writing-style-test-helpers.mjs';

function fixture({ failAt, supported = true, beforeCapabilities, beforeResolve, beforeAcquire } = {}) {
  const calls = [], drafts = [], stages = [], exports = {};
  const activity = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../src/workspaceActivity.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: activity });
  let closed = 0;
  const lease = { check: async () => {}, close: () => { closed++; } };
  runInNewContext(ts.transpileModule(readFileSync(new URL('../src/writingStyleClient.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, structuredClone,
    require: name => {
      if (name === './writingStyle') return loadStyleModule();
      if (name === './workspaceActivity') return activity;
      if (name === './localStore') return { getWorkspaceEpoch: () => 7 };
      if (name === './providerConnections') return {
        capabilities: async () => { await beforeCapabilities?.(); return { operations: supported ? ['distill_style_step'] : [], writing_style: { version: 1, distillation: { version: 1, max_rounds: 5, max_output_tokens: 20000 } } }; },
        resolveConnection: async () => { await beforeResolve?.(); return {}; }, acquireConnection: async () => { await beforeAcquire?.(); return lease; },
      };
      if (name === './computeClient') return {
        newIdentity: () => ({ run_id: webcrypto.randomUUID(), step_id: webcrypto.randomUUID(), attempt_id: webcrypto.randomUUID(), input_revision: 0 }),
        compute: async (operation, input, identity, _signal, _key, bound) => {
          calls.push({ operation, input: structuredClone(input), identity, bound });
          if (input.round_number === failAt) throw new Error('模型拒绝当前输出额度');
          return { result: { name: '克制', rules: '规则第' + input.round_number + '轮', candidate_examples: [], warnings: [] } };
        },
      };
      throw new Error(name);
    },
  });
  return { api: exports, calls, drafts, stages, active: () => activity.hasWorkspaceActivity(7), closed: () => closed, handlers: { onDraft: (value, round) => drafts.push({ value, round }), onProgress: (round, stage) => stages.push({ round, stage }) } };
}
const source = { kind: 'import', label: '合成原文' };

test('一次任务五轮、同一任务身份、独立请求，每轮只带上一轮完整稿', async () => {
  const f = fixture();
  const result = await f.api.distillWritingStyle('原文。', source, undefined, undefined, undefined, f.handlers);
  assert.equal(f.calls.length, 5); assert.equal(new Set(f.calls.map(c => c.identity.run_id)).size, 1);
  assert.equal(new Set(f.calls.map(c => c.identity.attempt_id)).size, 5);
  assert.equal(f.calls[0].input.previous_draft, null);
  for (let i = 1; i < 5; i++) {
    assert.equal(f.calls[i].input.previous_draft.rules, '规则第' + i + '轮');
    assert.equal(f.calls[i].input.source_text, '原文。');
    assert.equal(f.calls[i].operation, 'distill_style_step');
  }
  assert.equal(result.card.rules, '规则第5轮'); assert.equal(f.drafts.length, 5); assert.equal(f.closed(), 1);
  assert.equal(f.active(), false);
});
test('20000字符完整提交，20001字符在能力读取和计算前拒绝', async () => {
  const f = fixture(); await f.api.distillWritingStyle('𠮷'.repeat(20000), source);
  assert.equal(Array.from(f.calls[0].input.source_text).length, 20000);
  const g = fixture(); await assert.rejects(g.api.distillWritingStyle('𠮷'.repeat(20001), source), /已拒绝/); assert.equal(g.calls.length, 0);
});
test('第三轮失败不重试，前两轮草稿可供用户继续编辑', async () => {
  const f = fixture({ failAt: 3 });
  await assert.rejects(f.api.distillWritingStyle('原文。', source, undefined, undefined, undefined, f.handlers), /输出额度/);
  assert.equal(f.calls.length, 3); assert.equal(f.drafts.at(-1).value.card.rules, '规则第2轮'); assert.equal(f.closed(), 1);
  assert.equal(f.active(), false);
});
test('取消后不再启动下一轮，旧服务不静默退化', async () => {
  const f = fixture(), controller = new AbortController();
  await assert.rejects(f.api.distillWritingStyle('原文。', source, undefined, undefined, controller.signal, { onDraft: (_value, round) => { if (round === 2) controller.abort(); } }));
  assert.equal(f.calls.length, 2); assert.equal(f.closed(), 1);
  const old = fixture({ supported: false }); await assert.rejects(old.api.distillWritingStyle('原文。', source), /更新服务/); assert.equal(old.calls.length, 0);
  assert.equal(f.active(), false); assert.equal(old.active(), false);
});

test('能力、连接与凭据准备均保持工作区活动，取消或失败清理后才释放', async () => {
  for (const stage of ['beforeCapabilities', 'beforeResolve', 'beforeAcquire']) {
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    const f = fixture({ [stage]: async () => { enter(); await wait; } }), abort = new AbortController();
    const task = f.api.distillWritingStyle('原文。', source, undefined, undefined, abort.signal);
    await entered; assert.equal(f.active(), true); assert.equal(f.calls.length, 0);
    abort.abort(); assert.equal(f.active(), true); release();
    await assert.rejects(task); assert.equal(f.active(), false); assert.equal(f.calls.length, 0);
    assert.equal(f.closed(), stage === 'beforeAcquire' ? 1 : 0);
    const failed = fixture({ [stage]: async () => { throw new Error('准备失败'); } });
    await assert.rejects(failed.api.distillWritingStyle('原文。', source), /准备失败/); assert.equal(failed.active(), false);
  }
});
