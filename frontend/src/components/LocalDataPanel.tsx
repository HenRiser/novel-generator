import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, Button, Card, Modal, Space } from 'antd';
import { createBackup, downloadRescue, exportBackup, hasRescue, MAX_BACKUP_FILE_BYTES, workspaceHasUnsavedChanges } from '../localStore';
import { getLocalFolderSyncState, openWorkspaceFile, subscribeLocalFolderSync } from '../localFolderSync';
import LocalFolderPanel from './LocalFolderPanel';

type Props = { onProjectsChanged?: () => void | Promise<void> };
export default function LocalDataPanel({ onProjectsChanged }: Props) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [dirty, setDirty] = useState(workspaceHasUnsavedChanges()), [rescue, setRescue] = useState(hasRescue());
  const input = useRef<HTMLInputElement>(null);
  const folder = useSyncExternalStore(subscribeLocalFolderSync, getLocalFolderSyncState);
  useEffect(() => {
    const changed = () => { setDirty(workspaceHasUnsavedChanges()); setRescue(hasRescue()); };
    window.addEventListener('braipen:workspace-changed', changed); window.addEventListener('braipen:rescue', changed);
    return () => { window.removeEventListener('braipen:workspace-changed', changed); window.removeEventListener('braipen:rescue', changed); };
  }, []);
  async function action(fn: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); } catch (reason) { setError(reason instanceof Error ? reason.message : '文件操作未完成。'); }
    finally { setBusy(false); }
  }
  return <Space orientation="vertical" size={20} style={{ width: '100%' }}>
    {error && <Alert type="error" showIcon title={error} />}
    {notice && <Alert type="info" showIcon title={notice} />}
    <LocalFolderPanel />
    <Card title="工作区文件">
      <Space orientation="vertical" size={14} style={{ width: '100%' }}>
        <p>工作区包含设定、文风卡、正文、封面和未完成的创作草稿。打开文件保留原项目标识；模型 Key 不进入文件。</p>
        {(dirty || !folder.folderName) && <Alert type="warning" showIcon title={dirty ? '本次内容尚未保存到本机文件，请保存或下载工作区后再关闭页面。' : '尚未打开自动保存文件夹，创作后需手动下载工作区。'} />}
        <Space wrap>
          <Button disabled={busy} onClick={() => input.current?.click()}>打开工作区文件</Button>
          <Button disabled={busy} loading={busy} onClick={() => void action(async () => { await createBackup(); await exportBackup(); setNotice('已发起文件下载，请确认文件已保存到电脑。'); })}>下载工作区</Button>
          {rescue && <Button disabled={busy} onClick={downloadRescue}>下载未保存的应急副本</Button>}
        </Space>
        <input ref={input} hidden type="file" accept=".json,application/json" onChange={event => {
          const file = event.target.files?.[0]; event.target.value = '';
          if (file) void action(async () => {
            if (file.size > MAX_BACKUP_FILE_BYTES) throw new Error('工作区文件超过 200 MiB。');
            const text = await file.text();
            if (workspaceHasUnsavedChanges()) {
              const confirmed = await new Promise<boolean>(resolve => Modal.confirm({ title: '替换当前页面中的未保存内容？', content: '请先确认已下载工作区副本。本次打开不会修改原文件。', okText: '打开所选文件', cancelText: '保留当前内容', onOk: () => { resolve(true); }, onCancel: () => { resolve(false); } }));
              if (!confirmed) return;
            }
            await openWorkspaceFile(text, true); await onProjectsChanged?.(); setNotice('工作区已打开。后续修改请保存到文件夹或下载新文件。');
          });
        }} />
      </Space>
    </Card>
  </Space>;
}
