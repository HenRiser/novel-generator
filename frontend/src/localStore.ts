import type { ConnectionGuard, ConnectionProfile } from './providerTypes';
import type { LocalProject } from './localTypes';

const DATABASE = 'braipen.local.v1';
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
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      const db = request.result, tx = request.transaction!;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'project_ref' });
      if (!db.objectStoreNames.contains('imports')) db.createObjectStore('imports', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
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
  return transact(['projects'], 'readwrite', tx => { tx.objectStore('projects').delete(ref); });
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
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadRescue(): void {
  if (rescue === undefined) throw new Error('当前没有尚未保存的应急副本。');
  const projects = object(rescue) && Array.isArray(rescue.projects) ? rescue.projects : [rescue];
  try {
    projects.forEach(validateProject);
    download({ format: 'braipen-backup', version: 2, created_at: new Date().toISOString(), projects }, 'braipen-rescue.json');
    return;
  } catch { /* 导入草稿等尚未成为完整项目的数据也可以单独抢救。 */ }
  download({ format: 'braipen-rescue', version: 1, created_at: new Date().toISOString(), data: rescue }, 'braipen-rescue.json');
}

export async function exportBackup(): Promise<void> {
  download({ format: 'braipen-backup', version: 2, created_at: new Date().toISOString(), connections: safeCopy(await listSettings<ConnectionProfile>('connection:')), projects: safeCopy(await listProjects()) },
    `braipen-backup-${new Date().toISOString().slice(0, 10)}.json`);
}

export function parseBackup(text: string): LocalProject[] {
  const backup: unknown = JSON.parse(text);
  if (!object(backup) || backup.format !== 'braipen-backup' || ![1, 2].includes(Number(backup.version)) || !Array.isArray(backup.projects)) {
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
  return backup.projects as LocalProject[];
}

export function restoreCopies(projects: LocalProject[]): LocalProject[] {
  projects.forEach(validateProject);
  const refs = new Map(projects.map(project => [project.project_ref, `book:bk_${crypto.randomUUID().replace(/-/g, '')}`]));
  const remap = (value: unknown): unknown => {
    if (typeof value === 'string') return refs.get(value) ?? value;
    if (Array.isArray(value)) return value.map(remap);
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [refs.get(key) ?? key, remap(item)]));
    return value;
  };
  return projects.map(project => {
    const copy = remap(project) as LocalProject;
    copy.title += '（恢复副本）'; copy.config.title = copy.title; copy.updated_at = new Date().toISOString();
    copy.runs.forEach(run => { if (run.status === 'running') { run.status = 'interrupted'; run.error = '备份恢复后，请确认是否继续此任务。'; } });
    if (copy.batch.status === 'running' || copy.batch.status === 'stopping') { copy.batch.status = 'stopped'; copy.batch.message = '备份恢复后需手动继续。'; }
    return copy;
  });
}

export async function restoreBackup(text: string): Promise<string[]> {
  const copies = restoreCopies(parseBackup(text));
  const raw = JSON.parse(text);
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
  try {
    await transact<void>(['projects','settings'], 'readwrite', tx => {
      copies.forEach(project => tx.objectStore('projects').add(project));
      for (const profile of descriptors) { const id = mapped.get(profile.id)!; remapConnections(profile); tx.objectStore('settings').add({ key: 'connection:' + id, value: { ...profile, id, enabled:false, deleted:false, epoch:0, key_version:crypto.randomUUID(), test:undefined } }); }
    });
  } catch (error) { rememberRescue({ projects: copies }); throw storageError(error); }
  return copies.map(project => project.project_ref);
}
