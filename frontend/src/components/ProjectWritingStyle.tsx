import { useEffect, useState } from 'react';
import { Alert, Button, Card, Select, Space } from 'antd';
import { Link } from 'react-router-dom';
import { getProject, selectProjectWritingStyle } from '../localStore';
import { useWritingStyles } from '../hooks/useWritingStyles';
import type { LocalProject } from '../localTypes';

export default function ProjectWritingStyle({ projectRef }: { projectRef: string | null }) {
  const { cards, error: libraryError } = useWritingStyles();
  const [project, setProject] = useState<LocalProject>(), [choice, setChoice] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true; setProject(undefined); setError(''); setChoice('');
    if (!projectRef) return;
    const load = () => { void getProject(projectRef).then(p => { if (active) { setProject(p); setChoice(p.writing_style ? `${p.writing_style.id}@${p.writing_style.revision}` : ''); } }, reason => { if (active) setError(String(reason)); }); };
    load(); window.addEventListener('braipen:workflow-changed', load);
    return () => { active = false; window.removeEventListener('braipen:workflow-changed', load); };
  }, [projectRef]);
  if (!projectRef) return null;
  const saved = project?.writing_style, latest = cards.find(card => card.id === saved?.id), newer = latest && saved && latest.revision > saved.revision;
  const savedChoice = saved ? `${saved.id}@${saved.revision}` : '';
  const options = [{ value: '', label: '不使用文风卡 · 沿用原有风格描述' }, ...cards.map(card => ({ value: `${card.id}@${card.revision}`, label: `${card.name} · v${card.revision}` }))];
  if (saved && !options.some(option => option.value === savedChoice)) options.push({ value: savedChoice, label: `${saved.name} · 项目保留的 v${saved.revision}` });
  async function apply(update = false) {
    if (!project || !projectRef) return;
    const ref = projectRef; setBusy(true); setError('');
    try {
      const card = update ? latest : cards.find(item => `${item.id}@${item.revision}` === choice);
      if (choice && !card) throw new Error('该卡已从文风库删除；项目原快照保留，请选择其他卡。');
      const p = await selectProjectWritingStyle(ref, card, project.revision);
      if (ref === projectRef) { setProject(p); setChoice(p.writing_style ? `${p.writing_style.id}@${p.writing_style.revision}` : ''); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : '项目文风未保存。'); }
    finally { setBusy(false); }
  }
  return <Card size="small" title="此作品的默认文风">
    <Space orientation="vertical" style={{ width: '100%' }}>
      {(error || libraryError) && <Alert type="error" showIcon title={error || libraryError} />}
      <Space wrap style={{ width: '100%' }}><Select aria-label="项目默认文风卡" style={{ width: 300, maxWidth: '100%' }} value={choice} options={options} onChange={setChoice} disabled={!project || busy} /><Button onClick={() => void apply()} disabled={!project || busy || choice === savedChoice} loading={busy}>设为项目默认</Button></Space>
      <p className="muted-note">{saved ? `当前：${saved.name} · v${saved.revision}。` : '当前未使用文风卡。'}每个项目独立选择，单章可临时更换。</p>
      {newer && <Alert type="info" showIcon title={`文风库已有 v${latest.revision}，此作品仍使用 v${saved.revision}。`} action={<Button disabled={busy} onClick={() => void apply(true)}>更新到新版</Button>} />}
      {saved && <details><summary>查看项目保留的规则与范例</summary><p style={{ whiteSpace: 'pre-wrap' }}>{saved.rules}</p><p className="muted-note">已关联 {saved.examples.length} 段范例；编辑文风库不会自动替换此快照。</p></details>}
      <Link to="/settings?tab=styles">管理文风库、导入或提取文风</Link>
    </Space>
  </Card>;
}
