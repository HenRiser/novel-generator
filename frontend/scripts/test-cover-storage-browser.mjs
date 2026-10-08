// Real IndexedDB upgrade, atomic writes, guard revocation, quota failure, and byte-exact restore.
// Uses the existing Playwright runtime; never sends image requests or reads real credentials.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const runtime = process.env.BRAIPEN_PLAYWRIGHT_PATH;
const { chromium } = runtime ? await import(pathToFileURL(join(runtime, 'index.mjs')).href) : require('playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error',
  plugins: [{ name: 'cover-storage-check', configureServer(value) {
    value.middlewares.use('/__cover_storage', (_, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end('<!doctype html><title>封面存储验证</title><p>封面存储事务验证</p>'); });
  } }] });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: process.env.BRAIPEN_BROWSER || 'msedge', headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + '__cover_storage');
  assert.match(await page.textContent('body'), /封面存储事务验证/);
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  const result = await page.evaluate(async () => {
    const types = await import('/src/localTypes.ts');
    const original = types.emptyProject('真实封面事务');
    const legacy = types.emptyProject('旧提示词迁移');
    legacy.cover = { layout: { title: '旧封面', author: '', titleColor: '#ffffff', authorColor: '#ffffff', titlePosition: 'top', fontFamily: 'serif', titleSize: 10, authorSize: 3 },
      selected_id: 'old_cover', versions: [{ id: 'old_cover', media_id: 'old_media', prompt: 'INTERNAL_LEGACY_PROMPT', source: { idea: '旧设想', characters: '' },
        created_at: new Date().toISOString(), width: 1, height: 1, mime_type: 'image/png' }] };
    const pixel = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    // Seed the prior image schema, then validate physical prompt removal in DB4.
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('braipen.local.v1', 3);
      request.onupgradeneeded = () => { for (const [name, keyPath] of [['projects', 'project_ref'], ['settings', 'key'], ['imports', 'id']]) request.result.createObjectStore(name, { keyPath }); request.result.createObjectStore('cover_media', { keyPath: 'id' }).createIndex('project_ref', 'project_ref'); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { const db = request.result, tx = db.transaction(['projects','cover_media'], 'readwrite'); tx.objectStore('projects').add(original); tx.objectStore('projects').add(legacy); tx.objectStore('cover_media').add({ id: 'old_media', project_ref: legacy.project_ref, blob: new Blob([pixel], { type: 'image/png' }) }); tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error); };
    });
    const store = await import('/src/localStore.ts');
    const cover = await import('/src/coverStorage.ts');
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    let changed = 0;
    window.addEventListener('braipen:workflow-changed', () => changed++);
    const upgraded = await store.getProject(original.project_ref);
    check(!JSON.stringify(await store.getProject(legacy.project_ref)).includes('INTERNAL_LEGACY_PROMPT'), 'Legacy prompt must be removed by database upgrade');
    const migratedBackup = await store.createBackup();
    check(!JSON.stringify(migratedBackup).includes('INTERNAL_LEGACY_PROMPT'), 'Export must not retain a legacy prompt');
    check(migratedBackup.cover_media.length === 1, 'Legacy migration must preserve image bytes');
    await store.deleteProject(legacy.project_ref);
    check(!upgraded.cover, 'Prior projects acquire no artificial cover');
    const ref = original.project_ref;
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 240;
    const drawing = canvas.getContext('2d'); drawing.fillStyle = '#f00'; drawing.fillRect(0, 0, 160, 240);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const sourceBytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    const metadata = { width: 160, height: 240, style_id: 'cinematic', template_version: 1, text_model: 'text-model', source: { idea: '原始白话故事', characters: '原始人物卡' },
      connection: { profile_id: 'image_test', revision: 1, model: 'mock-image', preset: 'openai-images' } };
    const profile = { id: 'image_test', name: '事务测试', enabled: true, deleted: false, epoch: 0, key_version: 'mock-version', head: 1,
      revisions: [{ profile_id: 'image_test', revision: 1, model: 'mock-image', preset: 'openai-images', destination_fingerprint: 'mock-destination' }] };
    const guard = { profile_id: profile.id, epoch: 0, key_version: profile.key_version, destination_fingerprint: 'mock-destination' };
    await store.setSetting('connection:' + profile.id, profile);
    await cover.saveCoverConnection(ref, profile.id);
    await cover.saveCoverAttempt(ref, { id: 'attempt_first', status: 'running', started_at: new Date().toISOString() });
    await store.updateProject(ref, project => { project.assets.outline = '生成封面期间更新的正文大纲'; });
    const first = await cover.saveCoverVersion(ref, metadata, blob, guard);
    let saved = await store.getProject(ref);
    check(saved.revision === 1 && saved.assets.outline === '生成封面期间更新的正文大纲', 'Cover must merge current text without invalidating its revision');
    check(!saved.cover.attempt && !saved.cover.selected_id, 'Saving a candidate clears attempt without selecting it');
    check(saved.cover.connection_id === 'image_test' && saved.config.connection_id === 'legacy-deepseek', 'Cover connection must remain separate');
    await cover.selectCoverVersion(ref, first.id);
    const second = await cover.saveCoverVersion(ref, { ...metadata, style_id: 'ink', parent_id: first.id }, blob, guard);
    await cover.selectCoverVersion(ref, second.id);
    await cover.selectCoverVersion(ref, first.id);
    await cover.saveCoverLayout(ref, { ...saved.cover.layout, author: '测试作者', titlePosition: 'bottom', titleSize: 12 });
    saved = await store.getProject(ref);
    check(saved.cover.selected_id === first.id && saved.cover.versions[1].parent_id === first.id && saved.cover.layout.author === '测试作者', 'Selected version, edit lineage, rollback, and layout persist');
    check(JSON.stringify(Array.from(new Uint8Array(await (await cover.getCoverBlob(first.media_id)).arrayBuffer()))) === JSON.stringify(sourceBytes), 'Stored bytes match original bytes');

    await store.setSetting('connection:' + profile.id, { ...profile, enabled: false, epoch: 1 });
    let revoked = '';
    try { await cover.saveCoverVersion(ref, metadata, blob, guard); } catch (error) { revoked = error.message; }
    check(revoked.includes('连接已锁定'), 'Revoked guard must reject the commit');
    check((await store.getProject(ref)).cover.versions.length === 2, 'Revoked guard must leave no candidate');
    await store.setSetting('connection:' + profile.id, profile);

    const originalAdd = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args) { if (this.name === 'cover_media') throw new DOMException('mock quota', 'QuotaExceededError'); return originalAdd.apply(this, args); };
    let quota = '';
    try { await cover.saveCoverVersion(ref, metadata, blob, guard); } catch (error) { quota = error.message; }
    finally { IDBObjectStore.prototype.add = originalAdd; }
    check(quota.includes('存储空间不足') && (await store.getProject(ref)).cover.versions.length === 2, 'Quota failure must abort image plus metadata together');
    check(blob.size === sourceBytes.length, 'Caller retains downloadable original blob after quota failure');

    const batchProject = types.emptyProject('批次事务验证'); await store.putProject(batchProject);
    const textProfile = { ...profile, id: 'text_test', key_version: 'text-key-version', revisions: [{ ...profile.revisions[0], profile_id: 'text_test', destination_fingerprint: 'text-destination' }] };
    const textGuard = { profile_id: textProfile.id, epoch: 0, key_version: textProfile.key_version, destination_fingerprint: 'text-destination' };
    await store.setSetting('connection:' + textProfile.id, textProfile);
    await cover.saveCoverAttempt(batchProject.project_ref, { id: 'batch_attempt', status: 'running', started_at: new Date().toISOString(), requested: 4, completed: 0 });
    await cover.saveCoverVersion(batchProject.project_ref, metadata, blob, [guard, textGuard], { preserveAttempt: true, attemptId: 'batch_attempt' });
    check((await store.getProject(batchProject.project_ref)).cover.attempt.id === 'batch_attempt', 'Saving one image must not clear its remaining batch');
    await store.setSetting('connection:' + textProfile.id, { ...textProfile, epoch: 1 });
    let textRevoked = ''; try { await cover.saveCoverVersion(batchProject.project_ref, metadata, blob, [guard, textGuard], { preserveAttempt: true, attemptId: 'batch_attempt' }); } catch (error) { textRevoked = error.message; }
    check(textRevoked.includes('连接已锁定') && (await store.getProject(batchProject.project_ref)).cover.versions.length === 1, 'Text guard revocation must atomically prevent another image');
    await store.setSetting('connection:' + textProfile.id, textProfile);
    let staleBatch = ''; try { await cover.saveCoverVersion(batchProject.project_ref, metadata, blob, [guard, textGuard], { preserveAttempt: true, attemptId: 'other_attempt' }); } catch (error) { staleBatch = error.message; }
    check(staleBatch.includes('旧结果') && (await store.getProject(batchProject.project_ref)).cover.versions.length === 1, 'An old batch must not append to a replacement attempt');
    await cover.saveCoverVersion(batchProject.project_ref, metadata, blob, [guard, textGuard], { preserveAttempt: true, attemptId: 'batch_attempt' });
    await cover.saveCoverAttempt(batchProject.project_ref, { id: 'batch_attempt', status: 'unknown', started_at: new Date().toISOString(), requested: 4, completed: 2, error: '后续请求失败。' }, 'batch_attempt');
    check((await store.getProject(batchProject.project_ref)).cover.versions.length === 2, 'Partial batch failure must retain both paid candidates');
    check(!JSON.stringify(await store.getProject(batchProject.project_ref)).includes('"prompt"'), 'New candidate metadata must never contain prompt');
    await store.deleteProject(batchProject.project_ref);
    await cover.saveCoverPreferences(ref, { text_connection_id: textProfile.id, style_id: 'fantasy', count: 4 });

    await cover.saveCoverAttempt(ref, { id: 'attempt_pending', status: 'running', started_at: new Date().toISOString() });
    await cover.saveCoverAttempt(ref, { id: 'attempt_stale', status: 'unknown', started_at: new Date().toISOString() }, 'attempt_stale');
    check((await store.getProject(ref)).cover.attempt.id === 'attempt_pending', 'A stale failure must not overwrite a newer image attempt');
    await cover.saveCoverAttempt(ref, undefined, 'attempt_stale');
    check((await store.getProject(ref)).cover.attempt.id === 'attempt_pending', 'A stale cleanup must not clear a newer image attempt');
    const backup = await store.createBackup();
    check(backup.version === 3 && backup.cover_media.length === 2, 'Quota/revocation failures must leave no orphan media');
    const [copyRef] = await store.restoreBackup(JSON.stringify(backup));
    const copy = await store.getProject(copyRef);
    check(copy.cover.selected_id === copy.cover.versions[0].id && copy.cover.versions[1].parent_id === copy.cover.versions[0].id, 'Restore remaps selected and parent IDs');
    check(copy.cover.versions[0].id !== first.id && copy.cover.versions[0].media_id !== first.media_id, 'Restore assigns independent IDs');
    check(copy.cover.attempt.status === 'unknown', 'Restore never automatically repeats image generation');
    check(copy.cover.connection_id !== profile.id && copy.cover.versions[0].connection.profile_id === copy.cover.connection_id, 'Restore remaps image connection references');
    check((await store.getSetting('connection:' + copy.cover.connection_id)).enabled === false, 'Restored connection remains disabled');
    check(copy.cover.text_connection_id !== textProfile.id && (await store.getSetting('connection:' + copy.cover.text_connection_id)).enabled === false, 'Restore remaps text preparation connection references');
    check(JSON.stringify(Array.from(new Uint8Array(await (await cover.getCoverBlob(copy.cover.versions[0].media_id)).arrayBuffer()))) === JSON.stringify(sourceBytes), 'Restored image bytes match exactly');

    const damaged = structuredClone(backup); damaged.projects[0].cover.versions[0].width++;
    let dimensionError = '';
    try { await store.restoreBackup(JSON.stringify(damaged)); } catch (error) { dimensionError = error.message; }
    check(dimensionError.includes('尺寸') && (await store.listProjects()).length === 2, 'Invalid dimensions reject restore before writes');
    IDBObjectStore.prototype.add = function (...args) { if (this.name === 'cover_media') throw new DOMException('mock quota', 'QuotaExceededError'); return originalAdd.apply(this, args); };
    try { await store.restoreBackup(JSON.stringify(backup)); } catch (error) { quota = error.message; }
    finally { IDBObjectStore.prototype.add = originalAdd; }
    check(quota.includes('存储空间不足') && (await store.listProjects()).length === 2, 'Restore quota failure leaves no partial project or media');
    check((await store.createBackup()).cover_media.length === 4, 'Only committed original and restored media exist');
    await store.deleteProject(ref);
    let removed = false; try { await cover.getCoverBlob(first.media_id); } catch { removed = true; }
    check(removed && (await store.createBackup()).cover_media.length === 2, 'Deleting a project removes only its own media');
    return { changed, bytes: sourceBytes.length, quota, revoked, dimensions: dimensionError, remainingProjects: (await store.listProjects()).length };
  });
  assert.ok(result.changed >= 8);
  assert.equal(result.remainingProjects, 1);
  assert.deepEqual(errors, []);
  console.log('PASS real IndexedDB upgrade, candidate merge, selection/rollback/layout, guard revocation, atomic quota failure, byte-exact backup/restore, connection remapping, interrupted attempt, and cascade deletion');
  console.log(JSON.stringify(result));
} finally {
  if (browser) await browser.close();
  await server.close();
}
