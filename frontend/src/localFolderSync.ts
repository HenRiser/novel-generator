import { createBackup, openWorkspace, flushWorkspace, setWorkspaceWriter, changeWorkspaceBinding, markWorkspaceSaved, workspaceHasUnsavedChanges, getWorkspaceEpoch,
  readLegacyWorkspace, legacyWorkspaceDigest, clearLegacyWorkspace, listProjects, MAX_BACKUP_FILE_BYTES, type WorkspaceBackup } from './localStore';
import { hasWorkspaceActivity } from './workspaceActivity';

export const LOCAL_FOLDER_FILE = 'braipen-workspace.json';
type SyncFileHandle = {
  getFile(): Promise<File>;
  createWritable(options?: { keepExistingData?: boolean; mode?: 'exclusive' }): Promise<{
    write(data: Blob): Promise<void>; close(): Promise<void>; abort(): Promise<void>;
  }>;
};
export type SyncDirectoryHandle = {
  name: string; kind: 'directory';
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<SyncFileHandle>;
};
export type LocalFolderSyncState = {
  status: 'unsupported' | 'unbound' | 'pending' | 'syncing' | 'synced' | 'permission-required' | 'quota' | 'error';
  folderName?: string; lastSyncedAt?: string; message: string; migrated?: boolean;
};
type PickerWindow = Window & { showDirectoryPicker?: (options: { id: string; mode: 'readwrite' }) => Promise<SyncDirectoryHandle> };
const supported = () => typeof window !== 'undefined' && Boolean((window as PickerWindow).showDirectoryPicker) && typeof navigator !== 'undefined' && Boolean(navigator.locks?.request);
let state: LocalFolderSyncState = { status: supported() ? 'unbound' : 'unsupported', message: '打开本机工作区后自动保存；未打开时，请下载工作区保存本次内容。' };
type FolderBinding = { directory: SyncDirectoryHandle; workspaceId: string; expectedText?: string };
let binding: FolderBinding | undefined;
let changingBinding = false;
let migrationDigest = '', timer: ReturnType<typeof setTimeout> | undefined, started = false;
const subscribers = new Set<() => void>();
const publish = (patch: Partial<LocalFolderSyncState>) => { state = { ...state, ...patch }; for (const fn of subscribers) fn(); };
export const getLocalFolderSyncState = () => state;
export function subscribeLocalFolderSync(fn: () => void) { subscribers.add(fn); return () => { subscribers.delete(fn); }; }
type LocalProjectLike = { runs: Array<{ status: string }>; batch: { status: string }; cover?: { attempt?: { status: string } } };
export function hasActiveFolderWork(projects: LocalProjectLike[]): boolean {
  return hasWorkspaceActivity(getWorkspaceEpoch()) || projects.some(p => p.runs.some(r => r.status === 'running') || ['running', 'stopping'].includes(p.batch.status) || p.cover?.attempt?.status === 'running');
}
function failure(error: unknown) {
  const permission = error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name);
  publish({ status: permission ? 'permission-required' : 'error', message: permission ? '文件夹权限已失效，请重新授权；本次内容尚未保存。' : error instanceof Error && /[\u3400-\u9fff]/.test(error.message) ? error.message : '保存失败，请确认文件可读写，或下载副本后重试。' });
}
function bindFolder(target?: FolderBinding): void {
  binding = target; migrationDigest = '';
  if (timer) clearTimeout(timer);
  setWorkspaceWriter(target ? snapshot => lockedWrite(snapshot, target) : undefined);
}
async function withBindingChange<T>(operation: () => Promise<T>): Promise<T> {
  if (changingBinding) throw new Error('工作区正在切换，请稍后重试。');
  changingBinding = true;
  try { return await operation(); } finally { changingBinding = false; }
}
async function writeSnapshot(target: FolderBinding, snapshot: WorkspaceBackup): Promise<void> {
  const handle = target.directory, id = target.workspaceId;
  if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') throw new DOMException('文件夹需要重新授权。', 'NotAllowedError');
  const blob = new Blob([JSON.stringify({ ...snapshot, folder_sync: { version: 1, workspace_id: id } }, null, 2)], { type: 'application/json' });
  if (blob.size > MAX_BACKUP_FILE_BYTES) throw new Error('工作区超过 200 MiB，请减少内容后重试。');
  let file: SyncFileHandle | undefined;
  try { file = await handle.getFileHandle(LOCAL_FOLDER_FILE); }
  catch (error) { if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error; }
  if (file) {
    const current = await file.getFile();
    if (current.size > MAX_BACKUP_FILE_BYTES || target.expectedText === undefined || await current.text() !== target.expectedText) throw new Error('工作区文件已被外部修改，请先下载当前副本，再重新打开文件夹。');
  } else if (target.expectedText !== undefined) throw new Error('工作区文件已被移走，请重新打开文件夹。');
  const created = !file;
  file ??= await handle.getFileHandle(LOCAL_FOLDER_FILE, { create: true });
  if (binding === target) publish({ status: 'syncing', message: '正在保存到本机文件夹……' });
  let writable: Awaited<ReturnType<SyncFileHandle['createWritable']>> | undefined;
  try { writable = await file.createWritable({ keepExistingData: false, mode: 'exclusive' }); await writable.write(blob); await writable.close(); }
  catch (error) {
    await writable?.abort().catch(() => undefined);
    if (created && !(await file.getFile()).size) target.expectedText = '';
    throw error;
  }
  // close() has committed these bytes even if the verification read temporarily fails.
  target.expectedText = await blob.text();
  const text = await (await file.getFile()).text();
  if (text !== target.expectedText) throw new Error('文件写入后的校验未通过，请下载副本后重试。');
  if (binding === target) publish({ status: 'synced', message: '已保存到本机文件夹。', lastSyncedAt: new Date().toISOString() });
}
async function lockedWrite(snapshot: WorkspaceBackup, target = binding): Promise<void> {
  if (!target) throw new Error('尚未打开本机文件夹。');
  try { await navigator.locks.request('braipen:local-folder-sync', { mode: 'exclusive' }, () => writeSnapshot(target, snapshot)); }
  catch (error) { if (binding === target) failure(error); throw error; }
}
export async function writeFolderSnapshot(handle: SyncDirectoryHandle, id: string): Promise<string> {
  const snapshot = await createBackup();
  const target = binding?.directory === handle && binding.workspaceId === id ? binding : { directory: handle, workspaceId: id };
  return await navigator.locks.request('braipen:local-folder-sync', { mode: 'exclusive' }, async () => { await writeSnapshot(target, snapshot); return new Date().toISOString(); });
}
export async function startLocalFolderSync(): Promise<void> {
  if (started || typeof window === 'undefined') return; started = true;
  window.addEventListener('braipen:drafts-changed', () => {
    if (timer) clearTimeout(timer);
    if (binding) { publish({ status: 'pending', message: '编辑内容尚未保存，正在等待写入……' }); timer = setTimeout(() => { void syncLocalFolderNow().catch(() => undefined); }, 400); }
  });
  window.addEventListener('beforeunload', event => { if (workspaceHasUnsavedChanges()) { event.preventDefault(); (event as BeforeUnloadEvent).returnValue = ''; } });
}
export async function syncLocalFolderNow(): Promise<void> {
  if (timer) clearTimeout(timer);
  try { await flushWorkspace(); if (workspaceHasUnsavedChanges()) publish({ status: 'pending', message: '有新的编辑内容等待保存。' }); }
  catch (error) { failure(error); throw error; }
}
export async function chooseLocalFolder(allowReplace = false): Promise<boolean> {
  return withBindingChange(async () => {
    await startLocalFolderSync();
    if (!supported()) throw new Error('此浏览器不能直接写入文件夹，请使用打开文件和下载工作区。');
    if (hasActiveFolderWork(await listProjects())) throw new Error('请先结束正在运行的创作任务，再打开工作区。');
    let handle: SyncDirectoryHandle;
    try { handle = await (window as PickerWindow).showDirectoryPicker!({ id: 'braipen-workspace', mode: 'readwrite' }); }
    catch (error) { if (error instanceof DOMException && error.name === 'AbortError') return false; throw error; }
    let text: string | undefined;
    try {
      const file = await (await handle.getFileHandle(LOCAL_FOLDER_FILE)).getFile();
      if (file.size > MAX_BACKUP_FILE_BYTES) throw new Error('工作区文件超过 200 MiB。');
      text = await file.text();
    } catch (error) { if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error; }
    if (hasActiveFolderWork(await listProjects())) throw new Error('请先结束正在运行的创作任务，再打开工作区。');
    if (text !== undefined && workspaceHasUnsavedChanges() && !allowReplace) throw new Error('当前还有未保存内容，请先保存或下载副本，再打开另一工作区。');
    try {
      const target: FolderBinding = { directory: handle, workspaceId: crypto.randomUUID(), expectedText: text };
      if (text !== undefined) {
        const value = JSON.parse(text), id = value?.folder_sync?.workspace_id;
        if (typeof id === 'string' && id) target.workspaceId = id;
        await openWorkspace(text, allowReplace, () => bindFolder(target), async () => {
          const current = await (await handle.getFileHandle(LOCAL_FOLDER_FILE)).getFile();
          if (await current.text() !== text) throw new Error('所选工作区文件在打开前发生变化，请重新打开工作区。');
        });
      } else await changeWorkspaceBinding(() => bindFolder(target));
      publish({ folderName: handle.name, lastSyncedAt: undefined, migrated: false, message: '工作区已打开。' });
      if (text === undefined) await syncLocalFolderNow();
      else publish({ status: 'synced', message: '工作区已打开，后续更新将自动写入本机文件。' });
      return true;
    } catch (error) {
      failure(error); throw error;
    }
  });
}
export async function openWorkspaceFile(text: string, allowReplace = false): Promise<void> {
  return withBindingChange(async () => {
    if (hasActiveFolderWork(await listProjects())) throw new Error('请先结束正在运行的创作任务。');
    if (workspaceHasUnsavedChanges() && !allowReplace) throw new Error('请先下载当前未保存内容，再打开工作区。');
    await openWorkspace(text, allowReplace, () => bindFolder());
    publish({ status: 'unbound', folderName: undefined, lastSyncedAt: undefined, migrated: false, message: '已打开工作区文件。此方式需手动下载保存，修改后请及时保存到本地。' });
  });
}
export async function reauthorizeLocalFolder(): Promise<void> {
  const target = binding;
  if (!target) throw new Error('请先打开本机文件夹。');
  if (await target.directory.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('尚未获得文件夹写入权限。');
  if (binding !== target) throw new Error('工作区已切换，请在当前工作区重新授权。');
  await syncLocalFolderNow();
}
export async function disconnectLocalFolder(): Promise<void> {
  return withBindingChange(async () => {
    if (hasActiveFolderWork(await listProjects())) throw new Error('请先结束正在运行的创作任务。');
    await changeWorkspaceBinding(() => bindFolder(), true);
    publish({ status: 'unbound', folderName: undefined, migrated: false, message: '本次内容仍在页面内存中，请下载保存；重新打开页面时需选择工作区。' });
  });
}
export async function migrateLegacyWorkspace(): Promise<void> {
  return withBindingChange(async () => {
    const target = binding;
    if (!target) throw new Error('请先打开一个空的本机工作区文件夹。');
    const current = await createBackup();
    if (current.projects.length || current.writing_styles.length || current.imports.length || current.drafts.length) throw new Error('为避免覆盖，请在空工作区中迁移旧资料。');
    const snapshot = await readLegacyWorkspace(), digest = await legacyWorkspaceDigest(snapshot);
    await openWorkspace(JSON.stringify(snapshot), false, undefined, undefined, async () => {
      if (binding !== target) throw new Error('工作区已切换，请在当前工作区重新迁移。');
      await lockedWrite(snapshot, target);
    });
    migrationDigest = digest; markWorkspaceSaved(snapshot);
    publish({ migrated: true, message: '旧创作资料已写入并校验。确认内容完整后，可清理旧浏览器记录。' });
  });
}
export async function clearMigratedLegacyWorkspace(): Promise<void> {
  return withBindingChange(async () => {
    const target = binding;
    if (!target || !migrationDigest || target.expectedText === undefined) throw new Error('请先完成旧资料迁移。');
    const file = await (await target.directory.getFileHandle(LOCAL_FOLDER_FILE)).getFile();
    if (binding !== target || await file.text() !== target.expectedText) throw new Error('工作区文件已变化，请先确认本机文件完整。');
    await clearLegacyWorkspace(migrationDigest); migrationDigest = '';
    publish({ migrated: false, message: '旧浏览器创作记录已清理，Key、连接和界面偏好保留。' });
  });
}
if (typeof window !== 'undefined') void startLocalFolderSync();
