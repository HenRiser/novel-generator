import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadStyleModule, memoryStyleStore } from './writing-style-test-helpers.mjs';
const s = loadStyleModule();
const example = (id, text = '以动作收尾，旁白不解释笑点。', tags = []) => ({ id, text, source: { kind: 'manual', label: '作者确认片段' }, scene_tags: tags, pov: '', pace: '' });
const card = () => s.createWritingStyle('冷幽默', '旁白克制，以人物行动制造反差。');

test('统一 JSON 格式往返，导入新标识且不覆盖同名卡', () => {
  const a = card(); a.examples = [example('sample_1')];
  const b = s.importWritingStyle(s.exportWritingStyle(a));
  assert.equal(b.rules, a.rules); assert.equal(b.name, a.name); assert.equal(b.examples[0].text, a.examples[0].text);
  assert.notEqual(b.id, a.id); assert.notEqual(b.examples[0].id, a.examples[0].id); assert.equal(b.revision, 1);
});
test('规则、范例和来源拒绝超限、空值、重复标识及注入字段', () => {
  for (const patch of [{ rules: '' }, { rules: '字'.repeat(6001) }, { api_key: 'SYNTHETIC_ONLY' }, { source: { kind: 'manual', label: '来源', credentials: {} } }, { examples: [example('a'), example('a')] }, { examples: [example('a', '字'.repeat(2001))] }]) assert.throws(() => s.validateWritingStyle({ ...card(), ...patch }));
  assert.throws(() => s.importWritingStyle('正文不是JSON')); assert.throws(() => s.importWritingStyle('{"format":"other"}'));
});
test('场景匹配优先并稳定排序，整段选入不超过三段及两千字符', () => {
  const a = card(); a.examples = [example('z', '字'.repeat(900)), example('b', '字'.repeat(900), ['对话']), example('a', '字'.repeat(900), ['对话']), example('c', '短段落', ['对话'])];
  const first = s.writingStyleContext(a, { primary_function: '对话' });
  assert.deepEqual(Array.from(first.examples, e => e.id), ['a', 'b', 'c']);
  assert.equal(first.examples.reduce((n, e) => n + s.styleCharacters(e.text), 0), 1803);
  assert.equal(JSON.stringify(first), JSON.stringify(s.writingStyleContext(a, { primary_function: '对话' })));
  assert.equal(first.card.examples, undefined); s.validateStyleContext(first);
});
test('无范例可用，生成上下文为深拷贝且不能跨卡取例', () => {
  const a = card(), b = card(); b.examples = [example('foreign')];
  const ctx = s.writingStyleContext(a); a.rules = '已修改';
  assert.equal(ctx.examples.length, 0); assert.equal(ctx.card.rules.includes('已修改'), false);
});
test('中文补充平面字符按真实字符计数', () => { assert.equal(s.styleCharacters('𠮷好'), 2); });

test('本地卡修订和项目快照独立，删除库卡不删除项目', async () => {
  const f = memoryStyleStore(), p = f.types.emptyProject('作品A'), q = f.types.emptyProject('作品B');
  await f.store.putProject(p); await f.store.putProject(q);
  const a = await f.store.saveWritingStyle(card());
  await f.store.selectProjectWritingStyle(p.project_ref, a, 0);
  const b = await f.store.saveWritingStyle({ ...a, rules: '新版规则' }, 1);
  assert.equal((await f.store.getProject(p.project_ref)).writing_style.rules, a.rules);
  assert.equal((await f.store.getProject(q.project_ref)).writing_style, undefined);
  await assert.rejects(f.store.saveWritingStyle(a, 1), /另一处/);
  await f.store.selectProjectWritingStyle(p.project_ref, b, 1);
  await f.store.deleteWritingStyle(b.id, 2);
  assert.equal((await f.store.listWritingStyles()).length, 0);
  assert.equal((await f.store.getProject(p.project_ref)).writing_style.rules, '新版规则');
});
test('v4完整备份与恢复重映射卡标识，保留旧快照，排除密钥且不覆盖现有卡', async () => {
  const f = memoryStyleStore(), a = await f.store.saveWritingStyle(card());
  const p = f.types.emptyProject('作品'); await f.store.putProject(p); await f.store.selectProjectWritingStyle(p.project_ref, a);
  await f.store.setSetting('vault:private', { version: 3, api_key: 'SYNTHETIC_ONLY' });
  const backup = await f.store.createBackup(); assert.equal(backup.version, 4); assert.equal(backup.writing_styles.length, 1); assert.equal(JSON.stringify(backup).includes('SYNTHETIC_ONLY'), false);
  const refs = await f.store.restoreBackup(JSON.stringify(backup)), restored = await f.store.getProject(refs[0]);
  assert.notEqual(restored.writing_style.id, a.id); assert.equal(restored.writing_style.rules, a.rules);
  const cards = await f.store.listWritingStyles(); assert.equal(cards.length, 2); assert.ok(cards.some(c => c.id === restored.writing_style.id));
});
test('v1-v3备份仍可读，恢复旧备份不清空现有文风库', async () => {
  const f = memoryStyleStore(); await f.store.saveWritingStyle(card());
  for (const version of [1, 2, 3]) {
    const p = f.types.emptyProject(`旧项目${version}`); if (version === 1) p.schema_version = 1;
    const backup = { format: 'braipen-backup', version, projects: [p], ...(version === 3 ? { cover_media: [] } : {}) };
    const refs = await f.store.restoreBackup(JSON.stringify(backup)); assert.equal(refs.length, 1);
  }
  assert.equal((await f.store.listWritingStyles()).length, 1);
});
test('非法v4文风库拒绝整次恢复，不写入项目', async () => {
  const f = memoryStyleStore(), p = f.types.emptyProject('无效');
  await assert.rejects(f.store.restoreBackup(JSON.stringify({ format: 'braipen-backup', version: 4, projects: [p], cover_media: [], writing_styles: [{ name: '缺字段' }] })));
  assert.equal((await f.store.listProjects()).length, 0);
});
test('恢复时库卡与项目快照来源一致，只改结构化引用，不替换规则正文', async () => {
  const f = memoryStyleStore(), p = f.types.emptyProject('来源作品');
  await f.store.putProject(p);
  const value = card(); value.rules = p.project_ref; value.source = { kind: 'project', label: '选定章节', project_ref: p.project_ref };
  value.examples = [{ ...example('origin', p.project_ref), source: { ...value.source } }, { ...example('external'), source: { kind: 'project', label: '备份之外', project_ref: 'book:bk_external' } }];
  const a = await f.store.saveWritingStyle(value); await f.store.selectProjectWritingStyle(p.project_ref, a);
  const refs = await f.store.restoreBackup(JSON.stringify(await f.store.createBackup())), restored = await f.store.getProject(refs[0]);
  const library = (await f.store.listWritingStyles()).find(c => c.id === restored.writing_style.id);
  assert.equal(library.source.project_ref, refs[0]); assert.equal(library.examples[0].source.project_ref, refs[0]);
  assert.equal(library.examples[1].source.project_ref, 'book:bk_external');
  assert.equal(restored.writing_style.rules, p.project_ref); assert.equal(restored.writing_style.examples[0].text, p.project_ref);
  assert.equal(JSON.stringify(library), JSON.stringify(restored.writing_style));
});
