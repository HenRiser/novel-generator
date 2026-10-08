import { createBackup, getSetting, listProjects, MAX_BACKUP_FILE_BYTES, setSetting } from './localStore';
import type { LocalProject } from './localTypes';

export const LOCAL_FOLDER_FILE = 'braipen-workspace.json';
const BINDING_KEY = 'local-folder-sync.v1';
const LOCK_NAME = 'braipen:local-folder-sync';
const MERGE_DELAY = 1500;
const ACTIVE_DELAY = 30_000;
const ENVIRONMENT_KEYS = ['default_connection', 'default_image_connection', 'default_model'] as const;

// File System Access permission methods are not included in every DOM type library.
type SyncFileHandle = {
  getFile(): Promise<File>;
  isSameEntry?(other: SyncFileHandle): Promise<boolean>;
  createWritable(options?: { keepExistingData?: boolean; mode?: 'exclusive' }): Promise<{
    write(data: Blob): Promise<void>; close(): Promise<void>; abort(): Promise<void>;
  }>;
};
export type SyncDirectoryHandle = {
  name: string; kind: 'directory';
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  isSameEntry?(other: SyncDirectoryHandle): Promise<boolean>;
  removeEntry(name: string): Promise<void>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<SyncFileHandle>;
};
type FolderBinding = { version: 1; workspaceId: string; bindingId?: string; handle?: SyncDirectoryHandle };
export type LocalFolderSyncState = {
  status: 'unsupported' | 'unbound' | 'pending' | 'syncing' | 'synced' | 'permission-required' | 'quota' | 'error';
  folderName?: string; lastSyncedAt?: string; message: string;
};
type PickerWindow = Window & { showDirectoryPicker?: (options: { id: string; mode: 'readwrite' }) => Promise<SyncDirectoryHandle> };
const hasPicker = () => typeof window !== 'undefined' && typeof (window as PickerWindow).showDirectoryPicker === 'function';
const hasLocks = () => typeof navigator !== 'undefined' && Boolean(navigator.locks?.request);
const supported = () => hasPicker() && hasLocks();
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const errorName = (error: unknown) => object(error) && typeof error.name === 'string' ? error.name : '';
const errorMessage = (error: unknown) => object(error) && typeof error.message === 'string' ? error.message : '文件夹写入未完成，请重试。';

let state: LocalFolderSyncState = { status: supported() ? 'unbound' : 'unsupported', message: '尚未选择自动同步文件夹。' };
let binding: FolderBinding | undefined;
let initialization: Promise<void> | undefined;
let inFlight: Promise<void> | undefined;
let choosing = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let changeVersion = 0;
let dirty = false;
let dirtySince = 0;
const subscribers = new Set<() => void>();
let bindingChannel: BroadcastChannel | undefined;

async function withFolderLock<T>(operation: () => Promise<T>): Promise<T> {
  if (!hasLocks()) return Promise.reject(new Error('此浏览器未提供跨标签页安全锁，请使用下载备份与文件恢复。'));
  return await navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, operation);
}
async function readLatestBinding(): Promise<FolderBinding> {
  const saved = await getSetting<FolderBinding>(BINDING_KEY);
  const latest: FolderBinding = saved?.version === 1 && typeof saved.workspaceId === 'string' && saved.workspaceId ? saved :
    { version: 1, workspaceId: binding?.workspaceId || crypto.randomUUID() };
  if ((latest.bindingId || latest.handle?.name) !== (binding?.bindingId || binding?.handle?.name)) publish({ lastSyncedAt: undefined });
  binding = latest;
  publish({ folderName: latest.handle?.name });
  if (!latest.handle) {
    clearTimer(); dirty = false; dirtySince = 0;
    publish({ status: 'unbound', lastSyncedAt: undefined, message: '尚未选择同步文件夹，或已在其他标签页停止同步。' });
  }
  return latest;
}
async function refreshBindingLocked(): Promise<void> {
  const latest = await readLatestBinding();
  if (!latest.handle) return;
  if (await latest.handle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
    dirty = true; dirtySince ||= Date.now(); publish({ status: 'permission-required', message: '文件夹写入权限需要确认，请点击“重新授权”。' });
  } else { publish({ status: 'pending', message: '有更改待同步到所选文件夹。' }); changed(); }
}
const notifyBinding = () => bindingChannel?.postMessage({ type: 'binding-changed' });

function publish(patch: Partial<LocalFolderSyncState>) {
  state = { ...state, ...patch };
  for (const subscriber of subscribers) subscriber();
}
export const getLocalFolderSyncState = () => state;
export function subscribeLocalFolderSync(subscriber: () => void) { subscribers.add(subscriber); return () => { subscribers.delete(subscriber); }; }

function failure(error: unknown, prefix = '') {
  clearTimer();
  const name = errorName(error);
  publish({ status: ['NotAllowedError', 'SecurityError'].includes(name) ? 'permission-required' : name === 'QuotaExceededError' ? 'quota' : 'error',
    message: prefix + (['NotAllowedError', 'SecurityError'].includes(name) ? '文件夹写入权限已失效，请点击“重新授权”。' :
      name === 'QuotaExceededError' ? '文件夹或浏览器存储空间不足；本次未同步，请释放空间后重试。' : errorMessage(error)) });
}
function clearTimer() { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
function schedule(delay = MERGE_DELAY) {
  if (!binding?.handle || choosing || ['permission-required', 'quota', 'error'].includes(state.status)) return;
  clearTimer();
  timer = setTimeout(() => { timer = undefined; void syncLocalFolder(false); }, delay);
}
function changed() {
  changeVersion++;
  if (!dirty) dirtySince = Date.now();
  dirty = true;
  if (!binding?.handle || ['permission-required', 'quota', 'error'].includes(state.status)) return;
  publish({ status: inFlight ? 'syncing' : 'pending', message: '有更改待同步到所选文件夹。' });
  schedule(Math.min(MERGE_DELAY, Math.max(0, ACTIVE_DELAY - (Date.now() - dirtySince))));
}

export function hasActiveFolderWork(projects: LocalProject[]): boolean {
  return projects.some(project => project.runs.some(run => run.status === 'running') ||
    ['running', 'stopping'].includes(project.batch.status) || project.cover?.attempt?.status === 'running');
}

async function folderSnapshot(workspaceId: string) {
  const [backup, values] = await Promise.all([createBackup(), Promise.all(ENVIRONMENT_KEYS.map(key => getSetting<unknown>(key)))]);
  const environment: Record<string, string | number> = { version: 1 };
  ENVIRONMENT_KEYS.forEach((key, i) => { if (typeof values[i] === 'string' && (values[i] as string).length <= 300) environment[key] = values[i] as string; });
  const snapshot = { ...backup, folder_sync: { version: 1, workspace_id: workspaceId }, environment };
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  if (blob.size > MAX_BACKUP_FILE_BYTES) throw new Error('完整备份超过 200 MiB，本次未同步。请减少单次备份内容。');
  return { blob, projectCount: Array.isArray(backup.projects) ? backup.projects.length : 0 };
}

// Call only while holding the workspace lock; lock covers snapshot capture as well as close.
async function writeSnapshotLocked(handle: SyncDirectoryHandle, workspaceId: string): Promise<string> {
  if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') throw new DOMException('文件夹需要重新授权。', 'NotAllowedError');
  const { blob, projectCount } = await folderSnapshot(workspaceId);
  let file: Awaited<ReturnType<SyncDirectoryHandle['getFileHandle']>> | undefined;
  try { file = await handle.getFileHandle(LOCAL_FOLDER_FILE); }
  catch (error) { if (errorName(error) !== 'NotFoundError') throw error; }
  if (file) {
    const existingFile = await file.getFile();
    if (existingFile.size > MAX_BACKUP_FILE_BYTES) throw new Error('文件夹中已有同名大文件，已拒绝覆盖。请选择其他文件夹。');
    let existing: unknown;
    try { existing = JSON.parse(await existingFile.text()); } catch { throw new Error('文件夹中已有同名文件，无法确认其归属，已拒绝覆盖。'); }
    if (!object(existing) || existing.format !== 'braipen-backup' || existing.version !== 3 || !Array.isArray(existing.projects) ||
      !object(existing.folder_sync) || existing.folder_sync.version !== 1 || existing.folder_sync.workspace_id !== workspaceId) {
      throw new Error('文件夹中已有其他工作空间的同名文件，已拒绝覆盖。请选择其他文件夹或先恢复该备份。');
    }
    if (!projectCount && existing.projects.length) throw new Error('当前工作空间没有项目，已阻止覆盖文件夹中的非空备份。请先恢复备份或选择新文件夹。');
  }
  const created = !file;
  file ??= await handle.getFileHandle(LOCAL_FOLDER_FILE, { create: true });
  const placeholder = created ? await file.getFile() : undefined;
  let writable: Awaited<ReturnType<typeof file.createWritable>> | undefined;
  try { writable = await file.createWritable({ keepExistingData: false, mode: 'exclusive' }); await writable.write(blob); await writable.close(); }
  catch (error) {
    await writable?.abort().catch(() => undefined);
    // Delete only the same entry, still empty and unchanged since our own creation.
    if (placeholder) { try {
      const current = await handle.getFileHandle(LOCAL_FOLDER_FILE), currentFile = await current.getFile();
      if (file.isSameEntry && await file.isSameEntry(current) && !currentFile.size && currentFile.lastModified === placeholder.lastModified) await handle.removeEntry(LOCAL_FOLDER_FILE);
    } catch { /* Original failure remains visible. */ } }
    throw error;
  }
  return new Date().toISOString();
}
export function writeFolderSnapshot(handle: SyncDirectoryHandle, workspaceId: string): Promise<string> {
  return withFolderLock(() => writeSnapshotLocked(handle, workspaceId));
}

export function startLocalFolderSync(): Promise<void> {
  if (initialization) return initialization;
  initialization = (async () => {
    if (!supported()) { publish({ status: 'unsupported', message: hasPicker() ? '此浏览器未提供跨标签页安全锁，已停用文件夹同步，请使用下方下载备份与文件恢复。' : '此浏览器未提供文件夹同步，请使用下方下载备份与文件恢复。' }); return; }
    for (const event of ['braipen:projects-changed', 'braipen:workflow-changed', 'braipen:connections-changed', 'braipen:batch-changed']) window.addEventListener(event, changed);
    if (typeof BroadcastChannel !== 'undefined') {
      bindingChannel = new BroadcastChannel('braipen:local-folder-binding');
      bindingChannel.addEventListener('message', event => {
        if (event.data?.type === 'binding-changed') void withFolderLock(refreshBindingLocked).catch(error => failure(error));
      });
    }
    try {
      await withFolderLock(refreshBindingLocked);
    } catch (error) { failure(error); }
  })();
  return initialization;
}

async function syncLocalFolder(force: boolean): Promise<void> {
  await startLocalFolderSync();
  if (inFlight) { await inFlight; if (force && dirty) await syncLocalFolder(true); return; }
  if (!supported() || choosing || (!force && !dirty)) return;
  clearTimer();
  inFlight = withFolderLock(async () => {
      const current = await readLatestBinding();
      if (!current.handle) return;
      if (!force && hasActiveFolderWork(await listProjects()) && Date.now() - dirtySince < ACTIVE_DELAY) {
        publish({ status: 'pending', message: '生成或批次进行中，合并更改后同步；任务结束时会尽快同步。' });
        schedule(Math.min(5000, Math.max(0, ACTIVE_DELAY - (Date.now() - dirtySince)))); return;
      }
      const version = changeVersion;
      publish({ status: 'syncing', message: '正在写入所选文件夹…' });
      const lastSyncedAt = await writeSnapshotLocked(current.handle, current.workspaceId);
      dirty = changeVersion !== version;
      dirtySince = dirty ? Date.now() : 0;
      publish({ status: dirty ? 'pending' : 'synced', lastSyncedAt, message: dirty ? '快照已写入，新增更改待同步。' : '项目与模型配置已同步到所选文件夹。' });
  }).catch(error => { dirty = true; failure(error); });
  try { await inFlight; } finally { inFlight = undefined; if (dirty && state.status === 'pending' && timer === undefined) schedule(); }
}
export async function syncLocalFolderNow(): Promise<void> {
  if (!supported()) return;
  publish({ status: 'pending', message: '准备同步当前项目与模型配置。' });
  dirty = true; dirtySince ||= Date.now();
  await syncLocalFolder(true);
}

export async function chooseLocalFolder(): Promise<boolean> {
  if (!supported() || choosing) return false;
  choosing = true;
  let picked = false;
  clearTimer();
  try {
    // The system picker must be called directly from the user's button click.
    const handle = await (window as PickerWindow).showDirectoryPicker!({ id: 'braipen-workspace', mode: 'readwrite' });
    picked = true;
    await startLocalFolderSync();
    await inFlight;
    await withFolderLock(async () => {
      const current = await readLatestBinding();
      const next: FolderBinding = { version: 1, workspaceId: current.workspaceId, bindingId: crypto.randomUUID(), handle };
      const version = changeVersion;
      publish({ status: 'syncing', message: '正在向新文件夹写入当前项目与模型配置…' });
      const lastSyncedAt = await writeSnapshotLocked(handle, next.workspaceId);
      await setSetting(BINDING_KEY, next);
      binding = next;
      dirty = version !== changeVersion; dirtySince = dirty ? Date.now() : 0;
      publish({ status: dirty ? 'pending' : 'synced', folderName: handle.name, lastSyncedAt, message: dirty ? '新文件夹已绑定，新增更改待同步。' : '新文件夹已绑定并完成首次同步，旧文件夹中的备份保留。' });
      notifyBinding();
    });
    return true;
  } catch (error) {
    if (!picked && errorName(error) === 'AbortError') return false;
    failure(error, binding?.handle ? '原文件夹绑定保留。' : '未绑定新文件夹。'); return false;
  } finally { choosing = false; if (dirty && ['pending', 'syncing'].includes(state.status)) { publish({ status: 'pending' }); schedule(); } }
}

export async function reauthorizeLocalFolder(): Promise<void> {
  if (!binding?.handle || choosing) return;
  const requested = binding;
  try {
    // Never request permission in a timer or on page load.
    const permission = await requested.handle!.requestPermission({ mode: 'readwrite' });
    const authorized = await withFolderLock(async () => {
      const current = await readLatestBinding();
      if (!current.handle) return false;
      const same = requested.bindingId || current.bindingId ? requested.bindingId === current.bindingId :
        requested.handle === current.handle || Boolean(await requested.handle!.isSameEntry?.(current.handle));
      if (!same) { await refreshBindingLocked(); return false; }
      if (permission !== 'granted') { publish({ status: 'permission-required', message: '尚未获得文件夹写入权限，项目继续保存在此浏览器。' }); return false; }
      publish({ status: 'pending', message: '文件夹权限已确认，准备同步。' }); notifyBinding(); return true;
    });
    if (authorized) await syncLocalFolderNow();
  } catch (error) { if (errorName(error) !== 'AbortError') failure(error); }
}

export async function disconnectLocalFolder(): Promise<void> {
  if (choosing) return;
  await startLocalFolderSync(); await inFlight; clearTimer();
  try {
    await withFolderLock(async () => {
      const current = await readLatestBinding();
      const next: FolderBinding = { version: 1, workspaceId: current.workspaceId, bindingId: crypto.randomUUID() };
      await setSetting(BINDING_KEY, next); binding = next; dirty = false; clearTimer();
      publish({ status: 'unbound', folderName: undefined, lastSyncedAt: undefined, message: '已停止文件夹同步，文件夹中的备份保留。' });
      notifyBinding();
    });
  } catch (error) { failure(error); }
}

// The settings page is imported at application startup; syncing also runs on other pages.
if (typeof window !== 'undefined') void startLocalFolderSync();
