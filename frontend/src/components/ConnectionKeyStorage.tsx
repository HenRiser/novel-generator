import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Input, Popconfirm, Space, Tag } from 'antd';
import { KeyOutlined } from '@ant-design/icons';
import { getConnection, manageConnection, migrateEncryptedConnectionKey } from '../providerConnections';
import { keyStorageMode, profileKey, type KeyStorageMode } from '../keyVault';
import type { ConnectionProfile } from '../providerTypes';

type Props = {
  profile?: ConnectionProfile;
  remember: boolean | null;
  onRememberChange: (remember: boolean) => void;
  busy: boolean;
  onAction: (label: string, task: () => Promise<void>) => Promise<void>;
  onClear: () => void;
};

export default function ConnectionKeyStorage({ profile, remember, onRememberChange, busy, onAction, onClear }: Props) {
  const [mode, setMode] = useState<KeyStorageMode | null>(null);
  const [oldPassword, setOldPassword] = useState('');
  const id = profile?.id, epoch = profile?.epoch, keyVersion = profile?.key_version;
  useEffect(() => {
    let live = true;
    setMode(null); setOldPassword('');
    if (!id) { setMode('session'); return; }
    void getConnection(id).then(async current => {
      const snapshot = current.revisions.find(item => item.revision === current.head);
      const stored = snapshot ? await keyStorageMode(current, snapshot) : 'session';
      if (live) { setMode(stored); onRememberChange(stored === 'remembered'); }
    }).catch(() => { if (live) setMode('invalid'); });
    return () => { live = false; };
  }, [id, epoch, keyVersion, onRememberChange]);
  const snapshot = profile?.revisions.find(item => item.revision === profile.head);
  const available = Boolean(profile && snapshot && profileKey(profile, snapshot));
  return <section aria-label="API Key 本地保存" style={{ width: '100%' }}>
    <Space wrap><KeyOutlined /><strong>API Key 保存方式</strong>{profile && <Tag>{mode === null ? '读取中' : mode === 'remembered' ? '本机已记住' : mode === 'legacy' ? '旧版加密待迁移' : mode === 'invalid' ? '本地记录异常' : '仅本次使用'}</Tag>}{available && <Tag>Key 可用</Tag>}</Space>
    <div style={{ marginTop: 10 }}><Checkbox checked={remember ?? false} disabled={busy || Boolean(id) && mode === null} style={{ minHeight: 44, alignItems: 'center' }} onChange={event => onRememberChange(event.target.checked)}>在此浏览器记住 API Key</Checkbox></div>
    <p className="muted-note" style={{ margin: '8px 0' }}>勾选后点击保存连接，重新打开网页会自动使用；未勾选则仅供本次使用。记住的 Key 以明文保存在当前浏览器，能够访问本站数据的人可能读取。项目备份和文件夹同步不包含 Key。</p>
    {mode === 'invalid' && <Alert type="warning" showIcon title="本地 Key 记录无法使用" description="请重新填写 API Key 并保存，或清除本地记录。" />}
    {mode === 'legacy' && <Alert type="info" showIcon title="迁移旧版已保存的 Key" description={<Space orientation="vertical" style={{ width: '100%' }}>
      <span>输入一次原来的本地口令，将旧 Key 转为本机明文记住。迁移成功后不再需要口令；也可直接重新填写 API Key 并保存。</span>
      <Input.Password aria-label="旧版 Key 解锁口令" value={oldPassword} disabled={busy} onChange={event => setOldPassword(event.target.value)} autoComplete="off" maxLength={1024} placeholder="原来的本地口令，仅用于这次迁移" />
      <Button disabled={busy || !id || !oldPassword || !profile?.enabled} onClick={() => void onAction('key-migration', async () => { await migrateEncryptedConnectionKey(id!, oldPassword); setOldPassword(''); onRememberChange(true); })}>迁移并记住 API Key</Button>
    </Space>} />}
    {id && <Popconfirm title="清除此连接的 Key 并中断相关任务？" description="本机记住和当前会话中的 Key 都会清除，连接配置和作品保留。" onConfirm={() => onAction('forget', async () => { await manageConnection(id, 'forget'); onClear(); onRememberChange(false); })}><Button danger disabled={busy} style={{ marginTop: 10 }}>清除已保存 Key</Button></Popconfirm>}
  </section>;
}
