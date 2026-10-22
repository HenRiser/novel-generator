import { useState } from 'react';
import { Alert, Button, Empty, Input, Popconfirm, Space, Typography } from 'antd';
import { getWorkspaceDraft, getWorkspaceEpoch, setWorkspaceDraft, updateProject } from '../localStore';
import { changed, projectLock } from '../localWorkflow';
import { selectGenerationBusy, useAppStore } from '../store/useAppStore';

type Draft = { content: string; baseContent: string };
type Props = { projectRef: string; kind: 'outline' | 'characters'; content: string; onSaved: () => Promise<void>; onPrepareAssets: () => void };

export default function ProjectAssetEditor({ projectRef, kind, content, onSaved, onPrepareAssets }: Props) {
  const name = kind === 'outline' ? '小说大纲' : '人物卡';
  const key = 'asset-editor:' + JSON.stringify([projectRef, kind]);
  const [draft, setDraft] = useState<Draft | null>(() => {
    const cached = getWorkspaceDraft<Draft>(key);
    return cached && typeof cached.content === 'string' && typeof cached.baseContent === 'string' ? cached : null;
  });
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const busy = useAppStore(selectGenerationBusy) || saving;
  function edit(next: Draft) { setDraft(next); setWorkspaceDraft(key, next); setError(''); }
  function cancel() { setDraft(null); setWorkspaceDraft(key, undefined); setError(''); }
  async function save() {
    if (!draft || busy) return;
    const epoch = getWorkspaceEpoch();
    setSaving(true); setError('');
    try {
      await projectLock(projectRef, () => updateProject(projectRef, project => {
        if (project.assets[kind] !== draft.baseContent) throw new Error(`${name}已在其他操作中更新，当前编辑保留。请复制需要的文字，再放弃本次编辑并重新打开最新资料。`);
        project.assets[kind] = draft.content;
      }));
      if (getWorkspaceEpoch() !== epoch) return;
      cancel(); changed(projectRef); await onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : `${name}未能更新，编辑内容保留。`); }
    finally { setSaving(false); }
  }
  return <Space orientation="vertical" size={12} style={{ width: '100%' }}>
    {error && <Alert type="error" showIcon title={error} />}
    {draft ? <>
      <Typography.Text type="secondary">编辑草稿会随工作区文件保留；保存修改后，用于后续创作，已生成的章节保留。</Typography.Text>
      <Input.TextArea aria-label={`编辑${name}`} value={draft.content} disabled={busy} autoSize={{ minRows: 10, maxRows: 26 }} onChange={e => edit({ ...draft, content: e.target.value })} />
      <Space wrap><Button type="primary" loading={saving} disabled={busy || !draft.content.trim() || draft.content === draft.baseContent} onClick={() => void save()}>保存{name}修改</Button>
        <Popconfirm title={`放弃本次${name}编辑？`} description="正式资料保留，仅移除此处未提交的编辑草稿。" onConfirm={cancel}><Button disabled={busy}>放弃本次编辑</Button></Popconfirm>
      </Space>
    </> : <>
      <Button disabled={busy} onClick={() => edit({ content, baseContent: content })}>{content ? `编辑${name}` : `手动编写${name}`}</Button>
      {content ? <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.8, maxHeight: 'calc(100vh - 320px)', overflowY: 'auto' }}>{content}</div> :
        <Empty description={`还没有${name}。可以手动编写，或根据已保存的创作设定生成。`} image={Empty.PRESENTED_IMAGE_SIMPLE}><Button type="primary" onClick={onPrepareAssets}>前往生成大纲与人物卡</Button></Empty>}
    </>}
  </Space>;
}
