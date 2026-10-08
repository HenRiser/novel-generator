// End-to-end UI checks use synthetic credentials, real local IndexedDB and canvas,
// and mocked compute responses. No upstream image or text API is contacted.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { identity } from './provider-test-helpers.mjs';

const require = createRequire(import.meta.url), runtime = process.env.BRAIPEN_PLAYWRIGHT_PATH;
const { chromium } = runtime ? await import(pathToFileURL(join(runtime, 'index.mjs')).href) : require('playwright');
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]+$/, ''), projectRoot = resolve(root, '..');
const python = process.env.BRAIPEN_TEST_PYTHON || resolve(projectRoot, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
function pythonJson(code, value) {
  const result = spawnSync(python, ['-c', code], { cwd: projectRoot, input: JSON.stringify(value), encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  if (result.status !== 0) throw new Error(result.stderr); return JSON.parse(result.stdout);
}
const catalog = pythonJson('import json; from provider_catalog import catalog; from image_provider import image_catalog; from cover_generation import capabilities; print(json.dumps({"protocol_version":2,"providers":catalog(),"supported_protocols":["chat_completions","messages"],"image_providers":image_catalog(),"cover_generation":capabilities()}))');
const normalize = raw => pythonJson('import json,sys; from image_provider import normalize_image_connection; print(json.dumps(normalize_image_connection(json.load(sys.stdin))))', raw);
const normalizeText = raw => pythonJson('import json,sys; from provider_catalog import normalize_connection; print(json.dumps(normalize_connection(json.load(sys.stdin))))', raw);
const fingerprint = (payload, operation) => pythonJson('import json,sys; from provider_catalog import request_fingerprint; p=json.load(sys.stdin); print(json.dumps(request_fingerprint(p["connection"],p["operation"],p["input"])))', { connection: payload.connection, operation, input: payload.input });
const report = resolve(process.env.BRAIPEN_REPORT_DIR || resolve(projectRoot, 'reports/controlled-cover-workflow-2026-10-08'));
await mkdir(report, { recursive: true });
const server = await createServer({ root, define: { 'import.meta.env.VITE_API_BASE_URL': '""' }, logLevel: 'error', server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'cover-test', configureServer(s) { s.middlewares.use('/__cover_test', (_, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>cover test setup</title>'); }); } }] });
await server.listen();
const origin = server.resolvedUrls.local[0].replace(/\/$/, ''), browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true }), page = await context.newPage();
const results = [], requests = [], pageErrors = [], consoleErrors = [];
const IMAGE_WIDTH = 1000, IMAGE_HEIGHT = 1500;
let imageData, projectRef, profileId, textProfileId, modelsEmpty = false, abortNext = false, coverMode = 'full', releaseHeld;
page.on('pageerror', error => pageErrors.push(error.message));
page.on('console', event => { if (event.type() === 'error') consoleErrors.push(event.text()); });
await context.addInitScript(() => localStorage.setItem('braipen:intro-hidden', 'true'));
await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
await context.route('**/api/**', async route => {
  const url = route.request().url();
  if (url.endsWith('/health')) return route.fulfill({ json: { status: 'ok' } });
  if (url.endsWith('/capabilities')) return route.fulfill({ json: catalog });
  if (!url.includes('/api/compute/')) throw new Error('Unexpected compute API request: ' + url);
  const payload = route.request().postDataJSON(), operation = url.split('/').at(-1);
  requests.push({ operation, payload });
  if (operation === 'validate_connection') {
    assert.deepEqual(payload.credentials, {});
    const connection = url.includes('/images/') ? normalize(payload.connection) : normalizeText(payload.connection);
    return route.fulfill({ json: { ...identity(payload), protocol_version: 2, destination_fingerprint: connection.destination_fingerprint, execution_fingerprint: connection.execution_fingerprint, result: { connection } } });
  }
  assert.equal(payload.request_fingerprint, fingerprint(payload, url.includes('/cover/') ? 'cover_' + operation : operation));
  assert.equal(payload.credentials.api_key, 'SYNTHETIC_IMAGE_UI_KEY');
  if (operation === 'models') return route.fulfill({ json: { ...identity(payload), result: modelsEmpty ? { models: [], catalog_supported: false } : { models: [{ id: 'org/mock-image:cover', name: '合成图片模型' }], catalog_supported: true } } });
  assert.ok(['generate', 'edit'].includes(operation)); assert.equal(payload.input.size, '2K');
  assert.ok(url.includes('/images/cover/')); assert.equal(payload.credentials.text_api_key, 'SYNTHETIC_TEXT_UI_KEY');
  assert.equal(payload.input.prompt, undefined); assert.deepEqual(Object.keys(payload.input.source).sort(), ['characters', 'idea']);
  if (abortNext) { abortNext = false; return route.abort('failed'); }
  const base = { ...identity(payload), text_destination_fingerprint: payload.input.text_connection.destination_fingerprint, text_execution_fingerprint: payload.input.text_connection.execution_fingerprint, event_version: 1 };
  const events = [{ type: 'started', requested: payload.input.count }, { type: 'text_started' }, { type: 'text_done' }];
  for (let index = 0; index < payload.input.count; index++) {
    events.push({ type: 'image_started', index }, { type: 'image', index, result: { image: { ...imageData[operation === 'edit' ? 1 : 0], width: IMAGE_WIDTH, height: IMAGE_HEIGHT, mime_type: 'image/png' }, model: payload.connection.model, text_model: payload.input.text_connection.model, style_id: payload.input.style_id, template_version: 1 } });
    if (coverMode === 'partial') { events.push({ type: 'error', code: 'image_failed', status: 502, message: '合成第2张失败，已完成的候选已保留。', completed: index + 1, requested: payload.input.count }); break; }
  }
  if (coverMode !== 'partial') events.push({ type: 'done', completed: payload.input.count, requested: payload.input.count });
  if (coverMode === 'hold') await new Promise(resolve => { releaseHeld = resolve; });
  return route.fulfill({ contentType: 'application/x-ndjson', body: events.map((value, index) => JSON.stringify({ ...base, seq: index + 1, ...value })).join('\n') + '\n' }).catch(error => { if (!/Target.*closed|Invalid InterceptionId|Route is already handled|Request.*handled/i.test(error.message)) throw error; });
});
const paidCalls = () => requests.filter(r => ['generate', 'edit'].includes(r.operation));
async function step(name, task) {
  try { await task(); results.push({ name, status: 'passed' }); console.log('PASS ' + name); }
  catch (error) { results.push({ name, status: 'failed', error: error.message }); await page.screenshot({ path: join(report, 'failure.png'), fullPage: true }).catch(() => {}); throw error; }
}
async function load() {
  await page.evaluate(async () => {
    window.store = await import('/src/localStore.ts'); window.pc = await import('/src/providerConnections.ts'); window.ic = await import('/src/imageConnections.ts');
    window.wait = async predicate => { for (let i = 0; i < 300; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('condition timed out'); };
  });
}
async function project() { return page.evaluate(ref => store.getProject(ref), projectRef); }
async function rendered(selector, maxDimension = 1024) { await page.waitForFunction(({ selector, maxDimension }) => { const canvas = document.querySelector(selector); return canvas?.dataset.rendered === 'true' && canvas.width > 0 && canvas.height > 0 && Math.max(canvas.width, canvas.height) <= maxDimension && Math.abs(canvas.width / canvas.height - 2 / 3) < .002; }, { selector, maxDimension }); }
async function nav(name) { await page.getByRole('link', { name: new RegExp(name) }).click(); }
async function capture(filename) {
  await page.waitForFunction(() => document.querySelectorAll('.ant-message-notice').length === 0);
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.mouse.move(0, 0); await page.screenshot({ path: join(report, filename), fullPage: true });
}
try {
  await page.goto(origin + '/__cover_test'); await load();
  ({ projectRef, imageData } = await page.evaluate(async ({ width, height }) => {
    const { emptyProject } = await import('/src/localTypes.ts'), preferences = await import('/src/workspacePreferences.ts');
    const p = emptyProject('取反合成封面故事', { raw_story_idea: '合成白话设定：修钟青年发现影子来自未来。' });
    p.assets.characters = '人物卡：青年江舟，谨慎而执着。'; p.assets.outline = 'DO_NOT_UPLOAD_THIS_OUTLINE';
    await store.putProject(p); preferences.rememberProject(p.project_ref);
    await pc.ensureConnections(); await pc.storeConnectionKey('legacy-deepseek', 'SYNTHETIC_TEXT_UI_KEY');
    const imageData = ['#204b8a', '#aa4326'].map(color => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d'), gradient = context.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, color); gradient.addColorStop(1, '#17201f'); context.fillStyle = gradient; context.fillRect(0, 0, width, height);
      context.fillStyle = '#e5d6ab'; context.beginPath(); context.arc(width / 2, height * 5 / 12, width * 3 / 16, 0, Math.PI * 2); context.fill();
      return { data_base64: canvas.toDataURL('image/png').split(',')[1] };
    });
    return { projectRef: p.project_ref, imageData };
  }, { width: IMAGE_WIDTH, height: IMAGE_HEIGHT }));
  await step('图片设置query直达、四预设与建议模型无需 Key 直接可见', async () => {
    await page.goto(origin + '/settings?tab=images'); await load();
    await page.getByRole('heading', { name: '偏好设置', exact: true }).waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('tab', { name: '图片模型连接', exact: true }).getAttribute('aria-selected'), 'true');
    await page.getByRole('button', { name: '选择图片模型 doubao-seedream-5-0-flash-260915', exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('combobox', { name: '图片服务商', exact: true }).click();
    for (const preset of catalog.image_providers) await page.getByTitle(preset.name, { exact: true }).last().waitFor({ state: 'visible' });
    await page.getByTitle('自定义地址', { exact: true }).last().click();
    assert.equal(paidCalls().length, 0); assert.equal(requests.length, 0);
  });
  await step('Custom保存不带Key，实际模型目录直接展示可选，空目录支持手填', async () => {
    await page.getByLabel('图片连接名称', { exact: true }).fill('合成图片连接');
    await page.getByLabel('图片 API 服务地址', { exact: true }).fill('https://mock-images.example/v1');
    await page.getByRole('combobox', { name: '默认图片模型 ID', exact: true }).fill('org/manual-image');
    await page.getByLabel('图片连接 API Key', { exact: true }).fill('SYNTHETIC_IMAGE_UI_KEY');
    await page.getByRole('button', { name: '保存图片连接', exact: true }).click();
    await page.evaluate(() => wait(async () => (await ic.imageConnections()).some(p => p.name === '合成图片连接')));
    profileId = await page.evaluate(async () => (await ic.imageConnections()).find(p => p.name === '合成图片连接').id);
    await page.getByRole('button', { name: '获取图片模型列表', exact: true }).click();
    await page.getByRole('button', { name: '选择图片模型 org/mock-image:cover', exact: true }).click();
    assert.equal((await page.evaluate(id => pc.getConnection(id), profileId)).head, 1);
    await page.getByRole('button', { name: '保存图片连接', exact: true }).click();
    await page.evaluate(id => wait(async () => (await pc.getConnection(id)).head === 2), profileId);
    modelsEmpty = true;
    await page.getByRole('button', { name: '获取图片模型列表', exact: true }).click();
    await page.getByText('此服务未提供可用模型目录，请手动填写模型 ID。', { exact: true }).waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('combobox', { name: '默认图片模型 ID', exact: true }).inputValue(), 'org/mock-image:cover');
    assert.equal(paidCalls().length, 0);
    await capture('image-connections-desktop.png');
    await page.setViewportSize({ width: 390, height: 844 }); await capture('image-connections-mobile.png');
    const mobileWidth = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth, overflow: Array.from(document.querySelectorAll('body *')).map(e => ({ tag: e.tagName, className: e.className, right: e.getBoundingClientRect().right, width: e.getBoundingClientRect().width })).filter(e => e.right > innerWidth + 2).slice(0, 12) }));
    assert.ok(mobileWidth.width <= mobileWidth.viewport + 2, JSON.stringify(mobileWidth));
    await page.setViewportSize({ width: 1440, height: 1100 });
  });
  await step('选择已保存文字连接和五种风格，生成4张只发送保存的故事材料', async () => {
    textProfileId = await page.evaluate(async () => {
      const base = await pc.legacySnapshot();
      const profile = await pc.saveConnection('合成封面整理连接', { ...base, profile_id: crypto.randomUUID() });
      await pc.storeConnectionKey(profile.id, 'SYNTHETIC_TEXT_UI_KEY'); return profile.id;
    });
    await nav('创作台'); await page.getByRole('tab', { name: '作品封面', exact: true }).click();
    const configBefore = (await project()).config;
    await page.getByRole('combobox', { name: '封面文字连接', exact: true }).click(); await page.getByTitle('合成封面整理连接', { exact: true }).last().click();
    for (const style of catalog.cover_generation.styles) await page.getByRole('button', { name: `封面风格：${style.label}`, exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '封面风格：轻小说插画', exact: true }).click();
    await page.getByRole('combobox', { name: '封面候选张数', exact: true }).click(); await page.getByTitle('4 张', { exact: true }).last().click();
    assert.equal(await page.getByLabel('完整封面生成描述', { exact: true }).count(), 0); assert.equal(await page.getByLabel('封面视觉要求', { exact: true }).count(), 0); assert.equal(await page.getByLabel('原图修改要求', { exact: true }).count(), 0);
    await page.getByRole('button', { name: '生成候选图片 · 调用模型', exact: true }).click();
    await page.evaluate(ref => wait(async () => (await store.getProject(ref)).cover?.versions.length === 4 && !(await store.getProject(ref)).cover?.attempt), projectRef);
    const p = await project(); assert.equal(p.cover.selected_id, undefined); assert.equal(p.cover.versions[0].width, IMAGE_WIDTH);
    const request = paidCalls()[0]; assert.equal(request.operation, 'generate'); assert.equal(request.payload.input.image, undefined);
    assert.equal(request.payload.input.count, 4); assert.equal(request.payload.input.style_id, 'anime'); assert.equal(request.payload.input.source.idea, p.config.raw_story_idea); assert.equal(request.payload.input.source.characters, p.assets.characters); assert.ok(!JSON.stringify(request.payload).includes('DO_NOT_UPLOAD_THIS_OUTLINE'));
    assert.deepEqual(p.config, configBefore); assert.equal(p.cover.text_connection_id, textProfileId); assert.equal(p.cover.style_id, 'anime'); assert.equal(p.cover.count, 4); assert.ok(p.cover.versions.every(v => v.style_id === 'anime' && v.template_version === 1 && !('prompt' in v)));
    await rendered('.cover-result canvas'); await rendered('.cover-version-grid canvas', 384); await capture('cover-generated.png');
    await page.getByRole('button', { name: '预览图片版本 1', exact: true }).click();
  });
  await step('采用候选后，概览和阅读页使用真实canvas显示作品封面', async () => {
    await page.getByRole('button', { name: '设为作品封面', exact: true }).click();
    await page.evaluate(ref => wait(async () => !!(await store.getProject(ref)).cover?.selected_id), projectRef);
    await nav('创作概览'); await rendered('.book-card .book-cover canvas', 512); await capture('dashboard-cover.png');
    await nav('阅读空间'); await rendered('.reader-cover canvas', 512); await capture('reader-cover.png');
    assert.equal(paidCalls().length, 1);
  });
  await step('修改封面书名与作者只重绘本地canvas，没有生图调用', async () => {
    await nav('创作台'); await page.getByRole('tab', { name: '作品封面', exact: true }).click(); await rendered('.cover-result canvas');
    const before = await page.locator('.cover-result canvas').evaluate(canvas => canvas.toDataURL());
    await page.getByLabel('封面书名', { exact: true }).fill('换一个封面书名'); await page.getByLabel('封面作者', { exact: true }).fill('合成作者');
    await page.getByRole('button', { name: '保存排版 · 不调用模型', exact: true }).click();
    await page.evaluate(ref => wait(async () => (await store.getProject(ref)).cover.layout.title === '换一个封面书名'), projectRef);
    await page.waitForFunction(before => document.querySelector('.cover-result canvas')?.toDataURL() !== before, before);
    assert.equal(paidCalls().length, 1); await capture('cover-typography.png');
  });
  await step('原图编辑携带已保存PNG，生成子版本且不覆盖旧版本', async () => {
    await page.getByRole('combobox', { name: '封面候选张数', exact: true }).click(); await page.getByTitle('1 张', { exact: true }).last().click();
    await page.getByRole('combobox', { name: '原图修改目标', exact: true }).click(); await page.getByTitle('增强光影', { exact: true }).last().click();
    await page.getByRole('button', { name: '修改预览图片 · 调用模型', exact: true }).click();
    await page.evaluate(ref => wait(async () => (await store.getProject(ref)).cover.versions.length === 5 && !(await store.getProject(ref)).cover.attempt), projectRef);
    const p = await project(); assert.equal(p.cover.versions[4].parent_id, p.cover.versions[0].id); assert.equal(p.cover.selected_id, p.cover.versions[0].id);
    const request = paidCalls().at(-1); assert.equal(request.operation, 'edit'); assert.equal(request.payload.input.image.mime_type, 'image/png'); assert.equal(request.payload.input.image.data_base64, imageData[0].data_base64);
    assert.equal(request.payload.input.edit_kind, 'lighting');
    await rendered('.cover-result canvas'); await page.getByRole('button', { name: '设为作品封面', exact: true }).click();
    await page.evaluate(ref => wait(async () => { const p = await store.getProject(ref); return p.cover.selected_id === p.cover.versions[4].id; }), projectRef);
    await capture('cover-edited.png');
  });
  await step('主预览限制1024px，导出含文字PNG保留1000×1500原尺寸', async () => {
    await rendered('.cover-result canvas');
    const exportButton = page.getByRole('button', { name: /导出含文字封面$/ });
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), exportButton.click()]);
    const output = join(report, 'mock-composed-cover.png');
    await download.saveAs(output);
    const png = await readFile(output);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), IMAGE_WIDTH); assert.equal(png.readUInt32BE(20), IMAGE_HEIGHT);
    assert.equal(paidCalls().length, 2);
  });
  await step('版本回退只改变已采用版本，旧原图及源故事材料保持不变', async () => {
    await page.getByRole('button', { name: '预览图片版本 1', exact: true }).click();
    await page.getByRole('button', { name: '设为作品封面', exact: true }).click();
    await page.evaluate(ref => wait(async () => { const p = await store.getProject(ref); return p.cover.selected_id === p.cover.versions[0].id; }), projectRef);
    const p = await project(); assert.equal(p.cover.versions.length, 5); assert.equal(p.assets.outline, 'DO_NOT_UPLOAD_THIS_OUTLINE'); assert.equal(p.assets.characters, '人物卡：青年江舟，谨慎而执着。'); assert.equal(paidCalls().length, 2);
  });
  await step('批次第2张失败仍保存第1张，失败状态记录1/4且不重试', async () => {
    coverMode = 'partial';
    await page.getByRole('combobox', { name: '封面候选张数', exact: true }).click(); await page.getByTitle('4 张', { exact: true }).last().click();
    await page.getByRole('button', { name: '生成候选图片 · 调用模型', exact: true }).click();
    await page.evaluate(ref => wait(async () => (await store.getProject(ref)).cover.attempt?.status === 'unknown'), projectRef);
    const p = await project(); assert.equal(p.cover.versions.length, 6); assert.equal(p.cover.attempt.completed, 1); assert.equal(p.cover.attempt.requested, 4); assert.match(p.cover.attempt.error, /已保存 1\/4/);
    await page.waitForTimeout(300); assert.equal(paidCalls().length, 3); await capture('cover-partial.png'); coverMode = 'full';
  });
  for (const kind of ['stop', 'image', 'text']) await step(`挂起批次${kind === 'stop' ? '用户停止' : kind === 'image' ? '图片Key撤销' : '文字Key撤销'}阻止旧结果保存`, async () => {
    coverMode = 'hold'; releaseHeld = undefined;
    const before = paidCalls().length;
    await page.getByRole('button', { name: '生成候选图片 · 调用模型', exact: true }).click();
    for (let tries = 0; tries < 300 && !releaseHeld; tries++) await page.waitForTimeout(20);
    assert.ok(releaseHeld); assert.equal(paidCalls().length, before + 1);
    if (kind === 'stop') await page.getByRole('button', { name: '停止封面生成', exact: true }).click();
    else await page.evaluate(id => pc.manageConnection(id, 'lock'), kind === 'image' ? profileId : textProfileId);
    await page.evaluate(ref => wait(async () => (await store.getProject(ref)).cover.attempt?.status === 'unknown'), projectRef);
    releaseHeld(); releaseHeld = undefined; coverMode = 'full';
    await page.waitForTimeout(150); assert.equal((await project()).cover.versions.length, 6); assert.equal(paidCalls().length, before + 1);
    if (kind !== 'stop') await page.evaluate(({ id, key }) => pc.storeConnectionKey(id, key), { id: kind === 'image' ? profileId : textProfileId, key: kind === 'image' ? 'SYNTHETIC_IMAGE_UI_KEY' : 'SYNTHETIC_TEXT_UI_KEY' });
  });
  await step('网络中断结果标记未知，收费请求不自动重试，刷新仍保留封面版本', async () => {
    abortNext = true;
    await page.getByRole('button', { name: '生成候选图片 · 调用模型', exact: true }).click();
    await page.evaluate(ref => wait(async () => (await store.getProject(ref)).cover.attempt?.status === 'unknown'), projectRef);
    await page.waitForTimeout(300); assert.equal(paidCalls().length, 7); assert.equal((await project()).cover.versions.length, 6);
    assert.match((await project()).cover.attempt.error, /图片连接中断/);
    await page.reload(); await load(); await page.getByRole('tab', { name: '作品封面', exact: true }).click(); await rendered('.cover-result canvas');
    const p = await project(); assert.equal(p.cover.versions.length, 6); assert.equal(p.cover.selected_id, p.cover.versions[0].id); assert.equal(p.cover.layout.title, '换一个封面书名'); assert.equal(p.cover.layout.author, '合成作者');
    assert.equal(p.cover.text_connection_id, textProfileId); assert.equal(p.cover.count, 4); assert.equal(p.cover.style_id, 'anime');
    await page.getByText('上次封面任务未完成', { exact: true }).waitFor({ state: 'visible' }); assert.equal(paidCalls().length, 7);
    await capture('cover-restored.png');
    await page.setViewportSize({ width: 390, height: 844 }); await capture('cover-mobile.png');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
    assert.deepEqual(pageErrors, []); assert.ok(!await page.locator('vite-error-overlay').count());
  });
  await step('容量前检 existing+count：29版本不能再生成4张，不提交请求', async () => {
    await page.evaluate(async ref => {
      let p = await store.getProject(ref); const { getCoverBlob } = await import('/src/coverStorage.ts'), blob = await getCoverBlob(p.cover.versions[0].media_id);
      const first = p.cover.versions[0], metadata = { source: first.source, width: first.width, height: first.height, style_id: first.style_id, template_version: 1, text_model: first.text_model, connection: first.connection };
      while (p.cover.versions.length < 29) { await store.saveCoverVersion(ref, metadata, blob); p = await store.getProject(ref); }
    }, projectRef);
    const before = paidCalls().length; await page.getByRole('button', { name: '生成候选图片 · 调用模型', exact: true }).click();
    await page.getByText(/本作品最多保存 30 个版本/).waitFor({ state: 'visible' }); assert.equal(paidCalls().length, before); assert.equal((await project()).cover.versions.length, 29);
  });
  console.log('PASS ' + results.length + ' cover UI scenarios');
} finally {
  await writeFile(join(report, 'cover-workflow.json'), JSON.stringify({ results, request_counts: { total: requests.length, image_generation_or_edit: paidCalls().length }, pageErrors, consoleErrors }, null, 2));
  await browser.close(); await server.close();
}
