import { connections } from '../providerConnections';
import type { ConnectionProfile } from '../providerTypes';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Collapse, Popconfirm, Select, Space, Tag } from 'antd';
import { useAppStore } from '../store/useAppStore';
import { recoverInterrupted, resumeLocalRun, resolveLocalRun, startLocalBatch, endLocalBatch, stopLocalBatch, summarizeLocalChapter, cancelLocalRun, rebindFrozenConnection, newSummaryWithConnection } from '../localWorkflow';
import { downloadRescue, hasRescue } from '../localStore';
import type { LocalProject } from '../localTypes';

const labels: Record<string, string> = { generate_chapter: '正文生成', continue_chapter: '章内续写', summarize_chapter: '摘要与检查', generate_outline: '大纲生成', generate_characters: '人物卡生成', expand_setting: '设定扩写', story_delta: '章节分析', graph_change: '图谱修改', review_change: '知识审核', chapter_task: '章节任务单', scene_plan: '场景计划', plan_chapter: '章节策划' };

/** Always mounted for the selected work. Recovery never automatically calls a model. */
export default function LocalTasksPanel() {
  const [connectionList,setConnectionList]=useState<ConnectionProfile[]>([]),[replacement,setReplacement]=useState('');
  useEffect(()=>{const load=()=>void connections().then(setConnectionList).catch(()=>undefined);load();window.addEventListener('braipen:connections-changed',load);return()=>window.removeEventListener('braipen:connections-changed',load);},[]);
  const ref = useAppStore(state => state.selectedProjectRef);
  const [project, setProject] = useState<LocalProject | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [rescue, setRescue] = useState(hasRescue());
  const epoch = useRef(0);
  const [revision, setRevision] = useState(0);
  useEffect(() => { setProject(null); setError(''); setBusy(false); }, [ref]);
  useEffect(() => {
    const current = ++epoch.current;
    let timer: number;
    const refresh = async () => {
      try { const p = ref ? await recoverInterrupted(ref) : null; if (current === epoch.current) { setProject(p); setRescue(hasRescue()); } }
      catch (e) { if (current === epoch.current) setError(e instanceof Error ? e.message : '无法读取恢复记录。'); }
    };
    const changed = () => void refresh();
    void refresh(); timer = window.setInterval(changed, 2000);
    window.addEventListener('braipen:workflow-changed', changed); window.addEventListener('braipen:rescue', changed);
    return () => { epoch.current++; window.clearInterval(timer); window.removeEventListener('braipen:workflow-changed', changed); window.removeEventListener('braipen:rescue', changed); };
  }, [ref, revision]);
  const runs = project?.runs.filter(run => run.status === 'running' || run.status === 'interrupted' || run.status === 'failed' || (run.status === 'completed' && run.operation === 'continue_chapter')) || [];
  const orphanSummaries = Object.values(project?.chapters || {}).filter(c => c.workflow.status === 'confirmed' && (c.workflow.summary_status === 'failed' || c.workflow.review_status === 'failed') && !runs.some(r => r.operation === 'summarize_chapter' && r.chapter_number === c.chapter_number));
  const batch = project?.batch, running = runs.some(run => run.status === 'running') || batch?.status === 'running' || batch?.status === 'stopping';
  const recoverBatch = batch?.request && ['failed', 'stopped'].includes(batch.status);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (running || rescue) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [running, rescue]);
  async function act(task: () => Promise<unknown>) {
    const current = epoch.current; setBusy(true); setError('');
    try { await task(); }
    catch (e) { if (current === epoch.current) setError(e instanceof Error ? e.message : '任务未完成。'); }
    finally { if (current === epoch.current) { setBusy(false); setRevision(r => r + 1); } }
  }
  if (!ref || (!runs.length && !orphanSummaries.length && !recoverBatch && !running && !rescue && !error)) return null;
  return <div style={{ padding: '12px 24px 0' }} aria-label="任务恢复">
    {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 8 }} />}
    {rescue && <Alert type="warning" showIcon title="有未保存的结果，请在刷新前下载应急副本。" action={<Button onClick={downloadRescue}>下载应急副本</Button>} />}
    <Collapse items={[{ key: 'tasks', label: `任务与恢复 · ${running ? '正在执行' : `${runs.length + orphanSummaries.length} 项待处理`}`, children: <Space orientation="vertical" style={{ width: '100%' }}>
      <p>关闭页面后任务暂停。已保存结果可以直接应用；结果未知的步骤重新执行可能再次计费。Key 需在本标签页填写或解锁。</p>
      {!running&&<details><summary>原连接已删除或缺失？修复连接关联或采用新配置</summary><Space wrap><Select aria-label="恢复连接关联" placeholder="选择匹配的连接" style={{minWidth:220}} value={replacement||undefined} onChange={setReplacement} options={connectionList.filter(p=>p.enabled).map(p=>({value:p.id,label:p.name}))}/><Button disabled={busy||!replacement} onClick={()=>void act(()=>rebindFrozenConnection(ref,replacement))}>修复连接关联</Button></Space><p>仅允许原目的地、模型与能力策略完全匹配；换服务应新建任务，不能伪装为原任务恢复。</p></details>}
      {running && <Button danger onClick={() => { const run = runs.find(r => r.status === 'running'); if (run) cancelLocalRun(ref, run.run_id); void stopLocalBatch(ref, true).catch(e => setError(String(e))); }}>立即中断当前任务</Button>}
      {recoverBatch && <Popconfirm title="从已保存步骤继续连续生成？" description="完成的正文保留；结果未知的请求可能再次计费。" onConfirm={() => act(() => startLocalBatch(ref, batch!.request!, true))}><Button disabled={busy || running} type="primary">继续连续生成</Button></Popconfirm>}
      {recoverBatch && <Popconfirm title="结束此批次？" description="已保存章节和草稿保留，可以单独处理或另起批次。" onConfirm={() => act(() => endLocalBatch(ref))}><Button disabled={busy || running}>结束此批次</Button></Popconfirm>}
      {orphanSummaries.map(c => <Space wrap key={c.chapter_number}><Button disabled={busy || running} onClick={() => void act(() => summarizeLocalChapter(ref, c.chapter_number))}>按原配置继续第 {c.chapter_number} 章摘要与检查</Button><Popconfirm title="按所选连接的新配置重新生成摘要与检查？" description="会创建新运行并可能计费；正文和原叙事约束保留，旧任务记录保留。" onConfirm={()=>act(()=>newSummaryWithConnection(ref,c.chapter_number,replacement))}><Button disabled={busy||running||!replacement}>采用所选连接新建摘要检查</Button></Popconfirm></Space>)}
      {runs.map(run => <div key={run.run_id} style={{ borderTop: '1px solid var(--border)', paddingTop: 12, width: '100%' }}>
        <Space wrap><strong>{labels[run.operation] || run.operation} · 第 {run.chapter_number} 章</strong><Tag>{run.status === 'running' ? '执行中' : run.result ? '已有结果' : '已中断'}</Tag></Space>
        {run.connection&&<p className="muted-note">冻结目标：{run.connection.base_url} · {run.connection.model} · 修订 {run.connection.revision}</p>}
        {run.error && <p>{run.error}</p>}
        {Boolean(run.partial || (run.operation === 'continue_chapter' && run.result?.content)) && <details><summary>查看暂存文字（可复制）</summary><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>{String(run.result?.content || run.partial)}</pre></details>}
        {run.attempt_history?.filter(attempt => attempt.partial || attempt.result?.content).map(attempt => <details key={attempt.attempt_id}><summary>上次尝试保留的文字（可复制）</summary><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>{String(attempt.result?.content || attempt.partial)}</pre></details>)}
        {run.status !== 'running' && <Space wrap style={{ marginTop: 8 }}>
          {run.operation==='summarize_chapter'&&<Popconfirm title="用所选连接创建新的摘要检查？" description="可能计费，保留原正文与叙事约束；不会伪装成原任务重试。" onConfirm={()=>act(()=>newSummaryWithConnection(ref,run.chapter_number!,replacement))}><Button disabled={busy||running||!replacement}>采用所选连接新建摘要检查</Button></Popconfirm>}
          {run.status !== 'completed' && <Popconfirm title={run.result ? '应用已保存结果？' : '重新执行此步骤？'} description={run.result ? '不会再次调用模型。输入版本变化时会拒绝覆盖。' : '上次请求结果未知，可能再次计费。'} onConfirm={() => act(() => resumeLocalRun(ref, run.run_id))}><Button disabled={busy || running || Boolean(recoverBatch)}> {run.result ? '应用已保存结果' : '重新执行此步骤'}</Button></Popconfirm>}
          {['generate_chapter', 'continue_chapter'].includes(run.operation) && Boolean(run.partial || run.result?.content) && <Button disabled={busy || running || Boolean(recoverBatch)} onClick={() => void act(() => resolveLocalRun(ref, run.run_id, true))}>保存为待确认草稿</Button>}
          <Popconfirm title="结束此任务记录？" description="已保存章节保留，记录中的文字仍在完整备份中。" onConfirm={() => act(() => resolveLocalRun(ref, run.run_id))}><Button disabled={busy || running}>放弃此任务</Button></Popconfirm>
        </Space>}
      </div>)}
    </Space> }]} />
  </div>;
}
