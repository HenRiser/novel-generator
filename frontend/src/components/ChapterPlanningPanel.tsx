import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Descriptions, Input, Select, Space, Tag, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { safePublicMessage } from '../api';
import { authorizePlanningRun, generateChapterPlanning, getPlanningRun, savePlanningScenes, savePlanningTask } from '../chapterPlanning';
import { assertConnectionGuard, getProject } from '../localStore';
import { cancelLocalRun, recoverInterrupted } from '../localWorkflow';
import { buildPlanningInput, validatePlanningResult, type PlanningRequest, type PlanningResult } from '../planningInput';
import { readPlanningTrace } from '../planningTrace';
import type { LocalProject, LocalRun } from '../localTypes';

export type PlanningEditorState = { dirty: boolean; busy: boolean; loaded: boolean };
export type PlanningAction = '' | 'generating' | 'task' | 'scene' | 'authorizing';
type Form = { author_intent: string; canon_budget: PlanningRequest['canon_budget']; characters: string; forbidden: string };
const EMPTY_FORM: Form = { author_intent: '', canon_budget: 'none', characters: '', forbidden: '' };
const BUDGETS = [{ value: 'none', label: '不增加新设定' }, { value: 'minor', label: '少量新增' }, { value: 'normal', label: '正常推进' }];
const FUNCTIONS: Record<string, string> = { relationship_progress: '关系推进', emotional_aftermath: '情绪余波', action_progress: '行动推进', information_reveal: '信息揭示', foreshadowing_setup: '伏笔设置', foreshadowing_payoff: '伏笔回收', reward_delivery: '回报兑现', suspense_maintenance: '悬念维持', transition: '过渡' };
const NODES: Record<string, string> = { context_pack: '选取故事记忆', initial_proposal: '起草提案', validate: '检查章节约束', repair_once: '修订明确问题' };
const ISSUES: Record<string, string> = { invalid_json: '模型没有返回完整的提案。', invalid_fields: '提案字段不完整或包含不允许的内容。', invalid_type: '提案中的字段格式不正确。', task_invalid: '任务单违反了章节功能或新增设定预算规则。', empty_ending_state: '任务单缺少明确的结尾状态。', scene_invalid: '场景的数量、顺序或必要内容不完整。', canon_budget_changed: '提案改变了你指定的新增设定预算。', required_characters_missing: '任务单遗漏了你指定的必需人物。', forbidden_advances_missing: '任务单遗漏了你指定的禁止推进。', required_characters_absent: '必需人物没有出现在任何场景中。', scene_task_conflict: '场景信息约束存在冲突，请检查允许与禁止内容及任务单要求。' };
const lines = (text: string) => [...new Set(text.split(/\r?\n/).map(value => value.trim()).filter(Boolean))];

function initialForm(run: LocalRun | undefined): Form {
  const constraints = run?.input.constraints as Partial<PlanningRequest> | undefined;
  return { author_intent: typeof run?.input.author_intent === 'string' ? run.input.author_intent : '',
    canon_budget: constraints?.canon_budget && ['none', 'minor', 'normal'].includes(constraints.canon_budget) ? constraints.canon_budget : 'none',
    characters: Array.isArray(constraints?.required_characters) ? constraints.required_characters.join('\n') : '',
    forbidden: Array.isArray(constraints?.forbidden_advances) ? constraints.forbidden_advances.join('\n') : '' };
}

export function ChapterPlanningPanel({ projectRef, chapterNumber, disabled, taskEditor, sceneEditor, onSaved, onOpenEditor, onActionChange }: {
  projectRef: string; chapterNumber: number; disabled: boolean;
  taskEditor: PlanningEditorState; sceneEditor: PlanningEditorState;
  onSaved: (kind: 'task' | 'scene') => void;
  onOpenEditor: (kind: 'task' | 'scene') => void;
  onActionChange: (action: PlanningAction) => void;
}) {
  const [project, setProject] = useState<LocalProject | null>(null);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [loaded, setLoaded] = useState(false);
  const [action, setAction] = useState<PlanningAction>('');
  const [guardValid, setGuardValid] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(true);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const scope = `${projectRef}:${chapterNumber}`;
  const epoch = useRef(0), sequence = useRef(0), initializedScope = useRef('');
  const controller = useRef<AbortController | null>(null);
  const callbacks = useRef({ onSaved, onActionChange });
  callbacks.current = { onSaved, onActionChange };

  const refresh = useCallback(async (recover = false) => {
    const generation = epoch.current, request = ++sequence.current;
    try {
      const p = recover ? await recoverInterrupted(projectRef) : await getProject(projectRef);
      const run = getPlanningRun(p, chapterNumber);
      let authorized = false;
      if (run?.connection_guard) {
        try { await assertConnectionGuard(run.connection_guard); authorized = true; } catch { /* The author must explicitly renew permission. */ }
      }
      if (generation !== epoch.current || request !== sequence.current) return;
      if (initializedScope.current !== scope) {
        initializedScope.current = scope;
        setForm(initialForm(run));
      }
      setProject(p); setGuardValid(authorized); setLoaded(true);
    } catch (reason) {
      if (generation === epoch.current && request === sequence.current) {
        setLoaded(true);
        setError(safePublicMessage(reason instanceof Error ? reason.message : '', '策划记录读取失败。'));
      }
    }
  }, [projectRef, chapterNumber, scope]);

  useEffect(() => {
    epoch.current++; sequence.current++; initializedScope.current = '';
    controller.current?.abort(); controller.current = null;
    setProject(null); setForm(EMPTY_FORM); setLoaded(false); setGuardValid(false); setAction(''); setError(''); setMessage('');
    const changed = (event: Event) => { if ((event as CustomEvent<{ projectRef?: string }>).detail?.projectRef === projectRef) void refresh(); };
    const connectionsChanged = () => void refresh();
    void refresh(true);
    window.addEventListener('braipen:workflow-changed', changed);
    window.addEventListener('braipen:connections-changed', connectionsChanged);
    return () => {
      epoch.current++; sequence.current++; controller.current?.abort();
      window.removeEventListener('braipen:workflow-changed', changed);
      window.removeEventListener('braipen:connections-changed', connectionsChanged);
    };
  }, [projectRef, refresh]);

  const run = project ? getPlanningRun(project, chapterNumber) : undefined;
  let result: PlanningResult | undefined;
  if (run?.result) {
    try { validatePlanningResult(run.result, chapterNumber); result = run.result; } catch { /* Invalid saved data cannot be offered for adoption. */ }
  }
  const request: PlanningRequest = { author_intent: form.author_intent, canon_budget: form.canon_budget, required_characters: lines(form.characters), forbidden_advances: lines(form.forbidden) };
  let blockedReason = '';
  if (project) { try { buildPlanningInput(project, chapterNumber, request); } catch (reason) { blockedReason = reason instanceof Error ? reason.message : '请先确认前文与本章意图。'; } }
  const busy = Boolean(action), running = action === 'generating' || run?.status === 'running';
  const trace = readPlanningTrace(run?.planning_trace), lastEntry = trace.entries[trace.entries.length - 1];
  const nodeLabel = lastEntry ? `${NODES[lastEntry.node]}${lastEntry.visit === 2 ? '（再次检查）' : ''}` : '';
  const interrupted = run?.status === 'interrupted' || run?.status === 'failed';
  const executionLabel = run?.status === 'completed' ? '本次策划请求已完成，提案仍需作者审核。' : interrupted ?
    lastEntry?.status === 'started' ? `${nodeLabel}期间执行中断，节点后续结果未知。` : '本次执行已中断，已保存的节点记录保留。' :
    running ? lastEntry ? `${nodeLabel} · ${lastEntry.status === 'started' ? '正在执行' : lastEntry.status === 'failed' ? '节点失败' : '节点已结束，等待后续进度'}` : '等待节点进度。' : '';
  // Keep elapsed values outside the live region; announce only node/visit or run-phase changes.
  const announcedPhase = interrupted ? '策划执行已中断。' : run?.status === 'completed' ? '策划请求已完成，等待作者审核。' :
    running ? nodeLabel ? `当前节点：${nodeLabel}。` : '策划请求已开始，等待节点进度。' : '';
  const editorBusy = taskEditor.busy || sceneEditor.busy;
  const ready = run?.status === 'completed' && result?.status === 'draft_ready' && guardValid;
  const application = run?.planning_application;
  const approvedTask = project?.chapter_tasks[chapterNumber]?.approved;
  const approvedScene = project?.scene_plans[chapterNumber]?.approved;
  const taskDraft = project?.chapter_tasks[chapterNumber]?.latest_draft;
  const sceneDraft = project?.scene_plans[chapterNumber]?.latest_draft;
  const taskApproved = Boolean(application && approvedTask?.status === 'approved' && approvedTask.id === application.task_id && approvedTask.revision >= application.task_revision);
  const planningApproved = Boolean(taskApproved && application?.scene_plan_id && approvedScene?.status === 'approved' && approvedScene.id === application.scene_plan_id &&
    approvedScene.revision >= (application.scene_plan_revision || 0) && approvedScene.source_chapter_task_id === approvedTask?.id && approvedScene.source_chapter_task_revision === approvedTask?.revision);
  const linkedScene = sceneDraft?.id === application?.scene_plan_id ? sceneDraft : approvedScene?.id === application?.scene_plan_id ? approvedScene : null;
  const taskReplaced = Boolean(application && !taskApproved && taskDraft?.id !== application.task_id);
  const bindingChanged = Boolean(application?.scene_plan_id && (!linkedScene || !taskApproved || linkedScene.source_chapter_task_id !== approvedTask?.id || linkedScene.source_chapter_task_revision !== approvedTask?.revision));
  const stale = Boolean(result && !application && run?.result_revision !== project?.revision);
  const needsAuthorization = run?.status === 'completed' && !guardValid && !planningApproved;
  const reviewLabel = planningApproved ? '规划已批准' : taskReplaced || bindingChanged ? '规划关联待检查' : stale ? '提案已过期' : result?.status === 'needs_user_decision' ? '需要作者处理' : application?.scene_plan_id ? '场景待作者批准' : application ? taskApproved ? '任务已批准，待保存场景' : '任务待作者批准' : result ? '提案待保存' : running ? '正在生成提案' : '填写本章意图';
  const taskAllowed = ready && taskEditor.loaded && !taskEditor.dirty && !editorBusy && !application && !taskDraft && !stale;
  const sceneAllowed = ready && sceneEditor.loaded && !sceneEditor.dirty && !editorBusy && application && !application.scene_plan_id && taskApproved && !sceneDraft;
  const showTaskEditor = Boolean(application || taskDraft || taskEditor.dirty || result?.status === 'needs_user_decision');
  const showSceneEditor = Boolean(application?.scene_plan_id || sceneDraft || sceneEditor.dirty || bindingChanged);
  const nextStep = planningApproved ? 'writing' : bindingChanged ? 'review-scene' : taskReplaced || (application && !taskApproved) || (!application && (taskDraft || taskEditor.dirty || result?.status === 'needs_user_decision')) ? 'review-task' : application?.scene_plan_id || (taskApproved && (sceneDraft || sceneEditor.dirty)) ? 'review-scene' : !result || stale ? 'generate' : needsAuthorization ? 'authorize' : taskApproved ? 'scene' : 'task';
  const nextHint = planningApproved ? '任务单与场景计划已批准，可前往创作台查看正文生成条件。' : bindingChanged ? '任务已更新，请检查场景绑定并重新审核。' : taskReplaced ? '当前任务已变更，请检查这份提案与任务单的关联。' : stale && nextStep === 'generate' ? '作品已更新，这份尚未采纳的提案已过期，请重新生成。' : nextStep === 'review-task' ? '打开任务单，核对内容并保存需要的修改，再批准草稿。' : nextStep === 'review-scene' ? '打开场景计划，核对场景内容与任务绑定，再批准草稿。' : nextStep === 'authorize' ? '恢复原连接的授权后，可继续采纳已有提案。' : nextStep === 'scene' ? '任务单已批准，可以把场景提案保存为草稿。' : nextStep === 'task' ? '先将任务单提案保存为草稿，再由你审核批准。' : '填写意图与约束，生成可供审核的任务单和场景提案。';
  const progress = planningApproved ? 3 : application?.scene_plan_id || taskApproved ? 2 : application ? 1 : 0;
  const previewResultKey = result ? `${run?.run_id}:${run?.attempt_id}` : '';
  const hasApplication = Boolean(application);
  useEffect(() => { setPreviewOpen(!hasApplication); }, [previewResultKey, hasApplication]);

  async function act(kind: Exclude<PlanningAction, ''>, operation: (signal: AbortSignal) => Promise<unknown>) {
    if (controller.current || busy || running || disabled) return;
    const generation = epoch.current, current = new AbortController();
    controller.current = current; setAction(kind); setError(''); setMessage(''); callbacks.current.onActionChange(kind);
    try {
      await operation(current.signal);
      if (generation !== epoch.current) return;
      if (kind === 'task') setPreviewOpen(false);
      if (kind === 'task' || kind === 'scene') callbacks.current.onSaved(kind);
      setMessage(kind === 'task' ? '任务草稿已保存。' : kind === 'scene' ? '场景草稿已保存。' : kind === 'authorizing' ? '已有提案已重新授权，没有调用模型。' : '提案已保存在本浏览器。');
    } catch (reason) {
      if (generation !== epoch.current) return;
      if (current.signal.aborted) setMessage('操作已停止，已保存的结果保留。');
      else setError(safePublicMessage(reason instanceof Error ? reason.message : '', '操作未完成，请检查连接与章节约束。'));
    } finally {
      if (generation === epoch.current) { controller.current = null; setAction(''); callbacks.current.onActionChange(''); void refresh(true); }
    }
  }

  function stop() {
    controller.current?.abort();
    if (run?.status === 'running') cancelLocalRun(projectRef, run.run_id);
  }

  if (!projectRef.startsWith('book:')) return null;
  return <Card title="一键策划下一章" size="small" data-testid="chapter-planning-panel" style={{ marginBottom: 20 }} extra={<Button size="small" onClick={() => void refresh(true)} disabled={busy}>刷新提案</Button>}>
    <p className="review-note">输入本章意图，生成任务单与场景候选。最多调用模型两次；只有你保存并批准的版本才会参与正文生成。</p>
    <div className="planning-next-step" data-testid="planning-next-step">
      <ol className="planning-progress" aria-label="策划进度" data-testid="planning-progress">
        {['提案', '任务审核', '场景审核', '规划已批准'].map((label, index) => <li key={label} aria-current={index === progress ? 'step' : undefined} className={index < progress ? 'is-complete' : index === progress ? 'is-current' : ''}>{label}</li>)}
      </ol>
      <div role="status" aria-live="polite"><Tag color={planningApproved ? 'green' : stale || taskReplaced || bindingChanged ? 'orange' : 'blue'}>{reviewLabel}</Tag><p className="planning-next-hint">{nextHint}</p></div>
      <Space wrap>
        {planningApproved && <Link className="planning-writing-link" to={`/writing?chapter=${chapterNumber}`}>前往创作台</Link>}
        {showTaskEditor && <Button type={nextStep === 'review-task' ? 'primary' : 'default'} onClick={() => onOpenEditor('task')}>前往审核任务单</Button>}
        {showSceneEditor && <Button type={nextStep === 'review-scene' ? 'primary' : 'default'} onClick={() => onOpenEditor('scene')}>前往审核场景</Button>}
        {result && <>
          <Button type={nextStep === 'task' ? 'primary' : 'default'} onClick={() => void act('task', signal => savePlanningTask(projectRef, run!.run_id, signal))} disabled={disabled || busy || running || !taskAllowed} loading={action === 'task'}>保存任务草稿</Button>
          <Button type={nextStep === 'scene' ? 'primary' : 'default'} onClick={() => void act('scene', signal => savePlanningScenes(projectRef, run!.run_id, signal))} disabled={disabled || busy || running || !sceneAllowed} loading={action === 'scene'}>保存场景草稿</Button>
        </>}
        {needsAuthorization && <Button type={nextStep === 'authorize' ? 'primary' : 'default'} onClick={() => void act('authorizing', signal => authorizePlanningRun(projectRef, run!.run_id, undefined, signal))} disabled={disabled || busy || running}>重新授权已有提案</Button>}
        <Button type={nextStep === 'generate' ? 'primary' : 'default'} onClick={() => void act('generating', signal => generateChapterPlanning(projectRef, chapterNumber, request, signal))} disabled={!project || !loaded || disabled || busy || running || Boolean(blockedReason)} loading={action === 'generating'}>生成策划提案</Button>
        {running && <Button onClick={stop}>停止策划</Button>}
      </Space>
    </div>
    {(run || running) && <section className="planning-execution" aria-label="策划节点执行" data-testid="planning-execution">
      <Typography.Text strong>节点执行</Typography.Text>
      <p role="status" aria-live="polite" aria-atomic="true" className="planning-live-phase">{announcedPhase}</p>
      <p data-testid="planning-current-node">{executionLabel}</p>
      {lastEntry && <p className="planning-observed-time" data-testid="planning-observed-time">服务端观察累计：{(lastEntry.elapsed_ms / 1000).toFixed(1)} 秒</p>}
      {(trace.invalid || run?.planning_trace_invalid === true) && <Alert type="warning" showIcon message="节点记录格式无效，已安全忽略。" />}
      {trace.entries.length > 0 && <details key={`${scope}:${run?.attempt_id}`} className="planning-trace" data-testid="planning-trace">
        <summary>查看本次执行记录 · {trace.entries.length} 条</summary>
        <ol>{trace.entries.map(entry => <li key={entry.seq}>
          <span>{NODES[entry.node]}{entry.visit === 2 ? '（再次检查）' : ''} · {entry.status === 'finished' ? '节点结束' : entry.status === 'failed' ? '节点失败' : '节点开始'}</span>
          <span className="planning-trace-time">观察累计 {(entry.elapsed_ms / 1000).toFixed(1)} 秒</span>
        </li>)}</ol>
      </details>}
      {!trace.entries.length && result && <p className="review-note" data-testid="planning-final-nodes">此提案仅有最终节点记录：{result.nodes.map(node => NODES[node] || '处理提案').join(' → ')}。没有保存实时节点进度。</p>}
      <p className="review-note">节点记录用于查看本次执行过程；节点结束不代表规则通过或作者批准。中断后请在“任务与恢复”中查看结果，再决定是否重新调用模型。</p>
    </section>}
    {taskEditor.dirty && <Alert type="info" showIcon message="任务单编辑器中有未保存内容，暂不能采纳任务提案。请先前往审核任务单处理。" className="planning-notice" />}
    {sceneEditor.dirty && <Alert type="info" showIcon message="场景编辑器中有未保存内容，暂不能采纳场景提案。请先前往审核场景处理。" className="planning-notice" />}
    {taskDraft && !application && <Alert type="info" showIcon message="当前章节已有任务草稿，请前往审核任务单处理；采纳提案不会覆盖已有草稿。" className="planning-notice" />}
    {sceneDraft && !application?.scene_plan_id && <Alert type="info" showIcon message="当前章节已有场景草稿，请前往审核场景处理；采纳提案不会覆盖已有草稿。" className="planning-notice" />}
    {needsAuthorization && <Alert type="warning" showIcon message="该提案需要重新授权" description={<span>原提案使用模型 <strong>{run?.connection?.model || '未记录'}</strong>。请在<Link to="/settings">模型连接设置</Link>中启用匹配的原连接，并填写或解锁密钥。授权已有提案不会调用模型，也不会覆盖更新后的作品。</span>} className="planning-notice" />}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: 12 }}>
      <div><Typography.Text strong>本章意图</Typography.Text><Input.TextArea aria-label="本章策划意图" value={form.author_intent} onChange={event => setForm(value => ({ ...value, author_intent: event.target.value }))} disabled={!loaded || busy} autoSize={{ minRows: 3, maxRows: 6 }} /></div>
      <div><Typography.Text strong>新增设定预算</Typography.Text><Select aria-label="策划新增设定预算" value={form.canon_budget} onChange={value => setForm(form => ({ ...form, canon_budget: value }))} options={BUDGETS} disabled={!loaded || busy} style={{ width: '100%', display: 'block', marginBottom: 10 }} /><Typography.Text type="secondary">默认不增加新设定，以人物、关系与已有事件的后果推进。</Typography.Text></div>
      <div><Typography.Text strong>必需人物（每行一个）</Typography.Text><Input.TextArea aria-label="策划必需人物" value={form.characters} onChange={event => setForm(value => ({ ...value, characters: event.target.value }))} disabled={!loaded || busy} autoSize={{ minRows: 3, maxRows: 6 }} /></div>
      <div><Typography.Text strong>禁止推进（每行一条）</Typography.Text><Input.TextArea aria-label="策划禁止推进" value={form.forbidden} onChange={event => setForm(value => ({ ...value, forbidden: event.target.value }))} disabled={!loaded || busy} autoSize={{ minRows: 3, maxRows: 6 }} /></div>
    </div>
    {blockedReason && <Alert type="info" showIcon message={blockedReason} style={{ marginTop: 12 }} />}
    {error && <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} />}
    {message && <Alert type="success" showIcon message={message} style={{ marginTop: 12 }} />}
    {run?.status === 'interrupted' && <Alert type="warning" showIcon message="策划已中断。请在“任务与恢复”中查看已有结果，再决定是否继续。" style={{ marginTop: 12 }} />}
    {run?.result && !result && <Alert type="warning" showIcon message="已保存提案的格式无效，请重新策划。" style={{ marginTop: 12 }} />}
    {result && <details className="planning-proposal-details" data-testid="planning-proposal-details" open={previewOpen} onToggle={event => setPreviewOpen(event.currentTarget.open)}>
      <summary>查看任务单与场景提案 <span>· 修订 {result.repair_count} 次</span></summary>
      <Typography.Text type="secondary">{result.nodes.map(node => NODES[node] || '处理提案').join(' → ')}</Typography.Text>
      <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>本次提案依据：{String(run?.input.author_intent || '')}。调整上方意图后，需要重新生成提案。</Typography.Paragraph>
      {result.excluded_records > 0 && <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>已排除 {result.excluded_records} 条未来、未审核或缺少来源的故事记录。</Typography.Paragraph>}
      {result.issues.length > 0 && <Alert type="warning" showIcon message="提案仍有规则问题，不能直接采纳" description={<ul>{result.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{ISSUES[issue.code] || '提案未通过章节约束检查，请重新策划或手工规划。'}</li>)}</ul>} style={{ marginTop: 12 }} />}
      {result.task_payload && <Card size="small" title="任务单提案" style={{ marginTop: 12 }}><Descriptions size="small" column={1}>
        <Descriptions.Item label="主要功能">{FUNCTIONS[result.task_payload.primary_function] || result.task_payload.primary_function}</Descriptions.Item>
        <Descriptions.Item label="新增设定预算">{BUDGETS.find(budget => budget.value === result.task_payload?.canon_budget)?.label || result.task_payload.canon_budget}</Descriptions.Item>
        <Descriptions.Item label="必需人物">{result.task_payload.required_characters.join('、') || '未指定'}</Descriptions.Item>
        <Descriptions.Item label="必须承接">{result.task_payload.must_carry.join('；') || '未指定'}</Descriptions.Item>
        <Descriptions.Item label="允许推进">{result.task_payload.allowed_advances.join('；') || '未指定'}</Descriptions.Item>
        <Descriptions.Item label="禁止推进">{result.task_payload.forbidden_advances.join('；') || '未指定'}</Descriptions.Item>
        <Descriptions.Item label="关系目标">{result.task_payload.relationship_goal || '未指定'}</Descriptions.Item>
        <Descriptions.Item label="决定目标">{result.task_payload.decision_goal || '未指定'}</Descriptions.Item>
        <Descriptions.Item label="结尾状态">{result.task_payload.ending_state}</Descriptions.Item>
      </Descriptions></Card>}
      {result.scene_proposal && <div style={{ marginTop: 12 }}>{result.scene_proposal.scenes.map(scene => <Card size="small" key={scene.scene_no} title={`场景 ${scene.scene_no} · ${scene.title}`} style={{ marginBottom: 8 }}><Typography.Paragraph>地点：{scene.location} · 人物：{scene.participants.join('、')}</Typography.Paragraph><Typography.Paragraph>允许信息：{scene.allowed_information.join('；')}</Typography.Paragraph><Typography.Paragraph>禁止信息：{scene.forbidden_information.join('；')}</Typography.Paragraph><Typography.Paragraph>情绪变化：{scene.emotional_shift}</Typography.Paragraph><Typography.Text>结尾：{scene.ending_state}</Typography.Text></Card>)}</div>}
      <p className="review-note">先保存、审核并批准任务单，再保存场景草稿。场景还需单独批准。</p>
      <details><summary>查看完整提案 JSON</summary><pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflow: 'auto' }}>{JSON.stringify(result, null, 2)}</pre></details>
    </details>}
  </Card>;
}
