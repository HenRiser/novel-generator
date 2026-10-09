// Pure crop bounds, metadata, and pre-decode limits. No network or credentials.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function load(name, environment = {}) {
  const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  runInNewContext(outputText, { exports, structuredClone, crypto: webcrypto, Blob, atob, btoa,
    require: key => { assert.equal(key, './planningTrace'); return { readPlanningTrace: () => ({ invalid: false, entries: [] }) }; }, ...environment });
  return exports;
}
const crop = load('coverCrop'), store = load('localStore'), types = load('localTypes');
const png = (width, height) => {
  const data = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(data);
  data.writeUInt32BE(width, 16); data.writeUInt32BE(height, 20); return new Blob([data], { type: 'image/png' });
};
const jpeg = (width, height) => {
  const data = Buffer.from('ffd8ffc0000b080000000001011100', 'hex'); data.writeUInt16BE(height, 7); data.writeUInt16BE(width, 9);
  return new Blob([data], { type: 'image/jpeg' });
};
const webp = (width, height) => {
  const data = Buffer.from('524946461600000057454250565038580a00000000000000000000000000', 'hex');
  data.writeUIntLE(width - 1, 24, 3); data.writeUIntLE(height - 1, 27, 3); return new Blob([data], { type: 'image/webp' });
};

test('任意大小与滑块边界保持2:3、整数源像素且不越界', () => {
  for (const width of [2, 3, 17, 320, 600, 16384]) for (const height of [3, 19, 240, 900, 4096]) {
    for (const size of [-1, 20, 71, 100, 150]) for (const position of [-10, 0, 50, 100, 200]) {
      const rect = crop.coverCropRect(width, height, { size, horizontal: position, vertical: position });
      assert.equal(rect.width * 3, rect.height * 2); assert.ok(Object.values(rect).every(Number.isSafeInteger));
      assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= height);
    }
  }
  for (const [width, height, controls] of [[1, 10, crop.initialCoverCrop], [10, 2, crop.initialCoverCrop], [10, 10, { size: NaN, horizontal: 50, vertical: 50 }], [10, 10, { size: 50 }]]) assert.throws(() => crop.coverCropRect(width, height, controls));
});

test('本地来源兼容旧记录、拒绝假模型身份并随备份副本保留', () => {
  const p = types.emptyProject('本地封面');
  p.cover = { layout: store.defaultCoverLayout(p.title), versions: [{ id: 'cover_upload', media_id: 'media_upload', origin: 'upload', source: { idea: '', characters: '' }, created_at: new Date().toISOString(), width: 2, height: 3, mime_type: 'image/png' }] };
  store.validateProject(p); assert.equal(store.restoreCopies([p])[0].cover.versions[0].origin, 'upload');
  for (const update of [{ origin: 'unknown' }, { origin: ['upload'] }, { connection: { profile_id: 'image_x', model: 'pretend', preset: 'custom' } }, { text_model: 'pretend' }, { style_id: 'ink' }, { template_version: 1 }, { width: 3 }, { source: { idea: 'pretend story', characters: '' } }]) {
    const changed = structuredClone(p); Object.assign(changed.cover.versions[0], update); assert.throws(() => store.validateProject(changed));
  }
  const older = structuredClone(p); delete older.cover.versions[0].origin; older.cover.versions[0].width = 3; store.validateProject(older);
});

test('PNG/JPEG/WebP在解码前拒绝超边长和超64MP，文件超8MiB不读取字节', async () => {
  let decodes = 0;
  const checked = load('localStore', { createImageBitmap: async () => { decodes++; throw new Error('must never decode'); } });
  for (const create of [png, jpeg, webp]) for (const [width, height] of [[16385, 100], [100, 16385], [10000, 10000]]) await assert.rejects(() => checked.inspectCoverBlob(create(width, height)), /尺寸过大/);
  class Oversized extends Blob { get size() { return store.MAX_COVER_BYTES + 1; } async arrayBuffer() { throw new Error('must never read'); } }
  await assert.rejects(() => checked.inspectCoverBlob(new Oversized()), /8 MiB/); assert.equal(decodes, 0);
});

test('头部类型不匹配、截断以及浏览器解码失败会拒绝', async () => {
  const checked = load('localStore', { createImageBitmap: async () => { throw new Error('decode failed'); } });
  await assert.rejects(async () => checked.inspectCoverBlob(new Blob([await png(20, 30).arrayBuffer()], { type: 'image/jpeg' })), /类型.*不一致/);
  await assert.rejects(() => checked.inspectCoverBlob(new Blob([], { type: 'image/png' })), /8 MiB/);
  await assert.rejects(() => checked.inspectCoverBlob(new Blob([Buffer.from('ffd8ff00', 'hex')], { type: 'image/jpeg' })), /损坏/);
  await assert.rejects(() => checked.inspectCoverBlob(png(20, 30)), /无法解码/);
});

test('EXIF旋转交换宽高允许，未交换的不一致拒绝，bitmap总会关闭', async () => {
  let closes = 0;
  const checked = load('localStore', { createImageBitmap: async () => ({ width: 30, height: 20, close: () => closes++ }) });
  const result = await checked.inspectCoverBlob(jpeg(20, 30)); assert.equal(result.width, 30); assert.equal(result.height, 20);
  await assert.rejects(() => checked.inspectCoverBlob(png(20, 20)), /实际内容不一致/); assert.equal(closes, 2);
});

test('裁剪固化为PNG且不放大，大图输出最多2048×3072，非法区域拒绝并关闭bitmap', async () => {
  const sizes = [], bitmap = { width: 4000, height: 6000, close() { this.closed = true; } };
  const checked = load('coverCrop', { createImageBitmap: async () => bitmap, document: { createElement: () => ({ getContext: () => ({ drawImage() {} }), toBlob(callback, mime) { sizes.push([this.width, this.height, mime]); callback(new Blob(['output'], { type: mime })); } }) } });
  await checked.cropCoverBlob(new Blob(), { x: 0, y: 0, width: 4000, height: 6000 });
  await checked.cropCoverBlob(new Blob(), { x: 0, y: 0, width: 160, height: 240 });
  assert.deepEqual(sizes, [[2048, 3072, 'image/png'], [160, 240, 'image/png']]);
  for (const rect of [{ x: -1, y: 0, width: 2, height: 3 }, { x: 3999, y: 0, width: 2, height: 3 }, { x: 0, y: 0, width: 3, height: 3 }, { x: 0, y: 0, width: NaN, height: 3 }]) await assert.rejects(() => checked.cropCoverBlob(new Blob(), rect), /边界/);
  assert.equal(bitmap.closed, true);
});
