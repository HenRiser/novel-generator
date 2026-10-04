import { compute } from './computeClient';
import { assertConnectionGuard, getProject, updateProject } from './localStore';
import type { LocalProject, LocalRun } from './localTypes';
import { changed, projectLock, runOperation } from './localWorkflow';
import { acquireConnection, hash, resolveConnection, stable } from './providerConnections';
import { buildPlanningInput, TASK_FIELDS, validatePlanningResult, type PlanningRequest } from './planningInput';
import type { ChapterTaskResponse, ScenePlanResponse } from './types';

export function getPlanningRun(p: LocalProject, number: number): LocalRun | undefined {
  return [...p.runs].reverse().find(r => r.operation === 'plan_chapter' && r.chapter_number === number && r.status !== 'discarded');
}

export async function generateChapterPlanning(ref: string, number: number, request: PlanningRequest, signal?: AbortSignal) {
  const p = await getProject(ref);
  return runOperation(p, 'plan_chapter', buildPlanningInput(p, number, request), { signal });
}

/** Explicitly renew permission after backup restore/rebinding, without rerunning a model. */
export async function authorizePlanningRun(ref: string, id: string, targetId?: string, signal?: AbortSignal) {
  return projectLock(ref, async () => {
    signal?.throwIfAborted();
    const p = await getProject(ref), run = p.runs.find(r => r.run_id === id && r.operation === 'plan_chapter');
    if (!run || run.status !== 'completed' || !run.result || !run.connection) throw new Error('请先恢复已有策划结果。');
    validatePlanningResult(run.result, run.chapter_number!);
    // A project may override the connection's default model. Keep the actual frozen execution.
    const target = await resolveConnection(targetId || run.connection.profile_id, run.connection.model);
    if (target.execution_fingerprint !== run.connection.execution_fingerprint) throw new Error('连接的目的地、模型或能力策略不一致，不能授权该提案。');
    const lease = await acquireConnection(target, signal);
    try {
      await lease.check();
      signal?.throwIfAborted();
      await updateProject(ref, d => {
        const current = d.runs.find(r => r.run_id === id)!;
        current.connection = target; current.connection_guard = lease.guard;
      }, p.revision, false, lease.guard); // Permission metadata must not launder a stale result_revision.
    } finally { lease.close(); }
    changed(ref);
  });
}

function requireRun(p: LocalProject, id: string): LocalRun {
  const run = p.runs.find(r => r.run_id === id && r.operation === 'plan_chapter');
  if (!run || run.status !== 'completed' || !run.result || !run.connection_guard) throw new Error('策划尚未完成或缺少有效连接记录，请先恢复任务。');
  validatePlanningResult(run.result, run.chapter_number!);
  if (run.result.status !== 'draft_ready') throw new Error('提案仍有规则问题，请人工调整或重新策划。');
  return run;
}

async function sourceFingerprint(input: Record<string, unknown>) {
  return hash(JSON.stringify(stable({ prefix: input.prefix, setting: input.setting, graph: input.graph })));
}

async function checkSources(p: LocalProject, run: LocalRun) {
  const fixed = run.input.constraints as Omit<PlanningRequest, 'author_intent'>;
  const current = buildPlanningInput(p, run.chapter_number!, { ...fixed, author_intent: String(run.input.author_intent || '') });
  const original = await sourceFingerprint(run.input);
  if (original !== await sourceFingerprint(current) || (run.planning_application && run.planning_application.source_fingerprint !== original)) throw new Error('前文、设定或已审核知识已改变，请重新策划。');
  return original;
}

export async function savePlanningTask(ref: string, id: string, signal?: AbortSignal): Promise<ChapterTaskResponse> {
  return projectLock(ref, async () => {
    signal?.throwIfAborted();
    const p = await getProject(ref), run = requireRun(p, id), n = run.chapter_number!;
    if (run.planning_application) throw new Error('该提案的任务草稿已保存，不能重复采纳。');
    if (p.revision !== run.result_revision) throw new Error('作品已更新，旧策划结果不能覆盖当前版本，请重新策划。');
    if (p.chapter_tasks[n]?.latest_draft) throw new Error('当前章节已有任务草稿，请先在任务单中处理，避免覆盖。');
    await assertConnectionGuard(run.connection_guard!);
    const fingerprint = await checkSources(p, run);
    const checked = (await compute('validate_planning_candidate', { candidate: { task_payload: run.result!.task_payload, scene_proposal: run.result!.scene_proposal }, constraints: run.input.constraints }, undefined, signal)).result;
    if (!Array.isArray(checked.issues) || checked.issues.length) throw new Error('提案未通过规则检查，请重新策划或人工编辑。');
    const response = (await compute('chapter_task', { project_ref: ref, chapter_number: n, document: p.chapter_tasks[n] || { history: [] }, action: 'save', payload: checked.task_payload }, undefined, signal)).result as unknown as ChapterTaskResponse;
    if (!response.ok || !response.latest_draft || response.latest_draft.status !== 'draft') throw new Error('任务草稿保存结果无效。');
    signal?.throwIfAborted();
    await updateProject(ref, d => {
      d.chapter_tasks[n] = response;
      d.runs.find(r => r.run_id === id)!.planning_application = { source_fingerprint: fingerprint, task_id: response.latest_draft!.id, task_revision: response.latest_draft!.revision };
    }, p.revision, true, run.connection_guard);
    changed(ref); return response;
  });
}

export async function savePlanningScenes(ref: string, id: string, signal?: AbortSignal): Promise<ScenePlanResponse> {
  return projectLock(ref, async () => {
    signal?.throwIfAborted();
    const p = await getProject(ref), run = requireRun(p, id), n = run.chapter_number!;
    const application = run.planning_application, task = p.chapter_tasks[n]?.approved;
    if (!application || !task || task.status !== 'approved' || task.id !== application.task_id || task.revision < application.task_revision) throw new Error('请先审核并批准该提案对应的任务单。');
    if (application.scene_plan_id) throw new Error('该提案的场景草稿已保存，不能重复采纳。');
    if (p.scene_plans[n]?.latest_draft) throw new Error('当前章节已有场景草稿，请先处理，避免覆盖。');
    await assertConnectionGuard(run.connection_guard!);
    await checkSources(p, run);
    const checked = (await compute('validate_planning_candidate', {
      candidate: { task_payload: Object.fromEntries(TASK_FIELDS.map(k => [k, task[k]])), scene_proposal: run.result!.scene_proposal }, constraints: run.input.constraints,
    }, undefined, signal)).result;
    if (!Array.isArray(checked.issues) || checked.issues.length) throw new Error('当前批准任务与场景提案不一致，请调整场景或重新策划。');
    const response = (await compute('scene_plan', {
      project_ref: ref, chapter_number: n, document: p.scene_plans[n] || { history: [] }, chapter_task: task,
      chapter_task_document: p.chapter_tasks[n], action: 'save',
      payload: { ...(checked.scene_proposal as Record<string, unknown>), source_chapter_task_id: task.id, source_chapter_task_revision: task.revision },
    }, undefined, signal)).result as unknown as ScenePlanResponse;
    if (!response.ok || !response.latest_draft || response.latest_draft.status !== 'draft' || response.latest_draft.source_chapter_task_id !== task.id || response.latest_draft.source_chapter_task_revision !== task.revision) throw new Error('场景草稿或任务绑定版本无效。');
    signal?.throwIfAborted();
    await updateProject(ref, d => {
      d.scene_plans[n] = response;
      Object.assign(d.runs.find(r => r.run_id === id)!.planning_application!, { task_revision: task.revision, scene_plan_id: response.latest_draft!.id, scene_plan_revision: response.latest_draft!.revision });
    }, p.revision, true, run.connection_guard);
    changed(ref); return response;
  });
}
