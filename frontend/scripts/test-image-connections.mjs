import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aUksAAAAASUVORK5CYII=';
function fixture() {
  const settings = new Map(), keys = new Map(), revoked = new Set(), calls = [];
  let imageConnections, handler, validationHandler;
  const store = {
    getSetting: async key => structuredClone(settings.get(key)),
    setSetting: async (key, value) => { settings.set(key, structuredClone(value)); },
    listSettings: async prefix => [...settings].filter(([key]) => key.startsWith(prefix)).map(([, value]) => structuredClone(value)),
    commitSettings: async changes => { for (const change of changes) change.remove ? settings.delete(change.key) : settings.set(change.key, structuredClone(change.value)); },
    assertConnectionGuard: async guard => {
      const profile = settings.get('connection:' + guard.profile_id);
      if (!profile || profile.deleted || !profile.enabled || profile.epoch !== guard.epoch || profile.key_version !== guard.key_version) throw new Error('连接已撤销。');
    },
  };
  const vault = {
    profileKey: profile => keys.get(profile.id) || '',
    loadProfileKey: (profile, _snapshot, key) => { keys.set(profile.id, key); },
    validateKey: key => { if (!key || /[\r\n]/.test(key)) throw new Error('Key 无效。'); },
    hasRememberedKey: async () => false,
    notifyConnection: (id, revoke) => { if (revoke) { keys.delete(id); for (const listener of revoked) listener(id); } },
    onConnectionRevoked: listener => { revoked.add(listener); return () => revoked.delete(listener); },
  };
  const imports = { './api': { API_BASE_URL: 'https://compute.example', safePublicMessage: (message, fallback) => typeof message === 'string' ? message : fallback }, './localStore': store, './keyVault': vault, './providerTypes': { LEGACY_CONNECTION: 'legacy-deepseek' } };
  async function normalize(raw) {
    const snapshot = { ...raw, base_url: raw.base_url.trim().replace(/\/+$/, ''), model: raw.model.trim(), policy: pc.defaultPolicy() };
    snapshot.destination_fingerprint = await pc.hash('endpoint-v1\n' + snapshot.protocol + '\n' + snapshot.base_url);
    snapshot.execution_fingerprint = await pc.hash(JSON.stringify(pc.stable({ destination: snapshot.destination_fingerprint, model: snapshot.model, policy: snapshot.policy, auth_mode: snapshot.auth_mode })));
    return snapshot;
  }
  const identity = payload => Object.fromEntries(['run_id', 'step_id', 'attempt_id', 'input_revision', 'request_fingerprint'].map(key => [key, payload[key]]));
  async function fetchMock(url, options) {
    if (url.endsWith('/capabilities')) return Response.json({ protocol_version: 2, providers: [], supported_protocols: ['chat_completions', 'messages'], image_providers: imageConnections.IMAGE_PRESETS.filter(p => p.id !== 'custom') });
    const payload = JSON.parse(options.body), operation = url.split('/').at(-1); calls.push({ operation, payload });
    if (operation === 'validate_connection') {
      assert.equal(Object.keys(payload.credentials).length, 0);
      const connection = validationHandler ? await validationHandler(payload.connection) : await normalize(payload.connection);
      return Response.json({ ...identity(payload), protocol_version: 2, destination_fingerprint: connection.destination_fingerprint, execution_fingerprint: connection.execution_fingerprint, result: { connection } });
    }
    assert.equal(payload.request_fingerprint, await pc.requestFingerprint(payload.connection, url.includes('/cover/') ? 'cover_' + operation : operation, payload.input));
    if (handler) return handler(payload, operation);
    if (url.includes('/cover/')) return coverReply(payload);
    return Response.json({ ...identity(payload), protocol_version: 2, destination_fingerprint: payload.connection.destination_fingerprint, execution_fingerprint: payload.connection.execution_fingerprint,
      result: operation === 'models' ? { models: [{ id: 'suggested-image', name: '建议模型' }], catalog_supported: false } : { model: payload.connection.model, image: { mime_type: 'image/png', data_base64: PNG, width: 1, height: 1 } } });
  }
  const sandbox = { Error, URL, crypto: webcrypto, TextEncoder, TextDecoder, AbortSignal, AbortController, Response, Blob, atob, btoa, structuredClone, fetch: fetchMock, navigator: { locks: { request: async (_name, task) => task() } } };
  function load(name) {
    const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
    const exports = {};
    runInNewContext(outputText, { ...sandbox, exports, require: name => { assert.ok(name in imports, name); return imports[name]; } });
    return exports;
  }
  const pc = load('providerConnections'); imports['./providerConnections'] = pc;
  imageConnections = load('imageConnections'); imports['./imageConnections'] = imageConnections;
  imports['./coverStorage'] = { inspectCoverBlob: async blob => {
    assert.equal(blob.type, 'image/png');
    assert.equal(Buffer.from(await blob.arrayBuffer()).toString('base64'), PNG);
    return { mime_type: 'image/png', width: 1, height: 1 };
  } };
  const client = load('imageClient');
  async function connection(preset = imageConnections.IMAGE_PRESETS[0], key = 'SYNTHETIC_TEST_KEY') {
    const profile = await imageConnections.saveImageConnection(preset.name, imageConnections.blankImageConnection(preset));
    await pc.storeConnectionKey(profile.id, key); return pc.getConnection(profile.id);
  }
  function reply(payload, result, patch = {}) { return Response.json({ ...identity(payload), protocol_version: 2, destination_fingerprint: payload.connection.destination_fingerprint, execution_fingerprint: payload.connection.execution_fingerprint, result, ...patch }); }
  async function textConnection() { await pc.ensureConnections(); await pc.storeConnectionKey('legacy-deepseek', 'SYNTHETIC_TEXT_KEY'); const profile = await pc.getConnection('legacy-deepseek'); return pc.acquireConnection(profile.revisions[0]); }
  function coverEvents(payload) {
    const base = { ...identity(payload), protocol_version: 2, destination_fingerprint: payload.connection.destination_fingerprint, execution_fingerprint: payload.connection.execution_fingerprint,
      text_destination_fingerprint: payload.input.text_connection.destination_fingerprint, text_execution_fingerprint: payload.input.text_connection.execution_fingerprint, event_version: 1 };
    const events = [{ type: 'started', requested: payload.input.count }, { type: 'text_started' }, { type: 'text_done' }];
    for (let index = 0; index < payload.input.count; index++) events.push({ type: 'image_started', index }, { type: 'image', index, result: { model: payload.connection.model, style_id: payload.input.style_id, template_version: 2, text_model: payload.input.text_connection.model, image: { mime_type: 'image/png', data_base64: PNG, width: 1, height: 1 } } });
    events.push({ type: 'done', requested: payload.input.count, completed: payload.input.count });
    return events.map((value, index) => ({ ...base, seq: index + 1, ...value }));
  }
  function coverReply(payload, mutate = events => events) { return new Response(mutate(coverEvents(payload)).map(event => JSON.stringify(event)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } }); }
  return { pc, ic: imageConnections, client, calls, settings, connection, textConnection, normalize, reply, coverEvents, coverReply, setHandler: value => { handler = value; }, setValidationHandler: value => { validationHandler = value; } };
}

test('图片预设、连接修订和 Key 复用：保存不计费、图片连接不进入文字列表', async () => {
  const f = fixture(), profile = await f.connection(), snapshot = profile.revisions[0];
  assert.equal(snapshot.model, 'doubao-seedream-5-0-flash-260915');
  assert.equal(snapshot.policy.structured, 'unsupported');
  assert.equal((await f.ic.imageConnections()).length, 1);
  assert.ok((await f.pc.connections()).every(p => p.id !== profile.id));
  assert.ok(f.calls.every(c => c.operation === 'validate_connection'));
  await f.ic.setDefaultImageConnection(profile.id);
  assert.equal((await f.ic.resolveImageConnection()).profile_id, profile.id);
  const changed = await f.ic.saveImageConnection('重命名', { ...snapshot, model: 'custom-image-model' });
  assert.equal(changed.head, 2); assert.equal(changed.revisions[0].model, snapshot.model);
  await assert.rejects(f.ic.saveImageConnection('旧修订', snapshot), /另一处修改/);
  await assert.rejects(f.ic.saveImageConnection('不同目的地', { ...changed.revisions[1], base_url: 'https://other.example/v1' }), /复制为新连接/);
});

test('图片模型列表直接返回候选项、支持手填且不用生图探测', async () => {
  const f = fixture(), profile = await f.connection(), lease = await f.ic.acquireImageConnection(profile.revisions[0]);
  try {
    const list = await f.client.requestImage('models', {}, lease);
    assert.equal(list.models[0].id, 'suggested-image'); assert.equal(list.catalog_supported, false);
    assert.equal(f.calls.at(-1).operation, 'models'); assert.equal(f.calls.at(-1).payload.credentials.api_key, 'SYNTHETIC_TEST_KEY');
    assert.equal(profile.revisions[0].model, 'doubao-seedream-5-0-flash-260915');
  } finally { lease.close(); }
});

test('配置校验即使返回有效新指纹，也不能静默替换用户填写的地址', async () => {
  const f = fixture();
  f.setValidationHandler(raw => f.normalize({ ...raw, base_url: 'https://other-destination.example/v1' }));
  await assert.rejects(f.ic.saveImageConnection('合成图片连接', f.ic.blankImageConnection()), /不同的目的地址/);
  assert.equal((await f.ic.imageConnections()).length, 0);
});

const coverInput = (count = 1) => ({ source: { idea: '', characters: '姓名：江舟\n外貌特征：黑色短发，黑色眼睛' }, style_id: 'cinematic', count, size: '2K' });
async function leased(f) { const profile = await f.connection(), image = await f.ic.acquireImageConnection(profile.revisions[0]), text = await f.textConnection(); return { profile, image, text, close: () => { image.close(); text.close(); } }; }

test('受控封面4张逐图等待保存，生成和编辑使用两份冻结连接且不发送生成描述', async () => {
  const f = fixture(), leases = await leased(f), saved = [], phases = [];
  try {
    const input = coverInput(4), result = await f.client.requestCoverImages(input, leases.image, leases.text, { onProgress: (stage, index) => phases.push([stage, index]), onImage: async (image, index) => { await new Promise(resolve => setTimeout(resolve, 2)); assert.equal(saved.length, index); assert.equal(image.image.width, 1); saved.push(index); } });
    assert.equal(result.completed, 4); assert.deepEqual(saved, [0, 1, 2, 3]); assert.deepEqual(phases, [['text', 0], ['image', 0], ['image', 1], ['image', 2], ['image', 3]]);
    const request = f.calls.at(-1).payload; assert.equal(request.credentials.api_key, 'SYNTHETIC_TEST_KEY'); assert.equal(request.credentials.text_api_key, 'SYNTHETIC_TEXT_KEY');
    assert.equal(request.input.text_connection.execution_fingerprint, leases.text.snapshot.execution_fingerprint); assert.ok(!('prompt' in request.input)); assert.equal(JSON.stringify(request).includes('封面底图'), false);
    await f.client.requestCoverImages({ ...coverInput(), image: { mime_type: 'image/png', data_base64: PNG }, edit_kind: 'lighting' }, leases.image, leases.text, { onImage: async () => {} });
    assert.equal(f.calls.at(-1).operation, 'edit'); assert.equal(f.calls.at(-1).payload.input.image.data_base64, PNG);
    const count = f.calls.length;
    for (const bad of [{ ...coverInput(), count: 3 }, { ...coverInput(), prompt: '不允许的描述' }, { ...coverInput(), style_id: 'unknown' }, { ...coverInput(), source: { idea: 'x'.repeat(6001), characters: '' } }, { ...coverInput(), edit_kind: 'lighting' }, { ...coverInput(), edit_kind: 'lighting', image: { mime_type: 'image/png', data_base64: PNG, prompt: '不得转发' } }]) await assert.rejects(f.client.requestCoverImages(bad, leases.image, leases.text, { onImage: async () => {} }));
    await assert.rejects(f.client.requestImage('generate', { prompt: '不再支持' }, leases.image), /旧图片接口/); assert.equal(f.calls.length, count);
  } finally { leases.close(); }
});

test('部分失败保留已应用第一张、不自动重试，截断和重复序号拒绝', async () => {
  const f = fixture(), leases = await leased(f), saved = [];
  try {
    f.setHandler(payload => f.coverReply(payload, events => [...events.slice(0, 5), { ...events[5], type: 'error', index: undefined, completed: 1, requested: 4, code: 'image_failed', status: 502, message: '合成供应商失败' }]));
    const before = f.calls.length; await assert.rejects(f.client.requestCoverImages(coverInput(4), leases.image, leases.text, { onImage: async (_, index) => saved.push(index) }), /合成供应商失败/);
    assert.deepEqual(saved, [0]); assert.equal(f.calls.length, before + 1);
    f.setHandler(payload => f.coverReply(payload, events => events.slice(0, -1)));
    await assert.rejects(f.client.requestCoverImages(coverInput(), leases.image, leases.text, { onImage: async () => {} }), /提前结束/);
    f.setHandler(payload => f.coverReply(payload, events => { events[3].seq = events[2].seq; return events; }));
    await assert.rejects(f.client.requestCoverImages(coverInput(), leases.image, leases.text, { onImage: async () => assert.fail('不应应用错序图片') }), /版本不匹配/);
  } finally { leases.close(); }
});

test('身份、两连接指纹、模型风格、解码尺寸、隐藏字段与单行超限拒绝', async () => {
  const f = fixture(), leases = await leased(f);
  try {
    for (const patch of [{ run_id: 'other-run' }, { request_fingerprint: 'wrong' }, { execution_fingerprint: 'wrong' }, { text_execution_fingerprint: 'wrong' }, { text_destination_fingerprint: 'wrong' }]) {
      f.setHandler(payload => f.coverReply(payload, events => events.map(event => ({ ...event, ...patch }))));
      await assert.rejects(f.client.requestCoverImages(coverInput(), leases.image, leases.text, { onImage: async () => assert.fail('不应应用不匹配结果') }), /版本不匹配/);
    }
    for (const mutate of [result => { result.image.width = 2; }, result => { result.model = 'wrong'; }, result => { result.text_model = 'wrong'; }, result => { result.style_id = 'ink'; }, result => { result.template_version = 1; }, result => { result.prompt = '服务器不应公开'; }]) {
      f.setHandler(payload => f.coverReply(payload, events => { mutate(events[4].result); return events; }));
      await assert.rejects(f.client.requestCoverImages(coverInput(), leases.image, leases.text, { onImage: async () => assert.fail('不应应用异常图片') }), /信息无效/);
    }
    f.setHandler(() => new Response('x'.repeat(12 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/x-ndjson' } }));
    await assert.rejects(f.client.requestCoverImages(coverInput(), leases.image, leases.text, { onImage: async () => {} }), /单行超过/);
    f.setHandler(() => Response.json({ error: { message: '供应商拒绝了请求' } }, { status: 502 }));
    await assert.rejects(f.client.requestCoverImages(coverInput(), leases.image, leases.text, { onImage: async () => {} }), /供应商拒绝/);
  } finally { leases.close(); }
});

test('用户停止、图片Key撤销和文字Key撤销都中断挂起响应并阻止旧图片应用', async () => {
  for (const kind of ['stop', 'image', 'text']) {
    const f = fixture(), leases = await leased(f), controller = new AbortController();
    f.setHandler(() => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/x-ndjson' } }));
    const pending = f.client.requestCoverImages(coverInput(), leases.image, leases.text, { onImage: async () => assert.fail('撤销后不应应用图片') }, controller.signal);
    setTimeout(() => { if (kind === 'stop') controller.abort(new Error('合成停止')); else void f.pc.manageConnection(kind === 'image' ? leases.profile.id : leases.text.snapshot.profile_id, 'lock'); }, 10);
    await assert.rejects(pending, kind === 'stop' ? /合成停止/ : /撤销/); leases.close();
    if (kind === 'image') await assert.rejects(f.ic.acquireImageConnection(leases.image.snapshot), /偏好设置 → 图片模型连接/);
  }
});

test('图片已开始本地保存时先等待保存结束，再报告停止，避免晚到保存回调覆盖失败状态', async () => {
  const f = fixture(), leases = await leased(f), controller = new AbortController();
  let started, release, finished = false, rejected = false;
  const begun = new Promise(resolve => { started = resolve; }), saving = new Promise(resolve => { release = resolve; });
  const pending = f.client.requestCoverImages(coverInput(), leases.image, leases.text, { onImage: async () => { started(); await saving; finished = true; } }, controller.signal).catch(error => { rejected = true; throw error; });
  await begun; controller.abort(new Error('保存时停止'));
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(rejected, false); assert.equal(finished, false);
  release(); await assert.rejects(pending, /保存时停止/); assert.equal(finished, true); leases.close();
});

test('兜底仅保存 Seedream 5.0 Flash 连接引用；无模型调用，可停用', async () => {
  const f = fixture(), seedream = await f.connection(), gemini = await f.connection(f.ic.IMAGE_PRESETS.find(p => p.id === 'gemini'));
  await f.ic.setDefaultImageConnection(gemini.id);
  const before = f.calls.length;
  await f.ic.setFallbackImageConnection(seedream.id);
  assert.equal(await f.ic.fallbackImageConnectionId(), seedream.id);
  assert.equal(await f.ic.defaultImageConnectionId(), gemini.id);
  await assert.rejects(f.ic.setFallbackImageConnection(gemini.id), /Seedream/);
  await f.ic.setFallbackImageConnection(''); assert.equal(await f.ic.fallbackImageConnectionId(), '');
  assert.equal(f.calls.length, before);
});

test('兜底选项展示后另一处保存为4.5时拒绝，不临时覆盖模型绕过当前修订', async () => {
  const f = fixture(), seedream = await f.connection();
  await f.ic.setFallbackImageConnection(seedream.id);
  const old = seedream.revisions.find(r => r.revision === seedream.head);
  const current = await f.ic.saveImageConnection('另处修改', { ...old, model: 'doubao-seedream-4-5-251128' });
  assert.equal(current.revisions.find(r => r.revision === current.head).model, 'doubao-seedream-4-5-251128');
  const before = f.calls.length;
  await assert.rejects(f.ic.resolveFallbackImageConnection(seedream.id), /兜底连接已更改/);
  assert.equal(f.calls.length, before); assert.equal(await f.ic.fallbackImageConnectionId(), seedream.id);
});

test('只按已验证机器码提供确认兜底，内容拒绝、文本失败、已保存图片和未知结果不兜底', async () => {
  const f = fixture();
  for (const [code, status] of [['image_permission_denied', 403], ['image_quota_or_rate_limited', 429], ['image_unavailable', 503]]) {
    const error = new f.client.CoverRequestError('固定错误', code, status, 0, 'image');
    assert.equal(f.client.canOfferSeedreamFallback(error, 'gemini'), true);
    assert.equal(f.client.canOfferSeedreamFallback(error, 'custom'), false);
    assert.equal(f.client.canOfferSeedreamFallback(new f.client.CoverRequestError('固定错误', code, status, 1, 'image'), 'gemini'), false);
    assert.equal(f.client.canOfferSeedreamFallback(new f.client.CoverRequestError('固定错误', code, status, 0, 'text'), 'gemini'), false);
    assert.equal(f.client.canOfferSeedreamFallback(new f.client.CoverRequestError('固定错误', code, 502, 0, 'image'), 'gemini'), false);
  }
  for (const [code, status] of [['image_content_rejected', 422], ['cover_unsuitable', 422], ['compute_timeout', 504], ['image_outcome_unknown', 502], ['image_auth_error', 401], ['invalid_cover_plan', 502], ['cover_missing_appearance', 422]]) assert.equal(f.client.canOfferSeedreamFallback(new f.client.CoverRequestError('固定错误', code, status, 0, 'image'), 'gemini'), false);
  assert.equal(f.client.canOfferSeedreamFallback(new Error('限流或额度不足'), 'gemini'), false);
});

test('流式失败保留code/status/completed/stage；预检错误不能伪装为图片供应商失败', async () => {
  const f = fixture(), leases = await leased(f);
  try {
    f.setHandler(payload => f.coverReply(payload, events => [...events.slice(0, 4), { ...events[4], result: undefined, type: 'error', index: undefined, code: 'image_quota_or_rate_limited', status: 429, message: '固定额度提示', completed: 0, requested: 1 }]));
    const before = f.calls.length;
    await assert.rejects(f.client.requestCoverImages(coverInput(), leases.image, leases.text, { onImage: async () => assert.fail('失败不能保存图片') }), error => error instanceof f.client.CoverRequestError && error.code === 'image_quota_or_rate_limited' && error.status === 429 && error.completed === 0 && error.stage === 'image');
    assert.equal(f.calls.length, before + 1);
    f.setHandler(() => Response.json({ error: { code: 'image_quota_or_rate_limited', message: '固定提示' } }, { status: 429 }));
    await assert.rejects(f.client.requestCoverImages(coverInput(), leases.image, leases.text, { onImage: async () => {} }), error => error.stage === 'preflight' && !f.client.canOfferSeedreamFallback(error, 'gemini'));
  } finally { leases.close(); }
});
