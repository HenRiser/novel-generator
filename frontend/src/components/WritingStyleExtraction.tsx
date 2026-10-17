import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Input, Segmented, Select, Space } from 'antd';
import { Link } from 'react-router-dom';
import { connections, defaultConnectionId } from '../providerConnections';
import { getProject, getWorkspaceDraft, setWorkspaceDraft } from '../localStore';
import { decodeNovel, IMPORT_LIMITS } from '../novelImport';
import { distillWritingStyle } from '../writingStyleClient';
import { styleCharacters, STYLE_LIMITS, type StyleExample, type StyleSource, type WritingStyleCard } from '../writingStyle';
import type { LocalProject } from '../localTypes';
import type { ConnectionProfile } from '../providerTypes';

type AnalysisDraft = { mode: 'project' | 'import'; text: string; label: string; chapters: number[] };
const drafts = { get: (key: string) => getWorkspaceDraft<AnalysisDraft>('style-source:' + key), set: (key: string, value: AnalysisDraft) => { if (value.text.trim()) setWorkspaceDraft('style-source:' + key, value); else if (getWorkspaceDraft('style-source:' + key)) setWorkspaceDraft('style-source:' + key, undefined); } };
export default function WritingStyleExtraction({ projectRef, onDraft, onBusyChange }: { projectRef: string | null; onDraft: (card: WritingStyleCard, candidates: StyleExample[], warnings: string[]) => void; onBusyChange: (busy: boolean) => void }) {
  const key = projectRef || 'global', initial = drafts.get(key);
  const [mode, setMode] = useState<'project' | 'import'>(initial?.mode || (projectRef ? 'project' : 'import'));
  const [text, setText] = useState(initial?.text || ''), [label, setLabel] = useState(initial?.label || '导入参考正文');
  const [selected, setSelected] = useState<number[]>(initial?.chapters || []), [project, setProject] = useState<LocalProject>(), [includeDrafts, setIncludeDrafts] = useState(false);
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]), [connection, setConnection] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const controller = useRef<AbortController | null>(null), epoch = useRef(0);
  useEffect(() => { drafts.set(key, { mode, text, label, chapters: selected }); }, [key, mode, text, label, selected]);
  useEffect(() => {
    let active = true;
    void Promise.all([projectRef ? getProject(projectRef) : Promise.resolve(undefined), connections(), defaultConnectionId()]).then(([p, list, defaultId]) => {
      if (active) { setProject(p); setProfiles(list); setConnection(String(p?.config.connection_id || defaultId)); }
    }, reason => { if (active) setError(reason instanceof Error ? reason.message : '无法读取正文或模型连接。'); });
    return () => { active = false; epoch.current++; controller.current?.abort(); onBusyChange(false); };
  }, [projectRef, onBusyChange]);
  const chapters = Object.values(project?.chapters || {}).filter(c => includeDrafts || c.workflow.status === 'confirmed').sort((a, b) => a.chapter_number - b.chapter_number);
  function chooseChapters(numbers: number[]) {
    setSelected(numbers); setText(numbers.map(n => project?.chapters[n]?.content || '').join('\n\n'));
  }
  async function importFile(file: File) {
    setError('');
    try {
      if (!/\.(txt|md)$/i.test(file.name)) throw new Error('正文分析支持 TXT 或 Markdown；JSON 文风卡请使用上方的导入入口。');
      if (file.size > IMPORT_LIMITS.bytes) throw new Error('参考正文文件不得超过 10 MiB。');
      const decoded = decodeNovel(new Uint8Array(await file.arrayBuffer())); setText(decoded.normalized_text); setLabel(file.name); setSelected([]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '正文文件无法读取。'); }
  }
  async function analyze() {
    const run = new AbortController(), version = ++epoch.current; controller.current = run; setProgress('正在准备提取……'); setBusy(true); onBusyChange(true); setError('');
    try {
      const source: StyleSource = mode === 'project' ? { kind: 'project', label: `${project?.title || '当前项目'} · 选定正文`, project_ref: projectRef || '', chapter_numbers: selected } : { kind: 'import', label };
      const profile = profiles.find(p => p.id === connection), model = connection === project?.config.connection_id ? String(project.config.model || '') : profile?.revisions.find(r => r.revision === profile.head)?.model;
      await distillWritingStyle(text, source, connection, model, run.signal, {
        onProgress: (round, stage) => { if (version === epoch.current) setProgress(`第 ${round}／5 轮 · 正在${stage}`); },
        onDraft: result => { if (version === epoch.current && !run.signal.aborted) onDraft(result.card, result.candidates, result.warnings); },
      });
      if (version === epoch.current) setProgress('五轮提取已完成，文风卡可在上方编辑保存。');
    } catch (reason) { if (version === epoch.current) setError(run.signal.aborted ? '已中断分析，输入与已有文风草稿保留。' : reason instanceof Error ? reason.message : '文风分析未完成，输入保留。'); }
    finally { if (version === epoch.current) { setBusy(false); onBusyChange(false); controller.current = null; } }
  }
  return <Card title="从正文提取文风卡">
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Segmented<'project' | 'import'> aria-label="文风分析来源" value={mode} options={[{ value: 'project', label: '根据当前项目生成', disabled: !projectRef }, { value: 'import', label: '根据导入文本生成' }]} disabled={busy} onChange={value => { setMode(value); setText(''); setSelected([]); }} />
      {mode === 'project' ? <>
        <Checkbox checked={includeDrafts} disabled={busy} onChange={e => { setIncludeDrafts(e.target.checked); if (!e.target.checked) chooseChapters(selected.filter(n => project?.chapters[n]?.workflow.status === 'confirmed')); }}>也显示未确认正文</Checkbox>
        <Select aria-label="选择分析文风的章节" style={{ width: '100%' }} value={selected[0]} disabled={busy || !project} placeholder="选择一章正文；默认仅列出已确认章节" options={chapters.map(c => ({ value: c.chapter_number, label: `第 ${c.chapter_number} 章 · ${c.title}` }))} onChange={number => chooseChapters([number])} />
        {!chapters.length && <p className="muted-note">尚无可选正文。可以先确认章节，或切换到导入文本，粘贴参考片段。</p>}
      </> : <>
        <label className="style-file-input">导入参考正文<input aria-label="导入文风参考正文" type="file" accept=".txt,.md" disabled={busy} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void importFile(file); }} /></label>
        <Input aria-label="参考正文来源名称" value={label} maxLength={300} disabled={busy} onChange={e => setLabel(e.target.value)} />
      </>}
      <label className="field-label">实际提交给模型的正文<Input.TextArea aria-label="文风分析正文" value={text} disabled={busy} onChange={e => setText(e.target.value)} autoSize={{ minRows: 6, maxRows: 15 }} placeholder="一次粘贴一章正文；超过 20,000 字符会直接拒绝，不会截断或采样。" /></label>
      <span className="muted-note">已选择 {styleCharacters(text).toLocaleString()} / {STYLE_LIMITS.analysis.toLocaleString()} 字符（包含标点、空格和英文字母）。仅提交此处正文，不提交大纲、人物卡或整个项目。</span>
      <Select aria-label="文风分析模型连接" style={{ width: '100%' }} value={connection || undefined} placeholder="选择文本模型连接" disabled={busy} options={profiles.map(p => ({ value: p.id, label: `${p.name} · ${p.revisions.find(r => r.revision === p.head)?.model || '待配置'}`, disabled: !p.enabled || !p.revisions.length }))} onChange={setConnection} />
      <Space wrap><Button type="primary" loading={busy} disabled={!text.trim() || styleCharacters(text) > STYLE_LIMITS.analysis || !connection || (mode === 'project' && selected.length !== 1)} onClick={() => void analyze()}>提取文风卡</Button>{busy && <Button onClick={() => controller.current?.abort()}>中断任务</Button>}<Link to="/settings?tab=api">配置文本模型连接</Link></Space>
      {styleCharacters(text) > STYLE_LIMITS.analysis && <Alert type="error" showIcon title="正文超过 20,000 字符，已拒绝提交。请在其他工具中整理为单章后重新输入。" />}
      {progress && <Alert type="info" showIcon title={progress} />}
      {error && <Alert type="error" showIcon title={error} />}
      <p className="muted-note">一次点击启动一个任务，最多五轮模型调用；每轮输出额度为 20,000 个令牌，令牌并不等于汉字数。结果逐轮进入上方草稿；失败时最近有效草稿保留，不自动重试。候选范例需勾选收录并保存后才使用。</p>
    </Space>
  </Card>;
}
