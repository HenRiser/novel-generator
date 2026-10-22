// Real application UI with isolated storage and local-only model responses.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { providerFixtures, identity } from './provider-test-helpers.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url))).replaceAll('\\', '/');
const report = resolve(process.env.BRAIPEN_REPORT_DIR || join(root, '../reports/functional-audit-2026-10-23/planning-drafts-browser'));
const require = createRequire(import.meta.url), runtime = process.env.BRAIPEN_PLAYWRIGHT_PATH;
const { chromium } = runtime ? await import(pathToFileURL(join(runtime, 'index.mjs')).href) : require('playwright');
const fixtures = providerFixtures(root), calls = [], checks = [], errors = [], external = [];
let browser, page, moduleBase;
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
        if (operation === 'chapter_task') return json(res, { error: { message: '模拟规划草稿保存失败，请重试。' } }, 503);
        calls.push({ operation });
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
try {
  await server.listen(); const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ channel: process.env.BRAIPEN_BROWSER || 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }); page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
  await context.addInitScript(() => localStorage.setItem('braipen:intro-hidden', 'true'));
  await page.goto(origin + '/writing', { waitUntil: 'networkidle' });
  moduleBase = await page.evaluate(() => performance.getEntriesByType('resource').find(r => r.name.endsWith('/src/localStore.ts'))?.name.replace(/localStore\.ts$/, ''));
  assert(moduleBase);
  await page.goto(origin + '/__outline-entry');
  const ref = await seed('规划草稿验收', '合成大纲', '合成人物');
  async function renderReview() {
    await page.evaluate(async () => { history.replaceState(null, '', '/review?chapter=1'); await import('/src/main.tsx'); });
    await page.getByRole('textbox', { name: '备注', exact: true }).waitFor();
  }
  async function expectText(name, value) {
    await page.waitForFunction(({name, value}) => document.querySelector(`[aria-label="${name}"]`)?.value === value, { name, value });
  }
  async function moveChapter(number) {
    await page.getByRole('spinbutton', { name: '指定规划章节', exact: true }).fill(String(number));
    await page.waitForFunction(number => new URL(location.href).searchParams.get('chapter') === String(number), number);
  }
  await renderReview();
  await check('策划、任务单和场景未提交文字切章节后分别恢复', async () => {
    await page.getByRole('textbox', { name: '本章策划意图', exact: true }).fill('第一章：勇者拒绝带队');
    await page.getByRole('textbox', { name: '备注', exact: true }).fill('第一章任务单未提交文字');
    await page.getByRole('tab', { name: /02.*场景计划/ }).click();
    await page.getByRole('textbox', { name: '场景 1 · 场景标题', exact: true }).fill('旅馆里接受委托');
    await moveChapter(2); await expectText('本章策划意图', '');
    await page.getByRole('textbox', { name: '本章策划意图', exact: true }).fill('第二章独立意图');
    await moveChapter(1); await expectText('本章策划意图', '第一章：勇者拒绝带队');
    await expectText('备注', '第一章任务单未提交文字');
    await page.getByRole('tab', { name: /02.*场景计划/ }).click();
    await expectText('场景 1 · 场景标题', '旅馆里接受委托');
  });
  await check('规划保存失败保留编辑稿，可跨页面继续处理', async () => {
    await page.getByRole('tab', { name: /01.*章节任务单/ }).click();
    const editor = page.getByTestId('planning-task-editor');
    await editor.getByRole('button', { name: '保存草稿', exact: true }).click();
    await editor.getByRole('alert').filter({ hasText: /模拟规划草稿保存失败/ }).waitFor();
    await expectText('备注', '第一章任务单未提交文字');
  });
  await check('切去创作台再返回保留三个编辑器草稿', async () => {
    await page.getByRole('link', { name: /回到创作台/ }).click();
    await page.locator('a[href="/review"]').first().click();
    await expectText('本章策划意图', '第一章：勇者拒绝带队'); await expectText('备注', '第一章任务单未提交文字');
    await page.getByRole('tab', { name: /02.*场景计划/ }).click(); await expectText('场景 1 · 场景标题', '旅馆里接受委托');
  });
  await check('v5工作区往返恢复规划编辑稿，正式任务和场景仍未批准', async () => {
    const backup = await page.evaluate(async base => (await import(base + 'localStore.ts')).createBackup(), moduleBase);
    assert.equal(backup.version, 5); assert.equal(backup.drafts.length, 4);
    assert.deepEqual(Object.keys(backup.projects[0].chapter_tasks), []); assert.deepEqual(Object.keys(backup.projects[0].scene_plans), []);
    await page.goto(origin + '/__outline-entry');
    await page.evaluate(async ({base, backup, ref}) => {
      const store = await import(base + 'localStore.ts'); await store.openWorkspace(JSON.stringify(backup));
      (await import(base + 'store/useAppStore.ts')).useAppStore.getState().selectProject(ref);
    }, { base: moduleBase, backup, ref });
    await renderReview();
    await expectText('本章策划意图', '第一章：勇者拒绝带队'); await expectText('备注', '第一章任务单未提交文字');
    await page.getByRole('tab', { name: /02.*场景计划/ }).click(); await expectText('场景 1 · 场景标题', '旅馆里接受委托');
  });
  await check('正式规划已变化时保留旧编辑稿并阻止覆盖', async () => {
    await page.evaluate(async ({base, ref}) => {
      const store = await import(base + 'localStore.ts');
      const edited = store.getWorkspaceDraft('chapter-task:' + ref + ':1');
      await store.updateProject(ref, p => {
        const task = {...edited.form, id:'chapter_task_chapter_001_deadbeef', project_ref:ref, chapter_number:1, revision:1, status:'draft', notes:'另一份已保存内容'};
        p.chapter_tasks[1] = {ok:true,project_ref:ref,chapter_number:1,task,latest_draft:task,approved:null,history:[task]};
      });
    }, {base:moduleBase, ref});
    await moveChapter(2); await expectText('本章策划意图','第二章独立意图');
    await moveChapter(1); await expectText('备注','第一章任务单未提交文字');
    const editor = page.getByTestId('planning-task-editor');
    await editor.getByText('已恢复编辑稿，但已保存的规划发生变化。',{exact:true}).waitFor();
    assert.equal(await editor.getByRole('button',{name:'保存草稿',exact:true}).isDisabled(),true);
    await editor.getByRole('button',{name:'放弃编辑稿并载入最新规划',exact:true}).click();
    await expectText('备注','另一份已保存内容');
  });
  await check('无外部请求、无模型调用、无页面异常', async () => {
    assert.equal(calls.length,0); assert.deepEqual(external,[]); assert.deepEqual(errors,[]);
  });
  await page.screenshot({path:join(report,'planning-drafts.png'),fullPage:true});
  await writeFile(join(report,'result.json'),JSON.stringify({passed:checks.length,checks,errors,external,modelCalls:calls.length},null,2));
  console.log(`${checks.length} planning draft browser scenarios passed`);
} finally {await browser?.close();await server.close();}
