import { useEffect, useState } from 'react';
import { Alert, Select, Space } from 'antd';
import { useWritingStyles } from '../hooks/useWritingStyles';
import { getProject } from '../localStore';
import type { LocalProject } from '../localTypes';
import { validateStyleContext, type WritingStyleChoice, type WritingStyleContext } from '../writingStyle';

export default function GenerationWritingStyle({ projectRef, chapterNumber, value, onChange, disabled }: { projectRef: string | null; chapterNumber: number; value: WritingStyleChoice; onChange: (value: WritingStyleChoice) => void; disabled: boolean }) {
  const { cards, error: libraryError } = useWritingStyles();
  const [project, setProject] = useState<LocalProject>(), [error, setError] = useState('');
  useEffect(() => {
    let active = true; setProject(undefined); setError('');
    if (!projectRef) return;
    const load = () => { void getProject(projectRef).then(p => { if (active) setProject(p); }, reason => { if (active) setError(String(reason)); }); };
    load(); window.addEventListener('braipen:workflow-changed', load);
    return () => { active = false; window.removeEventListener('braipen:workflow-changed', load); };
  }, [projectRef]);
  const projectStyle = project?.writing_style, selected = typeof value === 'string' ? value : `${value.id}@${value.revision}`;
  const options = [{ value: 'project', label: `跟随项目${projectStyle ? ` · ${projectStyle.name} v${projectStyle.revision}` : ' · 原有风格描述'}` }, { value: 'none', label: '不使用文风卡 · 原有风格描述' }, ...cards.map(c => ({ value: `${c.id}@${c.revision}`, label: `${c.name} · v${c.revision}` }))];
  if (typeof value !== 'string' && !options.some(o => o.value === selected)) options.push({ value: selected, label: `${value.name} · 已选择的 v${value.revision}` });
  const frozen = project?.chapters[chapterNumber]?.frozen_context, hasUsed = frozen && Object.prototype.hasOwnProperty.call(frozen, 'writing_style_context');
  let used: WritingStyleContext | null = null;
  if (frozen?.writing_style_context != null) { try { validateStyleContext(frozen.writing_style_context); used = frozen.writing_style_context; } catch { /* Project validation reports corrupt persisted data. */ } }
  return <Space orientation="vertical" style={{ width: '100%' }}>
    <label className="field-label">本次生成的文风卡<Select aria-label="本次生成的文风卡" style={{ width: '100%' }} value={selected} options={options} disabled={disabled || !project} onChange={id => { if (id === 'project' || id === 'none') onChange(id); else { const card = cards.find(c => `${c.id}@${c.revision}` === id); if (card) onChange(structuredClone(card)); } }} /></label>
    <p className="muted-note">只用于本次生成，不修改作品默认值。连续生成会在启动时固定文风；单章续写沿用该章已用版本。</p>
    {(error || libraryError) && <Alert type="error" showIcon title={error || libraryError} />}
    {hasUsed && <details className="writing-style-summary"><summary>该章上次使用：{used ? `${used.card.name} · v${used.card.revision} · ${used.examples.length} 段范例` : '未使用文风卡'}</summary>{used && <><p style={{ whiteSpace: 'pre-wrap' }}>{used.card.rules}</p>{used.examples.map(example => <div key={example.id}><strong>{example.source.label}</strong><p style={{ whiteSpace: 'pre-wrap' }}>{example.text}</p></div>)}</>}</details>}
  </Space>;
}
