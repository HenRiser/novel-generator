import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/chapter-planning-events.json', import.meta.url), 'utf8'));
function load(name, require = () => { throw new Error('Unexpected runtime import'); }) {
  const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  runInNewContext(outputText, { exports, require, structuredClone });
  return exports;
}
const input = load('planningInput');
const contract = load('planningStreamContract', name => {
  assert.equal(name, './planningInput'); return input;
});

function eventsFor(kind) {
  const events = [];
  const emit = payload => events.push({ ...fixture.identity, event_version: 1, chapter_number: fixture.chapter_number, seq: events.length + 1, ...payload });
  const error = () => emit({ type: 'error', code: 'compute_failed', message: '离线错误示例。', status: 502 });
  if (kind === 'error_before') { error(); return events; }
  emit({ type: 'started' });
  if (kind === 'error_during' || kind === 'failed_node') {
    emit({ type: 'progress', node: 'context_pack', visit: 1, status: 'started', elapsed_ms: 1 });
    if (kind === 'failed_node') emit({ type: 'progress', node: 'context_pack', visit: 1, status: 'failed', elapsed_ms: 2 });
    error(); return events;
  }
  assert.ok(['normal', 'repair'].includes(kind));
  const nodes = ['context_pack', 'initial_proposal', 'validate', ...(kind === 'repair' ? ['repair_once', 'validate'] : [])];
  for (const [index, node] of nodes.entries()) {
    const visit = index === 4 ? 2 : 1;
    for (const status of ['started', 'finished']) emit({ type: 'progress', node, visit, status, elapsed_ms: events.length });
  }
  emit({ type: 'done', result: { ...structuredClone(fixture.result), nodes, repair_count: kind === 'repair' ? 1 : 0 },
    metrics: { ...fixture.metrics, call_count: kind === 'repair' ? 2 : 1, repair_used: kind === 'repair' } });
  return events;
}
function eventsForCase(entry) {
  const events = eventsFor(entry.kind);
  for (const mutation of entry.mutations || []) {
    let target = events[mutation.index];
    for (const key of mutation.path.slice(0, -1)) target = target[key];
    const key = mutation.path.at(-1);
    if (mutation.remove) delete target[key]; else target[key] = structuredClone(mutation.value);
  }
  if (entry.drop_last) events.pop();
  if (entry.append_index !== undefined) events.push({ ...structuredClone(events[entry.append_index]), seq: events.length + 1 });
  return events;
}

for (const entry of fixture.cases) test(`shared contract: ${entry.name}`, () => {
  const parser = new contract.PlanningEventContract(fixture.identity, fixture.chapter_number);
  let accepted = true, completed = false;
  try { for (const event of eventsForCase(entry)) parser.accept(event); } catch { accepted = false; }
  if (accepted) { try { parser.finish(); completed = true; } catch { /* Explicit failure or unknown EOF. */ } }
  assert.equal(accepted, entry.accept, 'event acceptance');
  assert.equal(completed, entry.complete, 'normal EOF result');
});

test('capability selection requires compute v2 and exact planning stream version', () => {
  for (const entry of fixture.capabilities) assert.equal(contract.selectPlanningTransport(entry.value), entry.expected);
});
test('nonfinite time and invalid expected identities are rejected', () => {
  for (const elapsed_ms of [NaN, Infinity, -Infinity]) {
    const parser = new contract.PlanningEventContract(fixture.identity, fixture.chapter_number);
    const events = eventsFor('normal'); events[1].elapsed_ms = elapsed_ms;
    parser.accept(events[0]); assert.throws(() => parser.accept(events[1]));
  }
  for (const input_revision of [true, -1, 2.5, 9007199254740992]) assert.throws(() => new contract.PlanningEventContract({ ...fixture.identity, input_revision }, 2));
  for (const chapter of [true, 0, 2.5, 9007199254740992]) assert.throws(() => new contract.PlanningEventContract(fixture.identity, chapter));
  for (const field of ['run_id', 'step_id', 'attempt_id', 'request_fingerprint', 'destination_fingerprint', 'execution_fingerprint']) {
    assert.throws(() => new contract.PlanningEventContract({ ...fixture.identity, [field]: fixture.identity[field] + '\n' }, 2));
  }
});
test('expected identity and completed result are frozen independently of caller mutation', () => {
  const identity = { ...fixture.identity };
  const parser = new contract.PlanningEventContract(identity, fixture.chapter_number);
  identity.run_id = 'mutated-after-construction';
  const events = eventsFor('normal');
  for (const event of events) parser.accept(event);
  events.at(-1).result.nodes.length = 0;
  assert.equal(parser.finish().nodes.length, 3);
  const first = parser.finish(); first.nodes.length = 0;
  assert.equal(parser.finish().nodes.length, 3);
});
test('missing optional provider usage does not invalidate a complete candidate', () => {
  const events = eventsFor('normal'); delete events.at(-1).metrics.call_count; delete events.at(-1).metrics.repair_used;
  const parser = new contract.PlanningEventContract(fixture.identity, fixture.chapter_number);
  for (const event of events) parser.accept(event);
  assert.equal(parser.finish().status, 'draft_ready');
});
test('published examples are accepted by the same frontend contract', () => {
  const examples = JSON.parse(readFileSync(new URL('../../docs/chapter-planning-events.examples.json', import.meta.url), 'utf8'));
  for (const kind of ['normal', 'repair', 'error_before', 'error_during', 'failed_node']) {
    const parser = new contract.PlanningEventContract(examples.identity, examples.chapter_number);
    for (const event of examples[kind]) parser.accept(event);
    if (['normal', 'repair'].includes(kind)) assert.equal(parser.finish().chapter_number, examples.chapter_number);
    else assert.throws(() => parser.finish());
  }
});
test('error message limit counts Unicode code points rather than UTF-16 units', () => {
  for (const size of [500, 501]) {
    const event = eventsFor('error_before')[0]; event.message = '🙂'.repeat(size);
    const parser = new contract.PlanningEventContract(fixture.identity, fixture.chapter_number);
    if (size === 500) parser.accept(event);
    else assert.throws(() => parser.accept(event));
  }
});
