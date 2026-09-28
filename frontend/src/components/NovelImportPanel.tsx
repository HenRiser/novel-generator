import type { ConnectionGuard, ConnectionProfile } from '../providerTypes';
import { acquireConnection, resolveConnection, legacySnapshot, connections, type ConnectionLease } from '../providerConnections';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert, Button, Card, Collapse, Empty, Input, InputNumber, Select, Space, Tag } from 'antd';
import { compute } from '../computeClient';
import { commitImport, getImport, listImports, putImport } from '../localStore';
import {
  aliasConflicts, boundaryDeclaration, buildImportedProject, chapterComputeInput, characterCount, createImportDraft,
  decodeNovel, detectBoundaries, importChapter, originalBytes, parseBoundaries, readyErrors, reviewChapterResult,
  synthesisComputeInput, textHash, validatePrefix, type ImportCandidate, type ImportDraft, type ImportEncoding,
} from '../novelImport';

const kindLabels = { characters: '人物', relationships: '关系', facts: '事实', foreshadows: '伏笔' };
const fieldLabels: Record<string, string> = { genre: '类型', style: '风格', word_count_range: '单章字数', protagonist: '主角', supporting_characters: '配角', worldview: '世界观', core_conflict: '核心冲突' };

function CandidateEditor({ candidate, disabled, onSave }: { candidate: ImportCandidate; disabled: boolean; onSave: (value: ImportCandidate) => void }) {
  const [label, setLabel] = useState(candidate.label), [summary, setSummary] = useState(candidate.summary), [aliases, setAliases] = useState(candidate.aliases.join('，'));
  const modified = label !== candidate.label || summary !== candidate.summary || aliases !== candidate.aliases.join('，');
  function save(status: ImportCandidate['status']) {
    if (status === 'accepted' && (!label.trim() || !summary.trim())) return;
    onSave({ ...candidate, label: label.trim(), summary: summary.trim(), aliases: aliases.split(/[,，]/).map(value => value.trim()).filter(Boolean),
      status, provenance: modified || !candidate.evidence ? 'user_setting' : candidate.provenance });
  }
  return <div style={{ borderTop: '1px solid var(--border-color, #ddd)', paddingBlock: 12 }}>
    <Space wrap><Tag>{kindLabels[candidate.kind]}</Tag><Tag color={candidate.status === 'accepted' ? 'green' : candidate.status === 'rejected' ? 'default' : 'orange'}>{({ pending: '待审核', accepted: '已接受', rejected: '已拒绝' })[candidate.status]}</Tag><span>{candidate.provenance === 'user_setting' ? '用户设定' : '有原文证据'}</span></Space>
    <label style={{ display: 'block', marginTop: 8 }}>名称<Input aria-label={`候选名称 ${candidate.id}`} value={label} onChange={event => setLabel(event.target.value)} disabled={disabled} /></label>
    <label style={{ display: 'block', marginTop: 8 }}>描述<Input.TextArea aria-label={`候选描述 ${candidate.id}`} value={summary} onChange={event => setSummary(event.target.value)} disabled={disabled} autoSize={{ minRows: 2, maxRows: 6 }} /></label>
    {candidate.kind === 'characters' && <label style={{ display: 'block', marginTop: 8 }}>别名（逗号分隔）<Input value={aliases} onChange={event => setAliases(event.target.value)} disabled={disabled} /></label>}
    <blockquote style={{ margin: '12px 0', paddingLeft: 12, borderLeft: '3px solid #b8cbbd', whiteSpace: 'pre-wrap' }}>{candidate.evidence || '无原文证据，仅可作为用户设定。'}</blockquote>
    {modified && <p>修改后的内容将标为“用户设定”，不会冒充原文事实。点击接受后保存。</p>}
    <Space><Button disabled={disabled || !label.trim() || !summary.trim()} onClick={() => save('accepted')}>接受并保存</Button><Button disabled={disabled} onClick={() => save('rejected')}>拒绝</Button></Space>
  </div>;
}

export default function NovelImportPanel({ onComplete }: { onComplete?: (projectRef: string) => void }) {
  const [drafts, setDrafts] = useState<ImportDraft[]>([]), [draft, setDraft] = useState<ImportDraft | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(''), [boundaries, setBoundaries] = useState(''), [prefix, setPrefix] = useState(1);
  const [previewNumber, setPreviewNumber] = useState(1), [encoding, setEncoding] = useState<ImportEncoding>('utf-8');
  const [connectionOptions,setConnectionOptions]=useState<ConnectionProfile[]>([]),[replacement,setReplacement]=useState('');
  useEffect(()=>{let active=true;const load=()=>void connections().then(p=>{if(active)setConnectionOptions(p);}).catch(()=>undefined);load();window.addEventListener('braipen:connections-changed',load);return()=>{active=false;window.removeEventListener('braipen:connections-changed',load);};},[]);
  const connectionLease = useRef<ConnectionLease | undefined>(undefined);
  const abort = useRef<AbortController | null>(null), stop = useRef(false), mounted = useRef(true);
  const sync = (value: ImportDraft) => {
    if (!mounted.current) return;
    setDraft(value); setTitle(value.title); setBoundaries(boundaryDeclaration(value.boundaries)); setPrefix(value.prefix); setEncoding(value.encoding);
  };
  async function refresh() { const values = await listImports<ImportDraft>(); if (mounted.current) setDrafts(values.filter(value => value.schema_version === 1).sort((a, b) => b.updated_at.localeCompare(a.updated_at))); }
  useEffect(() => {
    mounted.current = true; void refresh().catch(() => setError('无法读取本地导入草稿，请检查浏览器存储。'));
    return () => { mounted.current = false; stop.current = true; abort.current?.abort(); connectionLease.current?.close(); };
  }, []);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (busy) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload); return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [busy]);
  async function persist(value: ImportDraft, guard: ConnectionGuard | null | undefined = connectionLease.current?.guard) {
    const next = { ...value, revision: value.revision + 1, updated_at: new Date().toISOString() };
    await putImport(next.id, next, guard || undefined); sync(next); return next;
  }
  async function locked(id: string, action: (latest: ImportDraft) => Promise<void>) {
    if (!navigator.locks) throw new Error('当前浏览器不支持导入任务锁，请使用支持 Web Locks 的浏览器。');
    await navigator.locks.request(`braipen:import:${id}`, { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('另一个标签页正在处理此导入，请等待或关闭那个任务。');
      const latest = await getImport<ImportDraft>(id);
      if (!latest) throw new Error('导入草稿不存在。');
      await action(latest);
    });
  }
  async function action(task: () => Promise<void>) {
    setBusy(true); setError('');
    try { await task(); await refresh(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '导入操作失败。'); }
    finally { connectionLease.current?.close(); connectionLease.current=undefined; if (mounted.current) setBusy(false); }
  }
  async function selectDraft(id: string) {
    await locked(id, async value => {
      if (value.attempt?.status === 'running') {
        value = await persist({ ...value, attempt: { ...value.attempt, status: 'interrupted' }, error: '上次请求结果未知；手动恢复可能重新调用并计费。已完成章节不会重做。' });
      }
      sync(value); setPreviewNumber(1);
    });
  }
  async function edit(mutate: (value: ImportDraft) => void) {
    if (!draft) return;
    await locked(draft.id, async latest => {
      if (latest.revision !== draft.revision) { sync(latest); throw new Error('另一个标签页已更新草稿，已加载最新版本，请重新修改。'); }
      if (latest.phase === 'committed') throw new Error('该导入已创建项目。');
      mutate(latest); latest.error = ''; await persist(latest);
    });
  }
  async function startExtraction() {
    if (!draft) return;
    await locked(draft.id, async latest => {
      validatePrefix(latest);
      const snapshot = latest.connection || (latest.phase !== 'preview' ? await legacySnapshot() : await resolveConnection());
      connectionLease.current = await acquireConnection(snapshot); latest = { ...latest, connection: snapshot };
      stop.current = false; abort.current = new AbortController();
      latest = await persist({ ...latest, phase: 'extract', error: '' });
      for (let number = 1; number <= latest.prefix; number++) {
        if (latest.results[String(number)]) continue;
        if (stop.current) break;
        const attempt = { step_id: `chapter-${number}`, attempt_id: crypto.randomUUID(), chapter: number, status: 'running' as const };
        latest = await persist({ ...latest, attempt });
        try {
          const response = await compute('import_chapter', await chapterComputeInput(latest, number),
            { run_id: latest.id, step_id: attempt.step_id, attempt_id: attempt.attempt_id, input_revision: latest.revision }, abort.current.signal, undefined, connectionLease.current);
          const result = await reviewChapterResult(latest, number, response.result);
          latest = await persist({ ...latest, results: { ...latest.results, [number]: result }, attempt: { ...attempt, status: 'completed' } });
        } catch (cause) {
          const message = abort.current.signal.aborted ? '已中断本次请求，结果未知；恢复可能重新调用并计费。' : cause instanceof Error ? cause.message : '本章提取失败。';
          await persist({ ...latest, attempt: { ...attempt, status: 'interrupted' }, error: message }, null);
          throw new Error(message);
        }
      }
      latest = await persist({ ...latest, phase: Object.keys(latest.results).length === latest.prefix ? 'review' : 'extract' });
      sync(latest); abort.current = null;
    });
  }
  async function synthesize() {
    if (!draft) return;
    await locked(draft.id, async latest => {
      const input = synthesisComputeInput(latest);
      connectionLease.current = await acquireConnection(latest.connection || await legacySnapshot());
      latest = { ...latest, connection: connectionLease.current.snapshot }; abort.current = new AbortController();
      const attempt = { step_id: 'synthesis', attempt_id: crypto.randomUUID(), chapter: null, status: 'running' as const };
      latest = await persist({ ...latest, phase: 'synthesize', attempt, error: '' });
      try {
        const { result } = await compute('import_synthesis', input, { run_id: latest.id, step_id: attempt.step_id, attempt_id: attempt.attempt_id, input_revision: latest.revision }, abort.current.signal, undefined, connectionLease.current);
        await persist({ ...latest, phase: 'ready', synthesis: result, attempt: { ...attempt, status: 'completed' } });
      } catch (cause) {
        const message = abort.current.signal.aborted ? '整理请求已中断，恢复可能再次计费。' : cause instanceof Error ? cause.message : '整理失败。';
        await persist({ ...latest, attempt: { ...attempt, status: 'interrupted' }, error: message }, null); throw new Error(message);
      } finally { abort.current = null; }
    });
  }
  async function finish() {
    if (!draft) return;
    await locked(draft.id, async latest => {
      const ref = await commitImport(latest.id, await buildImportedProject(latest));
      await persist({ ...latest, phase: 'committed', project_ref: ref }); onComplete?.(ref);
    });
  }
  async function repairConnection(){
    if(!draft)return;
    await locked(draft.id,async latest=>{
      if(latest.phase==='committed')throw new Error('已完成导入不能更改。');
      const old=latest.connection||await legacySnapshot();
      const next=await resolveConnection(replacement,old.model);
      if(next.destination_fingerprint!==old.destination_fingerprint||next.model!==old.model)throw new Error('导入修复只允许相同目的地、协议和模型；换服务请创建新导入。');
      await persist({...latest,connection:next,connection_history:[...(latest.connection_history||[]),old],attempt:undefined,error:''});
    });
  }
  const conflicts = draft ? aliasConflicts(draft) : [];
  const preview = draft && previewNumber <= draft.boundaries.length ? importChapter(draft, previewNumber) : null;

  return <Card title="导入已有小说" style={{ marginBlock: 20 }}>
    <p>先校对分章、选择前 N 章，再调用模型逐章提取。文件和检查点保存在此浏览器；未选后文仅本地归档。支持 TXT / MD、UTF-8 / GB18030；文件最多 10 MiB，前缀最多 50 章 / 20 万字，单章最多 2 万字。</p>
    <Space wrap style={{ marginBottom: 16 }}>
      <label>选择小说 <input aria-label="导入小说文件" type="file" accept=".txt,.md" disabled={busy} onChange={event => {
        const file = event.target.files?.[0]; if (!file) return;
        void action(async () => {
          if (file.size > 10 * 1024 * 1024) throw new Error('文件超过 10 MiB，未读取或上传。');
          const value = await createImportDraft(file.name, new Uint8Array(await file.arrayBuffer()));
          await putImport(value.id, value); sync(value); setPreviewNumber(1);
        }); event.target.value = '';
      }} /></label>
      <Select aria-label="恢复导入草稿" placeholder="恢复导入草稿" style={{ minWidth: 230 }} disabled={busy} value={draft?.id} options={drafts.map(value => ({ value: value.id, label: `${value.title} · ${value.phase === 'committed' ? '已完成' : `${Object.keys(value.results).length}/${value.prefix} 章`}` }))} onChange={id => void action(() => selectDraft(id))} />
    </Space>
    {draft&&draft.phase!=='committed'&&<details style={{marginBottom:16}}><summary>恢复时原连接失效或需要采用修复后的能力？</summary><p>当前目标：{draft.connection?`${draft.connection.base_url} · ${draft.connection.model}`:'首次分析将使用默认连接；旧草稿保留原DeepSeek入口'}。只允许相同目的地与模型；显式采用所选连接当前策略后，下一次提取会新建请求，已保存章节不重做。</p><Space wrap><Select aria-label="导入恢复连接" value={replacement||undefined} onChange={setReplacement} style={{minWidth:240}} options={connectionOptions.filter(p=>p.enabled).map(p=>({value:p.id,label:p.name}))}/><Button disabled={busy||!replacement} onClick={()=>void action(repairConnection)}>明确采用此连接当前配置</Button></Space></details>}
    {(error || draft?.error) && <Alert type="error" showIcon title={error || draft?.error} style={{ marginBottom: 16 }} />}
    {!draft ? <Empty description="选择文件后先在本地预览，不会自动调用模型。" /> : <>
      {draft.phase === 'committed' ? <Alert type="success" showIcon title="导入已完成，重复提交不会创建重复作品。" action={<Button onClick={() => draft.project_ref && onComplete?.(draft.project_ref)}>打开作品</Button>} /> : <>
        <Collapse defaultActiveKey={['source']} items={[{ key: 'source', label: `文件与分章 · ${draft.boundaries.length} 章，选择前 ${draft.prefix} 章`, children: <>
          <Space wrap align="end"><label>作品标题<Input value={title} disabled={busy} maxLength={80} onChange={event => setTitle(event.target.value)} /></label>
            <label>编码<Select aria-label="小说编码" value={encoding} disabled={busy} style={{ width: 150 }} options={[{ value: 'utf-8', label: 'UTF-8' }, { value: 'gb18030', label: 'GB18030' }]} onChange={value => {
              void action(() => edit(latest => { const decoded = decodeNovel(originalBytes(latest), value); latest.encoding = decoded.encoding; latest.normalized_text = decoded.normalized_text; latest.boundaries = detectBoundaries(decoded.normalized_text); latest.prefix = 1; latest.results = {}; latest.synthesis = undefined; latest.phase = 'preview'; }));
            }} /></label>
            <label>选定前 N 章<InputNumber aria-label="导入前缀章节数" value={prefix} min={1} max={Math.min(50, draft.boundaries.length)} disabled={busy} onChange={value => setPrefix(value || 1)} /></label>
          </Space>
          <label style={{ display: 'block', marginTop: 16 }}>章节边界（每行：起始行号|标题；第一项从第 1 行开始）<Input.TextArea aria-label="章节边界" value={boundaries} onChange={event => setBoundaries(event.target.value)} disabled={busy} autoSize={{ minRows: 3, maxRows: 10 }} /></label>
          <p>文件规范化为换行 LF，保留原始字节。修改编码、分章或前缀会清除已有提取结果。共 {draft.normalized_text.split('\n').length} 行；分章可手动拆分、合并。</p>
          <Button disabled={busy || !title.trim()} onClick={() => void action(async () => {
            await edit(latest => { const next = parseBoundaries(boundaries, latest.normalized_text); const changed = JSON.stringify(next) !== JSON.stringify(latest.boundaries) || prefix !== latest.prefix;
              latest.title = title.trim(); latest.boundaries = next; latest.prefix = prefix; validatePrefix(latest);
              if (changed) { latest.results = {}; latest.synthesis = undefined; latest.phase = 'preview'; latest.attempt = undefined; }
            });
          })}>保存分章与前缀</Button>
          <Space style={{ display: 'flex', marginTop: 16 }}><span>本地原文预览</span><InputNumber min={1} max={draft.boundaries.length} value={previewNumber} onChange={value => setPreviewNumber(value || 1)} /></Space>
          {preview && <><p>{preview.title} · {characterCount(preview.content)} 字{previewNumber > draft.prefix ? ' · 未选后文，仅本地预览' : ''}</p><pre style={{ maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 14 }}>{preview.content.split('\n').map((line, index) => `${draft.boundaries[previewNumber - 1].start_line + index}  ${line}`).join('\n')}</pre></>}
        </> }]} />
        <Space wrap style={{ marginBlock: 16 }}>
          <Button type="primary" disabled={busy || Object.keys(draft.results).length === draft.prefix} onClick={() => void action(startExtraction)}>从检查点提取 · 调用模型</Button>
          {busy && <><Button onClick={() => { stop.current = true; }}>完成当前章后暂停</Button><Button danger onClick={() => { stop.current = true; abort.current?.abort(); }}>立即中断</Button></>}
          <span>已提取 {Object.keys(draft.results).length} / {draft.prefix} 章；每章保存成功后才继续。</span>
        </Space>
        {conflicts.length > 0 && <Alert type="warning" title="人物别名冲突，不会自动合并" description={conflicts.join('；')} />}
        <Collapse items={Object.entries(draft.results).map(([number, result]) => ({ key: number, label: `第 ${number} 章 · ${result.reviewed ? '审核完成' : '待审核'}`, children: <>
          {result.warnings.length > 0 && <Alert type="warning" title="提取提示" description={result.warnings.join('；')} />}
          <form key={`${number}:${draft.revision}`} onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault(); const summary = String(new FormData(event.currentTarget).get('summary') || '').trim();
            void action(() => edit(latest => { if (!summary) throw new Error('摘要不能为空。'); latest.results[number].summary = summary; latest.results[number].reviewed = false; latest.synthesis = undefined; latest.phase = 'review'; }));
          }}><label>章节摘要<Input.TextArea name="summary" defaultValue={result.summary} disabled={busy} autoSize={{ minRows: 2, maxRows: 6 }} /></label><Button htmlType="submit" disabled={busy}>保存摘要修改</Button></form>
          {result.candidates.map(candidate => <CandidateEditor key={`${candidate.id}:${draft.revision}`} candidate={candidate} disabled={busy} onSave={value => void action(() => edit(latest => {
            latest.results[number].candidates = latest.results[number].candidates.map(item => item.id === value.id ? value : item);
            latest.results[number].reviewed = false; latest.synthesis = undefined; latest.phase = 'review';
          }))} />)}
          <Button disabled={busy || result.candidates.some(candidate => candidate.status === 'pending')} onClick={() => void action(() => edit(latest => { latest.results[number].reviewed = true; }))}>确认本章摘要与候选审核</Button>
        </> }))} />
        <Button style={{ marginBlock: 16 }} disabled={busy || Object.keys(draft.results).length !== draft.prefix || Object.values(draft.results).some(result => !result.reviewed) || conflicts.length > 0} onClick={() => void action(synthesize)}>整理已审核前缀为写作设定 · 调用模型</Button>
        {draft.synthesis && <Card size="small" title="最终写作资产：检查并保存后创建作品">
          <p>整理结果是可修改的写作设定；正式知识图谱只采用你逐项接受的候选，不自动合并人物。</p>
          <form key={`synthesis:${draft.revision}`} onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault(); const data = new FormData(event.currentTarget);
            void action(() => edit(latest => { const current = latest.synthesis!; current.config = { ...(current.config as Record<string, unknown>), ...Object.fromEntries(Object.keys(fieldLabels).map(key => [key, String(data.get(key) || '').trim()])) };
              current.assets = { ...(current.assets as Record<string, unknown>), outline: String(data.get('outline') || '').trim(), characters: String(data.get('characters') || '').trim() }; latest.phase = 'ready'; }));
          }}>
            {Object.entries(fieldLabels).map(([key, label]) => <label key={key} style={{ display: 'block', marginBottom: 12 }}>{label}<Input.TextArea name={key} defaultValue={String((draft.synthesis!.config as Record<string, unknown> | undefined)?.[key] || '')} disabled={busy} autoSize={{ minRows: 1, maxRows: 6 }} /></label>)}
            {(['outline', 'characters'] as const).map(key => <label key={key} style={{ display: 'block', marginBottom: 12 }}>{key === 'outline' ? '大纲' : '人物卡'}<Input.TextArea name={key} defaultValue={String((draft.synthesis!.assets as Record<string, unknown> | undefined)?.[key] || '')} disabled={busy} autoSize={{ minRows: 4, maxRows: 12 }} /></label>)}
            <Button htmlType="submit" disabled={busy}>保存设定与资产修改</Button>
          </form>
          {readyErrors(draft.synthesis).length > 0 && <Alert style={{ marginTop: 12 }} type="warning" title={readyErrors(draft.synthesis).join('；')} />}
          <Button style={{ marginTop: 16 }} type="primary" disabled={busy || readyErrors(draft.synthesis).length > 0} onClick={() => void action(finish)}>创建可续写作品 · 从第 {draft.prefix + 1} 章开始</Button>
        </Card>}
      </>}
    </>}
  </Card>;
}
