// Actual import component, isolated Edge profile, synthetic files and mocked local compute only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { providerFixtures, identity } from './provider-test-helpers.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url))).replaceAll('\\', '/');
const report = resolve(process.env.BRAIPEN_REPORT_DIR || join(root, '../reports/import-lifecycle-2026-10-23'));
const require = createRequire(import.meta.url), runtime = process.env.BRAIPEN_PLAYWRIGHT_PATH;
const { chromium } = runtime ? await import(pathToFileURL(join(runtime, 'index.mjs')).href) : require('playwright');
const fixtures = providerFixtures(root), calls = [], checks = [], errors = [], external = [];
let holdNext = false, releaseHeld, browser, page;
const json = (res, value) => { if (res.destroyed) return; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
const server = await createServer({ root, define: { 'import.meta.env.VITE_API_BASE_URL': '""' }, logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{
  name: 'import-lifecycle-test', configureServer(s) {
    s.middlewares.use(async (req, res, next) => {
      const path = req.url?.split('?')[0];
      if (path === '/__import-audit') {
        res.setHeader('Content-Type', 'text/html');
        res.end(await s.transformIndexHtml(req.url, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><div id="root"></div><script type="module">
          import React from 'react'; import {createRoot} from 'react-dom/client';
          import Panel from '/src/components/NovelImportPanel.tsx';
          import * as store from '/src/localStore.ts'; import * as connections from '/src/providerConnections.ts';
          window.store=store; window.connections=connections;
          const root=createRoot(document.getElementById('root'));
          window.showImport=()=>root.render(React.createElement(Panel)); window.leaveImport=()=>root.render(null);
          window.showImport();
        </script></html>`)); return;
      }
      if (!path?.startsWith('/api/')) return next();
      if (path === '/api/capabilities') return json(res, fixtures.catalog);
      if (path === '/api/health') return json(res, { status: 'ok' });
      let raw = ''; for await (const part of req) raw += part;
      const p = JSON.parse(raw || '{}'), operation = path.split('/compute/')[1];
      if (operation === 'validate_connection') return json(res, { ...identity(p), result: { connection: fixtures.normalize(p.connection) } });
      assert.equal(operation, 'import_chapter'); assert.equal(p.request_fingerprint, fixtures.requestFingerprint(p, operation));
      calls.push({ operation, chapter: p.input.chapter_number });
      if (holdNext) { holdNext = false; await new Promise(resolve => { releaseHeld = resolve; }); }
      json(res, { ...identity(p), result: { summary: '合成章节摘要', characters: [], facts: [], relationships: [], foreshadows: [], warnings: [] }, metrics: { call_count: 1 } });
    });
  },
}] });
async function check(name, action) { await action(); checks.push(name); console.log('PASS ' + name); }
async function until(query) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await page.evaluate(query)) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Timed out waiting for import checkpoint');
}
async function upload() {
  await page.getByLabel('导入小说文件').setInputFiles({ name: '合成小说.txt', mimeType: 'text/plain', buffer: Buffer.from('第一章 开始\n勇者进城。\n第二章 返回\n同伴归来。') });
  await page.getByRole('button', { name: '保存分章与前缀', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-label="导入小说文件"]').disabled);
}
async function restoreDraft() {
  await page.getByRole('combobox', { name: '恢复导入草稿' }).click();
  await page.getByTitle(/合成小说/).last().click();
  await page.getByRole('button', { name: '保存分章与前缀', exact: true }).waitFor();
}
async function refusedSwitch() {
  return page.evaluate(async () => {
    const empty = await store.createBackup(); empty.projects = []; empty.imports = []; empty.drafts = [];
    try { await store.openWorkspace(JSON.stringify(empty), true); return ''; }
    catch (error) { return error.message; }
  });
}
try {
  await mkdir(report, { recursive: true }); await server.listen();
  const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext(); page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
  await page.goto(origin + '/__import-audit', { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    await connections.ensureConnections(); await connections.storeConnectionKey('legacy-deepseek', 'sk-' + 't'.repeat(32), true);
    store.setWorkspaceWriter(async snapshot => { window.disk = JSON.stringify(snapshot); });
  });
  await upload();
  await check('连接准备期间离开页面，晚到连接不触发模型', async () => {
    await page.evaluate(() => { void navigator.locks.request('braipen:connection:legacy-deepseek', async () => {
      window.lockHeld = true; await new Promise(resolve => { window.releaseLock = resolve; });
    }); });
    await page.waitForFunction(() => window.lockHeld);
    await page.getByRole('button', { name: '从检查点提取 · 调用模型', exact: true }).click();
    await page.getByRole('button', { name: '立即中断', exact: true }).waitFor();
    assert.match(await refusedSwitch(), /处理中|任务|运行/);
    await page.evaluate(() => window.leaveImport());
    await page.getByLabel('导入小说文件').waitFor({ state: 'detached' });
    assert.match(await refusedSwitch(), /处理中|任务|运行/); // Cleanup is still waiting for the held connection lock.
    await page.evaluate(() => window.releaseLock());
    await until(async () => (await navigator.locks.query()).held.length === 0);
    assert.equal(calls.length, 0);
    await page.evaluate(() => window.showImport()); await restoreDraft();
  });
  await check('导入任务结束或取消清理前禁止切换，结束后旧版本写入仍拒绝', async () => {
    holdNext = true;
    await page.getByRole('button', { name: '从检查点提取 · 调用模型', exact: true }).click();
    await until(async () => (await store.listImports())[0].attempt?.status === 'running');
    while (!releaseHeld) await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(await refusedSwitch(), /处理中|任务|运行/);
    await page.evaluate(async () => { window.oldImport = (await store.listImports())[0]; window.oldImportEpoch = store.getWorkspaceEpoch(); });
    await page.getByRole('button', { name: '立即中断', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="导入小说文件"]').disabled);
    releaseHeld(); releaseHeld = undefined;
    const oldError = await page.evaluate(async () => {
      const empty = await store.createBackup(); empty.projects = []; empty.imports = []; empty.drafts = [];
      await store.openWorkspace(JSON.stringify(empty), true);
      try { await store.putImport(window.oldImport.id, window.oldImport, undefined, window.oldImportEpoch); return ''; }
      catch (error) { return error.message; }
    });
    assert.match(oldError, /工作区已切换/);
    assert.deepEqual(await page.evaluate(async () => ({ imports: (await store.listImports()).length, dirty: store.workspaceHasUnsavedChanges(), rescue: store.hasRescue() })), { imports: 0, dirty: false, rescue: false });
    assert.equal(calls.length, 1);
    await page.evaluate(() => window.leaveImport()); await page.getByLabel('导入小说文件').waitFor({ state: 'detached' });
    await page.evaluate(() => window.showImport()); await upload();
  });
  await check('正常提取只调用选定前缀，重开工作区后恢复进度', async () => {
    await page.getByRole('button', { name: '从检查点提取 · 调用模型', exact: true }).click();
    await until(async () => (await store.listImports())[0].phase === 'review');
    assert.deepEqual(calls.map(value => value.chapter), [1, 1]);
    await page.evaluate(async () => { window.reopen = JSON.stringify(await store.createBackup()); window.leaveImport(); });
    await page.getByLabel('导入小说文件').waitFor({ state: 'detached' });
    await page.evaluate(async () => { await store.openWorkspace(window.reopen); window.showImport(); });
    await restoreDraft(); assert.equal(await page.getByRole('button', { name: '从检查点提取 · 调用模型', exact: true }).isDisabled(), true);
    assert.equal(calls.length, 2);
  });
  await check('分章、候选、摘要与合成资产编辑草稿随v5恢复，正式结果保持原值', async () => {
    await page.evaluate(async () => {
      window.leaveImport();
      const value = (await store.listImports())[0];
      value.results['1'].candidates = [{ id: '1:characters:0', kind: 'characters', label: '勇者', summary: '已保存描述', aliases: [], evidence: '勇者进城。', source_chapter: 1, source_hash: 'synthetic', status: 'pending', provenance: 'source_fact' }];
      value.synthesis = { config: Object.fromEntries(['genre','style','word_count_range','protagonist','supporting_characters','worldview','core_conflict'].map(key => [key,'已保存设定'])), assets: { outline: '已保存大纲', characters: '已保存人物' } };
      await store.putImport(value.id, value); window.showImport();
    });
    await restoreDraft();
    await page.getByText('第 1 章 · 待审核', { exact: true }).click();
    await page.getByLabel('作品标题', { exact: true }).fill('编辑中的导入标题');
    await page.getByLabel('章节边界').fill('1|正在编辑的第一章\n3|第二章 返回');
    await page.getByLabel('候选描述 1:characters:0').fill('候选尚未接受的修改');
    await page.locator('textarea[name="summary"]').fill('摘要尚未确认的修改');
    await page.locator('textarea[name="genre"]').fill('合成设定的待确认修改');
    await page.locator('textarea[name="outline"]').fill('合成大纲的待确认修改');
    await page.evaluate(async () => {
      const value = (await store.listImports())[0];
      if (value.results['1'].summary !== '合成章节摘要' || value.synthesis.assets.outline !== '已保存大纲') throw new Error('Editor mutated accepted data');
      window.reopen = JSON.stringify(await store.createBackup()); window.leaveImport();
    });
    await page.getByLabel('导入小说文件').waitFor({ state: 'detached' });
    await page.evaluate(async () => { await store.openWorkspace(window.reopen, true); window.showImport(); });
    await restoreDraft(); await page.getByText('第 1 章 · 待审核', { exact: true }).click();
    assert.equal(await page.getByLabel('作品标题', { exact: true }).inputValue(), '编辑中的导入标题');
    assert.match(await page.getByLabel('章节边界').inputValue(), /正在编辑/);
    assert.equal(await page.getByLabel('候选描述 1:characters:0').inputValue(), '候选尚未接受的修改');
    assert.equal(await page.locator('textarea[name="summary"]').inputValue(), '摘要尚未确认的修改');
    assert.equal(await page.locator('textarea[name="genre"]').inputValue(), '合成设定的待确认修改');
    assert.equal(await page.locator('textarea[name="outline"]').inputValue(), '合成大纲的待确认修改');
    await page.getByRole('button', { name: '保存分章与前缀', exact: true }).click();
    await until(async () => Object.keys((await store.listImports())[0].results).length === 0);
    assert.equal(await page.evaluate(async () => (await store.createBackup()).drafts.filter(value => value.name.includes('novel-import:')).length), 0);
    assert.equal(calls.length, 2);
  });
  await check('立即中断保留检查点，只有再次点击才重新调用', async () => {
    holdNext = true;
    await page.getByRole('button', { name: '从检查点提取 · 调用模型', exact: true }).click();
    while (!releaseHeld) await new Promise(resolve => setTimeout(resolve, 10));
    await page.getByRole('button', { name: '立即中断', exact: true }).click();
    await until(async () => (await store.listImports())[0].attempt?.status === 'interrupted');
    assert.equal(calls.length, 3); assert.equal(await page.evaluate(async () => Object.keys((await store.listImports())[0].results).length), 0);
    releaseHeld(); releaseHeld = undefined;
    await page.getByRole('button', { name: '从检查点提取 · 调用模型', exact: true }).click();
    await until(async () => (await store.listImports())[0].phase === 'review'); assert.equal(calls.length, 4);
  });
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await page.screenshot({ path: join(report, 'import.png'), fullPage: true });
} finally {
  releaseHeld?.(); await browser?.close(); await server.close();
  await writeFile(join(report, 'receipt.json'), JSON.stringify({ checks, calls, errors, external, paidCalls: 0 }, null, 2));
}
