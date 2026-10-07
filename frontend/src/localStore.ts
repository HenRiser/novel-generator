import type { ConnectionGuard, ConnectionProfile } from './providerTypes';
import type { LocalProject } from './localTypes';
import type { CoverAttempt, CoverLayout, CoverState, CoverVersion, CoverVersionInput } from './coverTypes';
import { readPlanningTrace } from './planningTrace';

const DATABASE = 'braipen.local.v1';
export const MAX_COVER_BYTES = 8 * 1024 * 1024;
export const MAX_COVER_VERSIONS = 30;
const MAX_BACKUP_COVER_BYTES = 120 * 1024 * 1024;
export const MAX_BACKUP_FILE_BYTES = 200 * 1024 * 1024;
type CoverMedia = { id: string; project_ref: string; blob: Blob };
type BackupCoverMedia = { id: string; project_ref: string; mime_type: string; bytes: number; base64: string };
let connection: Promise<IDBDatabase> | undefined;
let rescue: unknown;

export class RevisionConflictError extends Error {
  constructor() { super('项目已在另一处更新，请刷新后重试。'); this.name = 'RevisionConflictError'; }
}

function storageError(error: unknown): Error {
  if (error instanceof Error && error.name === 'QuotaExceededError') {
    return new Error('浏览器存储空间不足，数据尚未保存。请先下载应急副本，再释放空间。');
  }
  return error instanceof Error ? error : new Error('无法保存到此浏览器，请下载应急副本。');
}

function openDatabase(): Promise<IDBDatabase> {
  if (!connection) connection = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('此浏览器无法使用本地数据库。')); return; }
    const request = indexedDB.open(DATABASE, 3);
    request.onupgradeneeded = () => {
      const db = request.result, tx = request.transaction!;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'project_ref' });
      if (!db.objectStoreNames.contains('imports')) db.createObjectStore('imports', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('cover_media')) db.createObjectStore('cover_media', { keyPath: 'id' }).createIndex('project_ref', 'project_ref');
      const cursor = tx.objectStore('projects').openCursor();
      cursor.onsuccess = () => { const row = cursor.result; if (!row) return; const p = row.value;
        if (p.schema_version === 1) { p.schema_version = 2; p.config.connection_id = 'legacy-deepseek'; row.update(p); } row.continue(); };
    };
    request.onerror = () => reject(storageError(request.error));
    request.onblocked = () => reject(new Error('本地数据库升级被其他标签页阻挡，请关闭其他 Braipen 页面后重试。'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); connection = undefined; };
      resolve(db);
    };
  }).catch(error => { connection = undefined; throw storageError(error); });
  return connection;
}

// 只在事务回调里发起 IndexedDB 请求；成功必须等整个事务提交。
async function transact<T>(stores: string[], mode: IDBTransactionMode,
  execute: (tx: IDBTransaction, result: (value: T) => void, fail: (error: unknown) => void) => void,
): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let value: T;
    let failure: unknown;
    const fail = (error: unknown) => { failure = error; tx.abort(); };
    tx.oncomplete = () => resolve(value);
    tx.onabort = () => reject(storageError(failure ?? tx.error));
    tx.onerror = () => { failure ??= tx.error; };
    try { execute(tx, result => { value = result; }, fail); } catch (error) { fail(error); }
  });
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const secretNames = new Set(['key', 'apikey', 'secret', 'secretkey', 'password', 'passphrase', 'authorization', 'token', 'accesstoken', 'refreshtoken', 'privatekey', 'cookie', 'credentials']);
const isSecret = (name: string) => secretNames.has(name.replace(/[_-]/g, '').toLowerCase());

function checkFields(value: unknown, depth = 0): void {
  if (depth > 80) throw new Error('数据嵌套层级过深。');
  if (Array.isArray(value)) { value.forEach(item => checkFields(item, depth + 1)); return; }
  if (!object(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('数据包含不允许的字段。');
    if (isSecret(key)) throw new Error('项目数据不得包含密钥或口令字段，请使用模型连接设置。');
    checkFields(item, depth + 1);
  }
}

export function defaultCoverLayout(title: string): CoverLayout {
  return { title, author: '', titleColor: '#ffffff', authorColor: '#ffffff', titlePosition: 'top', fontFamily: 'serif', titleSize: 10, authorSize: 3 };
}

function validateCover(cover: unknown): asserts cover is CoverState {
  const invalid = () => { throw new Error('封面版本或排版数据无效。'); };
  const fields = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
  const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max;
  const identifier = (value: unknown) => typeof value === 'string' && /^[\w:-]{1,200}$/.test(value);
  if (!object(cover) || !fields(cover, ['connection_id', 'versions', 'selected_id', 'layout', 'attempt']) ||
      !Array.isArray(cover.versions) || cover.versions.length > MAX_COVER_VERSIONS || !object(cover.layout)) return invalid();
  if (cover.connection_id !== undefined && !identifier(cover.connection_id)) return invalid();
  if (cover.attempt !== undefined) {
    const attempt = cover.attempt;
    if (!object(attempt) || !fields(attempt, ['id', 'status', 'started_at', 'error']) || !identifier(attempt.id) ||
        !['running', 'unknown', 'failed'].includes(String(attempt.status)) || !text(attempt.started_at, 100) ||
        !Number.isFinite(Date.parse(attempt.started_at as string)) || (attempt.error !== undefined && !text(attempt.error, 2000))) return invalid();
  }
  const layout = cover.layout;
  if (!fields(layout, ['title', 'author', 'titleColor', 'authorColor', 'titlePosition', 'fontFamily', 'titleSize', 'authorSize']) ||
      !text(layout.title, 500) || !text(layout.author, 200) ||
      !['titleColor', 'authorColor'].every(name => typeof layout[name] === 'string' && /^#[0-9a-fA-F]{6}$/.test(layout[name] as string)) ||
      !['top', 'center', 'bottom'].includes(String(layout.titlePosition)) || !['serif', 'sans-serif'].includes(String(layout.fontFamily)) ||
      typeof layout.titleSize !== 'number' || !Number.isFinite(layout.titleSize) || layout.titleSize < 3 || layout.titleSize > 20 ||
      typeof layout.authorSize !== 'number' || !Number.isFinite(layout.authorSize) || layout.authorSize < 1 || layout.authorSize > 8) return invalid();
  const ids = new Set<string>(), media = new Set<string>();
  for (const version of cover.versions) {
    if (!object(version) || !fields(version, ['id', 'media_id', 'parent_id', 'prompt', 'source', 'connection', 'created_at', 'width', 'height', 'mime_type']) ||
        !identifier(version.id) || !identifier(version.media_id) || ids.has(String(version.id)) || media.has(String(version.media_id)) ||
        !text(version.prompt, 20000) || !(version.prompt as string).trim() ||
        !text(version.created_at, 100) || !Number.isFinite(Date.parse(version.created_at as string)) ||
        !['image/png', 'image/jpeg', 'image/webp'].includes(String(version.mime_type)) ||
        !Number.isSafeInteger(version.width) || !Number.isSafeInteger(version.height) || (version.width as number) <= 0 || (version.height as number) <= 0 ||
        (version.width as number) > 16384 || (version.height as number) > 16384 || (version.width as number) * (version.height as number) > 64 * 1024 * 1024 ||
        !object(version.source) || !fields(version.source, ['idea', 'characters']) || !text(version.source.idea, 100000) || !text(version.source.characters, 100000)) return invalid();
    if (version.parent_id !== undefined && !ids.has(String(version.parent_id))) return invalid();
    if (version.connection !== undefined) {
      const connection = version.connection;
      if (!object(connection) || !fields(connection, ['profile_id', 'revision', 'model', 'preset']) || !identifier(connection.profile_id) ||
          !text(connection.model, 200) || !(connection.model as string).trim() || !text(connection.preset, 200) ||
          (connection.revision !== undefined && (!Number.isSafeInteger(connection.revision) || (connection.revision as number) < 1))) return invalid();
    }
    ids.add(version.id as string); media.add(version.media_id as string);
  }
  if (cover.selected_id !== undefined && !ids.has(String(cover.selected_id))) return invalid();
}

function coverMime(bytes: Uint8Array): CoverVersion['mime_type'] {
  if (bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte) &&
      bytes[12] === 73 && bytes[13] === 72 && bytes[14] === 68 && bytes[15] === 82) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 20 && [82, 73, 70, 70].every((byte, i) => bytes[i] === byte) &&
      [87, 69, 66, 80].every((byte, i) => bytes[i + 8] === byte)) return 'image/webp';
  throw new Error('封面必须是有效的 PNG、JPEG 或 WebP 图片。');
}

export async function inspectCoverBlob(blob: Blob): Promise<{ mime_type: CoverVersion['mime_type']; width: number; height: number }> {
  if (!(blob instanceof Blob) || !blob.size || blob.size > MAX_COVER_BYTES) throw new Error('封面图片不能为空或超过 8 MiB。');
  const mime_type = coverMime(new Uint8Array(await blob.slice(0, 40).arrayBuffer()));
  if (blob.type !== mime_type) throw new Error('封面图片的文件类型与实际内容不一致。');
  if (typeof createImageBitmap !== 'function') throw new Error('此浏览器无法校验图片，请使用新版浏览器。');
  let image: ImageBitmap;
  try { image = await createImageBitmap(blob); } catch { throw new Error('封面图片损坏或无法解码。'); }
  const { width, height } = image;
  image.close();
  if (!width || !height || width > 16384 || height > 16384 || width * height > 64 * 1024 * 1024) throw new Error('封面图片尺寸过大。');
  return { mime_type, width, height };
}

export function validateProject(value: unknown): asserts value is LocalProject {
  const invalid = () => { throw new Error('项目备份格式不完整或版本不受支持。'); };
  if (!object(value)) return invalid();
  checkFields(value);
  if (value.schema_version !== 2 || typeof value.project_ref !== 'string' || !value.project_ref.startsWith('book:bk_') ||
      !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || typeof value.title !== 'string' ||
      typeof value.updated_at !== 'string') return invalid();
  for (const name of ['config', 'assets', 'chapters', 'graph', 'views', 'chapter_tasks', 'scene_plans', 'reviews', 'batch']) {
    if (!object(value[name])) return invalid();
  }
  for (const name of ['knowledge_drafts', 'story_deltas', 'events', 'snapshots', 'ai_runs', 'runs']) {
    if (!Array.isArray(value[name])) return invalid();
  }
  const assets = value.assets as Record<string, unknown>;
  if (['outline', 'characters', 'setting_expansion'].some(name => typeof assets[name] !== 'string')) return invalid();
  if (value.cover !== undefined) validateCover(value.cover);
  const graph = value.graph as Record<string, unknown>;
  if (!object(graph.graph) || !Array.isArray(graph.graph.nodes) || !Array.isArray(graph.graph.edges) ||
      !Array.isArray((value.views as Record<string, unknown>).views)) return invalid();
  const batch = value.batch as Record<string, unknown>;
  if (typeof batch.status !== 'string' || !Array.isArray(batch.completed_chapters)) return invalid();
  for (const [number, chapter] of Object.entries(value.chapters as Record<string, unknown>)) {
    if (!object(chapter) || !/^[1-9]\d*$/.test(number) || chapter.chapter_number !== Number(number) ||
        ['title', 'filename', 'content', 'revision'].some(name => typeof chapter[name] !== 'string') ||
        !Array.isArray(chapter.versions) || !object(chapter.workflow)) return invalid();
    for (const version of chapter.versions) {
      if (!object(version) || ['title', 'filename', 'content', 'revision'].some(name => typeof version[name] !== 'string')) return invalid();
    }
  }
  for (const run of value.runs as unknown[]) {
    if (!object(run) || typeof run.run_id !== 'string' || typeof run.status !== 'string' || !object(run.input)) return invalid();
    if ('planning_trace_invalid' in run && typeof run.planning_trace_invalid !== 'boolean') run.planning_trace_invalid = true;
    if ('planning_trace' in run) {
      const trace = readPlanningTrace(run.planning_trace);
      if (trace.invalid || run.operation !== 'plan_chapter') {
        delete run.planning_trace; run.planning_trace_invalid = true;
      } else run.planning_trace = trace.entries;
    }
  }
}

export function listProjects(): Promise<LocalProject[]> {
  return transact(['projects'], 'readonly', (tx, done) => {
    tx.objectStore('projects').getAll().onsuccess = event => {
      done(((event.target as IDBRequest).result as LocalProject[]).sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
    };
  });
}

export function getProject(ref: string): Promise<LocalProject> {
  return transact(['projects'], 'readonly', (tx, done, fail) => {
    const request = tx.objectStore('projects').get(ref);
    request.onsuccess = () => request.result ? done(request.result) : fail(new Error('此浏览器中找不到该项目。'));
  });
}

export async function putProject(project: LocalProject): Promise<void> {
  validateProject(project);
  try { await transact<void>(['projects'], 'readwrite', tx => { tx.objectStore('projects').add(project); }); }
  catch (error) { rememberRescue(project); throw storageError(error); }
}

export async function updateProject(ref: string, mutate: (project: LocalProject) => void,
  expectedRevision?: number, bumpRevision = true, guard?: ConnectionGuard): Promise<LocalProject> {
  let updated: LocalProject | undefined;
  try {
    return await transact<LocalProject>(['projects', 'settings'], 'readwrite', (tx, done, fail) => {
      const store = tx.objectStore('projects');
      const request = store.get(ref);
      request.onsuccess = () => {
        const apply = () => { try {
          const project = request.result as LocalProject | undefined;
          if (!project) throw new Error('此浏览器中找不到该项目。');
          if (expectedRevision !== undefined && project.revision !== expectedRevision) throw new RevisionConflictError();
          const revision = project.revision;
          const returned: unknown = mutate(project);
          if (returned && typeof (returned as Promise<unknown>).then === 'function') throw new Error('项目更新必须同步完成。');
          if (project.project_ref !== ref) throw new Error('项目更新不能改变项目标识。');
          project.revision = revision + (bumpRevision ? 1 : 0);
          project.updated_at = new Date().toISOString();
          validateProject(project);
          updated = project;
          store.put(project);
          done(project);
        } catch (error) { fail(error); } };
        if (guard) {
          const permission = tx.objectStore('settings').get('connection:' + guard.profile_id);
          permission.onsuccess = () => { try { checkConnectionGuard(permission.result?.value, guard); apply(); } catch(error) { fail(error); } };
        } else apply();
      };
    });
  } catch (error) { if (updated) rememberRescue(updated); throw storageError(error); }
}

export function deleteProject(ref: string): Promise<void> {
  return transact(['projects', 'cover_media'], 'readwrite', tx => {
    tx.objectStore('projects').delete(ref);
    const media = tx.objectStore('cover_media');
    const request = media.index('project_ref').openKeyCursor(ref);
    request.onsuccess = () => { const cursor = request.result; if (cursor) { media.delete(cursor.primaryKey); cursor.continue(); } };
  });
}

function coverChanged(projectRef: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('braipen:workflow-changed', { detail: { projectRef } }));
  window.dispatchEvent(new Event('braipen:projects-changed'));
}

function projectCover(project: LocalProject): CoverState {
  return project.cover ??= { versions: [], layout: defaultCoverLayout(project.title) };
}

export function getCoverBlob(mediaId: string): Promise<Blob> {
  return transact(['cover_media'], 'readonly', (tx, done, fail) => {
    const request = tx.objectStore('cover_media').get(mediaId);
    request.onsuccess = () => request.result?.blob instanceof Blob ? done(request.result.blob) : fail(new Error('此浏览器中找不到封面原图。'));
  });
}

export async function saveCoverVersion(ref: string, metadata: CoverVersionInput, blob: Blob, guard?: ConnectionGuard): Promise<CoverVersion> {
  if (guard && metadata.connection?.profile_id !== guard.profile_id) throw new Error('封面结果与生成所用连接不一致。');
  const image = await inspectCoverBlob(blob);
  if (metadata.width !== image.width || metadata.height !== image.height) throw new Error('封面尺寸与实际图片不一致。');
  const version: CoverVersion = { ...structuredClone(metadata), ...image, id: `cover_${crypto.randomUUID()}`, media_id: `media_${crypto.randomUUID()}`, created_at: new Date().toISOString() };
  checkFields(version);
  await transact<void>(['projects', 'settings', 'cover_media'], 'readwrite', (tx, _done, fail) => {
    const store = tx.objectStore('projects'), request = store.get(ref);
    request.onsuccess = () => {
      const save = () => { try {
        const project = request.result as LocalProject | undefined;
        if (!project) throw new Error('此浏览器中找不到该项目。');
        const cover = projectCover(project);
        if (cover.versions.length >= MAX_COVER_VERSIONS) throw new Error('每个项目最多保存 30 个封面版本，请先备份。');
        if (version.parent_id && !cover.versions.some(item => item.id === version.parent_id)) throw new Error('找不到修改所依据的封面版本。');
        cover.versions.push(version);
        delete cover.attempt;
        // 封面不参与文字生成输入；沿用当前项目并保持文字 revision，避免作废正在生成的章节。
        project.updated_at = new Date().toISOString();
        validateProject(project);
        tx.objectStore('cover_media').add({ id: version.media_id, project_ref: ref, blob } satisfies CoverMedia);
        store.put(project);
      } catch (error) { fail(error); } };
      if (guard) {
        const permission = tx.objectStore('settings').get('connection:' + guard.profile_id);
        permission.onsuccess = () => { try { checkConnectionGuard(permission.result?.value, guard); save(); } catch (error) { fail(error); } };
      } else save();
    };
  });
  coverChanged(ref);
  return version;
}

export async function selectCoverVersion(ref: string, id?: string): Promise<LocalProject> {
  const project = await updateProject(ref, project => {
    const cover = projectCover(project);
    if (id !== undefined && !cover.versions.some(version => version.id === id)) throw new Error('找不到该封面版本。');
    cover.selected_id = id;
  }, undefined, false);
  coverChanged(ref);
  return project;
}

export async function saveCoverLayout(ref: string, layout: CoverLayout): Promise<LocalProject> {
  const project = await updateProject(ref, project => { projectCover(project).layout = structuredClone(layout); }, undefined, false);
  coverChanged(ref);
  return project;
}

export async function saveCoverConnection(ref: string, id: string): Promise<LocalProject> {
  const project = await updateProject(ref, project => { projectCover(project).connection_id = id; }, undefined, false);
  coverChanged(ref);
  return project;
}

export async function saveCoverAttempt(ref: string, attempt?: CoverAttempt, expectedAttemptId?: string): Promise<LocalProject> {
  const project = await updateProject(ref, project => {
    const cover = projectCover(project);
    if (expectedAttemptId !== undefined && cover.attempt?.id !== expectedAttemptId) return;
    cover.attempt = attempt ? structuredClone(attempt) : undefined;
  }, undefined, false);
  coverChanged(ref);
  return project;
}

type ImportRecord<T> = { id: string; data: T; project_ref?: string };

export function getImport<T>(id: string): Promise<T | undefined> {
  return transact(['imports'], 'readonly', (tx, done) => {
    const request = tx.objectStore('imports').get(id);
    request.onsuccess = () => done((request.result as ImportRecord<T> | undefined)?.data);
  });
}

export function listImports<T>(): Promise<T[]> {
  return transact(['imports'], 'readonly', (tx, done) => {
    const request = tx.objectStore('imports').getAll();
    request.onsuccess = () => done((request.result as ImportRecord<T>[]).map(record => record.data));
  });
}

export async function putImport(id: string, data: unknown, guard?: ConnectionGuard): Promise<void> {
  checkFields(data);
  try {
    await transact<void>(['imports','settings'], 'readwrite', (tx, _done, fail) => {
      const store = tx.objectStore('imports');
      const request = store.get(id);
      request.onsuccess = () => {
        const save=()=>{try{store.put({...request.result,id,data});}catch(error){fail(error);}};
        if(guard){const permission=tx.objectStore('settings').get('connection:'+guard.profile_id);permission.onsuccess=()=>{try{checkConnectionGuard(permission.result?.value,guard);save();}catch(error){fail(error);}};}else save();
      };
    });
  } catch (error) { rememberRescue({ import_id: id, draft: data }); throw storageError(error); }
}

export function commitImport(id: string, project: LocalProject): Promise<string> {
  validateProject(project);
  return transact<string>(['imports', 'projects'], 'readwrite', (tx, done, fail) => {
    const imports = tx.objectStore('imports');
    const request = imports.get(id);
    request.onsuccess = () => {
      try {
        if (!request.result) throw new Error('找不到待提交的导入草稿。');
        const record = request.result as ImportRecord<unknown>;
        if (record.project_ref) { done(record.project_ref); return; }
        tx.objectStore('projects').add(project);
        imports.put({ ...record, project_ref: project.project_ref });
        done(project.project_ref);
      } catch (error) { fail(error); }
    };
  }).catch(error => { rememberRescue(project); throw storageError(error); });
}

export function checkConnectionGuard(profile: ConnectionProfile | undefined, guard: ConnectionGuard): void {
  if (!profile || !profile.enabled || profile.deleted || profile.epoch !== guard.epoch || profile.key_version !== guard.key_version ||
      !profile.revisions.some(r => r.destination_fingerprint === guard.destination_fingerprint)) throw new Error('连接已锁定、撤销或更换Key；结果未提交，请手动恢复。');
}
export function listSettings<T>(prefix: string): Promise<T[]> {
  return transact(['settings'], 'readonly', (tx, done) => { const r = tx.objectStore('settings').getAll(); r.onsuccess = () => done(r.result.filter((i: { key: string }) => i.key.startsWith(prefix)).map((i: { value: T }) => i.value)); });
}
export function commitSettings(updates: Array<{ key: string; value?: unknown; remove?: boolean }>): Promise<void> {
  return transact(['settings'], 'readwrite', tx => { const s = tx.objectStore('settings'); for (const item of updates) { if (item.remove) s.delete(item.key); else s.put({ key: item.key, value: item.value }); } });
}
export async function assertConnectionGuard(guard: ConnectionGuard): Promise<void> {
  checkConnectionGuard(await getSetting<ConnectionProfile>('connection:' + guard.profile_id), guard);
}

export function getSetting<T>(key: string): Promise<T | undefined> {
  return transact(['settings'], 'readonly', (tx, done) => {
    const request = tx.objectStore('settings').get(key);
    request.onsuccess = () => done(request.result?.value);
  });
}

export function setSetting(key: string, value: unknown): Promise<void> {
  return transact(['settings'], 'readwrite', tx => { tx.objectStore('settings').put({ key, value }); });
}

export function deleteSetting(key: string): Promise<void> {
  return transact(['settings'], 'readwrite', tx => { tx.objectStore('settings').delete(key); });
}

function safeCopy(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, item) => isSecret(key) || ['__proto__', 'constructor', 'prototype'].includes(key) ? undefined : item));
}

export function rememberRescue(value: unknown): void {
  // 应急路径不得掩盖原来的保存错误，也不保留未经脱敏的数据。
  try { rescue = safeCopy(value); } catch { return; }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('braipen:rescue'));
}

export function hasRescue(): boolean { return rescue !== undefined; }

function download(value: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  if (object(value) && value.format === 'braipen-backup' && blob.size > MAX_BACKUP_FILE_BYTES) throw new Error('完整备份超过 200 MiB，本次未导出。请减少单次备份内容。');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadRescue(): void {
  if (rescue === undefined) throw new Error('当前没有尚未保存的应急副本。');
  const projects = object(rescue) && Array.isArray(rescue.projects) ? rescue.projects : [rescue];
  try {
    projects.forEach(validateProject);
    const cover_media = object(rescue) && Array.isArray(rescue.cover_media) ? rescue.cover_media : [];
    validateBackupMedia(projects as LocalProject[], cover_media);
    download({ format: 'braipen-backup', version: 3, created_at: new Date().toISOString(), projects, cover_media,
      ...(object(rescue) && Array.isArray(rescue.connections) ? { connections: rescue.connections } : {}) }, 'braipen-rescue.json');
    return;
  } catch { /* 导入草稿等尚未成为完整项目的数据也可以单独抢救。 */ }
  download({ format: 'braipen-rescue', version: 1, created_at: new Date().toISOString(), data: rescue }, 'braipen-rescue.json');
}

function encodeCoverBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 32768) binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
  return btoa(binary);
}

function decodeCoverBytes(media: BackupCoverMedia): Uint8Array {
  if (typeof media.base64 !== 'string' || media.base64.length !== 4 * Math.ceil(media.bytes / 3) ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(media.base64)) throw new Error('封面备份的图片编码无效。');
  let binary: string;
  try { binary = atob(media.base64); } catch { throw new Error('封面备份的图片编码无效。'); }
  if (binary.length !== media.bytes || btoa(binary) !== media.base64) throw new Error('封面备份的图片字节数或编码无效。');
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function validateBackupMedia(projects: LocalProject[], value: unknown): CoverMedia[] {
  if (!Array.isArray(value)) throw new Error('封面备份缺少图片数据。');
  const referenced = new Map<string, { project_ref: string; version: CoverVersion }>();
  const versionIds = new Set<string>();
  for (const project of projects) for (const version of project.cover?.versions ?? []) {
    if (referenced.has(version.media_id) || versionIds.has(version.id)) throw new Error('备份含重复的封面版本或图片引用。');
    referenced.set(version.media_id, { project_ref: project.project_ref, version }); versionIds.add(version.id);
  }
  if (value.length !== referenced.size) throw new Error('封面备份含缺失或多余的图片。');
  const seen = new Set<string>();
  let total = 0;
  return value.map(item => {
    if (!object(item) || Object.keys(item).some(key => !['id', 'project_ref', 'mime_type', 'bytes', 'base64'].includes(key)) ||
        typeof item.id !== 'string' || typeof item.project_ref !== 'string' || typeof item.mime_type !== 'string' ||
        !Number.isSafeInteger(item.bytes) || (item.bytes as number) <= 0 || (item.bytes as number) > MAX_COVER_BYTES) throw new Error('封面备份的图片描述无效。');
    total += item.bytes as number;
    if (total > MAX_BACKUP_COVER_BYTES) throw new Error('封面备份图片总量超过 120 MiB。');
    const ref = referenced.get(item.id);
    if (seen.has(item.id) || !ref || ref.project_ref !== item.project_ref || ref.version.mime_type !== item.mime_type) throw new Error('封面备份含重复或不匹配的图片引用。');
    seen.add(item.id);
    const bytes = decodeCoverBytes(item as BackupCoverMedia);
    if (coverMime(bytes) !== item.mime_type) throw new Error('封面备份的文件类型与实际图片不一致。');
    return { id: item.id, project_ref: item.project_ref, blob: new Blob([bytes.buffer as ArrayBuffer], { type: item.mime_type }) };
  });
}

export async function createBackup(): Promise<{ format: string; version: number; created_at: string; connections: unknown; projects: unknown; cover_media: BackupCoverMedia[] }> {
  const snapshot = await transact<{ projects: LocalProject[]; connections: ConnectionProfile[]; media: CoverMedia[] }>(['projects', 'settings', 'cover_media'], 'readonly', (tx, done) => {
    const value = { projects: [] as LocalProject[], connections: [] as ConnectionProfile[], media: [] as CoverMedia[] };
    tx.objectStore('projects').getAll().onsuccess = event => { value.projects = (event.target as IDBRequest).result; };
    tx.objectStore('settings').getAll().onsuccess = event => { value.connections = (event.target as IDBRequest).result.filter((item: { key: string }) => item.key.startsWith('connection:')).map((item: { value: ConnectionProfile }) => item.value); };
    tx.objectStore('cover_media').getAll().onsuccess = event => { value.media = (event.target as IDBRequest).result; };
    done(value);
  });
  snapshot.projects.forEach(validateProject);
  if (snapshot.media.reduce((total, row) => total + row.blob.size, 0) > MAX_BACKUP_COVER_BYTES) throw new Error('封面备份图片总量超过 120 MiB。');
  const cover_media: BackupCoverMedia[] = [];
  for (const row of snapshot.media) {
    if (row.blob.size > MAX_COVER_BYTES) throw new Error('封面图片超过 8 MiB，无法导出。');
    cover_media.push({ id: row.id, project_ref: row.project_ref, mime_type: row.blob.type, bytes: row.blob.size, base64: encodeCoverBytes(new Uint8Array(await row.blob.arrayBuffer())) });
  }
  validateBackupMedia(snapshot.projects, cover_media);
  return { format: 'braipen-backup', version: 3, created_at: new Date().toISOString(), connections: safeCopy(snapshot.connections), projects: safeCopy(snapshot.projects), cover_media };
}

export async function exportBackup(): Promise<void> {
  download(await createBackup(), `braipen-backup-${new Date().toISOString().slice(0, 10)}.json`);
}

function readBackup(text: string): { projects: LocalProject[]; media: CoverMedia[]; raw: Record<string, unknown> } {
  if (new Blob([text]).size > MAX_BACKUP_FILE_BYTES) throw new Error('完整备份超过 200 MiB，请使用较小的备份文件。');
  const backup: unknown = JSON.parse(text);
  if (!object(backup) || backup.format !== 'braipen-backup' || ![1, 2, 3].includes(Number(backup.version)) || !Array.isArray(backup.projects)) {
    throw new Error('请选择 Braipen 导出的完整项目备份。');
  }
  checkFields(backup);
  const refs = new Set<string>();
  for (const project of backup.projects) {
    if (backup.version === 1 && object(project) && project.schema_version === 1 && object(project.config)) { project.schema_version = 2; project.config.connection_id = 'legacy-deepseek'; }
    validateProject(project);
    if (refs.has(project.project_ref)) throw new Error('备份包含重复的项目标识。');
    refs.add(project.project_ref);
  }
  const projects = backup.projects as LocalProject[];
  if (Number(backup.version) !== 3 && backup.cover_media !== undefined) throw new Error('图片备份必须使用版本 3。');
  const media = validateBackupMedia(projects, Number(backup.version) === 3 ? backup.cover_media : []);
  return { projects, media, raw: backup };
}

export function parseBackup(text: string): LocalProject[] {
  return readBackup(text).projects;
}

export function restoreCopies(projects: LocalProject[]): LocalProject[] {
  projects.forEach(validateProject);
  const refs = new Map(projects.map(project => [project.project_ref, `book:bk_${crypto.randomUUID().replace(/-/g, '')}`]));
  const remap = (value: unknown, ids: Map<string, string>): unknown => {
    if (typeof value === 'string') return ids.get(value) ?? value;
    if (Array.isArray(value)) return value.map(item => remap(item, ids));
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [ids.get(key) ?? key, remap(item, ids)]));
    return value;
  };
  return projects.map(project => {
    const copy = remap(project, refs) as LocalProject;
    if (project.cover) {
      // 只重映射真实引用，不改作者排版、提示词和原始故事/人物快照中的文本。
      copy.cover = structuredClone(project.cover);
      const versionIds = new Map(copy.cover.versions.map(version => [version.id, `cover_${crypto.randomUUID()}`]));
      for (const version of copy.cover.versions) {
        version.id = versionIds.get(version.id)!;
        version.media_id = `media_${crypto.randomUUID()}`;
        if (version.parent_id !== undefined) version.parent_id = versionIds.get(version.parent_id)!;
      }
      if (copy.cover.selected_id !== undefined) copy.cover.selected_id = versionIds.get(copy.cover.selected_id)!;
    }
    copy.title += '（恢复副本）'; copy.config.title = copy.title; copy.updated_at = new Date().toISOString();
    copy.runs.forEach(run => { if (run.status === 'running') { run.status = 'interrupted'; run.error = '备份恢复后，请确认是否继续此任务。'; } });
    if (copy.batch.status === 'running' || copy.batch.status === 'stopping') { copy.batch.status = 'stopped'; copy.batch.message = '备份恢复后需手动继续。'; }
    if (copy.cover?.attempt?.status === 'running') { copy.cover.attempt.status = 'unknown'; copy.cover.attempt.error = '备份恢复后无法确认图片请求结果，请手动检查，避免重复调用。'; }
    return copy;
  });
}

export async function restoreBackup(text: string): Promise<string[]> {
  const { projects, media, raw } = readBackup(text);
  const versions = new Map(projects.flatMap(project => (project.cover?.versions ?? []).map(version => [version.media_id, version] as const)));
  for (const row of media) {
    const image = await inspectCoverBlob(row.blob), version = versions.get(row.id)!;
    if (image.width !== version.width || image.height !== version.height) throw new Error('封面备份的尺寸与实际图片不一致。');
  }
  const copies = restoreCopies(projects);
  const mediaIds = new Map<string, { id: string; project_ref: string }>();
  projects.forEach((project, i) => (project.cover?.versions ?? []).forEach((version, j) => {
    mediaIds.set(version.media_id, { id: copies[i].cover!.versions[j].media_id, project_ref: copies[i].project_ref });
  }));
  const restoredMedia = media.map(row => ({ ...row, ...mediaIds.get(row.id)! }));
  const descriptors = Array.isArray(raw.connections) ? raw.connections as ConnectionProfile[] : [];
  const mapped = new Map<string,string>();
  for (const profile of descriptors) {
    checkFields(profile);
    if (typeof profile.id !== 'string' || !Array.isArray(profile.revisions) || !profile.revisions.length) throw new Error('备份连接描述无效。');
    if (mapped.has(profile.id)) throw new Error('备份含重复连接。');
    mapped.set(profile.id, crypto.randomUUID());
  }
  const remapConnections = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [k,v] of Object.entries(value)) { if ((k === 'connection_id' || k === 'profile_id') && typeof v === 'string' && mapped.has(v)) (value as Record<string,unknown>)[k] = mapped.get(v); else remapConnections(v); }
  };
  copies.forEach(remapConnections);
  const restoredProfiles = descriptors.map(profile => {
    const id = mapped.get(profile.id)!; remapConnections(profile);
    return { ...profile, id, enabled: false, deleted: false, epoch: 0, key_version: crypto.randomUUID(), test: undefined };
  });
  try {
    await transact<void>(['projects', 'settings', 'cover_media'], 'readwrite', tx => {
      copies.forEach(project => tx.objectStore('projects').add(project));
      restoredMedia.forEach(row => tx.objectStore('cover_media').add(row));
      for (const profile of restoredProfiles) tx.objectStore('settings').add({ key: 'connection:' + profile.id, value: profile });
    });
  } catch (error) {
    const rawMedia = raw.cover_media as BackupCoverMedia[] | undefined;
    rememberRescue({ projects: copies, connections: restoredProfiles, cover_media: (rawMedia ?? []).map(row => ({ ...row, ...mediaIds.get(row.id)! })) });
    throw storageError(error);
  }
  return copies.map(project => project.project_ref);
}
