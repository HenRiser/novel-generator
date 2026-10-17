// Real application UI with isolated storage and local-only model responses.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { providerFixtures, identity } from './provider-test-helpers.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url))).replaceAll('\\', '/');
const report = resolve(process.env.BRAIPEN_REPORT_DIR || join(root, '../reports/outline-entry-2026-10-18'));
const require = createRequire(import.meta.url), runtime = process.env.BRAIPEN_PLAYWRIGHT_PATH;
const { chromium } = runtime ? await import(pathToFileURL(join(runtime, 'index.mjs')).href) : require('playwright');
const fixtures = providerFixtures(root), calls = [], checks = [], errors = [], external = [];
let failOutline = false, browser, page, moduleBase;
const json = (res, value, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
const server = await createServer({ root, define: { 'import.meta.env.VITE_API_BASE_URL': '""' }, logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{
  name: 'outline-entry-test', configureServer(s) {
    s.middlewares.use(async (req, res, next) => {
      const path = req.url?.split('?')[0];
      if (path === '/__outline-entry') { res.setHeader('Content-Type', 'text/html'); res.end(await s.transformIndexHtml(req.url, '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><div id="root"></div></html>')); return; }
      if (!path.startsWith('/api/')) return next();
      if (path === '/api/health') return json(res, { status: 'ok' });
      if (path === '/api/capabilities') return json(res, { ...fixtures.catalog, operations: ['generate_outline', 'generate_characters'] });
      let raw = ''; for await (const part of req) raw += part;
      const p = JSON.parse(raw || '{}'), operation = path.split('/compute/')[1];
      try {
        if (operation === 'validate_connection') return json(res, { ...identity(p), result: { connection: fixtures.normalize(p.connection) } });
        assert.equal(p.request_fingerprint, fixtures.requestFingerprint(p, operation));
        calls.push({ operation, input: p.input });
        if (operation === 'generate_outline' && failOutline) return json(res, { error: { message: '模拟大纲生成失败，请重试。' } }, 502);
        if (!['generate_outline', 'generate_characters'].includes(operation)) return json(res, { error: { message: '此测试不允许其他模型调用。' } }, 400);
        const content = operation === 'generate_outline' ? '# 合成小说大纲\n\n第一卷：合成旅程。' : '# 合成人物卡\n\n合成勇者与同伴。';
        return json(res, { ...identity(p), result: { content }, metrics: { call_count: 1 } });
      } catch (error) { return json(res, { error: { message: error.message } }, 400); }
    });
  },
}] });
await mkdir(report, { recursive: true });
async function check(name, action) { await action(); checks.push(name); console.log('PASS ' + name); }
async function seed(title, outline = '', characters = '') {
  return page.evaluate(async ({ title, outline, characters, base }) => {
    const s = await import(base + 'localStore.ts'), t = await import(base + 'localTypes.ts');
    const c = await import(base + 'providerConnections.ts');
    await c.ensureConnections(); await c.storeConnectionKey('legacy-deepseek', 'sk-' + 's'.repeat(32), true);
    s.setWorkspaceWriter(async snapshot => { window.savedWorkspace = JSON.stringify(snapshot); });
    const p = t.emptyProject(title, { title, protagonist: '合成主角', supporting_characters: '合成配角', worldview: '合成世界', core_conflict: '合成冲突', genre: '奇幻', style: '克制', word_count_range: '2000-3000' });
    p.assets = { outline, characters, setting_expansion: '' }; await s.putProject(p);
    const state = (await import(base + 'store/useAppStore.ts')).useAppStore.getState();
    state.selectProject(p.project_ref);
    window.dispatchEvent(new Event('braipen:projects-changed'));
    return p.project_ref;
  }, { title, outline, characters, base: moduleBase });
}
const project = ref => page.evaluate(async ({ ref, base }) => (await import(base + 'localStore.ts')).getProject(ref), { ref, base: moduleBase });
async function generateButton() {
  const button = page.locator('#generation-assets').getByRole('button');
  await button.waitFor();
  await page.waitForFunction(() => document.querySelector('#generation-assets button')?.disabled === false);
  return button;
}
try {
  await server.listen(); const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ channel: process.env.BRAIPEN_BROWSER || 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }); page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
  await context.addInitScript(() => localStorage.setItem('braipen:intro-hidden', 'true'));
  await page.goto(origin + '/writing', { waitUntil: 'networkidle' });
  // Use the application's actual module URL; Windows Vite can expose /@id/ paths.
  moduleBase = await page.evaluate(() => performance.getEntriesByType('resource').find(r => r.name.endsWith('/src/localStore.ts'))?.name.replace(/localStore\.ts$/, ''));
  assert(moduleBase, 'Application storage module must be loaded before seeding');
  await page.goto(origin + '/__outline-entry');
  const ref = await seed('大纲入口验收');
  await page.evaluate(async () => { history.replaceState(null, '', '/writing?tab=assets'); await import('/src/main.tsx'); });
  await page.getByRole('textbox', { name: '主角', exact: true }).waitFor();
  await check('创作设定提供下一步入口，跳转不调用模型', async () => {
    await page.getByRole('button', { name: '下一步：准备大纲与人物卡', exact: true }).click();
    await generateButton(); assert.equal(calls.length, 0);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'generation-assets');
    assert.equal(await page.getByRole('button', { name: /生成这一章/ }).isDisabled(), true);
    assert(await page.evaluate(() => Boolean(document.querySelector('#generation-assets').compareDocumentPosition(document.querySelector('.generation-action-row')) & Node.DOCUMENT_POSITION_FOLLOWING)));
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.locator('#generation-assets').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(report, `outline-start-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
  });
  await check('空白小说大纲可直接导航到醒目的生成操作', async () => {
    await page.getByRole('tab', { name: '故事设定', exact: true }).click();
    await page.getByRole('tab', { name: '小说大纲', exact: true }).click();
    await page.getByRole('button', { name: '前往生成大纲与人物卡', exact: true }).click();
    await generateButton(); assert.equal(calls.length, 0);
  });
  await check('一次明确点击补齐大纲与人物卡，并自动展示生成的大纲', async () => {
    await (await generateButton()).click();
    await page.getByRole('tab', { name: '小说大纲', exact: true }).waitFor();
    await page.getByText('# 合成小说大纲', { exact: false }).waitFor();
    assert.deepEqual(calls.map(c => c.operation), ['generate_outline', 'generate_characters']);
    assert.equal(await page.getByRole('tab', { name: '小说大纲', exact: true }).getAttribute('aria-selected'), 'true');
    const saved = await project(ref);
    assert(saved.assets.outline.includes('合成小说大纲') && saved.assets.characters.includes('合成人物卡'));
    assert.equal(JSON.parse(await page.evaluate(() => window.savedWorkspace)).version, 5);
    await page.getByRole('tab', { name: 'AI 共创', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '生成这一章' && !b.disabled));
  });
  await check('已有大纲保留，只补齐缺少的人物卡', async () => {
    const partial = await seed('保留已有大纲', '作者手写大纲。');
    await (await generateButton()).click();
    await page.getByText('作者手写大纲。', { exact: true }).waitFor();
    assert.deepEqual(calls.map(c => c.operation), ['generate_outline', 'generate_characters', 'generate_characters']);
    const saved = await project(partial);
    assert.equal(saved.assets.outline, '作者手写大纲。');
  });
  await check('模型失败显示错误，不伪造大纲或自动重试', async () => {
    const failed = await seed('大纲失败验收'); failOutline = true;
    await page.getByRole('tab', { name: 'AI 共创', exact: true }).click();
    const before = calls.length; await (await generateButton()).click();
    await page.getByText('模拟大纲生成失败，请重试。', { exact: false }).waitFor();
    assert.equal(calls.length, before + 1);
    const saved = await project(failed);
    assert.equal(saved.assets.outline, ''); assert.equal(saved.assets.characters, '');
  });
  await check('桌面与手机入口完整可见，没有横向溢出', async () => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.locator('#generation-assets').scrollIntoViewIfNeeded();
      const size = await page.evaluate(() => ({ width: innerWidth, page: document.documentElement.scrollWidth }));
      assert(size.page <= size.width);
      assert((await page.locator('#generation-assets').getByRole('button').boundingBox()).height >= 44);
      await page.screenshot({ path: join(report, `outline-entry-${width}.png`) });
    }
  });
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
  await writeFile(join(report, 'browser.json'), JSON.stringify({ checks, paid_model_calls: 0, model_calls: calls.map(c => c.operation), external, errors, storage: 'isolated Edge; simulated file writer' }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, failed: 0, paid_model_calls: 0 }));
} catch (error) {
  await page?.screenshot({ path: join(report, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(join(report, 'failure.txt'), String(error.stack)); throw error;
} finally { await browser?.close(); await server.close(); }
