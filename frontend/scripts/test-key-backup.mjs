import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { loadStyleModule, loadActivityModule } from './writing-style-test-helpers.mjs';

// Exercise the real backup serializer and download Blob with a read-only IDB
// adapter. The adapter only delivers getAll events; it cannot filter secrets.
function fixture() {
  const rows = {
    projects: [], cover_media: [], settings: [
      { key: 'connection:text', value: { id: 'text', name: 'Synthetic descriptor', revisions: [{ model: 'synthetic-model' }] } },
      { key: 'vault:text', value: { version: 3, api_key: 'SYNTHETIC_PERSISTED_KEY', destination: 'synthetic', key_version: 'synthetic' } },
      { key: 'vault:image', value: { version: 2, ciphertext: [1, 2, 3], salt: [], iv: [] } },
      { key: 'deepseek-key-vault.v1', value: { version: 1, ciphertext: [4, 5, 6] } },
    ],
  };
  const blobs = [], links = [];
  const db = { transaction(names, mode) {
    assert.equal(mode, 'readonly'); assert.deepEqual([...names].sort(), ['settings']);
    let pending = 0;
    const tx = { abort() { tx.onabort?.(); }, objectStore(name) { return { getAll() {
      const request = {}; pending++;
      queueMicrotask(() => { request.result = structuredClone(rows[name]); request.onsuccess?.({ target: request }); if (--pending === 0) queueMicrotask(() => tx.oncomplete?.()); });
      return request;
    } }; } };
    return tx;
  } };
  const indexedDB = { open(name, version) { assert.equal(name, 'braipen.local.v1'); assert.equal(version, 4); const request = { result: db }; queueMicrotask(() => request.onsuccess?.()); return request; } };
  const source = readFileSync(new URL('../src/localStore.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  runInNewContext(outputText, { exports, indexedDB, structuredClone, queueMicrotask, Blob,
    require: name => { if (name === './workspaceActivity') return loadActivityModule(); if (name === './writingStyle') return loadStyleModule(); assert.equal(name, './planningTrace'); return {}; },
    URL: { createObjectURL: blob => { blobs.push(blob); return 'blob:synthetic-backup'; }, revokeObjectURL() {} },
    document: { body: { appendChild() {} }, createElement: () => { const link = { click() { links.push({ name: link.download, href: link.href }); }, remove() {} }; return link; } },
    setTimeout: callback => { callback(); },
  });
  return { store: exports, blobs, links };
}

test('真实完整备份序列化使用 v5，排除明文记住与两类旧密文记录', async () => {
  const f = fixture(), backup = await f.store.createBackup(), json = JSON.stringify(backup);
  assert.equal(backup.format, 'braipen-backup'); assert.equal(backup.version, 5);
  assert.equal(backup.connections.length, 1); assert.equal(backup.connections[0].id, 'text');
  for (const secret of ['SYNTHETIC_PERSISTED_KEY', 'api_key', 'ciphertext', 'vault:', 'deepseek-key-vault']) assert.equal(json.includes(secret), false, secret);
});

test('真实导出函数生成的 JSON Blob 同样不含凭据，并保留统一文件格式', async () => {
  const f = fixture(); await f.store.exportBackup();
  assert.equal(f.blobs.length, 1); assert.equal(f.blobs[0].type, 'application/json');
  assert.match(f.links[0].name, /^braipen-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const text = await f.blobs[0].text(), backup = JSON.parse(text);
  assert.equal(backup.format, 'braipen-backup'); assert.equal(backup.version, 5);
  assert.equal(text.includes('SYNTHETIC_PERSISTED_KEY'), false); assert.equal(text.includes('ciphertext'), false);
});
