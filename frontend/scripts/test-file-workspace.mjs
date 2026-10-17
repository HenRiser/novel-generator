import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryStyleStore } from './writing-style-test-helpers.mjs';

test('创作记录只进入工作区，浏览器仍保存连接与Key', async () => {
  const f = memoryStyleStore(), p = f.types.emptyProject('文件作品');
  await f.store.setSetting('vault:example', { secret: 'SYNTHETIC_ONLY' });
  await f.store.putProject(p);
  await f.store.saveWritingStyle(f.style.createWritingStyle('文风', '动作传情。'));
  await f.store.putImport('import_a', { id: 'import_a', schema_version: 1, title: '原文' });
  f.store.setWorkspaceDraft('chapter:1', { content: '待确认正文' });
  const backup = await f.store.createBackup();
  assert.equal(backup.version, 5); assert.equal(backup.projects.length, 1); assert.equal(backup.imports.length, 1);
  assert.equal(backup.drafts.length, 1); assert.equal(backup.writing_styles.length, 1);
  assert.equal(f.rows.projects.size, 0); assert.equal(f.rows.imports.size, 0); assert.equal(f.rows.cover_media.size, 0);
  assert.equal([...f.rows.settings.keys()].some(key => key.startsWith('writing-style:')), false);
  assert.equal(f.rows.settings.has('vault:example'), true);
  assert.equal(JSON.stringify(backup).includes('SYNTHETIC_ONLY'), false);
});

test('写盘失败不提交新版项目，重试后写入成功', async () => {
  const f = memoryStyleStore(), p = f.types.emptyProject('原项目');
  await f.store.putProject(p);
  let written;
  f.store.setWorkspaceWriter(async () => { throw new Error('磁盘写入失败'); });
  await assert.rejects(f.store.updateProject(p.project_ref, value => { value.title = '新项目'; }, 0), /磁盘|无法保存/);
  assert.equal((await f.store.getProject(p.project_ref)).title, '原项目');
  assert.equal((await f.store.getProject(p.project_ref)).revision, 0);
  f.store.setWorkspaceWriter(async snapshot => { written = structuredClone(snapshot); });
  await f.store.updateProject(p.project_ref, value => { value.title = '新项目'; }, 0);
  assert.equal(written.projects[0].title, '新项目');
  assert.equal((await f.store.getProject(p.project_ref)).revision, 1);
  assert.equal(f.store.workspaceHasUnsavedChanges(), false);
});

test('v5重新打开保留标识、修订、文风和编辑及导入草稿', async () => {
  const f = memoryStyleStore(), p = f.types.emptyProject('原作品');
  await f.store.putProject(p); await f.store.saveWritingStyle(f.style.createWritingStyle('风格', '短句。'));
  await f.store.putImport('import_a', { id: 'import_a', schema_version: 1, title: '来源' });
  f.store.setWorkspaceDraft('setting', { values: { protagonist: '主角' } });
  const snapshot = await f.store.createBackup(), fresh = memoryStyleStore();
  await fresh.store.openWorkspace(JSON.stringify(snapshot));
  const opened = await fresh.store.getProject(p.project_ref);
  assert.equal(opened.project_ref, p.project_ref); assert.equal(opened.revision, p.revision); assert.equal(opened.title, p.title);
  assert.equal((await fresh.store.listWritingStyles()).length, 1);
  assert.equal((await fresh.store.getImport('import_a')).title, '来源');
  assert.equal(fresh.store.getWorkspaceDraft('setting').values.protagonist, '主角');
  await fresh.store.openWorkspace(JSON.stringify(snapshot));
  assert.equal((await fresh.store.listProjects()).length, 1);
  assert.equal(fresh.rows.projects.size, 0);
});

test('非法v5拒绝打开，当前工作区保留', async () => {
  const f = memoryStyleStore(), p = f.types.emptyProject('保留');
  await f.store.putProject(p); const snapshot = await f.store.createBackup();
  snapshot.drafts = [{ name: 'untrusted', value: { text: '正文' } }];
  await assert.rejects(f.store.openWorkspace(JSON.stringify(snapshot)), /草稿/);
  assert.equal((await f.store.getProject(p.project_ref)).title, '保留');
});

test('旧库只读迁移，变更后拒绝清理，显式清理保留Key和偏好', async () => {
  const f = memoryStyleStore(), p = f.types.emptyProject('旧作品'), card = f.style.createWritingStyle('旧文风', '短句。');
  f.rows.projects.set(p.project_ref, p); f.rows.settings.set('writing-style:' + card.id, { key: 'writing-style:' + card.id, value: card });
  f.rows.settings.set('vault:a', { key: 'vault:a', value: { secret: 'SYNTHETIC_ONLY' } });
  f.rows.settings.set('default_model', { key: 'default_model', value: 'sample-model' });
  assert.equal((await f.store.listProjects()).length, 0);
  const old = await f.store.readLegacyWorkspace(), digest = await f.store.legacyWorkspaceDigest(old);
  assert.equal(old.projects.length, 1); assert.equal(f.rows.projects.size, 1);
  await f.store.openWorkspace(JSON.stringify(old));
  assert.equal((await f.store.getProject(p.project_ref)).title, '旧作品');
  f.rows.projects.get(p.project_ref).title = '旧库又改动';
  await assert.rejects(f.store.clearLegacyWorkspace(digest), /已发生变化/);
  const updated = await f.store.readLegacyWorkspace();
  await f.store.clearLegacyWorkspace(await f.store.legacyWorkspaceDigest(updated));
  assert.equal(f.rows.projects.size, 0);
  assert.equal(f.rows.settings.has('writing-style:' + card.id), false);
  assert.equal(f.rows.settings.has('vault:a'), true);
  assert.equal(f.rows.settings.get('default_model').value, 'sample-model');
});


test('损坏的文风编辑稿不能替换工作区，v5草稿不被恢复副本静默丢弃', async () => {
  const f = memoryStyleStore(), p = f.types.emptyProject('保留作品'); await f.store.putProject(p);
  f.store.setWorkspaceDraft('style-editor', { card: { rules: '半成品' } });
  const bad = await f.store.createBackup(); await assert.rejects(f.store.openWorkspace(JSON.stringify(bad)), /文风编辑草稿/);
  f.store.setWorkspaceDraft('style-editor', undefined); f.store.setWorkspaceDraft('qa', { text: '待确认内容' });
  const valid = await f.store.createBackup(); await assert.rejects(f.store.restoreBackup(JSON.stringify(valid)), /完整载入/);
  assert.equal((await f.store.getProject(p.project_ref)).title, '保留作品');
});

test('清理旧记录在同一事务内复核，拒绝读取后发生的并发修改', async () => {
  let armed = false, f;
  f = memoryStyleStore({ beforeBrowserWrite: () => { if (armed) { armed = false; f.rows.projects.get('book:bk_race').title = '清理前新增改动'; } } });
  const p = f.types.emptyProject('旧资料'); p.project_ref = 'book:bk_race'; f.rows.projects.set(p.project_ref, p);
  const snapshot = await f.store.readLegacyWorkspace(), digest = await f.store.legacyWorkspaceDigest(snapshot);
  armed = true;
  await assert.rejects(f.store.clearLegacyWorkspace(digest), /其他页面修改/);
  assert.equal(f.rows.projects.size, 1); assert.equal(f.rows.projects.get(p.project_ref).title, '清理前新增改动');
});
