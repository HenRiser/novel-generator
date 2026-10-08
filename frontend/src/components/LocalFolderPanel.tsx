import { useState, useSyncExternalStore } from 'react';
import { Alert, Button, Card, Descriptions, Space, Typography } from 'antd';
import { FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons';
import { chooseLocalFolder, disconnectLocalFolder, getLocalFolderSyncState, LOCAL_FOLDER_FILE,
  reauthorizeLocalFolder, subscribeLocalFolderSync, syncLocalFolderNow } from '../localFolderSync';

export default function LocalFolderPanel() {
  const state = useSyncExternalStore(subscribeLocalFolderSync, getLocalFolderSyncState);
  const [busy, setBusy] = useState(false);
  const bound = Boolean(state.folderName);
  const blocked = busy || state.status === 'syncing';
  const statusLabels = { unsupported: '使用文件备份', unbound: '未绑定', pending: '待同步', syncing: '同步中', synced: '已同步',
    'permission-required': '需要重新授权', quota: '空间不足，未同步', error: '同步失败' };
  async function action(operation: () => Promise<unknown>) { setBusy(true); try { await operation(); } finally { setBusy(false); } }
  const alertType = state.status === 'synced' ? 'success' : ['error', 'quota'].includes(state.status) ? 'error' : state.status === 'permission-required' ? 'warning' : 'info';

  return (
    <Card title={<Space><FolderOpenOutlined />本地文件夹自动同步</Space>} style={{ minWidth: 0 }}>
      <Space orientation="vertical" size={16} style={{ width: '100%', minWidth: 0, overflowWrap: 'anywhere' }}>
        <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
          选择电脑上的文件夹后，项目、正文、任务进度、封面原图与模型连接配置会自动写入完整备份。浏览器仍保存工作副本。
          文件夹的实际位置由系统选择窗口决定；网页只能显示文件夹名称，无法指定任意磁盘路径。
        </Typography.Paragraph>
        <Alert type={alertType} showIcon title={state.message} />
        <Descriptions size="small" column={1} items={[
          { key: 'status', label: '同步状态', children: statusLabels[state.status] },
          { key: 'folder', label: '所选文件夹', children: state.folderName || '尚未选择' },
          ...(bound ? [{ key: 'file', label: '备份文件', children: LOCAL_FOLDER_FILE }] : []),
          { key: 'time', label: '最后成功同步', children: state.lastSyncedAt ? new Date(state.lastSyncedAt).toLocaleString() : '尚未完成' },
        ]} />
        {state.status !== 'unsupported' && <Space wrap style={{ width: '100%' }}>
          <Button icon={<FolderOpenOutlined />} disabled={blocked} loading={busy}
            onClick={() => void action(chooseLocalFolder)}>{bound ? '更换同步文件夹' : '选择同步文件夹'}</Button>
          {bound && <Button icon={<ReloadOutlined />} disabled={blocked} onClick={() => void action(state.status === 'permission-required' ? reauthorizeLocalFolder : syncLocalFolderNow)}>
            {state.status === 'permission-required' ? '重新授权' : '立即同步'}</Button>}
          {bound && <Button disabled={blocked} onClick={() => void action(disconnectLocalFolder)}>停止自动同步</Button>}
        </Space>}
        <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
          API Key 仅供当前会话使用，或在此浏览器的本地保险库中加密保存；明文和加密密钥均不写入同步文件。
          更换文件夹会立即保存当前数据，旧备份保留。手机或不支持文件夹访问的浏览器可使用下方下载备份与文件恢复。
          从文件恢复会保留连接描述并创建项目副本，需重新配置密钥和默认连接。
        </Typography.Paragraph>
      </Space>
    </Card>
  );
}
