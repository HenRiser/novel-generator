// Offline checks with a simulated directory. No personal folders, credentials, network, or paid APIs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { memoryStyleStore } from './writing-style-test-helpers.mjs';

const source = readFileSync(new URL('../src/localFolderSync.ts', import.meta.url), 'utf8');
const { outputText, diagnostics } = ts.transpileModule(source, { reportDiagnostics: true,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
assert.equal(diagnostics.length, 0);
const bindingKey = 'local-folder-sync.v1';
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
function lockManager() {
  const tails = new Map();
  return { request(name, _options, callback) {
    const operation = (tails.get(name) || Promise.resolve()).then(callback);
    tails.set(name, operation.catch(() => undefined)); return operation;
  } };
}
function directory(initial, name = '模拟文件夹') {
  const files = new Map(initial === undefined ? [] : [['braipen-workspace.json', initial]]);
  let modified = 1;
  const entries = new Map(initial === undefined ? [] : [['braipen-workspace.json', { id: Symbol(), modified }]]);
  const state = { permission: 'granted', requested: 0, writes: 0, closes: 0, aborts: 0, active: 0, maxActive: 0,
    failure: '', gate: undefined, options: undefined, beforeFailure: undefined };
  const handle = { kind: 'directory', name,
    async queryPermission() { return state.permission; },
    async requestPermission() { state.requested++; return state.permission; },
    async removeEntry(fileName) { files.delete(fileName); entries.delete(fileName); },
    async getFileHandle(fileName, options) {
      if (!files.has(fileName)) {
        if (!options?.create) throw new DOMException('Missing', 'NotFoundError');
        files.set(fileName, '');
        entries.set(fileName, { id: Symbol(), modified: ++modified });
      }
      const entry = entries.get(fileName);
      return {
        entryId: entry.id,
        async isSameEntry(other) { return other.entryId === entry.id; },
        async getFile() { const blob = new Blob([files.get(fileName)]); Object.defineProperty(blob, 'lastModified', { value: entry.modified }); return blob; },
        async createWritable(options) {
          state.options = options; state.active++; state.maxActive = Math.max(state.maxActive, state.active);
          let staging, ended = false;
          const end = () => { if (!ended) { state.active--; ended = true; } };
          return {
            async write(blob) { state.writes++; staging = await blob.text(); await state.gate?.promise;
              if (state.failure) await state.beforeFailure?.();
              if (state.failure === 'write') throw new Error('simulated write failure');
              if (state.failure === 'abort') throw new DOMException('simulated interrupted write', 'AbortError');
              if (state.failure === 'quota') throw new DOMException('Full', 'QuotaExceededError'); },
            async close() { state.closes++; if (state.failure === 'close') throw new Error('simulated close failure'); files.set(fileName, staging); entry.modified = ++modified; end(); },
            async abort() { state.aborts++; end(); },
          };
        },
      };
    },
  };
  return { handle, state, files, text: () => files.get('braipen-workspace.json'), replace(text) {
    files.set('braipen-workspace.json', text); entries.set('braipen-workspace.json', { id: Symbol(), modified: ++modified });
  } };
}

function load({ folder = directory(), f = memoryStyleStore(), locks = lockManager(), support = true } = {}) {
  const exports = {}, listeners = new Map(), timers = new Map(); let selected = folder, cancelled = false;
  const window = { addEventListener: (name, listener) => listeners.set(name, listener), showDirectoryPicker: support ? async () => {
    if (cancelled) throw new DOMException('cancelled', 'AbortError'); return selected.handle;
  } : undefined };
  runInNewContext(outputText, { exports, require: () => f.store, window, navigator: { locks: support ? locks : undefined },
    Blob, DOMException, Error, crypto: webcrypto, JSON, Date,
    setTimeout: fn => { const id = Symbol(); timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
  });
  return { ...f, folder, api: exports, pick: value => { selected = value; }, cancel: value => { cancelled = value; } };
}

test('文件是创作主存储，v5写入关闭并回读后才成功，不保存目录句柄到浏览器', async () => {
  const f = load(), p = f.types.emptyProject('本机作品'); await f.store.putProject(p);
  await f.api.chooseLocalFolder();
  const saved = JSON.parse(f.folder.text()); assert.equal(saved.version, 5); assert.equal(saved.projects[0].project_ref, p.project_ref);
  assert.equal(f.api.getLocalFolderSyncState().status, 'synced'); assert.equal(f.folder.state.closes, 1);
  assert.equal(f.rows.settings.has(bindingKey), false); assert.equal(f.rows.projects.size, 0);
  await f.store.updateProject(p.project_ref, value => { value.title = '新版'; });
  assert.equal(JSON.parse(f.folder.text()).projects[0].title, '新版');
});
test('打开已有工作区保留身份且不自动重写，取消选择保持原目录', async () => {
  const original = load(), p = original.types.emptyProject('原有'); await original.store.putProject(p); await original.api.chooseLocalFolder();
  const folder = directory(original.folder.text()), fresh = load({ folder });
  await fresh.api.chooseLocalFolder(); assert.equal((await fresh.store.getProject(p.project_ref)).title, '原有');
  assert.equal(folder.state.writes, 0); fresh.cancel(true); assert.equal(await fresh.api.chooseLocalFolder(), false);
  assert.equal(fresh.api.getLocalFolderSyncState().folderName, folder.handle.name);
});
test('未知同名文件和外部修改不覆盖；失败时内存项目也不提交', async () => {
  const bad = load({ folder: directory('unknown') }); await assert.rejects(bad.api.chooseLocalFolder()); assert.equal(bad.folder.text(), 'unknown');
  const f = load(), p = f.types.emptyProject('原作'); await f.store.putProject(p); await f.api.chooseLocalFolder();
  f.folder.replace('external');
  await assert.rejects(f.store.updateProject(p.project_ref, value => { value.title = '不可覆盖'; }));
  assert.equal(f.folder.text(), 'external'); assert.equal((await f.store.getProject(p.project_ref)).title, '原作');
  assert.equal(f.api.getLocalFolderSyncState().status, 'error');
});
test('write、close及配额失败保留旧文件，修复后可重试', async () => {
  for (const failure of ['write','close','quota']) {
    const f = load(), p = f.types.emptyProject('旧稿'); await f.store.putProject(p); await f.api.chooseLocalFolder();
    const before = f.folder.text(); f.folder.state.failure = failure;
    await assert.rejects(f.store.updateProject(p.project_ref, value => { value.title = '新稿'; }));
    assert.equal(f.folder.text(), before); assert.equal((await f.store.getProject(p.project_ref)).title, '旧稿');
    assert.equal(f.folder.state.aborts, 1); f.folder.state.failure = '';
    await f.store.updateProject(p.project_ref, value => { value.title = '新稿'; });
    assert.equal(JSON.parse(f.folder.text()).projects[0].title, '新稿');
  }
});
test('首次写入失败保留可重试绑定，不删除任何用户文件', async () => {
  const f = load(); f.folder.state.failure = 'write';
  await assert.rejects(f.api.chooseLocalFolder()); assert.equal(f.folder.text(), '');
  assert.equal(f.api.getLocalFolderSyncState().folderName, f.folder.handle.name);
  f.folder.state.failure = ''; await f.api.syncLocalFolderNow(); assert.equal(JSON.parse(f.folder.text()).version, 5);
});
test('无目录API或安全锁时仅支持文件打开下载，不尝试申请权限', async () => {
  const f = load({ support: false }); await assert.rejects(f.api.chooseLocalFolder(), /不能直接/);
  assert.equal(f.api.getLocalFolderSyncState().status, 'unsupported'); assert.equal(f.folder.state.requested, 0);
});
test('旧资料迁移写盘失败时不清理，校验成功后显式清理保留Key', async () => {
  const f = load(), p = f.types.emptyProject('旧作品'); f.rows.projects.set(p.project_ref, p);
  f.rows.settings.set('vault:a', { key: 'vault:a', value: { secret: 'SYNTHETIC_ONLY' } });
  await f.api.chooseLocalFolder(); f.folder.state.failure = 'close';
  await assert.rejects(f.api.migrateLegacyWorkspace()); assert.equal(f.rows.projects.size, 1);
  await assert.rejects(f.api.clearMigratedLegacyWorkspace(), /先完成/);
  f.folder.state.failure = ''; await f.api.migrateLegacyWorkspace();
  assert.equal(JSON.parse(f.folder.text()).projects[0].project_ref, p.project_ref);
  assert.equal(f.rows.projects.size, 1); assert.equal(f.api.getLocalFolderSyncState().migrated, true);
  await f.api.clearMigratedLegacyWorkspace(); assert.equal(f.rows.projects.size, 0); assert.equal(f.rows.settings.has('vault:a'), true);
});
test('写入需要权限时不自动弹窗，重新授权仅由显式按钮触发', async () => {
  const f = load(); await f.api.chooseLocalFolder(); f.folder.state.permission = 'prompt';
  await assert.rejects(f.api.syncLocalFolderNow()); assert.equal(f.folder.state.requested, 0);
  assert.equal(f.api.getLocalFolderSyncState().status, 'permission-required');
  f.folder.state.permission = 'granted'; await f.api.reauthorizeLocalFolder(); assert.equal(f.folder.state.requested, 1);
});
test('两个页面共用文件时锁和原内容检查阻止旧页面覆盖新文件', async () => {
  const folder = directory(), locks = lockManager(), first = load({ folder, locks });
  const p = first.types.emptyProject('初稿'); await first.store.putProject(p); await first.api.chooseLocalFolder();
  const second = load({ folder, locks }); await second.api.chooseLocalFolder();
  folder.state.gate = deferred();
  const a = first.store.updateProject(p.project_ref, value => { value.title = '页面A'; }); await settle();
  const b = second.store.updateProject(p.project_ref, value => { value.title = '页面B'; }); await settle();
  folder.state.gate.resolve(); const result = await Promise.allSettled([a,b]);
  assert.equal(result[0].status, 'fulfilled'); assert.equal(result[1].status, 'rejected');
  assert.equal(JSON.parse(folder.text()).projects[0].title, '页面A'); assert.equal(folder.state.maxActive, 1);
});
