import { acquireConnection, resolveConnection, legacySnapshot } from './providerConnections';
import type { ConnectionSnapshot } from './providerTypes';
import { compute, computeStream, newIdentity, prepareCompute, MODEL_OPERATIONS } from './computeClient';
import { getProject, listProjects, rememberRescue, updateProject } from './localStore';
import type { LocalChapter, LocalProject, LocalRun } from './localTypes';
import type { BatchGenerationRequest, ChapterStreamDoneEvent, ChapterStreamHandlers, ChapterWorkflow, GenerationRequest, NoRevealReview, KnowledgeDraft, NarrativeGraphDocument, NarrativeGraphViewsDocument, ChapterTaskResponse, ScenePlanResponse } from './types';

const active = new Map<string, AbortController>();
const batchControllers = new Map<string, AbortController>();
window.addEventListener('pagehide', () => { for (const controller of active.values()) controller.abort(); for (const controller of batchControllers.values()) controller.abort(); });
const notify = (projectRef: string) => {
  window.dispatchEvent(new CustomEvent('braipen:workflow-changed', { detail: { projectRef } }));
  window.dispatchEvent(new Event('braipen:batch-changed'));
};
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('braipen:workflow') : null;
channel?.addEventListener('message', event => {
  if (event.data?.type === 'changed') notify(String(event.data.ref));
  if (event.data?.type === 'cancel') {
    active.get(String(event.data.id))?.abort(); batchControllers.get(String(event.data.ref))?.abort();
  }
});
export const changed = (projectRef: string) => { notify(projectRef); channel?.postMessage({ type: 'changed', ref: projectRef }); };
export function cancelLocalRun(ref: string, id: string) {
  active.get(id)?.abort(); batchControllers.get(ref)?.abort();
  channel?.postMessage({ type: 'cancel', ref, id });
}
const now = () => new Date().toISOString();

export function chapterWorkflow(ref: string, number: number, content: string, revision: string, filename: string): ChapterWorkflow {
  return { project_ref: ref, chapter_number: number, revision, chapter_file: filename, content,
    status: 'awaiting_confirmation', summary_status: 'not_requested', review_status: 'not_requested',
    review_scope: 'rules_only', summary_file: '', summary: '', error: '', review_error: '', warnings: [],
    editable: true, locked_by_chapter: null, lock_reason: '' };
}

function lockPreviousChapters(p: LocalProject, number: number) {
  for (const chapter of Object.values(p.chapters)) if (chapter.chapter_number < number && !chapter.workflow.locked_by_chapter) {
    Object.assign(chapter.workflow, { locked_by_chapter: number, editable: false,
      lock_reason: `第 ${number} 章已开始生成并引用前文，该章持续锁定。` });
  }
}

export function ensureEditable(chapter?: LocalChapter) {
  if (chapter && (chapter.source_locked || chapter.workflow.locked_by_chapter)) throw new Error(chapter.workflow.lock_reason || '该章已锁定，不能修改。');
}

export function setChapter(p: LocalProject, number: number, content: string, title?: string) {
  const previous = p.chapters[number];
  ensureEditable(previous);
  const revision = crypto.randomUUID();
  const filename = `chapter_${String(number).padStart(3, '0')}_${revision.slice(0, 8)}.md`;
  const name = title || previous?.title || `第 ${number} 章`;
  const versions = [...(previous?.versions || [])];
  if (previous) versions.push({ revision: previous.revision, content: previous.content, title: previous.title, filename: previous.filename });
  p.chapters[number] = { chapter_number: number, content, title: name, revision, filename, versions,
    workflow: chapterWorkflow(p.project_ref, number, content, revision, filename), connection: previous?.connection, summary_connection: previous?.summary_connection, frozen_context: previous?.frozen_context };
}

/** Deliberately select context fields; source archives, other chapters and keys never enter a compute input. */
export function contextInput(p: LocalProject, number = 1, request: Record<string, unknown> = {}): Record<string, unknown> {
  const chapter = p.chapters[number];
  const before = Object.values(p.chapters).filter(c => c.chapter_number < number).sort((a,b) => a.chapter_number-b.chapter_number);
  return { project_ref: p.project_ref, config: p.config, assets: p.assets, graph: p.graph, views: p.views,
    chapter_number: number, chapter: chapter ? { content: chapter.content, title: chapter.title, revision: chapter.revision, summary: chapter.workflow.summary_status === 'ready' ? chapter.workflow.summary : '' } : null,
    previous_chapter: before[before.length - 1]?.content || '',
    summaries: before.filter(c => c.workflow.status === 'confirmed' && c.workflow.summary_status === 'ready')
      .map(c => ({ chapter_number: c.chapter_number, summary: c.workflow.summary })),
    chapter_task: p.chapter_tasks[number]?.approved || null, scene_plan: request.scene_plan_id ? p.scene_plans[number]?.approved || null : null, request };
}

export function applyResult(p: LocalProject, operation: string, result: Record<string, unknown>, input: Record<string, unknown>) {
  const n = Number(input.chapter_number || 1);
  if (operation === 'generate_outline') p.assets.outline = requiredContent(result.content);
  else if (operation === 'generate_characters') p.assets.characters = requiredContent(result.content);
  else if (operation === 'expand_setting') {
    const data = result.expanded_data as Record<string, unknown>;
    if (!data || ['protagonist_setting', 'supporting_characters_setting', 'world_setting', 'core_conflict'].some(k => typeof data[k] !== 'string' || !String(data[k]).trim())) throw new Error('扩写结果字段不完整。');
    p.config = { ...p.config, protagonist: data.protagonist_setting, supporting_characters: data.supporting_characters_setting,
      worldview: data.world_setting, core_conflict: data.core_conflict };
    p.assets.setting_expansion = JSON.stringify(data, null, 2);
  } else if (operation === 'generate_chapter') {
    if (!String(result.content || '').trim()) throw new Error('正文为空，未保存。');
    lockPreviousChapters(p, n);
    setChapter(p, n, String(result.content), String(result.title || `第 ${n} 章`));
    p.chapters[n].frozen_context = (result.frozen_context || { chapter_task: input.chapter_task, scene_plan: input.scene_plan, narrative_context_text: (input.request as Record<string, unknown>)?.narrative_context_text || '' }) as Record<string, unknown>;
    if (result.function_review) (p.reviews[n] ||= []).push(result.function_review as NoRevealReview);
  } else if (operation === 'summarize_chapter') {
    const c = p.chapters[n];
    if (!c || c.revision !== (input.chapter as Record<string, unknown>)?.revision || c.workflow.status !== 'confirmed') throw new Error('正文已变更，旧摘要未保存。');
    if (!String(result.summary || '').trim()) throw new Error('摘要为空，不能推进下一章。');
    Object.assign(c.workflow, { summary: String(result.summary), summary_status: 'ready', summary_file: `summary_${n}_${c.revision}.md`,
      warnings: result.warnings || [], review_status: result.review_status || 'ready', review_error: result.review_error || '', error: '' });
  } else if (operation === 'graph_change' || operation === 'review_change') {
    p.snapshots.push({ id: crypto.randomUUID(), created_at: now(), graph: p.graph, views: p.views });
    if (result.graph) p.graph = result.graph as NarrativeGraphDocument;
    if (result.views) p.views = result.views as NarrativeGraphViewsDocument;
    if (result.draft) {
      const draft = result.draft as KnowledgeDraft;
      p.knowledge_drafts = p.knowledge_drafts.map(d => d.id === draft.id ? draft : d);
    }
  } else if (operation === 'chapter_task') p.chapter_tasks[n] = result as unknown as ChapterTaskResponse;
  else if (operation === 'scene_plan') p.scene_plans[n] = result as unknown as ScenePlanResponse;
  else if (operation === 'story_delta') {
    p.story_deltas.push({ ...result, chapter_number: n, id: crypto.randomUUID() });
    if (result.knowledge_draft) p.knowledge_drafts.push(result.knowledge_draft as KnowledgeDraft);
  } else if (operation === 'function_review' && result.review) (p.reviews[n] ||= []).push(result.review as NoRevealReview);
}

function requiredContent(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('模型未返回完整内容，未保存。');
  return value;
}

export async function projectLock<T>(ref: string, task: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('当前浏览器不支持安全的多标签任务锁，请使用新版 Edge 或 Chrome。');
  return navigator.locks.request(`braipen:project:${ref}`, { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('此作品正在计算，请等待完成或先停止任务。');
    return task();
  });
}

type RunOptions = { signal?: AbortSignal; stream?: boolean; handlers?: ChapterStreamHandlers; retry?: LocalRun; connection?: ConnectionSnapshot };
function currentRun(p: LocalProject, attempt: string): LocalRun {
  const run = p.runs.find(r => r.attempt_id === attempt);
  if (!run || run.status !== 'running') throw new Error('任务已失效，未应用结果。');
  return run;
}
function commitResult(draft: LocalProject, run: LocalRun, result: Record<string, unknown>, metrics: Record<string, unknown>) {
  applyResult(draft, run.operation, result, run.input);
  if (run.operation === 'generate_chapter' && draft.chapters[run.chapter_number!]) draft.chapters[run.chapter_number!].connection = run.connection;
  Object.assign(run, { status: 'completed', partial: '', result, metrics, error: '', result_revision: draft.revision + 1 });
  draft.ai_runs.push({ id: run.run_id, attempt_id: run.attempt_id, operation: run.operation, chapter_number: run.chapter_number, metrics, created_at: now() });
  draft.events.push({ id: crypto.randomUUID(), type: run.operation, chapter_number: run.chapter_number, created_at: now() });
  if (['running', 'stopping'].includes(draft.batch.status)) draft.batch.input_revision = draft.revision + 1;
}

/** Caller owns the project lock; batches keep it across all their steps. */
async function runLocked(p: LocalProject, operation: string, input: Record<string, unknown>, options: RunOptions = {}): Promise<Record<string, unknown>> {
  options.signal?.throwIfAborted();
  if ((await getProject(p.project_ref)).revision !== p.revision) throw new Error('作品已更新，请刷新后重试。');
  const identity = { ...newIdentity(p.revision), ...(options.retry ? { run_id: options.retry.run_id, step_id: options.retry.step_id } : {}) };
  const frozen = options.connection || options.retry?.connection || (MODEL_OPERATIONS.has(operation) ? await resolveConnection(String(p.config.connection_id || 'legacy-deepseek'), String((input.request as Record<string,unknown>)?.model || p.config.model || '')) : undefined);
  const lease = frozen ? await acquireConnection(frozen, options.signal) : undefined;
  try { prepareCompute(operation, input, identity, lease); } catch(error) { lease?.close(); throw error; }
  const run: LocalRun = { ...identity, operation, status: 'running', partial: '', error: '', started_at: now(),
    chapter_number: Number(input.chapter_number || 1), input: structuredClone(input), connection: frozen, connection_guard: lease?.guard,
    attempt_history: options.retry ? [...(options.retry.attempt_history || []), { attempt_id: options.retry.attempt_id, partial: options.retry.partial, error: options.retry.error, result: options.retry.result }] : [] };
  try { await updateProject(p.project_ref, draft => {
    draft.runs = draft.runs.filter(r => r.run_id !== run.run_id); draft.runs.push(run);
    if (operation === 'summarize_chapter') Object.assign(draft.chapters[run.chapter_number!].workflow, { summary_status: 'running', review_status: 'running', error: '' });
  }, p.revision, false, lease?.guard); } catch(error) { lease?.close(); throw error; }
  const controller = new AbortController();
  active.set(run.run_id, controller); changed(p.project_ref);
  const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : []), ...(lease ? [lease.signal] : [])]);
  let partial = '', lastSave = 0;
  let response: { result: Record<string, unknown>; metrics: Record<string, unknown> } | undefined;
  try {
    response = options.stream ? await computeStream(operation, input, identity, {
      onStarted: async frozen => {
        run.frozen_context = frozen;
        await updateProject(p.project_ref, draft => {
          currentRun(draft, run.attempt_id).frozen_context = frozen;
          if (operation !== 'generate_chapter') return;
          lockPreviousChapters(draft, run.chapter_number!);
        }, p.revision, false, lease?.guard);
      },
      onDelta: async text => {
        partial += text; options.handlers?.onDelta?.(text);
        if (Date.now() - lastSave >= 1000) {
          await updateProject(p.project_ref, draft => { currentRun(draft, run.attempt_id).partial = partial; }, p.revision, false, lease?.guard);
          lastSave = Date.now();
        }
      }, onReasoning: options.handlers?.onReasoning,
    }, signal, lease) : await compute(operation, input, identity, signal, undefined, lease);
    // A saved result can be manually applied after reload without another model call.
    await updateProject(p.project_ref, draft => {
      Object.assign(currentRun(draft, run.attempt_id), { result: response!.result, metrics: response!.metrics, result_revision: p.revision });
    }, undefined, false, lease?.guard);
    await updateProject(p.project_ref, draft => {
      commitResult(draft, currentRun(draft, run.attempt_id), response!.result, response!.metrics);
    }, p.revision);
    return { ...response.result, run_id: run.run_id };
  } catch (error) {
    const message = error instanceof Error ? error.message : '任务未完成。';
    let authorized = true;
    if (lease) { try { await lease.check(); } catch { authorized = false; response = undefined; } }
    await updateProject(p.project_ref, draft => {
      const current = draft.runs.find(r => r.attempt_id === identity.attempt_id);
      if (current?.status === 'running') Object.assign(current, { status: 'interrupted', error: message, partial: authorized ? partial : current.partial });
      if (operation === 'summarize_chapter') {
        const c = draft.chapters[Number(input.chapter_number)];
        if (c?.revision === (input.chapter as Record<string, unknown>)?.revision) Object.assign(c.workflow, { summary_status: 'failed', review_status: 'failed', error: message });
      }
    }, undefined, false).catch(() => undefined);
    // Last write wins in the rescue slot: always retain the richest in-memory result after error bookkeeping.
    const rescue = structuredClone(p);
    if (operation === 'generate_chapter' && run.frozen_context !== undefined) lockPreviousChapters(rescue, run.chapter_number!);
    rescue.runs = [...rescue.runs.filter(r => r.run_id !== run.run_id), { ...run, status: 'interrupted', partial, error: message,
      ...(response ? { result: response.result, metrics: response.metrics, result_revision: p.revision } : {}) }];
    if (authorized) rememberRescue({ projects: [rescue] });
    throw error;
  } finally { lease?.close(); active.delete(run.run_id); changed(p.project_ref); }
}

export async function runOperation(p: LocalProject, operation: string, input: Record<string, unknown>, options: RunOptions = {}) {
  return projectLock(p.project_ref, () => runLocked(p, operation, input, options));
}

async function recoverLocked(ref: string): Promise<LocalProject> {
  const p = await getProject(ref);
  const pending = Object.values(p.chapters).some(c => ['pending', 'running'].includes(c.workflow.summary_status));
  if (!pending && !p.runs.some(r => r.status === 'running') && !['running', 'stopping'].includes(p.batch.status)) return p;
  return updateProject(ref, draft => {
    for (const run of draft.runs) if (run.status === 'running') {
      run.status = 'interrupted'; run.error = run.result ? '结果已保存，确认后可直接应用，无需重新调用模型。' : '上次请求结果未知。手动重试可能再次计费。';
    }
    for (const c of Object.values(draft.chapters)) if (['pending', 'running'].includes(c.workflow.summary_status)) {
      Object.assign(c.workflow, { summary_status: 'failed', review_status: 'failed', error: '后台处理已中断，请手动继续。' });
    }
    if (['running', 'stopping'].includes(draft.batch.status)) Object.assign(draft.batch, { status: 'stopped', stage: 'interrupted', message: '连续生成已暂停，请手动继续。' });
  }, undefined, false);
}

export async function recoverInterrupted(ref: string): Promise<LocalProject> {
  if (!navigator.locks) throw new Error('当前浏览器不支持任务恢复锁。');
  return navigator.locks.request(`braipen:project:${ref}`, { ifAvailable: true }, async lock => lock ? recoverLocked(ref) : getProject(ref));
}

function validateChapterStart(p: LocalProject, number: number) {
  if (!Number.isInteger(number) || number < 1) throw new Error('章节编号无效。');
  ensureEditable(p.chapters[number]);
  const previous = Object.values(p.chapters).filter(c => c.chapter_number < number);
  if (previous.length !== number - 1) throw new Error('请按顺序生成章节，不能跳过缺失的前章。');
  if (previous.some(c => c.workflow.status !== 'confirmed' || c.workflow.summary_status !== 'ready')) throw new Error('前文尚未确认或摘要未就绪。');
  if (!p.assets.outline || !p.assets.characters) throw new Error('请先生成大纲和人物资料。');
}

async function generateLocked(ref: string, number: number, request: GenerationRequest, handlers: ChapterStreamHandlers = {}, signal?: AbortSignal): Promise<ChapterStreamDoneEvent> {
  const p = await getProject(ref);
  validateChapterStart(p, number);
  const result = await runLocked(p, 'generate_chapter', contextInput(p, number, request as unknown as Record<string, unknown>), { stream: true, handlers, signal, connection: ['running','stopping'].includes(p.batch.status) ? p.batch.connection : undefined });
  const chapter = (await getProject(ref)).chapters[number];
  const event: ChapterStreamDoneEvent = { type: 'done', ok: true, chapter_number: number, title: chapter.title,
    chapter_file: chapter.filename, workflow: chapter.workflow, message: '正文已保存在本浏览器，确认后生成摘要。',
    consistency_warnings: (result.consistency_warnings || []) as ChapterStreamDoneEvent['consistency_warnings'], function_review: result.function_review as NoRevealReview | undefined };
  handlers.onDone?.(event); return event;
}
export async function generateLocalChapter(ref: string, number: number, request: GenerationRequest, handlers: ChapterStreamHandlers = {}, signal?: AbortSignal) {
  return projectLock(ref, () => generateLocked(ref, number, request, handlers, signal));
}

async function summarizeLocked(ref: string, number: number, signal?: AbortSignal) {
  const p = await getProject(ref), c = p.chapters[number];
  if (!c || c.workflow.status !== 'confirmed') throw new Error('请先确认正文。');
  if (c.workflow.summary_status === 'ready' && c.workflow.review_status === 'ready') return;
  const saved = [...p.runs].reverse().find(r => r.operation === 'summarize_chapter' && r.chapter_number === number && r.status !== 'completed' && r.status !== 'discarded' && r.result && r.result_revision === p.revision);
  if (saved) return applySavedResult(p, saved);
  const input = { ...contextInput(p, number), frozen_context: c.frozen_context || {}, review_scope: c.workflow.review_scope || 'rules_only' };
  return runLocked(p, 'summarize_chapter', input, { signal, connection: c.summary_connection || c.connection || p.batch.connection });
}
export async function summarizeLocalChapter(ref: string, number: number) {
  return projectLock(ref, () => summarizeLocked(ref, number));
}

function sameConfirmation(c: LocalChapter, content: string, expected: string): boolean {
  return c.content === content && c.workflow.status === 'confirmed' && (c.revision === expected || c.confirmation_base_revision === expected);
}
async function confirmLocked(ref: string, number: number, content: string, expected: string): Promise<ChapterWorkflow> {
  const p = await getProject(ref), c = p.chapters[number];
  if (!c || (c.revision !== expected && !sameConfirmation(c, content, expected))) throw new Error('正文版本已变更，请刷新后确认。');
  if (sameConfirmation(c, content, expected)) return c.workflow;
  ensureEditable(c);
  if (!content.trim()) throw new Error('正文不能为空。');
  const saved = await updateProject(ref, draft => {
    const edited = draft.chapters[number].content !== content;
    if (edited) setChapter(draft, number, content);
    draft.chapters[number].confirmation_base_revision = expected;
    if (['running', 'stopping'].includes(draft.batch.status)) draft.batch.input_revision = draft.revision + 1;
    Object.assign(draft.chapters[number].workflow, { status: 'confirmed', summary_status: 'pending', review_status: 'pending',
      review_scope: edited ? 'semantic_and_rules' : draft.chapters[number].workflow.review_scope, error: '' });
  }, p.revision);
  changed(ref); return saved.chapters[number].workflow;
}
export async function confirmLocalChapter(ref: string, number: number, content: string, expectedRevision: string, background = true): Promise<ChapterWorkflow> {
  const p = await recoverInterrupted(ref), c = p.chapters[number];
  // Duplicate confirm while a summary owns the lock returns the same state, without another call.
  if (c && sameConfirmation(c, content, expectedRevision) && ['pending', 'running', 'ready'].includes(c.workflow.summary_status) && c.workflow.review_status !== 'failed') return c.workflow;
  const workflow = await projectLock(ref, () => confirmLocked(ref, number, content, expectedRevision));
  if (background) void summarizeLocalChapter(ref, number).catch(async error => {
    // Includes missing Key and quota failures before the running checkpoint existed.
    await updateProject(ref, d => {
      const current = d.chapters[number];
      if (current?.revision === workflow.revision && current.workflow.summary_status === 'pending') Object.assign(current.workflow, { summary_status: 'failed', review_status: 'failed', error: error instanceof Error ? error.message : '摘要未开始。' });
    }, undefined, false).catch(() => undefined);
    changed(ref);
  });
  return workflow;
}

async function applySavedResult(p: LocalProject, run: LocalRun) {
  if (!run.result || run.result_revision !== p.revision) throw new Error('输入已变更，旧结果不能直接应用；可下载应急副本或保存草稿。');
  await updateProject(p.project_ref, draft => {
    const current = draft.runs.find(r => r.attempt_id === run.attempt_id);
    if (!current || ['completed', 'discarded'].includes(current.status)) throw new Error('此任务已处理。');
    commitResult(draft, current, run.result!, run.metrics || {});
  }, p.revision);
  changed(p.project_ref); return run.result;
}

export async function resumeLocalRun(ref: string, id: string) {
  return projectLock(ref, async () => {
    const p = await recoverLocked(ref), run = p.runs.find(r => r.run_id === id);
    if (!run || ['completed', 'discarded'].includes(run.status)) return;
    if (run.result) return applySavedResult(p, run);
    if (run.input_revision !== p.revision) throw new Error('输入已变更，请从对应功能重新发起；旧草稿仍保留。');
    if (run.operation === 'generate_chapter') validateChapterStart(p, run.chapter_number!);
    return runLocked(p, run.operation, run.input, { retry: run, connection: run.connection || await legacySnapshot(String((run.input.request as Record<string,unknown>)?.model || p.config.model || 'deepseek-v4-flash')), stream: ['generate_chapter', 'continue_chapter'].includes(run.operation) });
  });
}

export async function resolveLocalRun(ref: string, id: string, saveDraft = false) {
  return projectLock(ref, async () => {
    const p = await recoverLocked(ref), run = p.runs.find(r => r.run_id === id);
    if (!run || run.status === 'discarded' || (run.status === 'completed' && run.operation !== 'continue_chapter')) return;
    await updateProject(ref, draft => {
      const current = draft.runs.find(r => r.run_id === id)!;
      if (saveDraft) {
        const prose = String(run.result?.content || run.partial);
        if (!['generate_chapter', 'continue_chapter'].includes(run.operation) || !prose.trim()) throw new Error('此任务没有可保存的正文草稿。');
        if ((run.status === 'completed' ? run.result_revision : run.input_revision) !== p.revision) throw new Error('作品已变化，请复制暂存文字后手动编辑，避免覆盖新版。');
        const n = run.chapter_number!;
        const content = run.operation === 'continue_chapter' ? `${draft.chapters[n]?.content || ''}\n\n${prose}` : prose;
        if (run.operation === 'generate_chapter') lockPreviousChapters(draft, n);
        setChapter(draft, n, content);
        if (run.operation === 'generate_chapter') draft.chapters[n].frozen_context = (run.result?.frozen_context || run.frozen_context || { chapter_task: run.input.chapter_task, scene_plan: run.input.scene_plan,
          narrative_context_text: (run.input.request as Record<string, unknown>)?.narrative_context_text || '' }) as Record<string, unknown>;
        draft.chapters[n].connection = run.connection;
        draft.chapters[n].workflow.review_scope = 'semantic_and_rules';
      }
      current.status = 'discarded';
    }, p.revision, saveDraft);
    changed(ref);
  });
}

export async function stopLocalBatch(ref: string, immediate = false) {
  const p = await updateProject(ref, d => {
    if (['running', 'stopping'].includes(d.batch.status)) { d.batch.status = 'stopping'; d.batch.message = '将在当前步骤保存后暂停。'; }
  }, undefined, false);
  if (immediate) {
    for (const run of p.runs) if (run.status === 'running') cancelLocalRun(ref, run.run_id);
    batchControllers.get(ref)?.abort(); channel?.postMessage({ type: 'cancel', ref });
  }
  changed(ref); return p.batch;
}

export async function endLocalBatch(ref: string) {
  return projectLock(ref, async () => {
    await recoverLocked(ref);
    const p = await updateProject(ref, d => {
      Object.assign(d.batch, { status: 'stopped', stage: 'abandoned', request: undefined, input_revision: undefined,
        message: '此批次已结束，已保存章节及任务草稿保留。', error: '' });
    }, undefined, false);
    changed(ref); return p.batch;
  });
}

export async function startLocalBatch(ref: string, request: BatchGenerationRequest, resume = false): Promise<LocalProject['batch']> {
  if (!navigator.locks) throw new Error('当前浏览器不支持任务锁。');
  return new Promise((resolve, reject) => {
    void projectLock(ref, async () => {
      let p = await recoverLocked(ref);
      if (resume) {
        if (!p.batch.request || !['stopped', 'failed'].includes(p.batch.status)) throw new Error('没有可继续的连续生成任务。');
        if (p.batch.input_revision !== undefined && p.batch.input_revision !== p.revision) throw new Error('作品已修改，请重新选择连续生成范围。');
        request = p.batch.request;
      }
      if (!Number.isInteger(request.start_chapter) || !Number.isInteger(request.end_chapter) || request.start_chapter < 1 || request.end_chapter < request.start_chapter || request.end_chapter - request.start_chapter >= 10) throw new Error('每批生成 1–10 章。');
      if (!resume && Object.values(p.chapters).some(c => c.chapter_number >= request.start_chapter)) throw new Error('连续生成只能追加新章，不能覆盖已有正文。');
      const first = resume ? p.batch.current_chapter || request.start_chapter : request.start_chapter;
      const connection = resume ? p.batch.connection || await legacySnapshot(request.model) : await resolveConnection(String(p.config.connection_id || 'legacy-deepseek'), request.model);
      const batchLease = await acquireConnection(connection);
      try { prepareCompute('generate_chapter', contextInput(p, first, request as unknown as Record<string, unknown>), newIdentity(p.revision), batchLease); } finally { batchLease.close(); }
      if (!resume) validateChapterStart(p, first);
      p = await updateProject(ref, draft => {
        draft.batch = { id: resume ? draft.batch.id : crypto.randomUUID(), status: 'running', stage: 'starting',
          start_chapter: request.start_chapter, end_chapter: request.end_chapter, current_chapter: first,
          completed_chapters: resume ? draft.batch.completed_chapters : [], message: '保持页面打开时逐章执行，关闭后需手动恢复。', error: '', request, connection, connection_guard: batchLease.guard, input_revision: draft.revision };
      }, p.revision, false);
      const controller = new AbortController(); batchControllers.set(ref, controller); changed(ref); resolve(p.batch);
      try {
        for (let n = request.start_chapter; n <= request.end_chapter; n++) {
          p = await getProject(ref);
          if (p.batch.status === 'stopping' || controller.signal.aborted) break;
          if (p.batch.connection_guard) await (await import('./localStore')).assertConnectionGuard(p.batch.connection_guard);
          if (p.batch.completed_chapters.includes(n)) continue;
          await updateProject(ref, d => { d.batch.current_chapter = n; d.batch.stage = 'generating'; }, undefined, false);
          if (!p.chapters[n]) {
            const saved = [...p.runs].reverse().find(r => r.operation === 'generate_chapter' && r.chapter_number === n && r.result && r.result_revision === p.revision && !['completed', 'discarded'].includes(r.status));
            if (saved) await applySavedResult(p, saved);
            else await generateLocked(ref, n, request, {}, controller.signal);
          }
          p = await getProject(ref);
          if (p.batch.status === 'stopping') break;
          const c = p.chapters[n];
          if (c.workflow.status !== 'confirmed') await confirmLocked(ref, n, c.content, c.revision);
          await updateProject(ref, d => { d.batch.stage = 'summarizing'; }, undefined, false);
          await summarizeLocked(ref, n, controller.signal);
          await updateProject(ref, d => {
            if (!d.batch.completed_chapters.includes(n)) d.batch.completed_chapters.push(n);
            d.batch.input_revision = d.revision;
          }, undefined, false);
          changed(ref);
        }
        await updateProject(ref, d => { d.batch.status = d.batch.completed_chapters.length === request.end_chapter - request.start_chapter + 1 ? 'completed' : 'stopped'; d.batch.stage = d.batch.status; d.batch.input_revision = d.revision; d.batch.message = '已保存章节保留，可手动继续未完成步骤。'; }, undefined, false);
      } catch (error) {
        await updateProject(ref, d => { d.batch.status = controller.signal.aborted ? 'stopped' : 'failed'; d.batch.stage = 'interrupted'; d.batch.input_revision = d.revision; d.batch.error = error instanceof Error ? error.message : '连续生成中断'; }, undefined, false).catch(() => undefined);
      } finally { batchControllers.delete(ref); changed(ref); }
    }).catch(reject);
  });
}

export async function localGenerationStatus() {
  const projects = await Promise.all((await listProjects()).map(p => recoverInterrupted(p.project_ref)));
  const runs = projects.flatMap(p => p.runs.map(r => ({ ...r, project_ref: p.project_ref })));
  const current = runs.find(r => r.status === 'running');
  const last = [...runs].sort((a,b) => b.started_at.localeCompare(a.started_at))[0];
  return { running: Boolean(current), task_type: current?.operation || '', project_ref: current?.project_ref || '', target: String(current?.chapter_number || ''),
    started_at: current?.started_at || '', finished_at: '', last_result: null, last_error: last?.error || '' };
}

/** Repair missing/revoked profile references without changing a frozen execution target. */
export async function rebindFrozenConnection(ref:string, targetId:string) {
  return projectLock(ref, async()=>{
    const p=await recoverLocked(ref);
    const snapshots=[...p.runs.filter(r=>r.status!=='running').map(r=>r.connection),p.batch.connection,...Object.values(p.chapters).flatMap(c=>[c.connection,c.summary_connection])].filter((s):s is ConnectionSnapshot=>Boolean(s));
    const replacements=new Map<string,ConnectionSnapshot>();
    for(const old of snapshots){
      try{const target=await resolveConnection(targetId,old.model);if(target.execution_fingerprint===old.execution_fingerprint)replacements.set(old.execution_fingerprint,target);}catch{/* Other frozen models may require a separate matching connection. */}
    }
    if(!replacements.size)throw new Error('新连接的目的地、模型或能力策略不匹配，不能用于恢复原任务。');
    await updateProject(ref,d=>{
      for(const run of d.runs)if(run.connection&&replacements.has(run.connection.execution_fingerprint)){run.connection=replacements.get(run.connection.execution_fingerprint);run.connection_guard=undefined;}
      if(d.batch.connection&&replacements.has(d.batch.connection.execution_fingerprint)){d.batch.connection=replacements.get(d.batch.connection.execution_fingerprint);d.batch.connection_guard=undefined;}
      for(const c of Object.values(d.chapters)){if(c.connection&&replacements.has(c.connection.execution_fingerprint))c.connection=replacements.get(c.connection.execution_fingerprint);if(c.summary_connection&&replacements.has(c.summary_connection.execution_fingerprint))c.summary_connection=replacements.get(c.summary_connection.execution_fingerprint);}
    },p.revision,false);
    changed(ref);
  });
}

/** A deliberate new run after repairing capabilities or choosing another provider. Never a silent retry. */
export async function newSummaryWithConnection(ref:string, number:number, targetId:string) {
  return projectLock(ref,async()=>{
    let p=await recoverLocked(ref);const c=p.chapters[number];
    if(!c||c.workflow.status!=='confirmed')throw new Error('请先确认正文，随后选择连接新建摘要检查。');
    const connection=await resolveConnection(targetId);
    const input={...contextInput(p,number),frozen_context:c.frozen_context||{},review_scope:c.workflow.review_scope||'rules_only'};
    const lease=await acquireConnection(connection);
    try{prepareCompute('summarize_chapter',input,newIdentity(p.revision),lease);}finally{lease.close();}
    p=await updateProject(ref,d=>{
      d.chapters[number].summary_connection=connection;
      Object.assign(d.chapters[number].workflow,{summary_status:'pending',review_status:'pending',error:''});
      for(const r of d.runs)if(r.operation==='summarize_chapter'&&r.chapter_number===number&&['interrupted','failed'].includes(r.status))r.status='discarded';
    },p.revision);
    changed(ref);
    try{return await runLocked(p,'summarize_chapter',input,{connection});}
    catch(error){await updateProject(ref,d=>{if(d.chapters[number].workflow.summary_status==='pending')Object.assign(d.chapters[number].workflow,{summary_status:'failed',review_status:'failed',error:error instanceof Error?error.message:'摘要未完成。'});},undefined,false).catch(()=>undefined);throw error;}
  });
}
