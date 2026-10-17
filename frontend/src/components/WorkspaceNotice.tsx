import { useEffect, useState, useSyncExternalStore } from 'react';
import { Alert } from 'antd';
import { Link } from 'react-router-dom';
import { getLocalFolderSyncState, subscribeLocalFolderSync } from '../localFolderSync';
import { workspaceHasUnsavedChanges } from '../localStore';
export default function WorkspaceNotice() {
  const folder = useSyncExternalStore(subscribeLocalFolderSync, getLocalFolderSyncState);
  const [dirty, setDirty] = useState(workspaceHasUnsavedChanges());
  useEffect(() => { const changed = () => setDirty(workspaceHasUnsavedChanges()); window.addEventListener('braipen:workspace-changed', changed); return () => window.removeEventListener('braipen:workspace-changed', changed); }, []);
  if (folder.folderName && !dirty && folder.status === 'synced') return null;
  return <Alert banner type={folder.status === 'error' ? 'error' : dirty ? 'warning' : 'info'}
    title={folder.status === 'error' || folder.status === 'permission-required' ? folder.message : dirty ? '本次创作内容尚未保存到本机文件，请保存或下载工作区。' : '创作资料只保存到本机文件，请打开工作区。'}
    action={<Link to="/settings?tab=system">打开工作区与保存</Link>} />;
}
