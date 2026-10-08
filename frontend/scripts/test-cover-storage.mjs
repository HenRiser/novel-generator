// Pure backup and schema checks. No database, browser, network, or paid image API.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function load(name, dependencies = {}, environment = {}) {
  const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  runInNewContext(outputText, { exports, structuredClone, crypto: webcrypto, Blob, atob, btoa,
    require: key => { assert.ok(key in dependencies, `Unexpected import ${key}`); return dependencies[key]; }, ...environment });
  return exports;
}
const store = load('localStore', { './planningTrace': { readPlanningTrace: () => ({ invalid: false, entries: [] }) } });
const types = load('localTypes');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=';
const bytes = Buffer.from(png, 'base64');
const clone = value => JSON.parse(JSON.stringify(value));

test('恢复采用统一文件限额，允许 Base64 膨胀后的备份并在解析前拒绝超限', async () => {
  let reportedSize = 160 * 1024 * 1024;
  class SizedBlob extends Blob { get size() { return reportedSize; } }
  const bounded = load('localStore', { './planningTrace': { readPlanningTrace: () => ({ invalid: false, entries: [] }) } }, { Blob: SizedBlob });
  assert.equal(bounded.parseBackup(JSON.stringify(backup())).length, 1);
  reportedSize = bounded.MAX_BACKUP_FILE_BYTES + 1;
  assert.throws(() => bounded.parseBackup('not JSON'), /200 MiB/);
  await assert.rejects(() => bounded.restoreBackup('not JSON'), /200 MiB/);
});

function project() {
  const value = types.emptyProject('封面故事');
  value.cover = { connection_id: 'image-connection', layout: store.defaultCoverLayout(value.title), selected_id: 'cover_edited', versions: [
    { id: 'cover_original', media_id: 'media_original', style_id: 'cinematic', template_version: 1, text_model: 'text-model', source: { idea: '原始白话设定', characters: '最初人物卡' },
      connection: { profile_id: 'image-connection', revision: 1, preset: 'openai-images', model: 'test-model' },
      created_at: '2026-10-06T00:00:00.000Z', width: 1, height: 1, mime_type: 'image/png' },
    { id: 'cover_edited', media_id: 'media_edited', parent_id: 'cover_original', style_id: 'ink', template_version: 1, source: { idea: '原始白话设定', characters: '最初人物卡' },
      created_at: '2026-10-06T00:01:00.000Z', width: 1, height: 1, mime_type: 'image/png' },
  ] };
  return value;
}
function backup(value = project()) {
  return { format: 'braipen-backup', version: 3, projects: [value], cover_media: value.cover.versions.map(version => ({
    id: version.media_id, project_ref: value.project_ref, mime_type: 'image/png', bytes: bytes.length, base64: png,
  })) };
}

test('旧备份的内部提示词迁移后不再进入客户端项目和后续备份', () => {
  const legacy = backup();
  legacy.projects[0].cover.versions[0].prompt = 'INTERNAL_LEGACY_PROMPT_MUST_NOT_SURVIVE';
  const [parsed] = store.parseBackup(JSON.stringify(legacy));
  assert.equal('prompt' in parsed.cover.versions[0], false);
  assert.equal(JSON.stringify(parsed).includes('INTERNAL_LEGACY_PROMPT'), false);
  assert.equal(legacy.projects[0].cover.versions[0].prompt, 'INTERNAL_LEGACY_PROMPT_MUST_NOT_SURVIVE');
  const invalid = project(); invalid.cover.count = '4'; assert.throws(() => store.validateProject(invalid), /封面/);
  invalid.cover.count = 4; invalid.cover.style_id = ['cinematic']; assert.throws(() => store.validateProject(invalid), /封面/);
});

test('原有无封面项目以及 v1/v2 备份继续可恢复', () => {
  const current = types.emptyProject('旧项目');
  store.validateProject(current);
  assert.equal(current.cover, undefined);
  assert.equal(store.parseBackup(JSON.stringify({ format: 'braipen-backup', version: 2, projects: [current] })).length, 1);
  const old = clone(current); old.schema_version = 1; delete old.config.connection_id;
  const [migrated] = store.parseBackup(JSON.stringify({ format: 'braipen-backup', version: 1, projects: [old] }));
  assert.equal(migrated.schema_version, 2); assert.equal(migrated.config.connection_id, 'legacy-deepseek');
});

test('v3 保存完整原图字节、版本谱系、选中项和原始故事快照', () => {
  const value = backup();
  const [parsed] = store.parseBackup(JSON.stringify(value));
  assert.deepEqual(clone(parsed), clone(value.projects[0]));
  assert.equal(parsed.cover.selected_id, 'cover_edited');
  assert.equal(parsed.cover.versions[1].parent_id, 'cover_original');
  assert.deepEqual(Buffer.from(value.cover_media[0].base64, 'base64'), bytes);
  assert.equal(parsed.assets.outline, '');
  assert.equal(JSON.stringify(parsed).includes(png), false);
  assert.equal(parsed.cover.versions[0].source.characters, '最初人物卡');
});

test('恢复副本重映射项目、图片、版本、父版本和已选版本，不改原对象', () => {
  const original = project(), before = clone(original);
  original.cover.attempt = { id: 'attempt_old', status: 'running', started_at: '2026-10-06T00:00:00.000Z' };
  const [copy] = store.restoreCopies([original]);
  assert.notEqual(copy.project_ref, original.project_ref);
  assert.equal(copy.title, '封面故事（恢复副本）');
  assert.notEqual(copy.cover.versions[0].id, 'cover_original');
  assert.notEqual(copy.cover.versions[0].media_id, 'media_original');
  assert.equal(copy.cover.versions[1].parent_id, copy.cover.versions[0].id);
  assert.equal(copy.cover.selected_id, copy.cover.versions[1].id);
  assert.deepEqual(clone(copy.cover.layout), clone(before.cover.layout));
  assert.deepEqual(clone(copy.cover.versions[0].source), clone(before.cover.versions[0].source));
  assert.equal(copy.cover.attempt.status, 'unknown');
  assert.match(copy.cover.attempt.error, /避免重复调用/);
  assert.deepEqual(clone(original.cover.versions), before.cover.versions);
  assert.equal(original.cover.attempt.status, 'running');
  const referenceText = project(); referenceText.cover.versions[0].source.idea = referenceText.project_ref;
  referenceText.cover.versions[0].source.characters = referenceText.cover.versions[0].id;
  referenceText.cover.layout.author = referenceText.cover.versions[0].media_id;
  const [referenceCopy] = store.restoreCopies([referenceText]);
  assert.equal(referenceCopy.cover.versions[0].source.idea, referenceText.project_ref);
  assert.equal(referenceCopy.cover.versions[0].source.characters, referenceText.cover.versions[0].id);
  assert.equal(referenceCopy.cover.layout.author, referenceText.cover.versions[0].media_id);
});

test('缺失、重复、多余、跨项目和MIME错误的媒体引用全部拒绝', () => {
  const changes = [
    value => value.cover_media.pop(),
    value => value.cover_media.push(clone(value.cover_media[0])),
    value => { value.cover_media[1].id = value.cover_media[0].id; },
    value => { value.cover_media[0].project_ref = 'book:bk_other'; },
    value => { value.cover_media[0].mime_type = 'image/jpeg'; },
    value => { value.projects[0].cover.versions[1].media_id = 'media_original'; },
    value => { value.projects[0].cover.selected_id = 'missing'; },
    value => { value.projects[0].cover.versions[0].parent_id = 'cover_edited'; },
  ];
  for (const change of changes) {
    const value = backup(); change(value);
    assert.throws(() => store.parseBackup(JSON.stringify(value)));
  }
  const oldVersion = backup(); oldVersion.version = 2;
  assert.throws(() => store.parseBackup(JSON.stringify(oldVersion)), /版本 3/);
});

test('损坏字节、伪装类型、非规范base64以及超过界限的媒体全部拒绝', () => {
  const changes = [
    item => { item.bytes--; },
    item => { item.base64 = '!' + item.base64.slice(1); },
    item => { item.base64 = item.base64.slice(0, -1); },
    item => { item.base64 = Buffer.alloc(bytes.length).toString('base64'); },
    item => { item.bytes = store.MAX_COVER_BYTES + 1; },
    item => { item.bytes = 0; },
    item => { item.unrequested = 'data'; },
  ];
  for (const change of changes) {
    const value = backup(); change(value.cover_media[0]);
    assert.throws(() => store.parseBackup(JSON.stringify(value)));
  }
});

test('封面结构有界且不能夹带base64、密钥、原型字段或无效排版', () => {
  const changes = [
    value => { value.cover.versions[0].data_base64 = png; },
    value => { value.cover.versions[0].connection.api_key = 'OFFLINE_SENTINEL'; },
    value => { value.cover.versions[0].source.constructor = 'OFFLINE_SENTINEL'; },
    value => { value.cover.versions[0].width = 0; },
    value => { value.cover.versions[0].height = 16385; },
    value => { value.cover.layout.titleColor = 'url(example)'; },
    value => { value.cover.layout.titleSize = 21; },
    value => { value.cover.layout.authorSize = .5; },
    value => { value.cover.versions = Array(store.MAX_COVER_VERSIONS + 1).fill(value.cover.versions[0]); },
    value => { value.cover.attempt = { id: 'attempt', status: 'complete', started_at: '2026-10-06T00:00:00.000Z' }; },
  ];
  for (const change of changes) { const value = project(); change(value); assert.throws(() => store.validateProject(value)); }
});
