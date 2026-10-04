import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import ts from 'typescript';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/chapter-planning-events.json', import.meta.url), 'utf8'));
const encode = text => new TextEncoder().encode(text);
function load(name, require, globals = {}) {
  const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replaceAll('import.meta.env', 'viteEnv');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  runInNewContext(outputText, { exports, require: require || (() => { throw new Error('Unexpected runtime import'); }), structuredClone,
    TextEncoder, TextDecoder, AbortController, AbortSignal, crypto: webcrypto, viteEnv: { PROD: true }, ...globals });
  return exports;
}
const planningInput = load('planningInput');
const contract = load('planningStreamContract', name => { assert.equal(name, './planningInput'); return planningInput; });
const api = load('api');

function eventsFor(repair = false) {
  const rows = [];
  const emit = value => rows.push({ ...fixture.identity, event_version: 1, chapter_number: fixture.chapter_number, seq: rows.length + 1, ...value });
  emit({ type: 'started' });
  const nodes = ['context_pack', 'initial_proposal', 'validate', ...(repair ? ['repair_once', 'validate'] : [])];
  for (const [index, node] of nodes.entries()) {
    for (const status of ['started', 'finished']) emit({ type: 'progress', node, visit: index === 4 ? 2 : 1, status, elapsed_ms: rows.length });
  }
  emit({ type: 'done', result: { ...structuredClone(fixture.result), nodes, repair_count: Number(repair) },
    metrics: { ...fixture.metrics, call_count: repair ? 2 : 1, repair_used: repair } });
  return rows;
}
const wire = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

function harness(options = {}) {
  const state = { requests: [], checks: 0, closes: 0, cancellations: 0, responses: [] };
  const revoked = new AbortController();
  const snapshot = { profile_id: 'offline-test', model: 'offline-model', policy: { structured: 'json_object' },
    destination_fingerprint: fixture.identity.destination_fingerprint, execution_fingerprint: fixture.identity.execution_fingerprint };
  const lease = { snapshot, guard: {}, apiKey: 'OFFLINE_CLIENT_TEST_KEY', signal: revoked.signal,
    check: async () => { state.checks++; if (options.guardCheck) await options.guardCheck(state); }, close: () => { state.closes++; } };
  const providers = {
    requestFingerprint: async () => fixture.identity.request_fingerprint,
    resolveConnection: async () => snapshot,
    acquireConnection: async (_, external) => {
      if (options.acquisitionDelay) await delay(options.acquisitionDelay);
      return { ...lease, signal: AbortSignal.any([revoked.signal, external]) };
    },
  };
  const fetch = async (url, init) => {
    state.requests.push({ url, init, payload: JSON.parse(init.body) });
    options.onFetch?.(state);
    if (options.status) return new Response(JSON.stringify({ error: { message: 'api_key=OFFLINE_ERROR_SENTINEL' } }), { status: options.status, headers: { 'content-type': 'application/json' } });
    const chunks = options.chunks || [encode(wire(options.rows || eventsFor()))];
    let offset = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (offset < chunks.length) controller.enqueue(chunks[offset++]);
        else if (!options.stall) controller.close();
      },
      cancel() { state.cancellations++; return options.cancelNeverResolves ? new Promise(() => {}) : undefined; },
    });
    const response = new Response(body, { headers: { 'content-type': options.contentType || 'application/x-ndjson; charset=utf-8' } });
    state.responses.push(response);
    return response;
  };
  const client = load('computeClient', name => {
    if (name === './api') return api;
    if (name === './providerConnections') return providers;
    assert.equal(name, './planningStreamContract'); return contract;
  }, { fetch, AbortSignal: { any: signals => AbortSignal.any(signals), timeout: () => AbortSignal.timeout(options.timeoutMs || 2000) } });
  const identity = Object.fromEntries(['run_id', 'step_id', 'attempt_id', 'input_revision'].map(key => [key, fixture.identity[key]]));
  const input = { chapter_number: fixture.chapter_number };
  const progress = [];
  const run = (handler = event => { progress.push(event); }, signal, bound = true) => client.computePlanningStream(input, identity, { onProgress: handler }, signal, bound ? lease : undefined);
  return { state, revoked, lease, identity, input, progress, run };
}

test('normal and repaired streams return only after valid EOF, with frozen safe progress', async () => {
  for (const repair of [false, true]) {
    const rows = eventsFor(repair);
    const h = harness({ rows });
    const result = await h.run(event => {
      assert.ok(Object.isFrozen(event));
      assert.deepEqual(Object.keys(event).sort(), ['event_version', 'seq', 'chapter_number', 'type', 'node', 'visit', 'status', 'elapsed_ms'].sort());
      h.progress.push(event);
    });
    assert.deepEqual(result.result, rows.at(-1).result);
    assert.deepEqual(result.metrics, rows.at(-1).metrics);
    assert.equal(h.progress.length, repair ? 10 : 6);
    assert.equal(h.state.requests.length, 1);
    assert.match(h.state.requests[0].url, /\/plan_chapter\/stream$/);
    assert.equal(h.state.requests[0].payload.request_fingerprint, fixture.identity.request_fingerprint);
    assert.equal(h.state.closes, 0, 'The bound lease belongs to the caller');
    assert.equal(h.state.responses[0].body.locked, false);
  }
});

test('fatal incremental UTF-8 preserves split Chinese and astral characters', async () => {
  const rows = eventsFor(); rows.at(-1).result.warnings = ['中文🚀'];
  const bytes = encode(wire(rows));
  const chunks = Array.from({ length: Math.ceil(bytes.length / 7) }, (_, index) => bytes.slice(index * 7, index * 7 + 7));
  const h = harness({ chunks });
  assert.deepEqual((await h.run()).result.warnings, ['中文🚀']);
});

for (const [name, field, value] of [['fingerprint', 'request_fingerprint', '0'.repeat(64)], ['chapter', 'chapter_number', 3], ['seq', 'seq', 3], ['visit', 'visit', 2]]) {
  test(`reject ${name} before progress dispatch without fallback`, async () => {
    const rows = eventsFor(); rows[1][field] = value;
    const h = harness({ rows });
    await assert.rejects(h.run());
    assert.equal(h.progress.length, 0);
    assert.equal(h.state.requests.length, 1);
    assert.equal(h.state.responses[0].body.locked, false);
  });
}

for (const variant of ['missing done', 'bad tail', 'event after done', 'blank line', 'bad UTF-8', 'incomplete UTF-8']) {
  test(`reject ${variant} and return no result`, async () => {
    let rows = eventsFor(), chunks;
    if (variant === 'missing done') rows.pop();
    if (variant === 'event after done') rows.push({ ...rows[0], seq: rows.length + 1 });
    if (variant === 'bad tail') chunks = [encode(wire(rows) + 'RAW_TAIL_SECRET_SENTINEL')];
    if (variant === 'blank line') chunks = [encode('\n' + wire(rows))];
    if (variant === 'bad UTF-8') chunks = [new Uint8Array([255])];
    if (variant === 'incomplete UTF-8') chunks = [new Uint8Array([228, 184])];
    const h = harness({ rows, chunks });
    await assert.rejects(h.run(), error => !String(error).includes('RAW_TAIL_SECRET_SENTINEL'));
    assert.equal(h.state.requests.length, 1);
    assert.equal(h.state.responses[0].body.locked, false);
  });
}

test('caller abort rejects buffered events and no later progress is dispatched', async () => {
  const h = harness(), controller = new AbortController();
  await assert.rejects(h.run(event => { h.progress.push(event); controller.abort(new Error('caller stopped')); }, controller.signal), /caller stopped/);
  assert.equal(h.progress.length, 1);
  assert.equal(h.state.responses[0].body.locked, false);
  assert.ok(h.state.requests[0].init.signal.aborted);
});

test('lease revocation rejects buffered events while keeping lease ownership with caller', async () => {
  const h = harness();
  await assert.rejects(h.run(event => { h.progress.push(event); h.revoked.abort(new Error('lease revoked')); }), /lease revoked/);
  assert.equal(h.progress.length, 1);
  assert.equal(h.state.closes, 0);
  assert.equal(h.state.responses[0].body.locked, false);
});

test('guard check rejection prevents dispatch even without a revocation signal', async () => {
  const h = harness({ guardCheck: state => { if (state.checks === 8) throw new Error('guard denied'); } });
  await assert.rejects(h.run(), /guard denied/);
  assert.equal(h.progress.length, 0);
  assert.equal(h.state.responses[0].body.locked, false);
});

test('async handler rejection closes owned lease and never retries', async () => {
  const h = harness();
  await assert.rejects(h.run(async () => { throw new Error('callback rejected'); }, undefined, false), /callback rejected/);
  assert.equal(h.state.closes, 1);
  assert.equal(h.state.requests.length, 1);
  assert.equal(h.state.responses[0].body.locked, false);
});

test('caller abort interrupts a pending async progress handler', async () => {
  const h = harness(), controller = new AbortController();
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const pending = h.run(() => { entered(); return new Promise(() => {}); }, controller.signal);
  await ready;
  controller.abort(new Error('handler stopped'));
  await assert.rejects(pending, /handler stopped/);
  assert.equal(h.state.responses[0].body.locked, false);
});

test('timeout covers a stalled reader and never waits for hostile cancellation', async () => {
  const h = harness({ chunks: [], stall: true, cancelNeverResolves: true, timeoutMs: 30 });
  const keepAlive = delay(100);
  await assert.rejects(h.run(), { name: 'TimeoutError' });
  assert.equal(h.state.cancellations, 1);
  assert.equal(h.state.responses[0].body.locked, false);
  await keepAlive;
});

test('timeout remains effective inside a pending async progress handler', async () => {
  const h = harness({ timeoutMs: 30 });
  const keepAlive = delay(100);
  await assert.rejects(h.run(() => new Promise(() => {})), { name: 'TimeoutError' });
  assert.equal(h.state.responses[0].body.locked, false);
  await keepAlive;
});

test('timeout revokes the handler signal before delayed persistence can commit', async () => {
  const h = harness({ timeoutMs: 30 });
  let deliveredSignal, authorizedWrites = 0;
  const pending = h.run(async (_, active) => {
    deliveredSignal = active;
    await delay(70);
    active.throwIfAborted();
    authorizedWrites++;
  });
  await assert.rejects(pending, { name: 'TimeoutError' });
  assert.ok(deliveredSignal.aborted);
  await delay(80);
  assert.equal(authorizedWrites, 0);
  assert.equal(h.state.responses[0].body.locked, false);
});

test('a valid done without EOF remains unknown until timeout', async () => {
  const h = harness({ stall: true, timeoutMs: 40 });
  const keepAlive = delay(100);
  await assert.rejects(h.run(), { name: 'TimeoutError' });
  assert.equal(h.progress.length, 6);
  assert.equal(h.state.responses[0].body.locked, false);
  await keepAlive;
});

test('terminal errors are safely displayed and no error message enters progress', async () => {
  const rows = [{ ...eventsFor()[0], type: 'error', code: 'provider_error', status: 502, message: 'api_key=OFFLINE_ERROR_SENTINEL' }];
  const h = harness({ rows });
  await assert.rejects(h.run(), error => String(error).includes('[hidden]') && !String(error).includes('OFFLINE_ERROR_SENTINEL'));
  assert.equal(h.progress.length, 0);
  assert.equal(h.state.requests.length, 1);
});

test('wrong content type and HTTP errors do not fall back to JSON', async () => {
  for (const options of [{ contentType: 'application/json' }, { status: 400 }]) {
    const h = harness(options);
    await assert.rejects(h.run());
    assert.equal(h.state.requests.length, 1);
    assert.equal(h.progress.length, 0);
    if (h.state.responses.length) assert.equal(h.state.responses[0].body.locked, false);
  }
});

test('unbounded frames and oversized responses are rejected before dispatch', async () => {
  for (const size of [1024 * 1024 + 1, 2 * 1024 * 1024 + 1]) {
    const h = harness({ chunks: [encode('x'.repeat(size))] });
    await assert.rejects(h.run(), /大小限制|2 MiB/);
    assert.equal(h.progress.length, 0);
    assert.equal(h.state.responses[0].body.locked, false);
  }
});

test('caller identity and chapter are frozen before network awaits', async () => {
  let h;
  h = harness({ onFetch: () => { h.identity.run_id = 'caller-mutated'; h.input.chapter_number = 3; } });
  assert.equal((await h.run()).result.chapter_number, fixture.chapter_number);
  assert.equal(h.state.requests[0].payload.run_id, fixture.identity.run_id);
  assert.equal(h.state.requests[0].payload.input.chapter_number, fixture.chapter_number);
});

test('an owned lease acquired after timeout is closed without sending a request', async () => {
  const h = harness({ acquisitionDelay: 50, timeoutMs: 20 });
  await assert.rejects(h.run(undefined, undefined, false), { name: 'TimeoutError' });
  await delay(60);
  assert.equal(h.state.closes, 1);
  assert.equal(h.state.requests.length, 0);
});
