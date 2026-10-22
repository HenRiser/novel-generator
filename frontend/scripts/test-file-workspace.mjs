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
  assert.equal(f.store.workspaceHasUnsavedChanges(), true);
  assert.equal((await f.store.createBackup()).projects[0].title, '新项目');
  f.store.setWorkspaceWriter(async snapshot => { written = structuredClone(snapshot); });
  await f.store.flushWorkspace();
  assert.equal(written.projects[0].title, '新项目');
  assert.equal((await f.store.getProject(p.project_ref)).revision, 1);
  assert.equal(f.store.workspaceHasUnsavedChanges(), false);
});

test('失败候选不可被后续更新覆盖，普通下载合并最新编辑稿，重试保留修订校验', async () => {
  const f = memoryStyleStore(), p = f.types.emptyProject('原项目'); await f.store.putProject(p);
  f.store.setWorkspaceWriter(async () => { throw new Error('磁盘故障'); });
  await assert.rejects(f.store.updateProject(p.project_ref, value => { value.assets.outline = '完整新大纲'; }, 0));
  await assert.rejects(f.store.updateProject(p.project_ref, value => { value.title = '后续覆盖'; }, 0), /重试保存/);
  f.store.setWorkspaceDraft('qa', { content: '失败后继续编辑的正文' });
  const backup = await f.store.createBackup();
  assert.equal(backup.projects[0].assets.outline, '完整新大纲'); assert.equal(backup.projects[0].title, '原项目');
  assert.equal(backup.drafts[0].value.content, '失败后继续编辑的正文');
  let written; f.store.setWorkspaceWriter(async value => { written = value; });
  await f.store.flushWorkspace();
  assert.equal(written.drafts[0].value.content, '失败后继续编辑的正文');
  assert.equal((await f.store.getProject(p.project_ref)).revision, 1);
  await assert.rejects(f.store.updateProject(p.project_ref, value => { value.title = '陈旧编辑'; }, 0), /已在另一处更新/);
  assert.equal(f.store.workspaceHasUnsavedChanges(), false);
});

test('重试写盘期间新增草稿仍标记待保存，下一次保存才清除', async () => {
  const f = memoryStyleStore(), p = f.types.emptyProject('原项目'); await f.store.putProject(p);
  f.store.setWorkspaceWriter(async () => { throw new Error('磁盘故障'); });
  await assert.rejects(f.store.updateProject(p.project_ref, value => { value.title = '新项目'; }));
  let release, writing; const started = new Promise(resolve => { writing = resolve; });
  f.store.setWorkspaceWriter(async () => { writing(); await new Promise(resolve => { release = resolve; }); });
  const retry = f.store.flushWorkspace(); await started;
  f.store.setWorkspaceDraft('qa', { content: '写入中的新编辑' }); release(); await retry;
  assert.equal(f.store.workspaceHasUnsavedChanges(), true);
  f.store.setWorkspaceWriter(async () => {}); await f.store.flushWorkspace();
  assert.equal(f.store.workspaceHasUnsavedChanges(), false);
});

test('删除作品同一提交清理所属草稿，失败可重试且其他作品草稿保留', async () => {
  const f = memoryStyleStore(), p = f.types.emptyProject('删除'), other = f.types.emptyProject('保留');
  await f.store.putProject(p); await f.store.putProject(other);
  const owned = ['setting:' + p.project_ref, 'style-source:' + p.project_ref,
    'braipen:chapter-draft:' + JSON.stringify([p.project_ref, 1]), 'asset-editor:' + JSON.stringify([p.project_ref, 'outline']),
    ...['chapter-task:', 'scene-plan:', 'chapter-planning:'].map(prefix => prefix + p.project_ref + ':1')];
  for (const key of [...owned, 'setting:' + other.project_ref, 'global']) f.store.setWorkspaceDraft(key, { content: key });
  f.store.setWorkspaceWriter(async () => { throw new Error('磁盘故障'); });
  await assert.rejects(f.store.deleteProject(p.project_ref));
  assert.ok(f.store.getWorkspaceDraft(owned[0])); assert.equal((await f.store.listProjects()).length, 2);
  const candidate = await f.store.createBackup(); assert.equal(candidate.projects.length, 1); assert.equal(candidate.drafts.length, 2);
  let disk; f.store.setWorkspaceWriter(async value => { disk = value; }); await f.store.flushWorkspace();
  assert.equal(disk.projects.length, 1); assert.equal(disk.drafts.length, 2);
  assert.equal(f.store.getWorkspaceDraft(owned[0]), undefined); assert.ok(f.store.getWorkspaceDraft('setting:' + other.project_ref));
});

test('打开工作区最终替换前复核未保存更新，失败候选需明确允许替换', async () => {
  const f = memoryStyleStore(), p = f.types.emptyProject('旧作品'), target = memoryStyleStore();
  await f.store.putProject(p); f.store.setWorkspaceWriter(async () => {}); await f.store.flushWorkspace();
  const targetText = JSON.stringify(await target.store.createBackup());
  f.store.setWorkspaceWriter(async () => { throw new Error('磁盘故障'); });
  const failed = f.store.updateProject(p.project_ref, value => { value.title = '必须保留'; });
  const opened = f.store.openWorkspace(targetText);
  await assert.rejects(failed); await assert.rejects(opened, /未保存/);
  assert.equal((await f.store.createBackup()).projects[0].title, '必须保留');
  await f.store.openWorkspace(targetText, true);
  assert.equal((await f.store.listProjects()).length, 0); assert.equal(f.store.hasRescue(), false);
});

test('旧工作区导入异步结果不能写入新工作区或污染应急副本', async () => {
  const f = memoryStyleStore(), oldEpoch = f.store.getWorkspaceEpoch();
  const empty = JSON.stringify(await f.store.createBackup());
  await f.store.openWorkspace(empty);
  await assert.rejects(f.store.putImport('late_import', { title: '旧小说' }, undefined, oldEpoch), /工作区已切换/);
  await assert.rejects(f.store.commitImport('late_import', f.types.emptyProject('迟到提交'), oldEpoch), /工作区已切换/);
  assert.equal((await f.store.listImports()).length, 0); assert.equal(f.store.hasRescue(), false);
  assert.equal(f.store.workspaceHasUnsavedChanges(), false);
  await f.store.putImport('current_import', { title: '新工作区导入' }, undefined, f.store.getWorkspaceEpoch());
  assert.equal((await f.store.listImports()).length, 1);
});

test('切换真正执行前复查当前工作区的任务，不拒绝载入文件中的旧运行状态', async () => {
  for (const kind of ['run', 'batch', 'cover']) {
    const f = memoryStyleStore(), p = f.types.emptyProject('当前作品'); await f.store.putProject(p);
    f.store.setWorkspaceWriter(async () => {}); await f.store.flushWorkspace();
    const empty = JSON.stringify(await memoryStyleStore().store.createBackup());
    let started, release; const entered = new Promise(resolve => { started = resolve; });
    f.store.setWorkspaceWriter(async () => { started(); await new Promise(resolve => { release = resolve; }); });
    const begin = kind === 'cover' ? f.store.saveCoverAttempt(p.project_ref, { id: 'attempt_test', status: 'running', started_at: new Date().toISOString() }) : f.store.updateProject(p.project_ref, value => {
      if (kind === 'run') value.runs.push({ run_id: 'run_test', input: {}, status: 'running' });
      else value.batch.status = 'running';
    });
    await entered;
    let bindingChanged = false;
    const change = f.store.openWorkspace(empty, true, () => { bindingChanged = true; });
    release(); await begin; await assert.rejects(change, /正在运行/);
    assert.equal(bindingChanged, false); assert.equal((await f.store.listProjects()).length, 1);
    await assert.rejects(f.store.changeWorkspaceBinding(() => { bindingChanged = true; }), /正在运行/);
    const runningSnapshot = await f.store.createBackup(), fresh = memoryStyleStore();
    await fresh.store.openWorkspace(JSON.stringify(runningSnapshot));
    const recovered = (await fresh.store.listProjects())[0];
    assert.equal(recovered.project_ref, p.project_ref); assert.equal(recovered.revision, runningSnapshot.projects[0].revision);
    if (kind === 'run') assert.equal(recovered.runs[0].status, 'interrupted');
    if (kind === 'batch') assert.equal(recovered.batch.status, 'stopped');
    if (kind === 'cover') assert.equal(recovered.cover.attempt.status, 'unknown');
    await fresh.store.openWorkspace(empty);
    assert.equal((await fresh.store.listProjects()).length, 0);
  }
});

test('真实活动在取消清理完成前阻止切换，释放幂等且不会清除新工作区任务', async () => {
  const f = memoryStyleStore(), empty = JSON.stringify(await f.store.createBackup());
  const epoch = f.store.getWorkspaceEpoch(), first = f.activity.beginWorkspaceActivity(epoch), second = f.activity.beginWorkspaceActivity(epoch);
  await assert.rejects(f.store.openWorkspace(empty, true), /处理中/);
  first(); first(); await assert.rejects(f.store.changeWorkspaceBinding(() => {}), /处理中/);
  assert.equal(f.activity.hasWorkspaceActivity(epoch), true);
  second(); await f.store.openWorkspace(empty);
  const currentEpoch = f.store.getWorkspaceEpoch(), current = f.activity.beginWorkspaceActivity(currentEpoch);
  first(); second(); assert.equal(f.activity.hasWorkspaceActivity(currentEpoch), true);
  await assert.rejects(f.store.openWorkspace(empty), /处理中/);
  current(); await f.store.openWorkspace(empty);
});

test('切换与迁移IO期间不能启动新的模型任务，完成后可以重新开始', async () => {
  const f = memoryStyleStore(), empty = JSON.stringify(await f.store.createBackup());
  let entered, release; const started = new Promise(resolve => { entered = resolve; });
  const open = f.store.openWorkspace(empty, false, undefined, undefined, async () => { entered(); await new Promise(resolve => { release = resolve; }); });
  await started;
  assert.throws(() => f.activity.beginWorkspaceActivity(f.store.getWorkspaceEpoch()), /正在切换/);
  release(); await open;
  const finish = f.activity.beginWorkspaceActivity(f.store.getWorkspaceEpoch()); finish();
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
