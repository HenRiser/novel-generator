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
    assert.equal(payload.request_fingerprint, await pc.requestFingerprint(payload.connection, operation, payload.input));
    if (handler) return handler(payload, operation);
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
  return { pc, ic: imageConnections, client, calls, settings, connection, normalize, reply, setHandler: value => { handler = value; }, setValidationHandler: value => { validationHandler = value; } };
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

test('生成与编辑使用冻结连接，图片数据解码后核对真实尺寸', async () => {
  const f = fixture(), profile = await f.connection(), lease = await f.ic.acquireImageConnection(profile.revisions[0]);
  try {
    const image = await f.client.requestImage('generate', { prompt: '合成测试图片', size: '2K' }, lease);
    assert.equal(image.image.width, 1); assert.equal(image.image.data_base64, PNG);
    await f.client.requestImage('edit', { prompt: '修改合成测试图片', size: '2K', image: { mime_type: 'image/png', data_base64: PNG } }, lease);
    assert.equal(f.calls.at(-1).operation, 'edit');
    const count = f.calls.length;
    await assert.rejects(f.client.requestImage('edit', { prompt: '缺少原图', size: '2K' }, lease), /需要原图/);
    await assert.rejects(f.client.requestImage('generate', { prompt: '错误携带原图', size: '2K', image: { mime_type: 'image/png', data_base64: PNG } }, lease), /不应携带原图/);
    await assert.rejects(f.client.requestImage('generate', { prompt: 'x'.repeat(6001), size: '2K' }, lease), /6000/);
    assert.equal(f.calls.length, count);
  } finally { lease.close(); }
});

test('身份、指纹、图像尺寸与响应大小异常都拒绝，收费请求不自动重试', async () => {
  const f = fixture(), profile = await f.connection(), lease = await f.ic.acquireImageConnection(profile.revisions[0]);
  const result = { model: profile.revisions[0].model, image: { mime_type: 'image/png', data_base64: PNG, width: 1, height: 1 } };
  try {
    for (const patch of [{ run_id: 'other-run' }, { request_fingerprint: 'wrong' }, { execution_fingerprint: 'wrong' }]) {
      f.setHandler(payload => f.reply(payload, result, patch));
      const count = f.calls.length;
      await assert.rejects(f.client.requestImage('generate', { prompt: '合成输入', size: '2K' }, lease), /版本不匹配/);
      assert.equal(f.calls.length, count + 1);
    }
    f.setHandler(payload => f.reply(payload, { ...result, image: { ...result.image, width: 2 } }));
    await assert.rejects(f.client.requestImage('generate', { prompt: '合成输入', size: '2K' }, lease), /尺寸或模型/);
    f.setHandler(() => new Response('{}', { headers: { 'content-length': String(13 * 1024 * 1024) } }));
    await assert.rejects(f.client.requestImage('generate', { prompt: '合成输入', size: '2K' }, lease), /超过大小限制/);
    f.setHandler(() => Response.json({ error: { message: '供应商拒绝了请求' } }, { status: 502 }));
    const count = f.calls.length;
    await assert.rejects(f.client.requestImage('generate', { prompt: '合成输入', size: '2K' }, lease), /供应商拒绝/);
    assert.equal(f.calls.length, count + 1);
  } finally { lease.close(); }
});

test('取消挂起响应及撤销凭据阻止旧结果应用；错误指向图片设置', async () => {
  const f = fixture(), profile = await f.connection(), snapshot = profile.revisions[0], lease = await f.ic.acquireImageConnection(snapshot), controller = new AbortController();
  f.setHandler(() => new Response(new ReadableStream({ start() {} })));
  const pending = f.client.requestImage('generate', { prompt: '挂起合成响应', size: '2K' }, lease, controller.signal);
  setTimeout(() => controller.abort(new Error('合成取消')), 10);
  await assert.rejects(pending, /合成取消/); lease.close();
  const next = await f.ic.acquireImageConnection(snapshot);
  await f.pc.manageConnection(profile.id, 'lock');
  await assert.rejects(f.client.requestImage('generate', { prompt: '撤销后请求', size: '2K' }, next), /撤销/); next.close();
  await assert.rejects(f.ic.acquireImageConnection(snapshot), /偏好设置 → 图片模型连接/);
});
