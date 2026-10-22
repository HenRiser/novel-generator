// Real Edge OPFS handles and IndexedDB. Only the system directory picker is substituted.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createServer } from 'vite';

const require = createRequire(import.meta.url), runtime = process.env.BRAIPEN_PLAYWRIGHT_PATH;
const { chromium } = runtime ? await import(pathToFileURL(join(runtime, 'index.mjs')).href) : require('playwright');
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '');
const output = join(root, '..', 'reports', 'functional-review-2026-10-23', 'storage-opfs');
const results = [], errors = [], externalRequests = [];
const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'native-workspace-storage', configureServer(value) {
    value.middlewares.use('/__native_workspace', (_, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><meta charset="utf-8"><title>本机工作区原生文件 API 验证</title><h1>原生 OPFS 文件读写验证</h1><p>仅合成数据；系统目录选择弹窗未覆盖。</p>');
    });
  } }] });
let browser, receipt;
try {
  await mkdir(output, { recursive: true }); await server.listen();
  browser = await chromium.launch({ channel: process.env.BRAIPEN_BROWSER || 'msedge', headless: true });
  const context = await browser.newContext(), url = server.resolvedUrls.local[0], origin = new URL(url).origin;
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    externalRequests.push(route.request().url()); return route.abort();
  });
  await context.addInitScript(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('synthetic-file-workspace-v5', { create: true });
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(url + '__native_workspace');
  const first = await page.evaluate(async () => {
    const store = await import('/src/localStore.ts'), sync = await import('/src/localFolderSync.ts');
    const types = await import('/src/localTypes.ts'), styles = await import('/src/writingStyle.ts');
    const handle = await window.showDirectoryPicker();
    if (!(handle instanceof FileSystemDirectoryHandle)) throw new Error('Not a native directory handle');
    const project = types.emptyProject('原生文件验证作品'); project.assets.setting_expansion = '合成设定：勇者归乡。';
    project.chapters['1'] = { chapter_number: 1, title: '归乡', filename: '第1章.txt', content: '这是合成正文。', revision: 'synthetic-rev-1', versions: [], workflow: { status: 'awaiting_confirmation', summary_status: 'not_requested', review_status: 'not_requested' } };
    await store.putProject(project);
    await store.setSetting('vault:opfs-test', { secret: 'OPFS_SYNTHETIC_PRIVATE_SENTINEL' });
    await store.saveWritingStyle(styles.createWritingStyle('合成文风卡', '动作表现情绪。'));
    await store.putImport('opfs_import', { title: '合成导入草稿' });
    store.setWorkspaceDraft('opfs-editor', { content: '未确认合成编辑稿' });
    const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 3;
    canvas.getContext('2d').fillRect(0, 0, 2, 3);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const cover = await store.saveCoverVersion(project.project_ref, { origin: 'upload', source: { idea: '', characters: '' }, width: 2, height: 3 }, blob);
    await sync.chooseLocalFolder();
    const fileHandle = await handle.getFileHandle(sync.LOCAL_FOLDER_FILE);
    const text = await (await fileHandle.getFile()).text(), data = JSON.parse(text);
    return { ref: project.project_ref, mediaId: cover.media_id, nativeDirectory: handle instanceof FileSystemDirectoryHandle,
      nativeFile: fileHandle instanceof FileSystemFileHandle, nativeCreateWritable: String(FileSystemFileHandle.prototype.createWritable).includes('[native code]'),
      permission: await handle.queryPermission({ mode: 'readwrite' }), version: data.version,
      containsSecret: text.includes('OPFS_SYNTHETIC_PRIVATE_SENTINEL'), coverBytes: blob.size,
      status: sync.getLocalFolderSyncState().status, dirty: store.workspaceHasUnsavedChanges(), projectsInFile: data.projects.length, draftsInFile: data.drafts.length,
      storeResources: performance.getEntriesByType('resource').map(item => item.name).filter(name => name.includes('localStore')) };
  });
  assert.equal(first.nativeDirectory, true); assert.equal(first.nativeFile, true); assert.equal(first.nativeCreateWritable, true);
  assert.equal(first.projectsInFile, 1); assert.equal(first.draftsInFile, 1); assert.equal(first.storeResources.length, 1, 'Test must use one production localStore module instance');
  assert.equal(first.permission, 'granted'); assert.equal(first.version, 5); assert.equal(first.status, 'synced'); assert.equal(first.dirty, false, JSON.stringify(first)); assert.equal(first.containsSecret, false);
  results.push('原生 OPFS 目录、文件及 createWritable/close/getFile 完成 v5 首次保存，Key 排除');

  const edited = await page.evaluate(async ref => {
    const store = await import('/src/localStore.ts'), sync = await import('/src/localFolderSync.ts');
    await store.updateProject(ref, value => { value.assets.outline = '原生文件保存的新大纲'; value.chapters['1'].content = '更新后的合成正文。'; });
    const text = await (await (await window.showDirectoryPicker()).getFileHandle(sync.LOCAL_FOLDER_FILE)).getFile().then(file => file.text());
    return { saved: JSON.parse(text).projects[0], dirty: store.workspaceHasUnsavedChanges() };
  }, first.ref);
  assert.equal(edited.saved.assets.outline, '原生文件保存的新大纲'); assert.equal(edited.dirty, false);
  results.push('编辑更新实际写入文件并回读，保存状态与内容一致');

  await page.reload();
  const reopened = await page.evaluate(async ({ ref, mediaId }) => {
    const store = await import('/src/localStore.ts'), sync = await import('/src/localFolderSync.ts');
    const emptyBeforeOpen = (await store.listProjects()).length;
    await sync.chooseLocalFolder();
    const data = await store.createBackup(), project = await store.getProject(ref), blob = await store.getCoverBlob(mediaId);
    const database = await new Promise((resolve, reject) => { const request = indexedDB.open('braipen.local.v1', 4); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const nativeCounts = await Promise.all(['projects', 'imports', 'cover_media'].map(name => new Promise((resolve, reject) => {
      const tx = database.transaction([name], 'readonly'), request = tx.objectStore(name).count(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    })));
    database.close();
    return { emptyBeforeOpen, project, styles: data.writing_styles.length, imports: data.imports.length, drafts: data.drafts, coverBytes: blob.size, nativeCounts,
      keyRetained: (await store.getSetting('vault:opfs-test')).secret === 'OPFS_SYNTHETIC_PRIVATE_SENTINEL' };
  }, first);
  assert.equal(reopened.emptyBeforeOpen, 0); assert.equal(reopened.project.project_ref, first.ref); assert.equal(reopened.project.revision, edited.saved.revision);
  assert.equal(reopened.project.chapters['1'].content, '更新后的合成正文。'); assert.equal(reopened.styles, 1); assert.equal(reopened.imports, 1);
  assert.equal(reopened.drafts[0].value.content, '未确认合成编辑稿'); assert.equal(reopened.coverBytes, first.coverBytes);
  assert.deepEqual(reopened.nativeCounts, [0, 0, 0]); assert.equal(reopened.keyRetained, true);
  results.push('刷新后内存为空，重新打开恢复原标识、修订、正文、设定、文风卡、封面与草稿');
  results.push('真实 IndexedDB 创作表保持为空，配置 Key 保留');

  const conflict = await page.evaluate(async ref => {
    const store = await import('/src/localStore.ts'), sync = await import('/src/localFolderSync.ts');
    const handle = await (await window.showDirectoryPicker()).getFileHandle(sync.LOCAL_FOLDER_FILE);
    const before = await (await handle.getFile()).text(), external = JSON.parse(before); external.projects[0].title = '外部程序的合成改动';
    const changed = JSON.stringify(external), writer = await handle.createWritable({ keepExistingData: false, mode: 'exclusive' }); await writer.write(changed); await writer.close();
    let message = ''; try { await store.updateProject(ref, p => { p.title = '页面内尚未保存的新稿'; }); } catch (error) { message = error.message; }
    const preserved = await (await handle.getFile()).text(), candidate = await store.createBackup(), dirty = store.workspaceHasUnsavedChanges();
    const repair = await handle.createWritable({ mode: 'exclusive' }); await repair.write(before); await repair.close();
    await sync.syncLocalFolderNow();
    return { message, externalPreserved: preserved === changed, pendingTitle: candidate.projects[0].title, dirty,
      savedTitle: JSON.parse(await (await handle.getFile()).text()).projects[0].title, afterRetryDirty: store.workspaceHasUnsavedChanges() };
  }, first.ref);
  assert.match(conflict.message, /外部修改/); assert.equal(conflict.externalPreserved, true); assert.equal(conflict.dirty, true);
  assert.equal(conflict.pendingTitle, '页面内尚未保存的新稿'); assert.equal(conflict.savedTitle, conflict.pendingTitle); assert.equal(conflict.afterRetryDirty, false);
  results.push('原生外部写入冲突被拒绝，外部文件保留，候选新稿可下载');
  results.push('测试恢复原字节后，重试写入候选稿并清除未保存状态');

  const exclusive = await page.evaluate(async ref => {
    const store = await import('/src/localStore.ts'), sync = await import('/src/localFolderSync.ts');
    const handle = await (await window.showDirectoryPicker()).getFileHandle(sync.LOCAL_FOLDER_FILE), held = await handle.createWritable({ mode: 'exclusive' });
    let failure = ''; try { await store.updateProject(ref, p => { p.title = '原生独占锁后重试'; }); } catch (error) { failure = error.name; }
    const dirty = store.workspaceHasUnsavedChanges(); await held.abort(); await sync.syncLocalFolderNow();
    return { failure, dirty, title: JSON.parse(await (await handle.getFile()).text()).projects[0].title, status: sync.getLocalFolderSyncState().status };
  }, first.ref);
  assert.ok(exclusive.failure); assert.equal(exclusive.dirty, true); assert.equal(exclusive.title, '原生独占锁后重试'); assert.equal(exclusive.status, 'synced');
  results.push('原生 exclusive 文件锁阻止并发写入，释放锁后重试成功');
  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  receipt = { success: true, browser: browser.version(), storage: 'Native Edge OPFS FileSystemDirectoryHandle/FileSystemFileHandle',
    picker: 'Only showDirectoryPicker substituted with isolated OPFS directory; OS permission dialog not tested',
    cases: results, counts: { passed: results.length, pageErrors: errors.length, externalRequests: externalRequests.length, paidCalls: 0 }, first, exclusive };
  await page.evaluate(values => { const list = document.createElement('ol'); for (const value of values) { const item = document.createElement('li'); item.textContent = '通过：' + value; list.appendChild(item); } document.body.appendChild(list); }, results);
  await page.screenshot({ path: join(output, 'native-opfs.png'), fullPage: true });
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  receipt = { success: false, cases: results, error: String(error?.stack || error), errors, externalRequests }; throw error;
} finally {
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
  await browser?.close(); await server.close();
}
