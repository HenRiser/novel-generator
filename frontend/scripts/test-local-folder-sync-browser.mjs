// Isolated Edge profile and browser-private files. The system folder picker and permission changes are simulated.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { installTestModuleLoader } from './workspace-browser-test-helpers.mjs';

const require = createRequire(import.meta.url), runtime = process.env.BRAIPEN_PLAYWRIGHT_PATH;
const { chromium } = runtime ? await import(pathToFileURL(join(runtime, 'index.mjs')).href) : require('playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.env.BRAIPEN_REPORT_DIR || join(root, '../reports/local-folder-sync/output/playwright'));
const server = await createServer({ root, cacheDir: join(root, 'node_modules/.vite-local-folder-sync'),
  define: { 'import.meta.env.VITE_API_BASE_URL': '""' }, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
const errors = [], unexpectedRequests = [];
let browser;

try {
  await server.listen(); await mkdir(output, { recursive: true });
  browser = await chromium.launch({ channel: process.env.BRAIPEN_BROWSER || 'msedge', headless: true });
  const origin = new URL(server.resolvedUrls.local[0]).origin;
  async function setupContext(viewport, missing) {
    const context = await browser.newContext({ viewport, acceptDownloads: true });
    await installTestModuleLoader(context);
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin) {
        if (url.pathname === '/api/health') return route.fulfill({ json: { status: 'ok' } });
        if (url.pathname === '/api/capabilities') return route.fulfill({ json: { protocol_version: 2, providers: [], image_providers: [] } });
        if (!url.pathname.startsWith('/api/')) return route.continue();
      }
      unexpectedRequests.push(url.origin + url.pathname);
      return route.abort();
    });
    await context.addInitScript(({ missing, origin }) => {
      if (location.origin !== origin) return;
      localStorage.setItem('braipen:intro-hidden', 'true');
      window.folderName = '本地同步测试'.repeat(12);
      window.pickerCalls = 0;
      window.testDirectory = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(window.folderName, { create: true });
      window.readTestFile = async () => (await (await (await window.testDirectory()).getFileHandle('braipen-workspace.json')).getFile()).text();
      window.showDirectoryPicker = async () => {
        window.pickerCalls++;
        window.pickerGesture = navigator.userActivation.isActive;
        const handle = await window.testDirectory();
        const query = handle.queryPermission.bind(handle), request = handle.requestPermission.bind(handle);
        handle.queryPermission = options => window.denyPermission ? Promise.resolve('denied') : query(options);
        handle.requestPermission = options => window.denyPermission ? Promise.resolve('denied') : request(options);
        return handle;
      };
      if (missing === 'picker') Object.defineProperty(window, 'showDirectoryPicker', { value: undefined });
      if (missing === 'locks') Object.defineProperty(navigator, 'locks', { value: undefined });
    }, { missing, origin });
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    return context;
  }
  async function settingsPage(context) {
    const page = await context.newPage();
    await page.goto(origin + '/settings?tab=system', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '打开工作区文件', exact: true }).waitFor();
    return page;
  }
  const button = (page, name) => page.getByRole('button', { name, exact: true });
  const context = await setupContext({ width: 1440, height: 1000 });
  const page = await settingsPage(context);
  const seeded = await page.evaluate(async () => {
    const types = await window.testModule('localTypes.ts'), store = await window.testModule('localStore.ts');
    const project = types.emptyProject('浏览器文件夹同步测试'); await store.putProject(project);
    await store.setSetting('default_model', 'offline-model');
    await store.setSetting('default_connection', 'offline-text');
    await store.setSetting('default_image_connection', 'offline-image');
    await store.setSetting('vault:offline-text', { ciphertext: [1, 2, 3], api_key: 'OFFLINE_PRIVATE_SENTINEL' });
    await store.setSetting('connection:offline-text', { id: 'offline-text', name: '离线测试连接', enabled: true, deleted: false, epoch: 0,
      key_version: 'offline-version', head: 1, revisions: [{ profile_id: 'offline-text', revision: 1, model: 'offline-model' }], api_key: 'OFFLINE_PRIVATE_SENTINEL' });
    return project.project_ref;
  });
  assert.equal(await page.evaluate(() => window.pickerCalls), 0);
  await button(page, '打开工作区').click();
  await button(page, '继续打开').click();
  await page.getByText('已保存到本机文件夹。', { exact: true }).waitFor();
  const first = await page.evaluate(async () => ({ text: await window.readTestFile(), native: (await window.testDirectory()) instanceof FileSystemDirectoryHandle,
    calls: window.pickerCalls, gesture: window.pickerGesture }));
  assert.equal(first.native, true); assert.equal(first.calls, 1); assert.equal(first.gesture, true);
  const parsed = JSON.parse(first.text);
  assert.equal(parsed.version, 5); assert.equal(parsed.projects[0].project_ref, seeded);
  assert.ok(parsed.connections.some(profile => profile.id === 'offline-text'));
  assert.doesNotMatch(first.text, /OFFLINE_PRIVATE_SENTINEL|ciphertext|api_key|"handle"|"environment"|"default_(model|connection|image_connection)"/);
  await page.screenshot({ path: join(output, 'desktop.png'), fullPage: true });
  console.log('PASS user-initiated folder selection, native v5 file and credential exclusion');

  await page.reload({ waitUntil: 'networkidle' });
  await button(page, '打开工作区').waitFor();
  assert.equal(await button(page, '关闭文件夹').count(), 0);
  const fresh = await page.evaluate(async () => {
    const store = await window.testModule('localStore.ts');
    return { picker: window.pickerCalls, projects: (await store.listProjects()).length,
      savedHandle: Boolean(await store.getSetting('local-folder-sync.v1')), model: await store.getSetting('default_model'),
      connection: await store.getSetting('default_connection'), imageConnection: await store.getSetting('default_image_connection') };
  });
  assert.deepEqual(fresh, { picker: 0, projects: 0, savedHandle: false, model: 'offline-model',
    connection: 'offline-text', imageConnection: 'offline-image' });
  await button(page, '打开工作区').click();
  await page.getByText('工作区已打开，后续更新将自动写入本机文件。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.readTestFile()), first.text);
  await page.getByRole('link', { name: /创作台/ }).click();
  await page.waitForURL('**/writing');
  await page.evaluate(async ref => (await window.testModule('localStore.ts')).updateProject(ref, p => { p.assets.outline = '离开设置页后自动同步'; }), seeded);
  assert.equal(JSON.parse(await page.evaluate(() => window.readTestFile())).projects[0].assets.outline, '离开设置页后自动同步');
  await page.goBack(); await button(page, '关闭文件夹').waitFor();
  console.log('PASS explicit reopen preserves file bytes, project identity and saving after in-app navigation');

  const prior = await page.evaluate(() => window.readTestFile());
  await page.evaluate(() => { window.denyPermission = true; });
  await assert.rejects(page.evaluate(async ref => (await window.testModule('localStore.ts')).updateProject(ref, p => { p.title = '重新授权后保留的新稿'; }), seeded), /重新授权/);
  await button(page, '重新授权并重试保存').click();
  await page.getByText('尚未获得文件夹写入权限。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.readTestFile()), prior);
  await page.evaluate(() => { window.denyPermission = false; });
  await button(page, '重新授权并重试保存').click();
  await page.getByText('已保存到本机文件夹。', { exact: true }).waitFor();
  assert.equal(JSON.parse(await page.evaluate(() => window.readTestFile())).projects[0].title, '重新授权后保留的新稿');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(output, 'mobile-bound.png'), fullPage: true });
  console.log('PASS permission denial preserves the file, reauthorization saves the pending edit, mobile layout fits');

  const tabB = await settingsPage(context);
  await button(tabB, '打开工作区').click();
  await tabB.getByText('工作区已打开，后续更新将自动写入本机文件。', { exact: true }).waitFor();
  await page.evaluate(() => {
    void navigator.locks.request('braipen:local-folder-sync', () => new Promise(resolve => { window.releaseLock = resolve; }));
  });
  await page.waitForFunction(() => typeof window.releaseLock === 'function');
  await tabB.evaluate(async ref => {
    const store = await window.testModule('localStore.ts');
    window.queuedWrite = store.updateProject(ref, p => { p.assets.outline = '另一标签页的新稿'; });
  }, seeded);
  await tabB.waitForFunction(async () => (await navigator.locks.query()).pending.some(lock => lock.name === 'braipen:local-folder-sync'));
  await page.evaluate(() => window.releaseLock());
  await tabB.evaluate(() => window.queuedWrite);
  const latest = await tabB.evaluate(() => window.readTestFile());
  assert.equal(JSON.parse(latest).projects[0].assets.outline, '另一标签页的新稿');
  await assert.rejects(page.evaluate(async ref => (await window.testModule('localStore.ts')).updateProject(ref, p => { p.assets.outline = '已过时的标签页'; }), seeded), /外部修改/);
  assert.equal(await page.evaluate(() => window.readTestFile()), latest);
  assert.equal(await page.evaluate(async () => (await (await window.testModule('localStore.ts')).createBackup()).projects[0].assets.outline), '已过时的标签页');
  await button(tabB, '关闭文件夹').click();
  await tabB.getByText(/本次内容仍在页面内存中/).waitFor();
  await tabB.evaluate(async ref => (await window.testModule('localStore.ts')).updateProject(ref, p => { p.title = '关闭后的本页改动'; }), seeded);
  assert.equal(await tabB.evaluate(() => window.readTestFile()), latest);
  console.log('PASS real cross-tab locks serialize writes, stale snapshots cannot overwrite, closed folders retain bytes');

  // A failed first write can leave a zero-byte placeholder. Retry through the original binding.
  await tabB.evaluate(() => {
    window.folderName = 'first-write-retry';
    const write = FileSystemWritableFileStream.prototype.write;
    FileSystemWritableFileStream.prototype.write = async function () {
      FileSystemWritableFileStream.prototype.write = write;
      throw new Error('合成首次写盘失败');
    };
  });
  await button(tabB, '打开工作区').click(); await button(tabB, '继续打开').click();
  await tabB.getByRole('tabpanel', { name: '本地数据与体验' }).getByText('合成首次写盘失败', { exact: true }).waitFor();
  assert.equal(await tabB.evaluate(() => window.readTestFile()), '');
  await button(tabB, '重试保存到本机文件夹').click();
  await tabB.getByText('已保存到本机文件夹。', { exact: true }).waitFor();
  assert.equal(JSON.parse(await tabB.evaluate(() => window.readTestFile())).projects[0].title, '关闭后的本页改动');
  const recovered = await tabB.evaluate(async text => {
    const store = await window.testModule('localStore.ts'), [ref] = await store.restoreBackup(text);
    return { restored: (await store.getProject(ref)).title, refs: (await store.listProjects()).map(p => p.project_ref), copy: ref };
  }, first.text);
  assert.match(recovered.restored, /（恢复副本）$/); assert.notEqual(recovered.copy, seeded);
  assert.deepEqual(new Set(recovered.refs), new Set([seeded, recovered.copy]));
  console.log('PASS first write can be retried without deleting files, backup restore keeps an independent copy');

  for (const missing of ['picker', 'locks']) {
    const mobile = await setupContext({ width: 390, height: 844 }, missing);
    const mobilePage = await settingsPage(mobile);
    assert.equal(await button(mobilePage, '打开工作区').count(), 0);
    await button(mobilePage, '打开工作区文件').waitFor();
    await mobilePage.locator('input[type=file][accept*="json"]').setInputFiles({ name: 'braipen-workspace.json', mimeType: 'application/json', buffer: Buffer.from(first.text) });
    await mobilePage.getByText('已打开工作区文件。此方式需手动下载保存，修改后请及时保存到本地。', { exact: true }).waitFor();
    const [download] = await Promise.all([mobilePage.waitForEvent('download'), button(mobilePage, '下载工作区').click()]);
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    const restored = JSON.parse(Buffer.concat(chunks));
    assert.equal(restored.version, 5); assert.equal(restored.projects[0].project_ref, seeded);
    assert.equal(await mobilePage.evaluate(() => window.pickerCalls), 0);
    assert.ok(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await mobilePage.screenshot({ path: join(output, 'mobile-fallback-' + missing + '.png'), fullPage: true });
    await mobile.close();
    console.log('PASS mobile JSON open/download without ' + missing);
  }
  assert.deepEqual(errors, []); assert.deepEqual(unexpectedRequests, []);
  console.log('PASS no unexpected requests or page errors');
} finally { await browser?.close(); await server.close(); }
