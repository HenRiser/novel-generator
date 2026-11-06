import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryStyleStore } from './writing-style-test-helpers.mjs';

function connectionDescriptor(id, protocol = 'chat_completions', base_url = 'https://example.invalid/v1') {
  return { id, name: id, enabled: true, deleted: false, epoch: 4, key_version: 'archived-version', head: 1,
    revisions: [{ profile_id: id, revision: 1, protocol, base_url, auth_mode: 'key', model: 'archived-model', policy: {}, destination_fingerprint: 'synthetic-destination', execution_fingerprint: 'synthetic-execution' }],
    test: { revision: 1, key_version: 'archived-version', at: '2026-01-01', result: {} } };
}

test('空浏览器打开工作区恢复文字、图片和未验证连接草稿，保持禁用且不恢复凭据', async () => {
  const source = memoryStyleStore(), text = connectionDescriptor('text'), image = connectionDescriptor('image', 'openai_images');
  const draft = connectionDescriptor('draft'); draft.draft = draft.revisions[0]; draft.revisions = []; draft.head = 0;
  for (const profile of [text, image, draft]) await source.store.setSetting('connection:' + profile.id, profile);
  await source.store.setSetting('vault:text', { api_key: 'SYNTHETIC_SOURCE_KEY' });
  const p = source.types.emptyProject('连接恢复', { connection_id: text.id }); await source.store.putProject(p);
  const fresh = memoryStyleStore(); await fresh.store.openWorkspace(JSON.stringify(await source.store.createBackup()));
  for (const original of [text, image, draft]) {
    const restored = await fresh.store.getSetting('connection:' + original.id);
    assert.ok(restored); assert.equal(restored.id, original.id); assert.equal(restored.enabled, false); assert.equal(restored.deleted, false);
    assert.equal(restored.epoch, 0); assert.notEqual(restored.key_version, original.key_version); assert.equal(restored.test, undefined);
    assert.deepEqual(restored.revisions, original.revisions); assert.deepEqual(restored.draft, original.draft);
  }
  assert.equal(await fresh.store.getSetting('vault:text'), undefined); assert.equal(await fresh.store.getSetting('default_connection'), undefined);
  const reopened = await fresh.store.createBackup(); assert.equal(reopened.connections.length, 3);
  assert.equal(reopened.projects[0].config.connection_id, text.id); assert.equal(JSON.stringify(reopened).includes('SYNTHETIC_SOURCE_KEY'), false);
  const again = memoryStyleStore(); await again.store.openWorkspace(JSON.stringify(reopened)); assert.equal((await again.store.createBackup()).connections.length, 3);
});

test('同ID同目的地保留浏览器最新模型、修订、状态和Key，不回滚归档配置', async () => {
  const source = memoryStyleStore(), archived = connectionDescriptor('same'); await source.store.setSetting('connection:same', archived);
  const fresh = memoryStyleStore(), current = structuredClone(archived);
  current.head = 2; current.key_version = 'current-key-version'; current.epoch = 9;
  current.revisions.push({ ...current.revisions[0], revision: 2, model: 'current-model' });
  await fresh.store.setSetting('connection:same', current); const vault = { api_key: 'SYNTHETIC_LOCAL_KEY', key_version: current.key_version };
  await fresh.store.setSetting('vault:same', vault); await fresh.store.setSetting('default_connection', current.id);
  await fresh.store.openWorkspace(JSON.stringify(await source.store.createBackup()));
  assert.deepEqual(await fresh.store.getSetting('connection:same'), current); assert.deepEqual(await fresh.store.getSetting('vault:same'), vault);
  assert.equal(await fresh.store.getSetting('default_connection'), current.id);
});

test('同ID不同目的地拒绝整次打开，不添加其它连接或更换工作区', async () => {
  const source = memoryStyleStore(); await source.store.setSetting('connection:new', connectionDescriptor('new'));
  const archived = connectionDescriptor('collision'); await source.store.setSetting('connection:collision', archived);
  const fresh = memoryStyleStore(), p = fresh.types.emptyProject('当前作品'); await fresh.store.putProject(p);
  const current = connectionDescriptor('collision', 'chat_completions', 'https://current.invalid/v1');
  await fresh.store.setSetting('connection:collision', current);
  let changedBinding = false;
  await assert.rejects(fresh.store.openWorkspace(JSON.stringify(await source.store.createBackup()), true, () => { changedBinding = true; }), /连接.*冲突|目的地/);
  assert.equal(changedBinding, false); assert.equal(await fresh.store.getSetting('connection:new'), undefined);
  assert.deepEqual(await fresh.store.getSetting('connection:collision'), current); assert.equal((await fresh.store.getProject(p.project_ref)).title, '当前作品');
});

test('连接目的地检查覆盖历史修订和草稿，不仅比较首个修订或指纹', async () => {
  for (const field of ['revision', 'draft']) {
    const source = memoryStyleStore(), profile = connectionDescriptor('collision');
    const changed = { ...profile.revisions[0], revision: 2, base_url: 'https://other.invalid/v1' };
    if (field === 'revision') profile.revisions.push(changed); else profile.draft = changed;
    await source.store.setSetting('connection:collision', profile);
    const fresh = memoryStyleStore(); await fresh.store.setSetting('connection:collision', connectionDescriptor('collision'));
    await assert.rejects(fresh.store.openWorkspace(JSON.stringify(await source.store.createBackup())), /连接.*冲突|目的地/);
  }
});

test('连接写入失败及打开前置检查失败不会改变当前工作区或留下新设置', async () => {
  const source = memoryStyleStore(); await source.store.setSetting('connection:new', connectionDescriptor('new'));
  const text = JSON.stringify(await source.store.createBackup());
  let failWrite = false;
  const fresh = memoryStyleStore({ beforeBrowserWrite: () => { if (failWrite) throw new Error('模拟连接写入失败'); } });
  const p = fresh.types.emptyProject('保留作品'); await fresh.store.putProject(p); failWrite = true;
  let changedBinding = false;
  await assert.rejects(fresh.store.openWorkspace(text, true, () => { changedBinding = true; }), /写入失败/);
  assert.equal(changedBinding, false); assert.equal(await fresh.store.getSetting('connection:new'), undefined); assert.equal((await fresh.store.getProject(p.project_ref)).title, '保留作品');
  failWrite = false;
  await assert.rejects(fresh.store.openWorkspace(text), /未保存/);
  await assert.rejects(fresh.store.openWorkspace(text, true, undefined, async () => { throw new Error('源文件变更'); }), /源文件变更/);
  assert.equal(await fresh.store.getSetting('connection:new'), undefined);
  const empty = memoryStyleStore();
  await assert.rejects(empty.store.openWorkspace(text, false, undefined, undefined, async () => { throw new Error('迁移写盘失败'); }), /迁移写盘失败/);
  assert.equal(await empty.store.getSetting('connection:new'), undefined);
});

test('重复或损坏连接描述在打开前拒绝，历史无连接描述备份仍可打开', async () => {
  const source = memoryStyleStore(), backup = await source.store.createBackup();
  for (const connections of [[connectionDescriptor('duplicate'), connectionDescriptor('duplicate')], [{ id: 'broken', revisions: [] }], 'invalid']) {
    const fresh = memoryStyleStore(); await assert.rejects(fresh.store.openWorkspace(JSON.stringify({ ...backup, connections })), /连接/);
    assert.equal((await fresh.store.createBackup()).connections.length, 0);
  }
  const fresh = memoryStyleStore(); delete backup.connections; await fresh.store.openWorkspace(JSON.stringify(backup));
  assert.equal((await fresh.store.createBackup()).connections.length, 0);
});

async function committedImport(f, id = 'source') {
  const project = f.types.emptyProject('导入作品');
  const data = { id, schema_version: 1, revision: 3, title: '原文档案', phase: 'ready',
    original_base64: btoa('SYNTHETIC_SOURCE'), normalized_text: '合成导入原文', results: { '1': { summary: '已审核摘要', reviewed: true, candidates: [] } },
    synthesis: { assets: { outline: '已审核大纲', characters: '已审核人物' } }, error: '', updated_at: '2026-01-01T00:00:00Z' };
  await f.store.putImport(id, data); await f.store.commitImport(id, project);
  const saved = { ...data, phase: 'committed', project_ref: project.project_ref }; await f.store.putImport(id, saved);
  return { project, data: saved };
}

test('删除导入作品解除内外提交引用，保留已审核材料并可重新创建且保持幂等', async () => {
  const f = memoryStyleStore(), { project, data } = await committedImport(f);
  await f.store.deleteProject(project.project_ref);
  const draft = await f.store.getImport(data.id), row = (await f.store.createBackup()).imports[0];
  assert.equal(row.project_ref, undefined); assert.equal(draft.project_ref, undefined); assert.equal(draft.phase, 'ready');
  assert.equal(draft.revision, data.revision + 1); assert.notEqual(draft.updated_at, data.updated_at);
  assert.equal(draft.original_base64, data.original_base64); assert.equal(draft.normalized_text, data.normalized_text);
  assert.deepEqual(draft.results, data.results); assert.deepEqual(draft.synthesis, data.synthesis); assert.equal((await f.store.listProjects()).length, 0);
  const replacement = f.types.emptyProject('重新创建');
  assert.equal(await f.store.commitImport(data.id, replacement), replacement.project_ref);
  assert.equal(await f.store.commitImport(data.id, f.types.emptyProject('不应重复')), replacement.project_ref);
  assert.equal((await f.store.listProjects()).length, 1);
});

test('删除导入作品写盘失败保留原项目与完成状态，重试才原子解除关联', async () => {
  const f = memoryStyleStore(), { project, data } = await committedImport(f);
  f.store.setWorkspaceWriter(async () => { throw new Error('模拟删除写盘失败'); });
  await assert.rejects(f.store.deleteProject(project.project_ref), /写盘失败/);
  assert.equal((await f.store.getProject(project.project_ref)).project_ref, project.project_ref);
  assert.deepEqual(await f.store.getImport(data.id), data);
  const pending = await f.store.createBackup(); assert.equal(pending.projects.length, 0);
  assert.equal(pending.imports[0].project_ref, undefined); assert.equal(pending.imports[0].data.phase, 'ready');
  let written; f.store.setWorkspaceWriter(async value => { written = value; }); await f.store.flushWorkspace();
  assert.equal(written.projects.length, 0); assert.equal(written.imports[0].project_ref, undefined);
  assert.equal((await f.store.listProjects()).length, 0); assert.equal((await f.store.getImport(data.id)).phase, 'ready');
  assert.equal(f.store.workspaceHasUnsavedChanges(), false);
});

test('打开旧工作区只恢复悬空导入，保留有效提交和未提交草稿', async () => {
  const f = memoryStyleStore(), lost = await committedImport(f, 'lost'), valid = await committedImport(f, 'valid');
  const unfinished = { id: 'unfinished', schema_version: 1, phase: 'review', revision: 7, title: '待审核', results: {} };
  await f.store.putImport(unfinished.id, unfinished);
  const snapshot = await f.store.createBackup(); snapshot.projects = snapshot.projects.filter(p => p.project_ref !== lost.project.project_ref);
  snapshot.imports.push({ id: 'inner-only', data: { ...lost.data, id: 'inner-only' } });
  const fresh = memoryStyleStore(); await fresh.store.openWorkspace(JSON.stringify(snapshot));
  for (const id of ['lost', 'inner-only']) {
    const restored = await fresh.store.getImport(id); assert.equal(restored.phase, 'ready'); assert.equal(restored.project_ref, undefined);
    assert.equal(restored.normalized_text, lost.data.normalized_text); assert.deepEqual(restored.results, lost.data.results);
  }
  assert.deepEqual(await fresh.store.getImport(valid.data.id), valid.data); assert.deepEqual(await fresh.store.getImport(unfinished.id), unfinished);
  const saved = await fresh.store.createBackup(); assert.equal(saved.imports.find(row => row.id === 'lost').project_ref, undefined);
  assert.equal(saved.imports.find(row => row.id === 'valid').project_ref, valid.project.project_ref);
});

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
