// Isolated Edge profile, actual application UI/IndexedDB/canvas. No keys or model calls.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';

const require = createRequire(import.meta.url), runtime = process.env.BRAIPEN_PLAYWRIGHT_PATH;
const { chromium } = runtime ? await import(pathToFileURL(join(runtime, 'index.mjs')).href) : require('playwright');
const root = fileURLToPath(new URL('../', import.meta.url)), report = resolve(process.env.BRAIPEN_REPORT_DIR || join(root, '../reports/cover-upload-2026-10-08'));
await mkdir(report, { recursive: true });
const server = await createServer({ root, define: { 'import.meta.env.VITE_API_BASE_URL': '""' }, logLevel: 'error', server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'cover-upload-check', configureServer(value) { value.middlewares.use('/__cover_upload', (_, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>local upload setup</title>'); }); } }] });
let browser, page, projectRef;
const results = [], pageErrors = [], writes = [], external = [];
async function step(name, task) { try { await task(); results.push({ name, status: 'passed' }); console.log('PASS ' + name); } catch (error) { results.push({ name, status: 'failed', error: error.message }); await page?.screenshot({ path: join(report, 'upload-failure.png'), fullPage: true }).catch(() => {}); throw error; } }
try {
  await server.listen(); const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ channel: process.env.BRAIPEN_BROWSER || 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, hasTouch: true }); page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await context.addInitScript(() => localStorage.setItem('braipen:intro-hidden', 'true'));
  await context.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort('blockedbyclient'); } return route.continue(); });
  await context.route('**/api/**', route => {
    const request = route.request();
    if (request.method() !== 'GET') writes.push({ method: request.method(), path: new URL(request.url()).pathname });
    if (request.url().endsWith('/health')) return route.fulfill({ json: { status: 'ok' } });
    return route.fulfill({ json: { protocol_version: 2, providers: [], image_providers: [], supported_protocols: ['chat_completions'] } });
  });
  await page.goto(origin + '/__cover_upload');
  const fixture = await page.evaluate(async () => {
    const store = await import('/src/localStore.ts'), types = await import('/src/localTypes.ts'), preferences = await import('/src/workspacePreferences.ts');
    const p = types.emptyProject('本地上传与裁剪验收', { raw_story_idea: '本地上传不读取或发送故事材料。' });
    p.assets.characters = '本地原始人物卡'; p.assets.outline = '本地原始大纲'; await store.putProject(p); preferences.rememberProject(p.project_ref);
    const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 300;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#173d59'; ctx.fillRect(0, 0, 200, 300);
    const firstBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const first = await store.saveCoverVersion(p.project_ref, { origin: 'model', source: { idea: '原始模型候选', characters: '' }, width: 200, height: 300 }, firstBlob); await store.selectCoverVersion(p.project_ref, first.id);
    await store.saveCoverAttempt(p.project_ref, { id: 'preserved_attempt', status: 'unknown', started_at: new Date().toISOString(), requested: 1, completed: 0, error: '合成未完成任务，仅用于本地保存验证。' });
    canvas.width = 600; canvas.height = 450;
    ctx.fillStyle = '#bc382a'; ctx.fillRect(0, 0, 300, 450); ctx.fillStyle = '#245dae'; ctx.fillRect(300, 0, 300, 450);
    ctx.fillStyle = '#f5d67d'; ctx.fillRect(150, 100, 300, 230);
    const files = {};
    for (const mime of ['image/png', 'image/jpeg', 'image/webp']) { const blob = await new Promise(resolve => canvas.toBlob(resolve, mime)); files[mime] = Array.from(new Uint8Array(await blob.arrayBuffer())); }
    return { ref: p.project_ref, firstId: first.id, files };
  });
  projectRef = fixture.ref;
  const project = () => page.evaluate(async ref => (await import('/src/localStore.ts')).getProject(ref), projectRef);
  const waitCount = count => page.evaluate(async ({ ref, count }) => {
    const store = await import('/src/localStore.ts');
    for (let tries = 0; tries < 300; tries++) { if ((await store.getProject(ref)).cover.versions.length === count) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('candidate count did not become ' + count);
  }, { ref: projectRef, count });
  const waitSelected = id => page.evaluate(async ({ ref, id }) => {
    const store = await import('/src/localStore.ts');
    for (let tries = 0; tries < 300; tries++) { if ((await store.getProject(ref)).cover.selected_id === id) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('selected candidate did not become ' + id);
  }, { ref: projectRef, id });
  const upload = (mime, data = fixture.files[mime], name = 'synthetic-upload.' + mime.split('/')[1]) => page.getByLabel('上传封面图片', { exact: true }).setInputFiles({ name, mimeType: mime, buffer: Buffer.from(data) });
  const editor = () => page.getByRole('group', { name: '2:3 封面裁剪框', exact: true });
  const save = () => page.getByRole('button', { name: '保存裁剪为候选 · 本地', exact: true }).click();
  const before = await project();
  await page.goto(origin + '/writing'); await page.getByRole('tab', { name: '作品封面', exact: true }).click();
  await page.getByLabel('上传封面图片', { exact: true }).waitFor({ state: 'visible' });

  await step('上传PNG显示固定2:3框；鼠标拖动和键盘滑块移动均保持边界', async () => {
    await upload('image/png'); await editor().waitFor({ state: 'visible' });
    let bounds = await editor().boundingBox(); assert.ok(Math.abs(bounds.width / bounds.height - 2 / 3) < .01);
    const scale = page.getByRole('slider', { name: '裁剪范围', exact: true }); await scale.focus(); await scale.press('Home'); await scale.press('ArrowRight');
    assert.equal(await scale.inputValue(), '21');
    await editor().scrollIntoViewIfNeeded(); bounds = await editor().boundingBox(); const startLeft = bounds.x;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down(); await page.mouse.move(1400, bounds.y + 20); await page.mouse.up();
    assert.equal(Number(await page.getByRole('slider', { name: '裁剪水平位置', exact: true }).inputValue()), 100);
    await editor().focus(); await editor().press('ArrowLeft'); assert.ok(Number(await page.getByRole('slider', { name: '裁剪水平位置', exact: true }).inputValue()) < 100);
    bounds = await editor().boundingBox(); assert.ok(bounds.x > startLeft); assert.ok(Math.abs(bounds.width / bounds.height - 2 / 3) < .02);
    await page.screenshot({ path: join(report, 'upload-crop-desktop.png'), fullPage: true });
    await page.locator('.cover-upload').screenshot({ path: join(report, 'upload-crop-desktop-detail.png') });
    assert.equal((await project()).cover.versions.length, 1);
  });
  await step('取消上传不写入、不更换现有已采用封面', async () => {
    await page.getByRole('button', { name: '取消裁剪', exact: true }).click(); await editor().waitFor({ state: 'hidden' });
    const p = await project(); assert.equal(p.cover.selected_id, fixture.firstId); assert.equal(p.cover.versions.length, 1);
  });
  await step('PNG/JPEG/WebP都可存为本地PNG候选；采用和任务状态保持', async () => {
    for (const [index, mime] of ['image/png', 'image/jpeg', 'image/webp'].entries()) {
      await upload(mime); await editor().waitFor({ state: 'visible' }); await save(); await waitCount(index + 2); await editor().waitFor({ state: 'hidden' });
      const p = await project(), version = p.cover.versions.at(-1); assert.equal(version.origin, 'upload'); assert.equal(version.mime_type, 'image/png'); assert.equal(version.width * 3, version.height * 2);
      assert.deepEqual(version.source, { idea: '', characters: '' }); assert.equal(version.connection, undefined); assert.equal(version.text_model, undefined); assert.equal(version.style_id, undefined); assert.equal(version.template_version, undefined);
      assert.equal(p.cover.selected_id, fixture.firstId); assert.equal(p.cover.attempt.id, 'preserved_attempt'); assert.equal(p.revision, before.revision); assert.deepEqual(p.assets, before.assets);
    }
  });
  await step('当前预览可再次裁剪，保存父子候选且旧字节和已采用封面保留', async () => {
    const parent = (await project()).cover.versions.at(-1);
    await page.getByRole('button', { name: '裁剪当前预览 · 本地', exact: true }).click(); await editor().waitFor({ state: 'visible' });
    await page.getByRole('slider', { name: '裁剪范围', exact: true }).focus(); await page.getByRole('slider', { name: '裁剪范围', exact: true }).press('Home'); await save(); await waitCount(5);
    const p = await project(); assert.equal(p.cover.versions.at(-1).parent_id, parent.id); assert.equal(p.cover.selected_id, fixture.firstId); assert.equal(p.cover.versions.length, 5);
    assert.ok(await page.evaluate(async id => (await (await import('/src/localStore.ts')).getCoverBlob(id)).size > 0, parent.media_id));
    await page.getByRole('button', { name: '设为作品封面', exact: true }).click();
    await waitSelected(p.cover.versions.at(-1).id);
    await page.getByRole('button', { name: '预览图片版本 1', exact: true }).click(); await page.getByRole('button', { name: '设为作品封面', exact: true }).click();
    await waitSelected(fixture.firstId);
  });
  await step('手机EXIF方向6 JPEG按方向显示，输出PNG固化正确方向', async () => {
    const raw = Buffer.from(fixture.files['image/jpeg']), exif = Buffer.from('ffe1002245786966000049492a0008000000010012010300010000000600000000000000', 'hex');
    await upload('image/jpeg', Buffer.concat([raw.subarray(0, 2), exif, raw.subarray(2)]), 'synthetic-phone-rotated.jpg'); await editor().waitFor({ state: 'visible' });
    await page.getByText(/上传原图：450 × 600/).waitFor({ state: 'visible' });
    const displayed = await page.evaluate(async () => {
      const img = document.querySelector('.cover-crop-stage img'); await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
      const { coverCropRect, initialCoverCrop } = await import('/src/coverCrop.ts'); const rect = coverCropRect(canvas.width, canvas.height, initialCoverCrop);
      return { width: canvas.width, height: canvas.height, top: Array.from(ctx.getImageData(rect.x + 20, rect.y + 20, 1, 1).data), bottom: Array.from(ctx.getImageData(rect.x + 20, rect.y + rect.height - 20, 1, 1).data) };
    });
    assert.equal(displayed.width, 450); assert.equal(displayed.height, 600);
    await page.screenshot({ path: join(report, 'upload-phone-exif-display.png'), fullPage: true });
    await save(); await waitCount(6);
    const pixels = await page.evaluate(async ref => {
      const store = await import('/src/localStore.ts'), p = await store.getProject(ref), version = p.cover.versions.at(-1), blob = await store.getCoverBlob(version.media_id), bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
      return { width: canvas.width, height: canvas.height, top: Array.from(ctx.getImageData(20, 20, 1, 1).data), bottom: Array.from(ctx.getImageData(20, canvas.height - 20, 1, 1).data) };
    }, projectRef);
    assert.equal(pixels.width, 400); assert.equal(pixels.height, 600);
    assert.equal(pixels.width * 3, pixels.height * 2); assert.ok(pixels.top[0] > pixels.top[2], JSON.stringify(pixels)); assert.ok(pixels.bottom[2] > pixels.bottom[0], JSON.stringify(pixels));
    assert.ok(pixels.top.every((value, index) => Math.abs(value - displayed.top[index]) <= 2)); assert.ok(pixels.bottom.every((value, index) => Math.abs(value - displayed.bottom[index]) <= 2));
  });
  await step('另一标签页持有同名封面锁时拒绝保存，原候选、裁剪图和任务保留', async () => {
    await upload('image/png'); await editor().waitFor({ state: 'visible' });
    const second = await context.newPage(); await second.goto(origin + '/__cover_upload');
    await second.evaluate(ref => { window.heldCoverLock = navigator.locks.request('braipen:cover:' + ref, () => new Promise(resolve => { window.releaseCoverLock = resolve; })); }, projectRef);
    await second.waitForFunction(() => typeof window.releaseCoverLock === 'function');
    try {
      await save(); await page.getByText(/另一个标签页生成或保存封面/).waitFor({ state: 'visible' });
      const p = await project(); assert.equal(p.cover.versions.length, 6); assert.equal(p.cover.selected_id, fixture.firstId); assert.equal(p.cover.attempt.id, 'preserved_attempt'); assert.equal(await editor().count(), 1);
    } finally { await second.evaluate(() => window.releaseCoverLock()); await second.close(); }
    await page.getByRole('button', { name: '取消裁剪', exact: true }).click();
  });
  await step('裁剪及存储复验解码挂起后离开作品页，卸载组件阻止旧结果写入', async () => {
    for (const heldDecode of [1, 3]) {
      await upload('image/png'); await editor().waitFor({ state: 'visible' });
      await page.evaluate(heldDecode => { window.originalCropBitmap = window.createImageBitmap; window.cropDecodeCount = 0; window.heldCropDecode = heldDecode; window.finishedCropBitmap = false; delete window.releaseCropBitmap; window.createImageBitmap = async (...args) => {
      if (++window.cropDecodeCount === window.heldCropDecode) { await new Promise(resolve => { window.releaseCropBitmap = resolve; }); }
      const result = await window.originalCropBitmap(...args); window.finishedCropBitmap = window.cropDecodeCount === window.heldCropDecode; return result;
      }; }, heldDecode);
    await save(); await page.waitForFunction(() => typeof window.releaseCropBitmap === 'function');
    await page.getByRole('link', { name: /创作概览/ }).click();
    await page.evaluate(() => window.releaseCropBitmap()); await page.waitForFunction(() => window.finishedCropBitmap === true);
    await page.waitForTimeout(150); assert.equal((await project()).cover.versions.length, 6);
    await page.evaluate(() => { window.createImageBitmap = window.originalCropBitmap; delete window.originalCropBitmap; });
    await page.getByRole('link', { name: /创作台/ }).click(); await page.getByRole('tab', { name: '作品封面', exact: true }).click(); await page.getByLabel('上传封面图片', { exact: true }).waitFor({ state: 'visible' });
    }
  });
  await step('空、伪装、损坏、SVG、超容量和超尺寸文件不产生候选', async () => {
    const huge = Buffer.from(fixture.files['image/png']); huge.writeUInt32BE(16385, 16);
    const corrupt = Buffer.from(fixture.files['image/png']); corrupt[corrupt.length - 8] ^= 255;
    const cases = [
      ['image/png', Buffer.alloc(0), /8 MiB/], ['image/jpeg', fixture.files['image/png'], /类型.*不一致/], ['image/png', fixture.files['image/png'].slice(0, 40), /损坏|解码/],
      ['image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), /PNG、JPEG 或 WebP/], ['image/png', Buffer.alloc(8 * 1024 * 1024 + 1), /8 MiB/], ['image/png', huge, /尺寸过大/],
    ];
    for (const [mime, bytes, expected] of cases) { await upload(mime, bytes, 'synthetic-invalid.bin'); await page.getByText(expected).last().waitFor({ state: 'visible' }); assert.equal((await project()).cover.versions.length, 6); assert.equal(await editor().count(), 0); }
  });
  await step('390px手机滑块与触摸pointer可框选，页面无水平溢出', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await upload('image/png'); await editor().waitFor({ state: 'visible' });
    const scale = page.getByRole('slider', { name: '裁剪范围', exact: true }); await scale.focus(); await scale.press('Home');
    await editor().scrollIntoViewIfNeeded(); const box = await editor().boundingBox(); const session = await context.newCDPSession(page);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.round(box.x + box.width / 2 + 35), y: Math.round(box.y + box.height / 2) }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.ok(Number(await page.getByRole('slider', { name: '裁剪水平位置', exact: true }).inputValue()) > 50);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)); await page.screenshot({ path: join(report, 'upload-crop-mobile.png'), fullPage: true });
    await page.locator('.cover-upload').screenshot({ path: join(report, 'upload-crop-mobile-detail.png') });
    await page.getByRole('button', { name: '取消裁剪', exact: true }).click(); await page.setViewportSize({ width: 1440, height: 1100 });
  });
  await step('刷新保留版本、选中项；v3备份恢复重映射父子版本并逐字节保留PNG', async () => {
    await page.reload(); await page.getByRole('tab', { name: '作品封面', exact: true }).click(); await page.getByLabel('上传封面图片', { exact: true }).waitFor({ state: 'visible' });
    const p = await project(); assert.equal(p.cover.versions.length, 6); assert.equal(p.cover.selected_id, fixture.firstId);
    const restored = await page.evaluate(async ref => {
      const store = await import('/src/localStore.ts'), original = await store.getProject(ref), backup = await store.createBackup(), refs = await store.restoreBackup(JSON.stringify(backup)), copy = await store.getProject(refs[0]);
      const bytesEqual = await Promise.all(original.cover.versions.map(async (version, index) => {
        const originalBytes = Array.from(new Uint8Array(await (await store.getCoverBlob(version.media_id)).arrayBuffer())), newBytes = Array.from(new Uint8Array(await (await store.getCoverBlob(copy.cover.versions[index].media_id)).arrayBuffer())); return JSON.stringify(originalBytes) === JSON.stringify(newBytes);
      }));
      return { version: backup.version, copy, bytesEqual };
    }, projectRef);
    assert.equal(restored.version, 3); assert.equal(restored.copy.cover.versions.length, 6); assert.ok(restored.bytesEqual.every(Boolean));
    assert.notEqual(restored.copy.cover.versions[0].id, fixture.firstId); assert.equal(restored.copy.cover.selected_id, restored.copy.cover.versions[0].id);
    assert.equal(restored.copy.cover.versions[4].parent_id, restored.copy.cover.versions[3].id); assert.equal(restored.copy.cover.versions[5].origin, 'upload');
    await page.screenshot({ path: join(report, 'upload-restored-desktop.png'), fullPage: true });
  });
  await step('浏览器没有WebLocks时仍可纯本地保存，IndexedDB保持候选和已采用封面', async () => {
    await upload('image/png'); await editor().waitFor({ state: 'visible' });
    await page.evaluate(() => Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }));
    try { await save(); await waitCount(7); const p = await project(); assert.equal(p.cover.selected_id, fixture.firstId); assert.equal(p.cover.versions.at(-1).origin, 'upload'); }
    finally { await page.evaluate(() => delete navigator.locks); }
  });
  await step('原生IndexedDB配额异常拒绝候选且保留裁剪图，达到30版本前检拒绝读取', async () => {
    await upload('image/png'); await editor().waitFor({ state: 'visible' });
    await page.evaluate(() => { window.originalCoverAdd = IDBObjectStore.prototype.add; IDBObjectStore.prototype.add = function (...args) { if (this.name === 'cover_media') throw new DOMException('synthetic quota', 'QuotaExceededError'); return window.originalCoverAdd.apply(this, args); }; });
    await save(); await page.getByText(/存储空间不足/).waitFor({ state: 'visible' }); assert.equal((await project()).cover.versions.length, 7); assert.equal(await editor().count(), 1);
    await page.evaluate(() => { IDBObjectStore.prototype.add = window.originalCoverAdd; delete window.originalCoverAdd; }); await page.getByRole('button', { name: '取消裁剪', exact: true }).click();
    await page.evaluate(async ref => { const store = await import('/src/localStore.ts'); let p = await store.getProject(ref); const version = p.cover.versions[1], blob = await store.getCoverBlob(version.media_id); while (p.cover.versions.length < 30) { await store.saveCoverVersion(ref, { origin: 'upload', source: { idea: '', characters: '' }, width: version.width, height: version.height }, blob, undefined, { preserveAttempt: true }); p = await store.getProject(ref); } }, projectRef);
    await upload('image/png'); await page.getByText(/本作品最多保存 30 个版本/).last().waitFor({ state: 'visible' }); assert.equal((await project()).cover.versions.length, 30); assert.equal(await editor().count(), 0);
  });
  assert.deepEqual(writes, []); assert.deepEqual(pageErrors, []); assert.equal(await page.locator('vite-error-overlay').count(), 0);
  console.log('PASS ' + results.length + ' local upload/crop UI scenarios; zero API writes');
} finally {
  await writeFile(join(report, 'upload-browser-results.json'), JSON.stringify({ results, network_writes: writes, external_requests: external, pageErrors, credentials: 'none', paid_calls: 0 }, null, 2));
  await writeFile(join(report, 'upload-browser-log.txt'), results.map(result => `${result.status.toUpperCase()} ${result.name}${result.error ? ': ' + result.error : ''}`).join('\n') + `\nAPI writes: ${writes.length}; external requests: ${external.length}; page errors: ${pageErrors.length}; credentials: none\n`);
  await browser?.close(); await server.close();
}
