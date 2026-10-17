import { useEffect, useState } from 'react';
import { Alert, Button, Card, Checkbox, Empty, Input, Modal, Select, Space } from 'antd';
import { useWritingStyles } from '../hooks/useWritingStyles';
import { deleteWritingStyle, saveWritingStyle, getWorkspaceDraft, setWorkspaceDraft } from '../localStore';
import { createWritingStyle, exportWritingStyle, importWritingStyle, styleCharacters, type WritingStyleCard, type StyleExample } from '../writingStyle';
import { decodeNovel, IMPORT_LIMITS } from '../novelImport';
import ProjectWritingStyle from './ProjectWritingStyle';
import WritingStyleExtraction from './WritingStyleExtraction';
import '../styles/writingStyle.css';

// Keep an unfinished editor while visiting the story or model connection pages.
type EditorDraft = { card: WritingStyleCard; revision: number; candidates?: StyleExample[] };
export default function WritingStyleLibrary({ projectRef }: { projectRef: string | null }) {
  const editorDraft = getWorkspaceDraft<EditorDraft>('style-editor');
  const { cards, error: libraryError } = useWritingStyles();
  const [draft, setDraft] = useState(() => structuredClone(editorDraft?.card || createWritingStyle('新的文风卡')));
  const [revision, setRevision] = useState(editorDraft?.revision || 0), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<StyleExample[]>(editorDraft?.candidates || []), [chosen, setChosen] = useState<string[]>([]);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const blocked = busy || analysisBusy;
  const options = cards.map(card => ({ value: `${card.id}@${card.revision}`, label: `${card.name} · v${card.revision}` }));
  const selected = `${draft.id}@${revision}`;
  if (revision && !options.some(option => option.value === selected)) options.push({ value: selected, label: `${draft.name} · 当前编辑的 v${revision}` });
  useEffect(() => { if (draft.rules.trim() || draft.examples.length) setWorkspaceDraft('style-editor', { card: structuredClone(draft), revision, candidates: structuredClone(candidates) }); else if (getWorkspaceDraft('style-editor')) setWorkspaceDraft('style-editor', undefined); }, [draft, revision, candidates]);
  const edit = (patch: Partial<WritingStyleCard>) => { setDraft(value => ({ ...value, ...patch })); setNotice(''); };
  const open = (card: WritingStyleCard, saved = 0) => { setDraft(structuredClone(card)); setRevision(saved); setCandidates([]); setChosen([]); setError(''); setNotice(''); };
  const report = (reason: unknown) => setError(reason instanceof Error ? reason.message : '文风操作未完成，草稿保留。');
  async function save() {
    setBusy(true); setError('');
    try { const card = await saveWritingStyle(draft, revision); setDraft(card); setRevision(card.revision); setNotice(`已更新 ${card.name} · v${card.revision}。项目需主动选择或更新后才应用。`); }
    catch (reason) { report(reason); } finally { setBusy(false); }
  }
  async function importFile(file: File) {
    setError(''); setNotice('');
    try {
      if (file.size > IMPORT_LIMITS.bytes) throw new Error('文风资料文件不得超过 10 MiB。');
      if (/\.json$/i.test(file.name)) open(importWritingStyle(await file.text()));
      else if (/\.(txt|md)$/i.test(file.name)) {
        const rules = decodeNovel(new Uint8Array(await file.arrayBuffer())).normalized_text;
        open(createWritingStyle(file.name.replace(/\.[^.]+$/, ''), rules, { kind: 'import', label: file.name }));
        setNotice('已作为规则草稿导入；若这是小说正文，请使用下方“根据导入文本生成”。');
      } else throw new Error('支持 JSON 文风卡或 TXT、Markdown 规则文本。');
    } catch (reason) { report(reason); }
  }
  function download() {
    try {
      const content = exportWritingStyle(draft), url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `braipen-style-${draft.id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) { report(reason); }
  }
  return <div className="writing-style-library">
    <ProjectWritingStyle key={projectRef} projectRef={projectRef} />
    <Card title="本地文风库">
      <Space orientation="vertical" size={16} style={{ width: '100%' }}>
        <p className="muted-note">文风卡和范例写入本机工作区文件，不保存到浏览器数据库。这里的编辑不会自动改变作品正在使用的版本。</p>
        {(error || libraryError) && <Alert type="error" showIcon title={error || libraryError} />}
        {notice && <Alert type="success" showIcon title={notice} />}
        <Space wrap><Select aria-label="选择编辑文风卡" placeholder="选择已保存的文风卡" value={revision ? selected : undefined} style={{ width: 300, maxWidth: '100%' }} options={options} onChange={value => { const card = cards.find(item => `${item.id}@${item.revision}` === value); if (card) open(card, card.revision); }} disabled={blocked} /><Button disabled={blocked} onClick={() => open(createWritingStyle('新的文风卡'))}>新建文风卡</Button><label className="style-file-input">导入文风卡或规则<input aria-label="导入文风卡或规则" type="file" accept=".json,.txt,.md" disabled={blocked} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file); }} /></label></Space>
        <label className="field-label">文风卡名称<Input aria-label="文风卡名称" maxLength={120} value={draft.name} disabled={blocked} onChange={e => edit({ name: e.target.value })} /></label>
        <label className="field-label">文风规则<Input.TextArea aria-label="文风规则" value={draft.rules} disabled={blocked} onChange={e => edit({ rules: e.target.value })} autoSize={{ minRows: 7, maxRows: 20 }} placeholder="描述叙述视角、语言、对白、节奏、描写和避免事项。参考作品的人物与剧情不会作为本书设定。" /></label>
        <span className="muted-note">规则 {styleCharacters(draft.rules).toLocaleString()} / 6,000 字符</span>
        {candidates.length > 0 && <Card size="small" title="模型推荐范例 · 尚未收录">
          <Space orientation="vertical" style={{ width: '100%' }}>{candidates.map((example, index) => <div key={example.id}>
            <Checkbox disabled={blocked} checked={chosen.includes(example.id)} onChange={e => setChosen(value => e.target.checked ? [...value, example.id] : value.filter(id => id !== example.id))}>收录候选范例 {index + 1}</Checkbox><p style={{ whiteSpace: 'pre-wrap' }}>{example.text}</p>
          </div>)}<Button disabled={blocked || !chosen.length} onClick={() => { edit({ examples: [...draft.examples, ...candidates.filter(e => chosen.includes(e.id))] }); setCandidates(value => value.filter(e => !chosen.includes(e.id))); setChosen([]); }}>将勾选范例加入草稿</Button></Space>
        </Card>}
        <label className="field-label">文风来源<Input aria-label="文风来源" value={draft.source.label} disabled={blocked} maxLength={300} onChange={e => edit({ source: { ...draft.source, label: e.target.value } })} /></label>
        <div><strong>已确认范例 · {draft.examples.length} 段</strong><p className="muted-note">收录你认可的完整片段。生成时按场景选取最多三段，不自动收录每个生成章节。</p></div>
        {!draft.examples.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未收录范例，文风卡仍可独立使用。" />}
        {draft.examples.map((example, index) => <Card size="small" key={example.id} title={`范例 ${index + 1}`} extra={<Button disabled={blocked} onClick={() => edit({ examples: draft.examples.filter(item => item.id !== example.id) })}>移除此范例</Button>}>
          <Space orientation="vertical" style={{ width: '100%' }}>
            <Input.TextArea aria-label={`范例${index + 1}原文`} value={example.text} disabled={blocked} autoSize={{ minRows: 3, maxRows: 10 }} onChange={e => edit({ examples: draft.examples.map(item => item.id === example.id ? { ...item, text: e.target.value } : item) })} />
            <Input aria-label={`范例${index + 1}来源`} value={example.source.label} disabled={blocked} placeholder="来源作品、章节或手动收录说明" onChange={e => edit({ examples: draft.examples.map(item => item.id === example.id ? { ...item, source: { ...item.source, label: e.target.value } } : item) })} />
            <Select aria-label={`范例${index + 1}场景`} mode="tags" style={{ width: '100%' }} value={example.scene_tags} disabled={blocked} placeholder="场景标签，例如：对话、误会、动作" options={['对话', '误会', '动作', '日常', '心理', '环境', '谈判', '反转'].map(value => ({ value }))} onChange={scene_tags => edit({ examples: draft.examples.map(item => item.id === example.id ? { ...item, scene_tags } : item) })} />
            <Space wrap><Select aria-label={`范例${index + 1}人称`} value={example.pov} disabled={blocked} style={{ width: 150 }} options={['', '第一人称', '第三人称'].map(value => ({ value, label: value || '不限人称' }))} onChange={pov => edit({ examples: draft.examples.map(item => item.id === example.id ? { ...item, pov } : item) })} /><Select aria-label={`范例${index + 1}节奏`} value={example.pace} disabled={blocked} style={{ width: 150 }} options={['', '低', '中', '高'].map(value => ({ value, label: value ? { 低: '舒缓', 中: '适中', 高: '紧凑' }[value] : '不限节奏' }))} onChange={pace => edit({ examples: draft.examples.map(item => item.id === example.id ? { ...item, pace } : item) })} /></Space>
          </Space>
        </Card>)}
        <Button disabled={blocked || draft.examples.length >= 100} onClick={() => edit({ examples: [...draft.examples, { id: `example_${crypto.randomUUID()}`, text: '', source: structuredClone(draft.source), scene_tags: [], pov: '', pace: '' }] })}>手动收录范例</Button>
        <Space wrap><Button type="primary" loading={busy} disabled={analysisBusy} onClick={() => void save()}>保存文风卡{revision ? '新版' : ''}</Button><Button disabled={blocked} onClick={download}>导出此文风卡</Button>{revision > 0 && <Button danger disabled={blocked} onClick={() => Modal.confirm({ title: '删除文风库中的这张卡？', content: '作品已选用的快照与生成历史会保留。', okText: '删除库内卡', cancelText: '保留', onOk: async () => { try { await deleteWritingStyle(draft.id, revision); open(createWritingStyle('新的文风卡')); setNotice('已从文风库删除，项目快照保留。'); } catch (reason) { report(reason); throw reason; } } })}>删除库内卡</Button>}</Space>
      </Space>
    </Card>
    <WritingStyleExtraction key={projectRef || 'global'} projectRef={projectRef} onBusyChange={setAnalysisBusy} onDraft={(card, examples, warnings) => { open(card); setCandidates(examples); setNotice(['文风卡已放入上方编辑稿；正式保存并选用后才应用到作品。', ...warnings].join(' ')); }} />
  </div>;
}
