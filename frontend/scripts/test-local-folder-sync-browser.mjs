// Isolated browser/IndexedDB + native OPFS directory checks. No personal disk folders or real API credentials.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createServer } from 'vite';

const require = createRequire(import.meta.url), runtime = process.env.BRAIPEN_PLAYWRIGHT_PATH;
const { chromium } = runtime ? await import(pathToFileURL(join(runtime, 'index.mjs')).href) : require('playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, '..', 'reports', 'local-folder-sync', 'output', 'playwright');
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error',
  plugins: [{ name: 'folder-storage-check', configureServer(value) {
    value.middlewares.use('/__folder_storage', (_, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end('<!doctype html><title>文件夹同步验证</title>'); });
  } }] });
let browser;
try {
  await server.listen(); await mkdir(output, { recursive: true });
  browser = await chromium.launch({ channel: process.env.BRAIPEN_BROWSER || 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const address = server.resolvedUrls.local[0], origin = new URL(address).origin;
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.addInitScript(() => {
    localStorage.setItem('braipen:intro-hidden', 'true'); window.__pickerCalls = 0;
    // Native browser-private filesystem; substitutes the system picker only inside this test context.
    window.showDirectoryPicker = async () => {
      window.__pickerCalls++; window.__gestureAtPicker = navigator.userActivation.isActive;
      return (await navigator.storage.getDirectory()).getDirectoryHandle('本地同步测试'.repeat(12), { create: true });
    };
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(address + '__folder_storage');
  const seeded = await page.evaluate(async () => {
    const types = await import('/src/localTypes.ts'), store = await import('/src/localStore.ts');
    const project = types.emptyProject('浏览器文件夹同步测试'); await store.putProject(project);
    await store.setSetting('default_model', 'offline-model'); await store.setSetting('default_connection', 'offline-text');
    await store.setSetting('default_image_connection', 'offline-image');
    await store.setSetting('vault:offline-text', { ciphertext: [1, 2, 3], api_key: 'OFFLINE_PRIVATE_SENTINEL' });
    await store.setSetting('connection:offline-text', { id: 'offline-text', name: '离线测试连接', enabled: true, deleted: false, epoch: 0,
      key_version: 'offline-version', head: 1, revisions: [{ profile_id: 'offline-text', revision: 1, model: 'offline-model' }], api_key: 'OFFLINE_PRIVATE_SENTINEL' });
    return project.project_ref;
  });
  await page.goto(address + 'settings?tab=system');
  await page.getByRole('button', { name: '选择同步文件夹' }).click();
  await page.getByText('新文件夹已绑定并完成首次同步，旧文件夹中的备份保留。', { exact: true }).waitFor();
  const first = await page.evaluate(async () => {
    const store = await import('/src/localStore.ts');
    const bound = await store.getSetting('local-folder-sync.v1');
    const file = await (await bound.handle.getFileHandle('braipen-workspace.json')).getFile(), text = await file.text();
    return { text, workspaceId: bound.workspaceId, nativeHandle: bound.handle instanceof FileSystemDirectoryHandle,
      calls: window.__pickerCalls, gesture: window.__gestureAtPicker };
  });
  assert.equal(first.nativeHandle, true); assert.equal(first.calls, 1); assert.equal(first.gesture, true);
  const parsed = JSON.parse(first.text); assert.equal(parsed.version, 3); assert.equal(parsed.projects[0].project_ref, seeded);
  assert.equal(parsed.environment.default_model, 'offline-model'); assert.equal(parsed.environment.default_image_connection, 'offline-image');
  assert.equal(first.text.includes('OFFLINE_PRIVATE_SENTINEL'), false); assert.equal(first.text.includes('ciphertext'), false); assert.equal(first.text.includes('handle'), false);
  await page.screenshot({ path: join(output, 'desktop.png'), fullPage: true });
  await page.reload();
  await page.getByText('项目与模型配置已同步到所选文件夹。', { exact: true }).waitFor();
  const reloaded = await page.evaluate(async () => {
    const store = await import('/src/localStore.ts'), bound = await store.getSetting('local-folder-sync.v1');
    return { workspaceId: bound.workspaceId, nativeHandle: bound.handle instanceof FileSystemDirectoryHandle, pickerCalls: window.__pickerCalls };
  });
  assert.equal(reloaded.workspaceId, first.workspaceId); assert.equal(reloaded.nativeHandle, true); assert.equal(reloaded.pickerCalls, 0);
  // Automatic sync remains alive after leaving settings.
  await page.goto(address + 'writing');
  await page.evaluate(async ref => { const store = await import('/src/localStore.ts'); await store.updateProject(ref, value => { value.assets.outline = '离开设置页后自动同步'; });
    window.dispatchEvent(new Event('braipen:workflow-changed')); }, seeded);
  await page.waitForFunction(async () => {
    const store = await import('/src/localStore.ts'), binding = await store.getSetting('local-folder-sync.v1');
    return (await (await binding.handle.getFileHandle('braipen-workspace.json')).getFile()).text().then(text => text.includes('离开设置页后自动同步'));
  });
  await page.goto(address + 'settings?tab=system'); await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '更换同步文件夹' }).waitFor();
  const overflow = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
  assert.ok(overflow.width <= overflow.viewport, `Bound folder page overflow: ${JSON.stringify(overflow)}`);
  await page.screenshot({ path: join(output, 'mobile-bound.png'), fullPage: true });
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await mobile.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await mobile.addInitScript(() => { localStorage.setItem('braipen:intro-hidden', 'true'); Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true }); });
  const mobilePage = await mobile.newPage(); mobilePage.on('pageerror', error => errors.push(error.message));
  await mobilePage.goto(address + 'settings?tab=system');
  await mobilePage.getByText('此浏览器未提供文件夹同步，请使用下方下载备份与文件恢复。', { exact: true }).waitFor();
  assert.equal(await mobilePage.getByRole('button', { name: '选择同步文件夹' }).count(), 0);
  assert.equal(await mobilePage.getByRole('button', { name: '下载全部项目备份' }).count(), 1);
  assert.equal(await mobilePage.getByRole('button', { name: '从备份恢复副本' }).count(), 1);
  const fallbackOverflow = await mobilePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  assert.equal(fallbackOverflow, true); await mobilePage.screenshot({ path: join(output, 'mobile-fallback.png'), fullPage: true });
  // Two actual tabs share IndexedDB, native locks and the browser-private directory.
  await page.evaluate(async ref => {
    const store = await import('/src/localStore.ts');
    await store.updateProject(ref, value => { value.assets.outline = 'dual-old'; });
    const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    await store.saveCoverVersion(ref, { width: 2, height: 2, prompt: '离线锁验证', source: { idea: '', characters: '' } }, blob);
    await (await import('/src/localFolderSync.ts')).syncLocalFolderNow();
  }, seeded);
  const tabB = await context.newPage(); tabB.on('pageerror', error => errors.push(error.message));
  await tabB.goto(address + 'settings?tab=system'); await tabB.getByText('项目与模型配置已同步到所选文件夹。', { exact: true }).waitFor();
  await page.evaluate(() => {
    const original = Blob.prototype.arrayBuffer;
    window.__heldSnapshot = false; window.__snapshotGate = new Promise(resolve => { window.__releaseSnapshot = resolve; });
    Blob.prototype.arrayBuffer = async function(...args) {
      if (this.type === 'image/png' && !window.__heldSnapshot) { window.__heldSnapshot = true; await window.__snapshotGate; }
      return original.apply(this, args);
    };
    window.__syncA = import('/src/localFolderSync.ts').then(sync => sync.syncLocalFolderNow());
  });
  await page.waitForFunction(() => window.__heldSnapshot);
  await tabB.evaluate(async ref => {
    const store = await import('/src/localStore.ts'); await store.updateProject(ref, value => { value.assets.outline = 'dual-new'; });
    window.__doneB = false; window.__syncB = import('/src/localFolderSync.ts').then(sync => sync.syncLocalFolderNow()).then(() => { window.__doneB = true; });
  }, seeded);
  const held = await tabB.evaluate(async () => ({ done: window.__doneB, locks: await navigator.locks.query() }));
  assert.equal(held.done, false); assert.ok(held.locks.held.some(lock => lock.name === 'braipen:local-folder-sync'));
  await page.evaluate(() => window.__releaseSnapshot()); await Promise.all([page.evaluate(() => window.__syncA), tabB.evaluate(() => window.__syncB)]);
  const latest = await tabB.evaluate(async () => {
    const bound = await (await import('/src/localStore.ts')).getSetting('local-folder-sync.v1');
    window.__priorHandle = bound.handle;
    return JSON.parse(await (await (await bound.handle.getFileHandle('braipen-workspace.json')).getFile()).text()).projects[0].assets.outline;
  });
  assert.equal(latest, 'dual-new');
  await page.evaluate(async () => (await import('/src/localFolderSync.ts')).disconnectLocalFolder());
  const stopped = await tabB.evaluate(async ref => {
    const store = await import('/src/localStore.ts'), sync = await import('/src/localFolderSync.ts');
    const before = await (await (await window.__priorHandle.getFileHandle('braipen-workspace.json')).getFile()).text();
    await store.updateProject(ref, value => { value.assets.outline = 'after-stop-must-not-write'; }); window.dispatchEvent(new Event('braipen:projects-changed'));
    await sync.syncLocalFolderNow();
    const after = await (await (await window.__priorHandle.getFileHandle('braipen-workspace.json')).getFile()).text();
    return { sameBytes: before === after, state: sync.getLocalFolderSyncState().status, stillBound: Boolean((await store.getSetting('local-folder-sync.v1')).handle) };
  }, seeded);
  assert.deepEqual(stopped, { sameBytes: true, state: 'unbound', stillBound: false });
  await tabB.close();
  const retried = await page.evaluate(async () => {
    const sync = await import('/src/localFolderSync.ts'), store = await import('/src/localStore.ts');
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('native-first-write-retry', { create: true });
    const workspaceId = (await store.getSetting('local-folder-sync.v1')).workspaceId;
    const original = FileSystemWritableFileStream.prototype.write;
    FileSystemWritableFileStream.prototype.write = async () => { throw new Error('offline injected first write failure'); };
    let failed = false;
    try { await sync.writeFolderSnapshot(folder, workspaceId); } catch { failed = true; }
    finally { FileSystemWritableFileStream.prototype.write = original; }
    let removed = false;
    try { await folder.getFileHandle('braipen-workspace.json'); } catch (error) { removed = error.name === 'NotFoundError'; }
    await sync.writeFolderSnapshot(folder, workspaceId);
    return { failed, emptyPlaceholderRemoved: removed, retryHasProjects: JSON.parse(await (await (await folder.getFileHandle('braipen-workspace.json')).getFile()).text()).projects.length > 0 };
  });
  assert.deepEqual(retried, { failed: true, emptyPlaceholderRemoved: true, retryHasProjects: true });
  const noLockContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await noLockContext.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await noLockContext.addInitScript(() => { localStorage.setItem('braipen:intro-hidden', 'true'); Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }); });
  const noLockPage = await noLockContext.newPage(); await noLockPage.goto(address + 'settings?tab=system');
  await noLockPage.getByText('此浏览器未提供跨标签页安全锁，已停用文件夹同步，请使用下方下载备份与文件恢复。', { exact: true }).waitFor();
  assert.equal(await noLockPage.getByRole('button', { name: '选择同步文件夹' }).count(), 0);
  assert.equal(await noLockPage.getByRole('button', { name: '下载全部项目备份' }).count(), 1); await noLockContext.close();
  const recovered = await page.evaluate(async text => {
    const store = await import('/src/localStore.ts');
    const refs = await store.restoreBackup(text);
    const copy = await store.getProject(refs[0]), projects = await store.listProjects();
    return { count: refs.length, copied: copy.title.endsWith('（恢复副本）'), originalRetained: projects.length === 2 };
  }, first.text);
  assert.deepEqual(recovered, { count: 1, copied: true, originalRetained: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ nativeHandlePersisted: true, pickerOnlyOnClick: true, reloadNoPicker: true, syncOutsideSettings: true,
    noKeysInSnapshot: true, desktop: '1440x1000', mobile: '390x844', noHorizontalOverflow: true, unsupportedFallback: true,
    folderSnapshotRestoresThroughExistingBackup: true, twoTabsOldSnapshotCannotOverwriteNew: true, crossTabStopPreventsWrites: true,
    nativeFirstWriteFailureRetriesSafely: true, noWebLocksFallsBack: true, pageErrors: errors.length, screenshots: output }, null, 2));
} finally { await browser?.close(); await server.close(); }
