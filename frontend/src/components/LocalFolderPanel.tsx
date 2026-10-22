import { useState, useSyncExternalStore } from 'react';
import { Alert, Button, Card, Descriptions, Modal, Space, Typography } from 'antd';
import { workspaceHasUnsavedChanges } from '../localStore';
import { chooseLocalFolder, disconnectLocalFolder, getLocalFolderSyncState, LOCAL_FOLDER_FILE,
  reauthorizeLocalFolder, subscribeLocalFolderSync, syncLocalFolderNow, migrateLegacyWorkspace, clearMigratedLegacyWorkspace } from '../localFolderSync';

export default function LocalFolderPanel() {
  const state = useSyncExternalStore(subscribeLocalFolderSync, getLocalFolderSyncState);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const bound = Boolean(state.folderName), blocked = busy || state.status === 'syncing';
  async function action(operation: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await operation(); } catch (reason) { setError(reason instanceof Error && /[\u3400-\u9fff]/.test(reason.message) ? reason.message : '工作区操作未完成，请检查文件夹权限后重试。'); }
    finally { setBusy(false); }
  }
  return <Card title="本机工作区">
    <Space orientation="vertical" size={14} style={{ width: '100%' }}>
      <Typography.Paragraph type="secondary">打开电脑上的文件夹后，设定、文风卡、正文、封面及创作草稿保存在一个工作区文件中。每次打开页面需重新选择工作区；浏览器只保留模型连接、Key 和界面偏好。</Typography.Paragraph>
      <Alert type={['error','quota'].includes(state.status) ? 'error' : state.status === 'synced' ? 'success' : 'info'} showIcon title={error || state.message} />
      <Descriptions size="small" column={1} items={[
        { key: 'folder', label: '本机文件夹', children: state.folderName || '尚未打开' },
        ...(bound ? [{ key: 'file', label: '工作区文件', children: LOCAL_FOLDER_FILE }] : []),
        { key: 'time', label: '最后写入成功', children: state.lastSyncedAt ? new Date(state.lastSyncedAt).toLocaleString() : '尚未写入' },
      ]} />
      <Space wrap>
        {state.status !== 'unsupported' && <Button type="primary" disabled={blocked} loading={busy} onClick={() => {
          if (workspaceHasUnsavedChanges()) Modal.confirm({ title: '当前内容尚未保存到文件', content: '请先下载工作区副本。继续打开已有工作区会替换当前页面内容；选择新的空文件夹会保存当前内容。', okText: '继续打开', cancelText: '先保留当前内容', onOk: () => action(() => chooseLocalFolder(true)) });
          else void action(() => chooseLocalFolder());
        }}>打开工作区</Button>}
        {bound && <><Button disabled={blocked} onClick={() => void action(state.status === 'permission-required' ? reauthorizeLocalFolder : syncLocalFolderNow)}>{state.status === 'permission-required' ? '重新授权并重试保存' : state.status === 'error' ? '重试保存到本机文件夹' : '保存到本机文件夹'}</Button><Button disabled={blocked} onClick={() => void action(disconnectLocalFolder)}>关闭文件夹</Button></>}
      </Space>
      {bound && <Space wrap>
        <Button disabled={blocked} onClick={() => void action(migrateLegacyWorkspace)}>迁移旧浏览器创作资料</Button>
        {state.migrated && <Button danger disabled={blocked} onClick={() => Modal.confirm({
          title: '确认本机文件完整后，清理旧创作记录？', content: '只清理旧浏览器中的项目、文风卡、封面和创作草稿。模型连接、Key 和界面偏好保留。本机工作区文件不会删除。',
          okText: '清理旧创作记录', cancelText: '保留旧记录', onOk: () => action(clearMigratedLegacyWorkspace),
        })}>清理已迁移的旧记录</Button>}
      </Space>}
      <Typography.Paragraph type="secondary">手机或不支持文件夹访问的浏览器，可使用下方“打开工作区文件”和“下载工作区”。文件未写入成功时，不会改存浏览器数据库。</Typography.Paragraph>
    </Space>
  </Card>;
}
