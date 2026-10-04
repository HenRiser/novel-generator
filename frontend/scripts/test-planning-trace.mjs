import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function load(name, dependencies = {}) {
  const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  runInNewContext(outputText, { exports, structuredClone, require: key => {
    assert.ok(key in dependencies, `Unexpected import ${key}`); return dependencies[key];
  } });
  return exports;
}
const planningInput = load('planningInput');
const contract = load('planningStreamContract', { './planningInput': planningInput });
const trace = load('planningTrace', { './planningStreamContract': contract });
const store = load('localStore', { './planningTrace': trace });
const examples = JSON.parse(readFileSync(new URL('../../docs/chapter-planning-events.examples.json', import.meta.url), 'utf8'));
const entries = examples.normal.filter(event => event.type === 'progress').map(trace.planningTraceEntry);
const project = () => ({ schema_version: 2, project_ref: 'book:bk_trace_test', revision: 0, title: 'trace', updated_at: '',
  config: {}, assets: { outline: '', characters: '', setting_expansion: '' }, chapters: {}, graph: { graph: { nodes: [], edges: [] } },
  views: { views: [] }, chapter_tasks: {}, scene_plans: {}, reviews: {}, batch: { status: 'idle', completed_chapters: [] },
  knowledge_drafts: [], story_deltas: [], events: [], snapshots: [], ai_runs: [],
  runs: [{ run_id: 'trace', operation: 'plan_chapter', status: 'interrupted', input: {} }] });

test('旧记录与真实进度前缀可读，返回值独立于原数据', () => {
  assert.equal(trace.readPlanningTrace(undefined).invalid, false);
  for (let length = 0; length <= entries.length; length++) {
    const actual = trace.readPlanningTrace(entries.slice(0, length));
    assert.equal(actual.invalid, false); assert.equal(actual.entries.length, length);
  }
  const actual = trace.readPlanningTrace(entries);
  actual.entries[0].elapsed_ms = 999;
  assert.notEqual(entries[0].elapsed_ms, 999);
});
test('诊断投影只有六个字段，不保留身份、结果或正文', () => {
  const projected = trace.planningTraceEntry({ ...examples.normal[1], text: 'PRIVATE_TEXT', result: {} });
  assert.deepEqual(Object.keys(projected).sort(), ['elapsed_ms', 'event_version', 'node', 'seq', 'status', 'visit']);
});
test('损坏、重复、乱序、非有限与超量轨迹全部安全忽略', () => {
  const malformed = [null, {}, Array(33).fill(entries[0]), [{ ...entries[0], seq: 1 }], [{ ...entries[0], elapsed_ms: NaN }],
    [{ ...entries[0], metadata: 'PRIVATE_ARCHIVE' }], [entries[1]], [entries[0], entries[0]],
    [{ ...entries[0], node: 'unknown' }], [{ ...entries[0], event_version: 2 }]];
  for (const value of malformed) {
    const actual = trace.readPlanningTrace(value);
    assert.equal(actual.invalid, true); assert.equal(actual.entries.length, 0);
  }
});
test('非法诊断被丢弃并标记，合法完整结果不受影响', () => {
  const value = project(); value.runs[0].planning_trace = [{ ...entries[0], archive: 'PRIVATE_ARCHIVE' }];
  value.runs[0].result = examples.normal.at(-1).result;
  store.validateProject(value);
  assert.equal(value.runs[0].planning_trace, undefined);
  assert.equal(value.runs[0].planning_trace_invalid, true);
  assert.equal(value.runs[0].result.status, 'draft_ready');
  const clean = project(); clean.runs[0].planning_trace = entries;
  store.validateProject(clean);
  assert.equal(clean.runs[0].planning_trace.length, 6);
  const badMarker = project(); badMarker.runs[0].planning_trace_invalid = 'bad';
  badMarker.runs[0].result = examples.normal.at(-1).result;
  store.validateProject(badMarker);
  assert.equal(badMarker.runs[0].planning_trace_invalid, true);
  assert.equal(badMarker.runs[0].result.status, 'draft_ready');
});
test('诊断清洗不能绕过全项目凭据与原型字段保护', () => {
  for (const key of ['api_key', 'credentials', '__proto__']) {
    const value = project();
    value.runs[0].planning_trace = [{ ...entries[0], [key]: 'OFFLINE_SENTINEL' }];
    assert.throws(() => store.validateProject(value));
  }
});
