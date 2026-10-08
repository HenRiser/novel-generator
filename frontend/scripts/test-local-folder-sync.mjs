// Offline checks with a simulated directory. No personal folders, credentials, network, or paid APIs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/localFolderSync.ts', import.meta.url), 'utf8');
const { outputText, diagnostics } = ts.transpileModule(source, { reportDiagnostics: true,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
assert.equal(diagnostics.length, 0);
const bindingKey = 'local-folder-sync.v1';
const snapshot = (count = 1) => ({ format: 'braipen-backup', version: 3, created_at: '2026-10-08T00:00:00Z',
  projects: Array.from({ length: count }, (_, i) => ({ project_ref: `book:bk_${i}`, runs: [], batch: { status: 'idle' } })),
  connections: [{ id: 'text', name: '文字连接', revisions: [{ base_url: 'https://example.invalid/v1', model: 'test-model' }] }],
  cover_media: [{ id: 'mock-media', base64: 'bW9jay1pbWFnZS1ieXRlcw==' }] });
const previous = (workspace = 'workspace-1', count = 1) => JSON.stringify({ ...snapshot(count), folder_sync: { version: 1, workspace_id: workspace } });
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
function lockManager() {
  const tails = new Map();
  return { request(name, _options, callback) {
    const operation = (tails.get(name) || Promise.resolve()).then(callback);
    tails.set(name, operation.catch(() => undefined)); return operation;
  } };
}
function broadcastHub() {
  const members = [], messages = [];
  class Channel {
    constructor(name) { this.name = name; this.listeners = []; members.push(this); }
    addEventListener(_event, listener) { this.listeners.push(listener); }
    postMessage(data) { messages.push(structuredClone(data)); for (const other of members) if (other !== this && other.name === this.name) {
      for (const listener of other.listeners) Promise.resolve().then(() => listener({ data: structuredClone(data) }));
    } }
  }
  return { Channel, messages };
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

function load({ backup = snapshot(), saved, browser = false, maxBytes = 200 * 1024 * 1024,
  settings: sharedSettings, locks = lockManager(), broadcast, captureGate } = {}) {
  const exports = {}, settings = sharedSettings || new Map(saved ? [[bindingKey, saved]] : []), reads = [], timers = new Map();
  const counters = { backups: 0 }, time = { now: 1000 };
  let nextTimer = 0;
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [time.now])); } static now() { return time.now; } }
  const window = browser ? new EventTarget() : undefined;
  if (window) window.showDirectoryPicker = async () => { throw new DOMException('Canceled', 'AbortError'); };
  const store = {
    MAX_BACKUP_FILE_BYTES: maxBytes,
    async createBackup() { counters.backups++; const captured = structuredClone(backup); await captureGate?.promise; return captured; },
    async listProjects() { return structuredClone(backup.projects); },
    async getSetting(key) { reads.push(key); return settings.get(key); },
    async setSetting(key, value) { settings.set(key, value); },
  };
  runInNewContext(outputText, { exports, require: key => { assert.equal(key, './localStore'); return store; },
    Blob, DOMException, crypto: webcrypto, Date: ClockDate, navigator: { locks }, ...(window ? { window } : {}),
    ...(broadcast ? { BroadcastChannel: broadcast.Channel } : {}),
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, due: time.now + delay }); return id; },
    clearTimeout: id => timers.delete(id) });
  async function advance(ms) {
    time.now += ms;
    for (const [id, timer] of [...timers]) if (timer.due <= time.now) { timers.delete(id); timer.callback(); }
    await settle();
  }
  return { sync: exports, settings, reads, backup, counters, window, advance, timers };
}

test('v3 快照保留项目、原图与连接，环境设置只读白名单，密钥保险库与handle不进入文件', async () => {
  const app = load(), folder = directory();
  app.settings.set('default_connection', 'text'); app.settings.set('default_image_connection', 'image'); app.settings.set('default_model', 'custom-model');
  app.settings.set('vault:text', { ciphertext: [1], api_key: 'OFFLINE_KEY_SENTINEL' });
  app.settings.set('unknown-config', 'OFFLINE_UNKNOWN_SENTINEL');
  await app.sync.writeFolderSnapshot(folder.handle, 'workspace-1');
  const result = JSON.parse(folder.text());
  assert.deepEqual(result.projects, app.backup.projects); assert.deepEqual(result.cover_media, app.backup.cover_media);
  assert.deepEqual(result.connections, app.backup.connections);
  assert.deepEqual(result.environment, { version: 1, default_connection: 'text', default_image_connection: 'image', default_model: 'custom-model' });
  assert.equal(result.folder_sync.workspace_id, 'workspace-1');
  assert.equal(folder.text().includes('OFFLINE_'), false); assert.equal(folder.text().includes('handle'), false);
  assert.deepEqual(app.reads.sort(), ['default_connection', 'default_image_connection', 'default_model'].sort());
  assert.equal(folder.state.closes, 1); assert.deepEqual(JSON.parse(JSON.stringify(folder.state.options)), { keepExistingData: false, mode: 'exclusive' });
});

test('不同工作空间、未知同名文件、空工作空间覆盖非空快照均拒绝且原字节不变', async () => {
  for (const old of [previous('another-workspace'), 'not json', JSON.stringify(snapshot())]) {
    const app = load(), folder = directory(old);
    await assert.rejects(app.sync.writeFolderSnapshot(folder.handle, 'workspace-1'), /拒绝覆盖/);
    assert.equal(folder.text(), old); assert.equal(folder.state.writes, 0);
  }
  const app = load({ backup: snapshot(0) }), old = previous(), folder = directory(old);
  await assert.rejects(app.sync.writeFolderSnapshot(folder.handle, 'workspace-1'), /没有项目/);
  assert.equal(folder.text(), old); assert.equal(folder.state.writes, 0);
});

test('write、close或配额失败会abort且保留旧文件，超限在触碰文件前拒绝', async () => {
  for (const failure of ['write', 'close', 'quota']) {
    const app = load(), old = previous(), folder = directory(old); folder.state.failure = failure;
    await assert.rejects(app.sync.writeFolderSnapshot(folder.handle, 'workspace-1'));
    assert.equal(folder.text(), old); assert.equal(folder.state.aborts, 1); assert.equal(folder.state.active, 0);
  }
  const app = load({ maxBytes: 5 }), folder = directory();
  await assert.rejects(app.sync.writeFolderSnapshot(folder.handle, 'workspace-1'), /200 MiB/);
  assert.equal(folder.files.size, 0); assert.equal(folder.state.writes, 0);
});

test('首次写失败清除自身空占位，修复错误后可重试；不会删除已有空同名文件', async () => {
  const app = load(), folder = directory(); folder.state.failure = 'write';
  await assert.rejects(app.sync.writeFolderSnapshot(folder.handle, 'workspace-1'));
  assert.equal(folder.files.size, 0); folder.state.failure = '';
  await app.sync.writeFolderSnapshot(folder.handle, 'workspace-1'); assert.equal(JSON.parse(folder.text()).projects.length, 1);
  const unknown = directory(''); await assert.rejects(app.sync.writeFolderSnapshot(unknown.handle, 'workspace-1'), /拒绝覆盖/);
  assert.equal(unknown.text(), '');
  for (const replacement of ['', previous('external-workspace')]) {
    const changed = directory(); changed.state.failure = 'write'; changed.state.beforeFailure = () => changed.replace(replacement);
    await assert.rejects(app.sync.writeFolderSnapshot(changed.handle, 'workspace-1'));
    assert.equal(changed.text(), replacement); assert.equal(changed.files.size, 1);
  }
});

test('选择取消不改绑定，换目录立即写当前数据且旧目录保留，停止同步不删文件', async () => {
  const old = directory(previous(), '旧目录'), next = directory(undefined, '新目录');
  const app = load({ browser: true, saved: { version: 1, workspaceId: 'workspace-1', handle: old.handle } });
  await app.sync.startLocalFolderSync();
  assert.equal(await app.sync.chooseLocalFolder(), false);
  assert.equal(app.settings.get(bindingKey).handle, old.handle); assert.equal(app.sync.getLocalFolderSyncState().folderName, '旧目录');
  const before = old.text();
  app.window.showDirectoryPicker = async () => next.handle;
  assert.equal(await app.sync.chooseLocalFolder(), true);
  assert.equal(app.settings.get(bindingKey).handle, next.handle); assert.equal(old.text(), before);
  assert.equal(JSON.parse(next.text()).projects.length, 1); assert.equal(app.sync.getLocalFolderSyncState().status, 'synced');
  await app.sync.disconnectLocalFolder(); assert.equal(app.sync.getLocalFolderSyncState().status, 'unbound');
  assert.equal(app.settings.get(bindingKey).handle, undefined); assert.equal(next.files.size, 1);
});

test('碰撞或新目录写入失败不替换原绑定，也不显示成功', async () => {
  for (const failure of ['collision', 'close', 'abort']) {
    const old = directory(previous(), '旧目录'), next = directory(failure === 'collision' ? previous('other') : undefined, '失败目录');
    next.state.failure = failure;
    const app = load({ browser: true, saved: { version: 1, workspaceId: 'workspace-1', handle: old.handle } });
    await app.sync.startLocalFolderSync(); app.window.showDirectoryPicker = async () => next.handle;
    assert.equal(await app.sync.chooseLocalFolder(), false); assert.equal(app.settings.get(bindingKey).handle, old.handle);
    assert.equal(app.sync.getLocalFolderSyncState().status, 'error'); assert.equal(app.sync.getLocalFolderSyncState().folderName, '旧目录');
    assert.equal(app.sync.getLocalFolderSyncState().lastSyncedAt, undefined);
  }
});

test('重载只queryPermission，权限失效与配额失败有明确状态；requestPermission仅按钮函数调用', async () => {
  const folder = directory(previous()); folder.state.permission = 'prompt';
  const app = load({ browser: true, saved: { version: 1, workspaceId: 'workspace-1', handle: folder.handle } });
  await app.sync.startLocalFolderSync(); await app.advance(31_000);
  assert.equal(app.sync.getLocalFolderSyncState().status, 'permission-required'); assert.equal(folder.state.requested, 0); assert.equal(folder.state.writes, 0);
  await app.sync.reauthorizeLocalFolder(); assert.equal(folder.state.requested, 1); assert.equal(folder.state.writes, 0);
  folder.state.permission = 'granted'; await app.sync.reauthorizeLocalFolder();
  assert.equal(app.sync.getLocalFolderSyncState().status, 'synced'); assert.equal(folder.state.requested, 2);
  folder.state.failure = 'quota'; await app.sync.syncLocalFolderNow();
  assert.equal(app.sync.getLocalFolderSyncState().status, 'quota');
  folder.state.permission = 'denied'; await app.sync.syncLocalFolderNow();
  assert.equal(app.sync.getLocalFolderSyncState().status, 'permission-required'); assert.equal(folder.state.requested, 2);
});

test('频繁事件合并、运行时30秒内合并或结束后同步，写入期间更改排队且只有一个写者', async () => {
  const folder = directory(previous()), backup = snapshot(); backup.projects[0].runs = [{ status: 'running' }];
  const app = load({ browser: true, backup, saved: { version: 1, workspaceId: 'workspace-1', handle: folder.handle } });
  await app.sync.startLocalFolderSync();
  for (let i = 0; i < 50; i++) app.window.dispatchEvent(new Event('braipen:workflow-changed'));
  await app.advance(1500); assert.equal(app.counters.backups, 0); assert.equal(app.sync.getLocalFolderSyncState().status, 'pending');
  await app.advance(28_500); assert.equal(app.counters.backups, 1); assert.equal(folder.state.closes, 1);
  app.window.dispatchEvent(new Event('braipen:connections-changed')); await app.advance(1500); assert.equal(app.counters.backups, 1);
  backup.projects[0].runs[0].status = 'completed'; app.window.dispatchEvent(new Event('braipen:workflow-changed'));
  folder.state.gate = deferred(); await app.advance(1500);
  assert.equal(app.sync.getLocalFolderSyncState().status, 'syncing'); assert.equal(folder.state.closes, 1);
  const second = app.sync.syncLocalFolderNow(); app.window.dispatchEvent(new Event('braipen:projects-changed'));
  await settle(); assert.equal(folder.state.maxActive, 1);
  folder.state.gate.resolve(); await second; await settle();
  assert.equal(folder.state.maxActive, 1); assert.equal(app.sync.getLocalFolderSyncState().status, 'synced'); assert.ok(folder.state.closes >= 2);
});

test('不支持目录API时降级且不会尝试选择、申请权限或读取保险库', async () => {
  const app = load(); await app.sync.startLocalFolderSync();
  assert.equal(app.sync.getLocalFolderSyncState().status, 'unsupported'); assert.equal(await app.sync.chooseLocalFolder(), false);
  assert.equal(app.reads.length, 0); assert.equal(app.counters.backups, 0);
});

test('无WebLocks时目录能力明确降级，按钮选择函数不打开picker', async () => {
  const noLocks = load({ browser: true, locks: null }); let calls = 0;
  noLocks.window.showDirectoryPicker = async () => { calls++; return directory().handle; };
  await noLocks.sync.startLocalFolderSync(); assert.equal(noLocks.sync.getLocalFolderSyncState().status, 'unsupported');
  assert.match(noLocks.sync.getLocalFolderSyncState().message, /跨标签页安全锁/);
  assert.equal(await noLocks.sync.chooseLocalFolder(), false); assert.equal(calls, 0);
});

test('双标签页锁涵盖旧快照capture到close：A延迟时B不得先写new后被A覆盖', async () => {
  const folder = directory(previous()), backup = snapshot(), locks = lockManager(), gate = deferred();
  backup.projects[0].title = 'old';
  const settings = new Map([[bindingKey, { version: 1, workspaceId: 'workspace-1', handle: folder.handle }]]);
  const a = load({ browser: true, backup, settings, locks, captureGate: gate }), b = load({ browser: true, backup, settings, locks });
  await Promise.all([a.sync.startLocalFolderSync(), b.sync.startLocalFolderSync()]);
  const writingA = a.sync.syncLocalFolderNow(); await settle(); assert.equal(a.counters.backups, 1);
  backup.projects[0].title = 'new'; const writingB = b.sync.syncLocalFolderNow(); await settle();
  assert.equal(b.counters.backups, 0); assert.equal(folder.state.closes, 0);
  gate.resolve(); await Promise.all([writingA, writingB]);
  assert.equal(JSON.parse(folder.text()).projects[0].title, 'new'); assert.equal(folder.state.maxActive, 1);
});

test('即使通知晚到，B也在锁内重读绑定：A停用后B不再写旧目录或显示synced', async () => {
  const folder = directory(previous()), backup = snapshot(), locks = lockManager();
  const settings = new Map([[bindingKey, { version: 1, workspaceId: 'workspace-1', handle: folder.handle }]]);
  const a = load({ browser: true, backup, settings, locks }), b = load({ browser: true, backup, settings, locks });
  await Promise.all([a.sync.startLocalFolderSync(), b.sync.startLocalFolderSync()]);
  await a.sync.disconnectLocalFolder(); const before = folder.text(), writes = folder.state.writes;
  backup.projects[0].title = 'after-stop'; b.window.dispatchEvent(new Event('braipen:projects-changed')); await b.advance(1500);
  assert.equal(folder.text(), before); assert.equal(folder.state.writes, writes); assert.equal(b.sync.getLocalFolderSyncState().status, 'unbound');
  await b.sync.syncLocalFolderNow(); assert.equal(folder.state.writes, writes); assert.equal(b.sync.getLocalFolderSyncState().status, 'unbound');
});

test('跨标签页换目录通知只传type：B重读新handle，旧目录保留，授权旧handle不能恢复停用绑定', async () => {
  const old = directory(previous(), '旧目录'), next = directory(undefined, '新目录'), backup = snapshot(), locks = lockManager(), broadcast = broadcastHub();
  const settings = new Map([[bindingKey, { version: 1, workspaceId: 'workspace-1', handle: old.handle }]]);
  const a = load({ browser: true, backup, settings, locks, broadcast }), b = load({ browser: true, backup, settings, locks, broadcast });
  await Promise.all([a.sync.startLocalFolderSync(), b.sync.startLocalFolderSync()]);
  const before = old.text(); a.window.showDirectoryPicker = async () => next.handle; await a.sync.chooseLocalFolder(); await settle();
  assert.equal(b.sync.getLocalFolderSyncState().folderName, '新目录'); await b.sync.syncLocalFolderNow();
  assert.equal(old.text(), before); assert.equal(JSON.parse(next.text()).projects.length, 1);
  const gate = deferred(); next.handle.requestPermission = () => gate.promise;
  const authorizing = b.sync.reauthorizeLocalFolder(); await a.sync.disconnectLocalFolder(); gate.resolve('granted'); await authorizing; await settle();
  assert.equal(settings.get(bindingKey).handle, undefined); assert.equal(b.sync.getLocalFolderSyncState().status, 'unbound');
  assert.ok(broadcast.messages.length > 0); assert.ok(broadcast.messages.every(message => JSON.stringify(message) === '{"type":"binding-changed"}'));
});
