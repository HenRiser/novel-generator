import type { ConnectionGuard, ConnectionProfile } from './providerTypes';
import type { LocalProject } from './localTypes';
import type { CoverAttempt, CoverLayout, CoverState, CoverStyleId, CoverVersion, CoverVersionInput } from './coverTypes';
import { readPlanningTrace } from './planningTrace';
import { validateWritingStyle, validateStyleContext, remapWritingStyleIds, remapWritingStyleSources, type WritingStyleCard, type WritingStyleContext } from './writingStyle';

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
    return new Error('存储空间不足，数据尚未保存到本机文件。请下载应急副本。');
  }
  return error instanceof Error ? error : new Error('无法保存工作区，请下载应急副本。');
}

function openDatabase(): Promise<IDBDatabase> {
  if (!connection) connection = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('此浏览器无法使用本地数据库。')); return; }
    const request = indexedDB.open(DATABASE, 4);
    request.onupgradeneeded = () => {
      const db = request.result, tx = request.transaction!;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'project_ref' });
      if (!db.objectStoreNames.contains('imports')) db.createObjectStore('imports', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('cover_media')) db.createObjectStore('cover_media', { keyPath: 'id' }).createIndex('project_ref', 'project_ref');
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
async function browserTransact<T>(stores: string[], mode: IDBTransactionMode,
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

// Creative records exist only in this tab and the selected workspace file.
type Rows = Record<string, Map<IDBValidKey, any>>;
const workspaceRows: Rows = { projects: new Map(), imports: new Map(), cover_media: new Map(), settings: new Map() };
const creativeSetting = (key: string) => key.startsWith('writing-style:') || key.startsWith('workspace-draft:');
let workspaceWriter: ((snapshot: WorkspaceBackup) => Promise<void>) | undefined;
let workspaceQueue: Promise<unknown> = Promise.resolve();
let unsavedWorkspace = false;
const editorDrafts = new Map<string, unknown>();
export function getWorkspaceDraft<T>(key: string): T | undefined { return structuredClone(editorDrafts.get('workspace-draft:' + key)) as T | undefined; }
export function setWorkspaceDraft(key: string, value: unknown): void {
  checkFields(value); const name = 'workspace-draft:' + key;
  if (value === undefined) editorDrafts.delete(name); else editorDrafts.set(name, structuredClone(value));
  unsavedWorkspace = true;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('braipen:drafts-changed'));
  workspaceChanged();
}

export const workspaceHasUnsavedChanges = () => unsavedWorkspace;
export function setWorkspaceWriter(writer?: (snapshot: WorkspaceBackup) => Promise<void>): void { workspaceWriter = writer; }
export function markWorkspaceSaved(snapshot: WorkspaceBackup): void { unsavedWorkspace = JSON.stringify(snapshot.drafts) !== JSON.stringify([...editorDrafts].map(([name, value]) => ({ name, value }))); workspaceChanged(); }
function workspaceChanged(): void { if (typeof window !== 'undefined') window.dispatchEvent(new Event('braipen:workspace-changed')); }

async function transact<T>(stores: string[], mode: IDBTransactionMode,
  execute: (tx: IDBTransaction, result: (value: T) => void, fail: (error: unknown) => void) => void,
): Promise<T> {
  const run = async () => {
    const config = await browserTransact<any[]>(['settings'], 'readonly', (tx, done) => {
      const r = tx.objectStore('settings').getAll(); r.onsuccess = () => done(r.result.filter((row: any) => !creativeSetting(row.key) && row.key !== 'local-folder-sync.v1'));
    });
    const settings = new Map(config.map(row => [row.key, row]));
    for (const [key, row] of workspaceRows.settings) settings.set(key, row);
    const rows: Rows = { ...workspaceRows, settings };
    const next: Rows = Object.fromEntries(stores.map(name => [name, new Map(rows[name])]));
    return new Promise<T>((resolve, reject) => {
      let pending = 0, started = false, closed = false, scheduled = false, value: T;
      const fail = (error: unknown) => { if (!closed) { closed = true; reject(storageError(error)); } };
      const finish = () => {
        if (!started || pending || scheduled || closed) return;
        scheduled = true;
        queueMicrotask(() => {
          if (closed) return;
          if (pending) { scheduled = false; finish(); return; }
          closed = true;
          void (async () => {
            if (mode === 'readwrite') {
              const merged = { ...rows, ...next };
              const beforeConfig = new Map(config.map(row => [row.key, row]));
              const afterConfig = new Map([...merged.settings].filter(([key]) => !creativeSetting(String(key))));
              const edits = [...new Set([...beforeConfig.keys(), ...afterConfig.keys()])].filter(key => JSON.stringify(beforeConfig.get(key)) !== JSON.stringify(afterConfig.get(key)));
              if (edits.length) await browserTransact<void>(['settings'], 'readwrite', tx => {
                const store = tx.objectStore('settings');
                for (const key of edits) { const row = afterConfig.get(key); if (row) store.put(row); else store.delete(key); }
              });
              const changed = stores.some(name => name !== 'settings') ||
                JSON.stringify([...merged.settings].filter(([key]) => creativeSetting(String(key)))) !== JSON.stringify([...workspaceRows.settings]);
              if (changed) {
                const snapshot = await backupFromRows(merged);
                if (workspaceWriter) await workspaceWriter(snapshot);
                for (const name of stores) if (name !== 'settings') workspaceRows[name] = merged[name];
                workspaceRows.settings = new Map([...merged.settings].filter(([key]) => creativeSetting(String(key))));
                unsavedWorkspace = !workspaceWriter || JSON.stringify(snapshot.drafts) !== JSON.stringify([...editorDrafts].map(([name, value]) => ({ name, value })));
                workspaceChanged();
              }
            }
            resolve(value);
          })().catch(reject);
        });
      };
      const request = (fn: () => any) => {
        const r: any = {}; pending++;
        queueMicrotask(() => {
          if (closed) return;
          try { r.result = fn(); r.onsuccess?.({ target: r }); } catch (error) { fail(error); }
          pending--; finish();
        });
        return r;
      };
      const tx = { abort: () => fail(new Error('工作区更新已取消。')), objectStore(name: string) {
        const map = next[name]; if (!map) throw new Error('工作区数据类型无效。');
        const keyOf = (row: any) => name === 'settings' ? row.key : name === 'projects' ? row.project_ref : row.id;
        return {
          get: (key: IDBValidKey) => request(() => structuredClone(map.get(key))),
          getAll: () => request(() => structuredClone([...map.values()])),
          put: (row: any) => request(() => { map.set(keyOf(row), structuredClone(row)); }),
          add: (row: any) => request(() => { const key = keyOf(row); if (map.has(key)) throw new Error('工作区中已有相同标识的记录。'); map.set(key, structuredClone(row)); }),
          delete: (key: IDBValidKey) => request(() => map.delete(key)),
          index: (field: string) => ({ openKeyCursor: (match: string) => {
            const entries = [...map].filter(([, row]) => row[field] === match); let index = 0;
            const r: any = {}; const advance = () => { pending++; queueMicrotask(() => {
              if (closed) return;
              const entry = entries[index++]; r.result = entry ? { primaryKey: entry[0], continue: advance } : null;
              try { r.onsuccess?.({ target: r }); } catch (error) { fail(error); }
              pending--; finish();
            }); }; advance(); return r;
          } }),
        };
      } };
      try { execute(tx as unknown as IDBTransaction, result => { value = result; }, fail); started = true; finish(); } catch (error) { fail(error); }
    });
  };
  if (mode === 'readonly') return run();
  const task = workspaceQueue.then(run); workspaceQueue = task.catch(() => undefined); return task;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const secretNames = new Set(['key', 'apikey', 'secret', 'secretkey', 'password', 'passphrase', 'authorization', 'token', 'accesstoken', 'refreshtoken', 'privatekey', 'cookie', 'credentials']);
const isSecret = (name: string) => secretNames.has(name.replace(/[_-]/g, '').toLowerCase());

// Legacy prompt strings belong to the old client-authored flow; never re-export them.
function removeLegacyCoverPrompts(value: unknown): void {
  if (!object(value) || !object(value.cover) || !Array.isArray(value.cover.versions)) return;
  for (const version of value.cover.versions) if (object(version) && typeof version.prompt === 'string') delete version.prompt;
}
const coverStyles = ['cinematic', 'ink', 'anime', 'fantasy', 'minimal'];

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
  if (!object(cover) || !fields(cover, ['connection_id', 'text_connection_id', 'style_id', 'count', 'versions', 'selected_id', 'layout', 'attempt']) ||
      !Array.isArray(cover.versions) || cover.versions.length > MAX_COVER_VERSIONS || !object(cover.layout)) return invalid();
  if (cover.connection_id !== undefined && !identifier(cover.connection_id)) return invalid();
  if (cover.text_connection_id !== undefined && !identifier(cover.text_connection_id)) return invalid();
  if (cover.style_id !== undefined && (typeof cover.style_id !== 'string' || !coverStyles.includes(cover.style_id))) return invalid();
  if (cover.count !== undefined && (typeof cover.count !== 'number' || ![1, 2, 4].includes(cover.count))) return invalid();
  if (cover.attempt !== undefined) {
    const attempt = cover.attempt;
    if (!object(attempt) || !fields(attempt, ['id', 'status', 'started_at', 'error', 'requested', 'completed']) || !identifier(attempt.id) ||
        !['running', 'unknown', 'failed'].includes(String(attempt.status)) || !text(attempt.started_at, 100) ||
        !Number.isFinite(Date.parse(attempt.started_at as string)) || (attempt.error !== undefined && !text(attempt.error, 2000))) return invalid();
    if (attempt.requested !== undefined && (typeof attempt.requested !== 'number' || ![1, 2, 4].includes(attempt.requested))) return invalid();
    if (attempt.completed !== undefined && (!Number.isSafeInteger(attempt.completed) || (attempt.completed as number) < 0 ||
        (attempt.completed as number) > Number(attempt.requested ?? 4))) return invalid();
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
    if (!object(version) || !fields(version, ['id', 'media_id', 'origin', 'parent_id', 'style_id', 'template_version', 'text_model', 'source', 'connection', 'created_at', 'width', 'height', 'mime_type']) ||
        !identifier(version.id) || !identifier(version.media_id) || ids.has(String(version.id)) || media.has(String(version.media_id)) ||
        !text(version.created_at, 100) || !Number.isFinite(Date.parse(version.created_at as string)) ||
        !['image/png', 'image/jpeg', 'image/webp'].includes(String(version.mime_type)) ||
        !Number.isSafeInteger(version.width) || !Number.isSafeInteger(version.height) || (version.width as number) <= 0 || (version.height as number) <= 0 ||
        (version.width as number) > 16384 || (version.height as number) > 16384 || (version.width as number) * (version.height as number) > 64 * 1024 * 1024 ||
        !object(version.source) || !fields(version.source, ['idea', 'characters']) || !text(version.source.idea, 100000) || !text(version.source.characters, 100000)) return invalid();
    if (version.origin !== undefined && (typeof version.origin !== 'string' || !['model', 'upload'].includes(version.origin))) return invalid();
    if (version.origin === 'upload' && ((version.width as number) * 3 !== (version.height as number) * 2 ||
        version.source.idea !== '' || version.source.characters !== '' ||
        ['connection', 'text_model', 'style_id', 'template_version'].some(key => version[key] !== undefined))) return invalid();
    if (version.style_id !== undefined && (typeof version.style_id !== 'string' || !coverStyles.includes(version.style_id))) return invalid();
    if (version.template_version !== undefined && (!Number.isSafeInteger(version.template_version) || (version.template_version as number) < 1)) return invalid();
    if (version.text_model !== undefined && (!text(version.text_model, 200) || !(version.text_model as string).trim())) return invalid();
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
  const bytes = new Uint8Array(await blob.arrayBuffer()), mime_type = coverMime(bytes);
  if (blob.type !== mime_type) throw new Error('封面图片的文件类型与实际内容不一致。');
  // Bound decoded allocation before giving compressed bytes to the browser.
  const declared = coverImageDimensions(bytes, mime_type);
  checkCoverDimensions(declared.width, declared.height);
  if (typeof createImageBitmap !== 'function') throw new Error('此浏览器无法校验图片，请使用新版浏览器。');
  let image: ImageBitmap;
  try { image = await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { throw new Error('封面图片损坏或无法解码。'); }
  const { width, height } = image;
  image.close();
  checkCoverDimensions(width, height);
  // EXIF orientation can exchange JPEG width and height during browser decoding.
  if (!(width === declared.width && height === declared.height) && !(mime_type === 'image/jpeg' && width === declared.height && height === declared.width)) throw new Error('封面图片声明尺寸与实际内容不一致。');
  return { mime_type, width, height };
}

function checkCoverDimensions(width: number, height: number): void {
  if (!width || !height || width > 16384 || height > 16384 || width * height > 64 * 1024 * 1024) throw new Error('封面图片尺寸过大。');
}

function coverImageDimensions(bytes: Uint8Array, mime: CoverVersion['mime_type']): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === 'image/png') return { width: view.getUint32(16), height: view.getUint32(20) };
  if (mime === 'image/jpeg') {
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 1 || marker === 216 || (marker >= 208 && marker <= 215)) continue;
      if (marker === 217 || marker === 218 || offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker) && length >= 8) return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
      offset += length;
    }
  } else {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const kind = String.fromCharCode(...bytes.subarray(offset, offset + 4)), length = view.getUint32(offset + 4, true), data = offset + 8;
      if (data + length > bytes.length) break;
      if (kind === 'VP8X' && length >= 10) return { width: 1 + bytes[data + 4] + (bytes[data + 5] << 8) + (bytes[data + 6] << 16), height: 1 + bytes[data + 7] + (bytes[data + 8] << 8) + (bytes[data + 9] << 16) };
      if (kind === 'VP8 ' && length >= 10 && bytes[data + 3] === 157 && bytes[data + 4] === 1 && bytes[data + 5] === 42) return { width: view.getUint16(data + 6, true) & 16383, height: view.getUint16(data + 8, true) & 16383 };
      if (kind === 'VP8L' && length >= 5 && bytes[data] === 47) { const packed = view.getUint32(data + 1, true); return { width: 1 + (packed & 16383), height: 1 + ((packed >>> 14) & 16383) }; }
      offset = data + length + (length % 2);
    }
  }
  throw new Error('封面图片损坏或无法读取尺寸。');
}

export function validateProject(value: unknown): asserts value is LocalProject {
  const invalid = () => { throw new Error('项目备份格式不完整或版本不受支持。'); };
  if (!object(value)) return invalid();
  removeLegacyCoverPrompts(value);
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
  if (value.writing_style !== undefined) validateWritingStyle(value.writing_style);
  const graph = value.graph as Record<string, unknown>;
  if (!object(graph.graph) || !Array.isArray(graph.graph.nodes) || !Array.isArray(graph.graph.edges) ||
      !Array.isArray((value.views as Record<string, unknown>).views)) return invalid();
  const batch = value.batch as Record<string, unknown>;
  if (batch.writing_style !== undefined && batch.writing_style !== null) validateWritingStyle(batch.writing_style);
  if (typeof batch.status !== 'string' || !Array.isArray(batch.completed_chapters)) return invalid();
  for (const [number, chapter] of Object.entries(value.chapters as Record<string, unknown>)) {
    if (!object(chapter) || !/^[1-9]\d*$/.test(number) || chapter.chapter_number !== Number(number) ||
        ['title', 'filename', 'content', 'revision'].some(name => typeof chapter[name] !== 'string') ||
        !Array.isArray(chapter.versions) || !object(chapter.workflow)) return invalid();
    for (const version of chapter.versions) {
      if (!object(version) || ['title', 'filename', 'content', 'revision'].some(name => typeof version[name] !== 'string')) return invalid();
    }
    if (object(chapter.frozen_context) && chapter.frozen_context.writing_style_context != null) validateStyleContext(chapter.frozen_context.writing_style_context);
  }
  for (const run of value.runs as unknown[]) {
    if (!object(run) || typeof run.run_id !== 'string' || typeof run.status !== 'string' || !object(run.input)) return invalid();
    if ('planning_trace_invalid' in run && typeof run.planning_trace_invalid !== 'boolean') run.planning_trace_invalid = true;
    if (run.input.writing_style_context != null) validateStyleContext(run.input.writing_style_context);
    if ('planning_trace' in run) {
      const trace = readPlanningTrace(run.planning_trace);
      if (trace.invalid || run.operation !== 'plan_chapter') {
        delete run.planning_trace; run.planning_trace_invalid = true;
      } else run.planning_trace = trace.entries;
    }
  }
}

export function listProjects(): Promise<LocalProject[]> {
  return transact(['projects'], 'readonly', (tx, done, fail) => {
    tx.objectStore('projects').getAll().onsuccess = event => {
      try {
        const projects = (event.target as IDBRequest).result as LocalProject[];
        projects.forEach(validateProject);
        done(projects.sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
      } catch (error) { fail(error); }
    };
  });
}

export function getProject(ref: string): Promise<LocalProject> {
  return transact(['projects'], 'readonly', (tx, done, fail) => {
    const request = tx.objectStore('projects').get(ref);
    request.onsuccess = () => {
      if (!request.result) { fail(new Error('当前工作区中找不到该项目。')); return; }
      try { validateProject(request.result); done(request.result); } catch (error) { fail(error); }
    };
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
          if (!project) throw new Error('当前工作区中找不到该项目。');
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
    request.onsuccess = () => request.result?.blob instanceof Blob ? done(request.result.blob) : fail(new Error('当前工作区中找不到封面原图。'));
  });
}

export async function saveCoverVersion(ref: string, metadata: CoverVersionInput, blob: Blob, guard?: ConnectionGuard | ConnectionGuard[],
  options: { preserveAttempt?: boolean; attemptId?: string; isCurrent?: () => boolean } = {}): Promise<CoverVersion> {
  const checkCurrent = () => { if (options.isCurrent && !options.isCurrent()) throw new Error('封面操作已结束，旧结果未写入。'); };
  checkCurrent();
  const guards = guard ? Array.isArray(guard) ? guard : [guard] : [];
  if (guards.length && metadata.connection?.profile_id !== guards[0].profile_id) throw new Error('封面结果与生成所用连接不一致。');
  const image = await inspectCoverBlob(blob);
  checkCurrent();
  if (metadata.width !== image.width || metadata.height !== image.height) throw new Error('封面尺寸与实际图片不一致。');
  const version: CoverVersion = { ...structuredClone(metadata), ...image, id: `cover_${crypto.randomUUID()}`, media_id: `media_${crypto.randomUUID()}`, created_at: new Date().toISOString() };
  removeLegacyCoverPrompts({ cover: { versions: [version] } });
  checkFields(version);
  await transact<void>(['projects', 'settings', 'cover_media'], 'readwrite', (tx, _done, fail) => {
    const store = tx.objectStore('projects'), request = store.get(ref);
    request.onsuccess = () => {
      const save = () => { try {
        checkCurrent();
        const project = request.result as LocalProject | undefined;
        if (!project) throw new Error('当前工作区中找不到该项目。');
        const cover = projectCover(project);
        if (options.attemptId !== undefined && cover.attempt?.id !== options.attemptId) throw new Error('封面批次已结束或更换，旧结果未写入。');
        if (cover.versions.length >= MAX_COVER_VERSIONS) throw new Error('每个项目最多保存 30 个封面版本，请先备份。');
        if (version.parent_id && !cover.versions.some(item => item.id === version.parent_id)) throw new Error('找不到修改所依据的封面版本。');
        cover.versions.push(version);
        if (!options.preserveAttempt) delete cover.attempt;
        // 封面不参与文字生成输入；沿用当前项目并保持文字 revision，避免作废正在生成的章节。
        project.updated_at = new Date().toISOString();
        validateProject(project);
        tx.objectStore('cover_media').add({ id: version.media_id, project_ref: ref, blob } satisfies CoverMedia);
        store.put(project);
      } catch (error) { fail(error); } };
      let remaining = guards.length;
      if (!remaining) { save(); return; }
      for (const current of guards) {
        const permission = tx.objectStore('settings').get('connection:' + current.profile_id);
        permission.onsuccess = () => { try { checkConnectionGuard(permission.result?.value, current); if (--remaining === 0) save(); } catch (error) { fail(error); } };
      }
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

export async function saveCoverPreferences(ref: string, prefs: { text_connection_id?: string; style_id?: CoverStyleId; count?: 1 | 2 | 4 }): Promise<LocalProject> {
  const project = await updateProject(ref, project => { Object.assign(projectCover(project), prefs); }, undefined, false);
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

const STYLE_PREFIX = 'writing-style:';
let styleChannel: BroadcastChannel | undefined;
function notifyWritingStyles(broadcast = true): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('braipen:styles-changed'));
  if (broadcast) styleChannel?.postMessage('changed');
}
if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
  styleChannel = new BroadcastChannel('braipen:writing-styles');
  styleChannel.onmessage = () => notifyWritingStyles(false);
}
export async function listWritingStyles(): Promise<WritingStyleCard[]> {
  const cards = await listSettings<WritingStyleCard>(STYLE_PREFIX);
  cards.forEach(validateWritingStyle);
  return cards.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
export async function saveWritingStyle(card: WritingStyleCard, expectedRevision = 0): Promise<WritingStyleCard> {
  validateWritingStyle(card);
  const saved = await transact<WritingStyleCard>(['settings'], 'readwrite', (tx, done, fail) => {
    const store = tx.objectStore('settings'), read = store.get(STYLE_PREFIX + card.id);
    read.onsuccess = () => { try {
      const old = read.result?.value as WritingStyleCard | undefined;
      if ((old?.revision || 0) !== expectedRevision) throw new Error('文风卡已在另一处修改或删除，请重新载入后保存；当前草稿保留。');
      const next = { ...structuredClone(card), revision: expectedRevision + 1, updated_at: new Date().toISOString() };
      store.put({ key: STYLE_PREFIX + next.id, value: next }); done(next);
    } catch (error) { fail(error); } };
  });
  notifyWritingStyles(); return saved;
}
export async function deleteWritingStyle(id: string, expectedRevision: number): Promise<void> {
  await transact<void>(['settings'], 'readwrite', (tx, _done, fail) => {
    const store = tx.objectStore('settings'), read = store.get(STYLE_PREFIX + id);
    read.onsuccess = () => { if (read.result?.value?.revision !== expectedRevision) { fail(new Error('文风卡已改变，请刷新后重试。')); return; } store.delete(STYLE_PREFIX + id); };
  });
  notifyWritingStyles();
}
export async function selectProjectWritingStyle(ref: string, card?: WritingStyleCard, expectedRevision?: number): Promise<LocalProject> {
  if (card) validateWritingStyle(card);
  const project = await updateProject(ref, p => { if (card) p.writing_style = structuredClone(card); else delete p.writing_style; }, expectedRevision);
  coverChanged(ref); return project;
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
    const writing_styles = object(rescue) && Array.isArray(rescue.writing_styles) ? rescue.writing_styles : [];
    writing_styles.forEach(validateWritingStyle);
    download({ format: 'braipen-backup', version: 4, created_at: new Date().toISOString(), projects, cover_media, writing_styles,
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

export type WorkspaceBackup = { format: string; version: number; created_at: string; connections: unknown; projects: LocalProject[]; cover_media: BackupCoverMedia[]; writing_styles: WritingStyleCard[]; imports: ImportRecord<unknown>[]; drafts: Array<{ name: string; value: unknown }> };
async function backupFromRows(rows: Rows): Promise<WorkspaceBackup> {
  const projects = structuredClone([...rows.projects.values()]) as LocalProject[];
  const settings = [...rows.settings.values()];
  const styles = settings.filter(row => row.key.startsWith(STYLE_PREFIX)).map(row => structuredClone(row.value)) as WritingStyleCard[];
  const imports = structuredClone([...rows.imports.values()]) as ImportRecord<unknown>[];
  const drafts = structuredClone([...editorDrafts].map(([name, value]) => ({ name, value })));
  projects.forEach(validateProject); styles.forEach(validateWritingStyle); checkFields(imports); checkFields(drafts);
  const media = [...rows.cover_media.values()] as CoverMedia[];
  if (media.reduce((total, row) => total + row.blob.size, 0) > MAX_BACKUP_COVER_BYTES) throw new Error('工作区封面总量超过 120 MiB。');
  const cover_media: BackupCoverMedia[] = [];
  for (const row of media) cover_media.push({ id: row.id, project_ref: row.project_ref, mime_type: row.blob.type, bytes: row.blob.size, base64: encodeCoverBytes(new Uint8Array(await row.blob.arrayBuffer())) });
  validateBackupMedia(projects, cover_media);
  return { format: 'braipen-backup', version: 5, created_at: new Date().toISOString(), connections: safeCopy(settings.filter(row => row.key.startsWith('connection:')).map(row => row.value)), projects, cover_media, writing_styles: styles, imports, drafts };
}
export async function createBackup(): Promise<WorkspaceBackup> {
  const config = await browserTransact<any[]>(['settings'], 'readonly', (tx, done) => { const r = tx.objectStore('settings').getAll(); r.onsuccess = () => done(r.result.filter((row: any) => !creativeSetting(row.key))); });
  return backupFromRows({ ...workspaceRows, settings: new Map([...config.map(row => [row.key, row] as const), ...workspaceRows.settings]) });
}

export async function exportBackup(): Promise<void> {
  download(await createBackup(), `braipen-backup-${new Date().toISOString().slice(0, 10)}.json`);
}

function readBackup(text: string): { projects: LocalProject[]; media: CoverMedia[]; styles: WritingStyleCard[]; raw: Record<string, unknown> } {
  if (new Blob([text]).size > MAX_BACKUP_FILE_BYTES) throw new Error('完整备份超过 200 MiB，请使用较小的备份文件。');
  let backup: unknown;
  try { backup = JSON.parse(text); } catch { throw new Error('工作区文件无法解析，请选择有效的工作区文件。'); }
  if (!object(backup) || backup.format !== 'braipen-backup' || ![1, 2, 3, 4, 5].includes(Number(backup.version)) || !Array.isArray(backup.projects)) {
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
  if (Number(backup.version) < 3 && backup.cover_media !== undefined) throw new Error('图片备份必须使用版本 3 或 4。');
  const media = validateBackupMedia(projects, Number(backup.version) >= 3 ? backup.cover_media : []);
  if (Number(backup.version) >= 4 && !Array.isArray(backup.writing_styles)) throw new Error('版本 4 备份缺少文风库。');
  if (Number(backup.version) < 4 && backup.writing_styles !== undefined) throw new Error('文风库备份必须使用版本 4 或更新版本。');
  const styles = (backup.writing_styles || []) as WritingStyleCard[], styleIds = new Set<string>();
  for (const style of styles) { validateWritingStyle(style); if (styleIds.has(style.id)) throw new Error('备份包含重复的文风卡标识。'); styleIds.add(style.id); }
  if (Number(backup.version) === 5) {
    if (!Array.isArray(backup.imports) || !Array.isArray(backup.drafts)) throw new Error('工作区缺少创作草稿。');
    const ids = new Set<string>();
    for (const row of backup.imports) {
      if (!object(row) || typeof row.id !== 'string' || !row.id || ids.has(row.id) || !object(row.data)) throw new Error('导入草稿格式无效。');
      ids.add(row.id);
    }
    const keys = new Set<string>();
    for (const row of backup.drafts) {
      if (!object(row) || typeof row.name !== 'string' || !row.name.startsWith('workspace-draft:') || keys.has(row.name) || row.value === undefined) throw new Error('编辑草稿格式无效。');
      const value = row.value;
      if (row.name === 'workspace-draft:style-editor') {
        if (!object(value) || !object(value.card) || typeof value.card.name !== 'string' || typeof value.card.rules !== 'string' || !Array.isArray(value.card.examples) || !object(value.card.source) || typeof value.card.source.label !== 'string' || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || (value.candidates !== undefined && !Array.isArray(value.candidates))) throw new Error('文风编辑草稿格式无效。');
        for (const item of [...value.card.examples, ...(value.candidates || []) as unknown[]]) {
          if (!object(item) || typeof item.id !== 'string' || typeof item.text !== 'string' || !object(item.source) || typeof item.source.label !== 'string' || !Array.isArray(item.scene_tags) || item.scene_tags.some(tag => typeof tag !== 'string') || typeof item.pov !== 'string' || typeof item.pace !== 'string') throw new Error('文风范例草稿格式无效。');
        }
      }
      if (row.name.startsWith('workspace-draft:style-source:') && (!object(value) || !['project','import'].includes(String(value.mode)) || typeof value.text !== 'string' || typeof value.label !== 'string' || !Array.isArray(value.chapters) || value.chapters.some(number => !Number.isSafeInteger(number) || number < 1))) throw new Error('文风原文草稿格式无效。');
      if (row.name.startsWith('workspace-draft:setting:') && (!object(value) || typeof value.snapshot !== 'string' || !object(value.values) || Object.values(value.values).some(item => typeof item !== 'string') || !Array.isArray(value.fields))) throw new Error('设定编辑草稿格式无效。');
      if (row.name.startsWith('workspace-draft:braipen:chapter-draft:') && (!object(value) || ['content','baseContent','baseRevision'].some(field => typeof value[field] !== 'string'))) throw new Error('正文编辑草稿格式无效。');
      keys.add(row.name);
    }
  }
  return { projects, media, styles, raw: backup };
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
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if ((key === 'writing_style' || key === 'writing_style_context') && object(item)) {
        const style = structuredClone(item) as WritingStyleCard | WritingStyleContext;
        if (key === 'writing_style') validateWritingStyle(style); else validateStyleContext(style);
        remapWritingStyleSources(style, ids); return [key, style];
      }
      return [ids.get(key) ?? key, remap(item, ids)];
    }));
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
  const { projects, media, styles, raw } = readBackup(text);
  if (Number(raw.version) === 5 && ((raw.imports as unknown[]).length || (raw.drafts as unknown[]).length)) throw new Error('此工作区包含未完成草稿，请使用“打开工作区文件”完整载入。');
  const versions = new Map(projects.flatMap(project => (project.cover?.versions ?? []).map(version => [version.media_id, version] as const)));
  for (const row of media) {
    const image = await inspectCoverBlob(row.blob), version = versions.get(row.id)!;
    if (image.width !== version.width || image.height !== version.height) throw new Error('封面备份的尺寸与实际图片不一致。');
  }
  const copies = restoreCopies(projects);
  const styleIds = new Map<string, string>();
  const collectStyles = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(collectStyles); return; }
    if (!object(value)) return;
    for (const [key, item] of Object.entries(value)) {
      const card = key === 'writing_style' && object(item) ? item : key === 'writing_style_context' && object(item) && object(item.card) ? item.card : undefined;
      if (card && typeof card.id === 'string' && !styleIds.has(card.id)) styleIds.set(card.id, `style_${crypto.randomUUID()}`);
      collectStyles(item);
    }
  };
  copies.forEach(collectStyles);
  for (const card of styles) if (!styleIds.has(card.id)) styleIds.set(card.id, `style_${crypto.randomUUID()}`);
  copies.forEach(copy => remapWritingStyleIds(copy, styleIds));
  const restoredStyles = styles.map(card => ({ ...structuredClone(card), id: styleIds.get(card.id)! }));
  const projectRefs = new Map(projects.map((project, index) => [project.project_ref, copies[index].project_ref]));
  restoredStyles.forEach(card => remapWritingStyleSources(card, projectRefs));
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
    for (const [k,v] of Object.entries(value)) { if ((k === 'connection_id' || k === 'text_connection_id' || k === 'profile_id') && typeof v === 'string' && mapped.has(v)) (value as Record<string,unknown>)[k] = mapped.get(v); else remapConnections(v); }
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
      for (const card of restoredStyles) tx.objectStore('settings').add({ key: STYLE_PREFIX + card.id, value: card });
    });
  } catch (error) {
    const rawMedia = raw.cover_media as BackupCoverMedia[] | undefined;
    rememberRescue({ projects: copies, connections: restoredProfiles, writing_styles: restoredStyles, cover_media: (rawMedia ?? []).map(row => ({ ...row, ...mediaIds.get(row.id)! })) });
    throw storageError(error);
  }
  notifyWritingStyles();
  return copies.map(project => project.project_ref);
}

/** Open a workspace in place; unlike backup recovery this preserves all identities. */
export async function openWorkspace(text: string): Promise<void> {
  const { projects, media, styles, raw } = readBackup(text);
  for (const row of media) {
    const image = await inspectCoverBlob(row.blob);
    const version = projects.flatMap(project => project.cover?.versions || []).find(item => item.media_id === row.id)!;
    if (image.width !== version.width || image.height !== version.height) throw new Error('工作区封面尺寸无效。');
  }
  await workspaceQueue;
  const imports = (raw.imports || []) as ImportRecord<unknown>[];
  const drafts = (raw.drafts || []) as Array<{ name: string; value: unknown }>;
  workspaceRows.projects = new Map(projects.map(project => [project.project_ref, project]));
  workspaceRows.cover_media = new Map(media.map(row => [row.id, row]));
  workspaceRows.imports = new Map(imports.map(row => [row.id, row]));
  workspaceRows.settings = new Map(styles.map(card => [STYLE_PREFIX + card.id, { key: STYLE_PREFIX + card.id, value: card }]));
  editorDrafts.clear(); for (const row of drafts) editorDrafts.set(row.name, row.value);
  unsavedWorkspace = false; rescue = undefined;
  notifyWritingStyles(false); workspaceChanged();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('braipen:projects-changed'));
    window.dispatchEvent(new Event('braipen:workspace-opened'));
  }
}

export async function flushWorkspace(): Promise<void> {
  const task = workspaceQueue.then(async () => {
    if (!workspaceWriter) throw new Error('尚未打开本机文件夹，请选择文件夹或下载工作区文件。');
    const snapshot = await createBackup(); await workspaceWriter(snapshot); markWorkspaceSaved(snapshot);
  });
  workspaceQueue = task.catch(() => undefined); return task;
}

const legacySignatures = new WeakMap<WorkspaceBackup, string>();
function legacySignature(rows: Rows): string {
  // Cover records use immutable IDs; project revisions and media membership change on edits.
  return JSON.stringify([[...rows.projects.values()], [...rows.imports.values()],
    [...rows.cover_media.values()].map(row => [row.id, row.project_ref, row.blob.size, row.blob.type]),
    [...rows.settings.values()].filter(row => row.key.startsWith(STYLE_PREFIX))]);
}
/** The legacy database is read only until the user explicitly migrates and clears it. */
export async function readLegacyWorkspace(): Promise<WorkspaceBackup> {
  const rows: Rows = { projects: new Map(), imports: new Map(), cover_media: new Map(), settings: new Map() };
  await browserTransact<void>(Object.keys(rows), 'readonly', tx => {
    for (const name of Object.keys(rows)) {
      const r = tx.objectStore(name).getAll();
      r.onsuccess = () => { for (const row of r.result) rows[name].set(name === 'projects' ? row.project_ref : name === 'settings' ? row.key : row.id, row); };
    }
  });
  const originalSignature = legacySignature(rows);
  for (const project of rows.projects.values()) {
    if (project.schema_version === 1) { project.schema_version = 2; project.config.connection_id = 'legacy-deepseek'; }
    removeLegacyCoverPrompts(project);
  }
  const snapshot = await backupFromRows(rows);
  snapshot.drafts = [];
  if (typeof window !== 'undefined') for (let i = 0; i < window.sessionStorage.length; i++) {
    const key = window.sessionStorage.key(i);
    if (key?.startsWith('braipen:chapter-draft:')) {
      const value = JSON.parse(window.sessionStorage.getItem(key) || 'null'); checkFields(value);
      if (object(value)) snapshot.drafts.push({ name: 'workspace-draft:' + key, value });
    }
  }
  legacySignatures.set(snapshot, originalSignature);
  return snapshot;
}
export async function legacyWorkspaceDigest(snapshot: WorkspaceBackup): Promise<string> {
  const content = JSON.stringify([snapshot.projects, snapshot.writing_styles, snapshot.cover_media, snapshot.imports, snapshot.drafts]);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function clearLegacyWorkspace(expectedDigest: string): Promise<void> {
  const snapshot = await readLegacyWorkspace();
  if (await legacyWorkspaceDigest(snapshot) !== expectedDigest) throw new Error('旧创作资料已发生变化，请重新迁移后再清理。');
  await browserTransact<void>(['projects', 'imports', 'cover_media', 'settings'], 'readwrite', (tx, _done, fail) => {
    const rows: Rows = { projects: new Map(), imports: new Map(), cover_media: new Map(), settings: new Map() };
    let remaining = 4;
    for (const name of Object.keys(rows)) {
      const request = tx.objectStore(name).getAll();
      request.onsuccess = () => { try {
        for (const row of request.result) rows[name].set(name === 'projects' ? row.project_ref : name === 'settings' ? row.key : row.id, row);
        if (--remaining) return;
        if (legacySignature(rows) !== legacySignatures.get(snapshot)) { fail(new Error('旧创作资料在清理前被其他页面修改，请重新迁移。')); return; }
        for (const store of ['projects', 'imports', 'cover_media']) tx.objectStore(store).clear();
        for (const card of snapshot.writing_styles) tx.objectStore('settings').delete(STYLE_PREFIX + card.id);
        tx.objectStore('settings').delete('local-folder-sync.v1');
      } catch (error) { fail(error); } };
    }
  });
  if (typeof window !== 'undefined') for (const row of snapshot.drafts) window.sessionStorage.removeItem(row.name.slice('workspace-draft:'.length));
}
