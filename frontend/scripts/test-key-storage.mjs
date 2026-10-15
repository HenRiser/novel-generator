import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function fixture() {
  const settings = new Map(), channels = new Set(), locks = new Map();
  let failCommit = false;
  const store = {
    getSetting: async name => structuredClone(settings.get(name)),
    setSetting: async (name, value) => { settings.set(name, structuredClone(value)); },
    listSettings: async prefix => [...settings].filter(([name]) => name.startsWith(prefix)).map(([, value]) => structuredClone(value)),
    commitSettings: async updates => {
      if (failCommit) { failCommit = false; throw new Error('SYNTHETIC_STORAGE_FAILURE'); }
      const next = new Map(settings);
      for (const item of updates) item.remove ? next.delete(item.key) : next.set(item.key, structuredClone(item.value));
      settings.clear(); for (const [name, value] of next) settings.set(name, value);
    },
    assertConnectionGuard: async guard => {
      const current = settings.get('connection:' + guard.profile_id);
      if (!current || current.deleted || !current.enabled || current.epoch !== guard.epoch || current.key_version !== guard.key_version) throw new Error('连接已撤销。');
    },
  };
  class Channel {
    listener;
    constructor() { channels.add(this); }
    addEventListener(_event, listener) { this.listener = listener; }
    postMessage(data) { for (const other of channels) if (other !== this) other.listener?.({ data: structuredClone(data) }); }
  }
  function client() {
    const imports = { './localStore': store, './api': { API_BASE_URL: 'https://compute.example', safePublicMessage: (_value, fallback) => fallback }, './providerTypes': { LEGACY_CONNECTION: 'legacy-deepseek' } };
    const window = new EventTarget();
    const sandbox = { crypto: webcrypto, TextEncoder, TextDecoder, Event, window, BroadcastChannel: Channel, AbortSignal, AbortController, structuredClone,
      navigator: { locks: { request: (name, task) => { const result = (locks.get(name) || Promise.resolve()).catch(() => {}).then(task); locks.set(name, result); return result; } } },
      fetch: async () => { throw new Error('Unexpected network access'); } };
    function load(name) {
      const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
      const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
      const exports = {};
      runInNewContext(outputText, { ...sandbox, exports, require: dependency => { assert.ok(dependency in imports, dependency); return imports[dependency]; } });
      return exports;
    }
    const vault = load('keyVault'); imports['./keyVault'] = vault;
    const pc = load('providerConnections'); imports['./providerConnections'] = pc;
    const images = load('imageConnections');
    return { pc, vault, images };
  }
  async function profile(id = 'text-a', protocol = 'chat_completions', base_url = 'https://a.example/v1') {
    const a = client(), destination = await a.pc.hash('endpoint-v1\n' + protocol + '\n' + base_url);
    const snapshot = { profile_id: id, revision: 1, preset: 'custom', protocol, base_url, model: 'synthetic-model', policy: a.pc.defaultPolicy(), auth_mode: 'key', destination_fingerprint: destination, execution_fingerprint: 'synthetic-execution' };
    const value = { id, name: id, enabled: true, deleted: false, epoch: 0, key_version: webcrypto.randomUUID(), head: 1, revisions: [snapshot] };
    settings.set('connection:' + id, structuredClone(value)); return value;
  }
  async function encrypted(profile, version = 2, password = 'SYNTHETIC_OLD_PASSWORD') {
    const snapshot = profile.revisions[0], salt = webcrypto.getRandomValues(new Uint8Array(16)), iv = webcrypto.getRandomValues(new Uint8Array(12));
    const material = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const additionalData = new TextEncoder().encode(profile.id + '\n' + snapshot.protocol + '\n' + snapshot.base_url);
    const cipher = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, ...(version === 2 ? { additionalData } : {}) }, key, new TextEncoder().encode('SYNTHETIC_LEGACY_KEY'));
    const value = { version, iterations: 600000, salt: [...salt], iv: [...iv], ciphertext: [...new Uint8Array(cipher)], ...(version === 2 ? { destination: snapshot.destination_fingerprint } : {}) };
    settings.set(version === 1 ? 'deepseek-key-vault.v1' : 'vault:' + profile.id, value); return structuredClone(value);
  }
  return { settings, client, profile, encrypted, failNextCommit: () => { failCommit = true; } };
}

test('未主动勾选时仅会话使用；新页面没有 Key 且错误不包含原文', async () => {
  const f = fixture(), p = await f.profile(), a = f.client();
  await a.pc.storeConnectionKey(p.id, 'SYNTHETIC_SESSION_KEY');
  assert.equal(f.settings.has('vault:' + p.id), false);
  const lease = await a.pc.acquireConnection(p.revisions[0]); assert.equal(lease.apiKey, 'SYNTHETIC_SESSION_KEY'); lease.close();
  await assert.rejects(f.client().pc.acquireConnection(p.revisions[0]), error => error.message.includes('勾选') && !error.message.includes('SYNTHETIC_SESSION_KEY'));
});

test('显式记住后文字和图片在新页面自动可用，列表与任务入口都能恢复', async () => {
  const f = fixture(), text = await f.profile(), image = await f.profile('image-a', 'openai_images'), a = f.client();
  for (const p of [text, image]) await a.pc.storeConnectionKey(p.id, 'SYNTHETIC_' + p.id, true);
  const b = f.client();
  assert.equal((await b.pc.connections()).length, 2); // Includes the legacy default text descriptor.
  assert.equal((await b.images.imageConnections()).length, 1);
  for (const p of [text, image]) {
    const current = await b.pc.getConnection(p.id);
    assert.equal(await b.vault.keyStorageMode(current, p.revisions[0]), 'remembered');
    const lease = await b.pc.acquireConnection(p.revisions[0]); assert.equal(lease.apiKey, 'SYNTHETIC_' + p.id); lease.close();
    assert.equal(await b.pc.connectionConfigured(p.id), true);
  }
});

test('取消记住并保存会删除本地副本，当前会话仍可用，旧授权失效', async () => {
  const f = fixture(), p = await f.profile(), a = f.client();
  await a.pc.storeConnectionKey(p.id, 'SYNTHETIC_KEY', true);
  const old = await a.pc.acquireConnection(p.revisions[0]);
  await a.pc.storeConnectionKey(p.id, 'SYNTHETIC_KEY', false);
  assert.equal(f.settings.has('vault:' + p.id), false); assert.equal(old.signal.aborted, true); await assert.rejects(old.check()); old.close();
  const lease = await a.pc.acquireConnection(p.revisions[0]); assert.equal(lease.apiKey, 'SYNTHETIC_KEY'); lease.close();
  await assert.rejects(f.client().pc.acquireConnection(p.revisions[0]), /没有可用/);
});

test('相同 Key 和保存方式不重新撤销现有授权', async () => {
  const f = fixture(), p = await f.profile(), a = f.client();
  await a.pc.storeConnectionKey(p.id, 'SYNTHETIC_KEY', true);
  const lease = await a.pc.acquireConnection(p.revisions[0]);
  await a.pc.storeConnectionKey(p.id, 'SYNTHETIC_KEY', true);
  assert.equal(lease.signal.aborted, false); await lease.check(); lease.close();
});

test('明文记录仍绑定目的地和 Key 版本，损坏记录不会作为凭据使用', async () => {
  for (const patch of [{ destination: 'wrong' }, { key_version: 'wrong' }, { api_key: 'BAD\nKEY' }, { api_key: 8 }, { version: 99 }]) {
    const f = fixture(), p = await f.profile(), a = f.client();
    await a.pc.storeConnectionKey(p.id, 'SYNTHETIC_KEY', true);
    Object.assign(f.settings.get('vault:' + p.id), patch);
    await assert.rejects(f.client().pc.acquireConnection(p.revisions[0]), /记录已损坏或与当前连接不匹配/);
  }
});

test('清除与删除跨页面撤销活动授权，新页面不能重新自动读取', async () => {
  for (const action of ['forget', 'delete']) {
    const f = fixture(), p = await f.profile(), a = f.client(), b = f.client();
    await a.pc.storeConnectionKey(p.id, 'SYNTHETIC_KEY', true);
    const lease = await b.pc.acquireConnection(p.revisions[0]);
    await a.pc.manageConnection(p.id, action);
    assert.equal(lease.signal.aborted, true); await assert.rejects(lease.check()); lease.close();
    assert.equal(f.settings.has('vault:' + p.id), false);
    await assert.rejects(f.client().pc.acquireConnection(p.revisions[0]));
  }
});

test('替换 Key 后其他页面的旧任务被撤销，新请求只使用新 Key', async () => {
  const f = fixture(), p = await f.profile(), a = f.client(), b = f.client();
  await a.pc.storeConnectionKey(p.id, 'SYNTHETIC_OLD_KEY', true);
  const old = await b.pc.acquireConnection(p.revisions[0]);
  await a.pc.storeConnectionKey(p.id, 'SYNTHETIC_NEW_KEY', true);
  assert.equal(old.signal.aborted, true); await assert.rejects(old.check()); old.close();
  const next = await b.pc.acquireConnection(p.revisions[0]); assert.equal(next.apiKey, 'SYNTHETIC_NEW_KEY'); next.close();
});

test('禁用阻止自动使用；重新启用可继续使用已记住 Key，旧授权仍失效', async () => {
  const f = fixture(), p = await f.profile(), a = f.client();
  await a.pc.storeConnectionKey(p.id, 'SYNTHETIC_KEY', true);
  const old = await a.pc.acquireConnection(p.revisions[0]);
  await a.pc.manageConnection(p.id, 'disable');
  assert.equal(f.settings.get('vault:' + p.id).version, 3); await assert.rejects(f.client().pc.acquireConnection(p.revisions[0]), /原连接修订不可用/);
  await a.pc.manageConnection(p.id, 'enable'); await assert.rejects(old.check()); old.close();
  const next = await f.client().pc.acquireConnection(p.revisions[0]); assert.equal(next.apiKey, 'SYNTHETIC_KEY'); next.close();
});

test('旧版程序化锁定不会被明文自动读取绕过', async () => {
  const f = fixture(), p = await f.profile(), a = f.client();
  await a.pc.storeConnectionKey(p.id, 'SYNTHETIC_KEY', true); await a.pc.manageConnection(p.id, 'lock');
  await assert.rejects(a.pc.acquireConnection(p.revisions[0]), /没有可用/);
});

test('旧 v2 密文仅显式迁移；口令错误或事务失败保留原记录且不加载 Key', async () => {
  const f = fixture(), p = await f.profile(), before = await f.encrypted(p), a = f.client();
  await assert.rejects(a.pc.acquireConnection(p.revisions[0]), /旧版加密 Key/);
  await assert.rejects(a.pc.migrateEncryptedConnectionKey(p.id, 'wrong'), /旧口令错误/);
  assert.deepEqual(f.settings.get('vault:' + p.id), before);
  f.failNextCommit(); await assert.rejects(a.pc.migrateEncryptedConnectionKey(p.id, 'SYNTHETIC_OLD_PASSWORD'), /STORAGE_FAILURE/);
  assert.deepEqual(f.settings.get('vault:' + p.id), before); assert.equal(a.vault.profileKey(p, p.revisions[0]), '');
  await a.pc.migrateEncryptedConnectionKey(p.id, 'SYNTHETIC_OLD_PASSWORD');
  assert.equal(f.settings.get('vault:' + p.id).version, 3); assert.equal(f.settings.get('vault:' + p.id).ciphertext, undefined);
  const next = await f.client().pc.acquireConnection(p.revisions[0]); assert.equal(next.apiKey, 'SYNTHETIC_LEGACY_KEY'); next.close();
});

test('旧全局 v1 仅限原官方连接，成功提交后才移除旧密文', async () => {
  const f = fixture(), legacy = await f.profile('legacy-deepseek', 'chat_completions', 'https://api.deepseek.com'), custom = await f.profile(), a = f.client();
  const before = await f.encrypted(legacy, 1);
  await assert.rejects(a.pc.migrateEncryptedConnectionKey(custom.id, 'SYNTHETIC_OLD_PASSWORD'), /没有可迁移/);
  f.failNextCommit(); await assert.rejects(a.pc.migrateEncryptedConnectionKey(legacy.id, 'SYNTHETIC_OLD_PASSWORD'), /STORAGE_FAILURE/);
  assert.deepEqual(f.settings.get('deepseek-key-vault.v1'), before);
  assert.equal(a.vault.getSessionKey(), '');
  await a.pc.migrateEncryptedConnectionKey(legacy.id, 'SYNTHETIC_OLD_PASSWORD');
  assert.equal(f.settings.has('deepseek-key-vault.v1'), false); assert.equal(f.settings.get('vault:' + legacy.id).version, 3);
});

test('写入新 Key 失败时不覆盖原 Key 或提前撤销已有任务', async () => {
  const f = fixture(), p = await f.profile(), a = f.client();
  await a.pc.storeConnectionKey(p.id, 'SYNTHETIC_OLD_KEY', true);
  const lease = await a.pc.acquireConnection(p.revisions[0]), before = structuredClone(f.settings.get('vault:' + p.id));
  f.failNextCommit(); await assert.rejects(a.pc.storeConnectionKey(p.id, 'SYNTHETIC_NEW_KEY', true), /STORAGE_FAILURE/);
  assert.deepEqual(f.settings.get('vault:' + p.id), before); assert.equal(lease.signal.aborted, false); await lease.check(); lease.close();
});

test('旧字符串参数不能被误当作明文记住授权', async () => {
  const f = fixture(), p = await f.profile(), a = f.client();
  await assert.rejects(a.pc.storeConnectionKey(p.id, 'SYNTHETIC_KEY', 'old-password'), /请选择是否/);
  assert.equal(f.settings.has('vault:' + p.id), false);
});
