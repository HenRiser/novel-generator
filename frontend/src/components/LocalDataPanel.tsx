import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Descriptions, Space, Typography } from 'antd';
import { DownloadOutlined, SafetyCertificateOutlined, UploadOutlined } from '@ant-design/icons';
import { downloadRescue, exportBackup, hasRescue, restoreBackup, MAX_BACKUP_FILE_BYTES } from '../localStore';

type Props = { onProjectsChanged?: () => void | Promise<void> };
type StorageInfo = { usage?: number; quota?: number; persisted?: boolean };
const formatBytes = (bytes?: number) => bytes === undefined ? '浏览器未提供' : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export default function LocalDataPanel({ onProjectsChanged }: Props) {
  const { message } = AntApp.useApp();
  const [busy, setBusy] = useState('');
  const [storage, setStorage] = useState<StorageInfo>({});
  const [rescueAvailable, setRescueAvailable] = useState(hasRescue());
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const [estimate, persisted] = await Promise.all([
      navigator.storage?.estimate?.() ?? Promise.resolve({} as StorageEstimate),
      navigator.storage?.persisted?.() ?? Promise.resolve(undefined),
    ]);
    if (!mounted.current) return;
    setStorage({ usage: estimate.usage, quota: estimate.quota, persisted });
  }, []);

  useEffect(() => {
    mounted.current = true;
    const rescued = () => setRescueAvailable(hasRescue());
    void refresh().catch(reason => setError(reason instanceof Error ? reason.message : '无法读取本地存储。'));
    window.addEventListener('braipen:rescue', rescued);
    return () => {
      mounted.current = false;
      window.removeEventListener('braipen:rescue', rescued);
    };
  }, [refresh]);

  async function action(name: string, operation: () => Promise<void>) {
    setBusy(name); setError('');
    try { await operation(); await refresh(); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : '操作未完成，请重试。'); }
    finally { if (mounted.current) { setBusy(''); } }
  }

  async function importFile(file: File) {
    await action('restore', async () => {
      if (file.size > MAX_BACKUP_FILE_BYTES) throw new Error('完整备份超过 200 MiB，请使用较小的备份文件。');
      const refs = await restoreBackup(await file.text());
      void message.success(`已恢复 ${refs.length} 个项目副本，原有项目保留。`);
      window.dispatchEvent(new Event('braipen:projects-changed'));
      await onProjectsChanged?.();
    });
  }

  return (
    <Space orientation="vertical" size={20} style={{ width: '100%' }}>
      {error && <Alert type="error" showIcon title={error} />}
      <Card title={<Space><DownloadOutlined />项目备份与恢复</Space>}>
        <Space orientation="vertical" size={16} style={{ width: '100%' }}>
          <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
            项目、正文、知识与任务进度保存在此浏览器。更换设备、浏览器或清除站点数据前，请下载备份。
            恢复会创建项目副本；未完成的任务需手动继续。正在分析的导入草稿请先完成导入。
          </Typography.Paragraph>
          <Space wrap>
            <Button icon={<DownloadOutlined />} loading={busy === 'backup'} disabled={Boolean(busy)}
              onClick={() => void action('backup', exportBackup)}>下载全部项目备份</Button>
            <Button icon={<UploadOutlined />} loading={busy === 'restore'} disabled={Boolean(busy)}
              onClick={() => fileInput.current?.click()}>从备份恢复副本</Button>
            <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={event => {
              const file = event.target.files?.[0]; event.target.value = '';
              if (file) void importFile(file);
            }} />
            {rescueAvailable && <Button danger icon={<DownloadOutlined />} disabled={Boolean(busy)}
              onClick={() => { try { downloadRescue(); } catch (reason) { setError(String(reason)); } }}>下载未保存的应急副本</Button>}
          </Space>
          {rescueAvailable && <Alert type="warning" showIcon title="有尚未保存的内容，请先下载应急副本再刷新或关闭页面。" />}
        </Space>
      </Card>

      <Card title={<Space><SafetyCertificateOutlined />浏览器存储</Space>}>
        <Space orientation="vertical" size={16} style={{ width: '100%' }}>
          <Descriptions size="small" column={1} items={[
            { key: 'usage', label: '本站已使用', children: formatBytes(storage.usage) },
            { key: 'quota', label: '浏览器提供的配额', children: formatBytes(storage.quota) },
            { key: 'persist', label: '持久存储', children: storage.persisted === undefined ? '此浏览器未提供状态' : storage.persisted ? '已获准' : '尚未获准' },
          ]} />
          <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
            持久存储可降低浏览器自动回收数据的风险，仍不能替代备份；主动清理站点数据会删除项目和加密密钥。
          </Typography.Paragraph>
          <Button disabled={Boolean(busy) || storage.persisted || !navigator.storage?.persist} loading={busy === 'persist'}
            onClick={() => void action('persist', async () => {
              const granted = await navigator.storage.persist();
              void message.info(granted ? '浏览器已允许持久存储。' : '浏览器暂未允许持久存储，请继续定期下载备份。');
            })}>申请持久存储</Button>
        </Space>
      </Card>
    </Space>
  );
}
