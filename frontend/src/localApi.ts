import { connectionConfigured, defaultConnectionId, getConnection } from './providerConnections';
import { compute, newIdentity } from './computeClient';
import { deleteProject, getProject, getSetting, listProjects, putProject, setSetting, updateProject } from './localStore';
import { getSessionKey, setSessionKey } from './keyVault';
import { emptyProject } from './localTypes';
import type { LocalProject } from './localTypes';
import { settingGenerationRequest } from './settingGeneration';
import { changed, projectLock, stopLocalBatch, confirmLocalChapter, contextInput, ensureEditable, generateLocalChapter, localGenerationStatus, recoverInterrupted, runOperation, setChapter, startLocalBatch } from './localWorkflow';
import type { BatchGenerationRequest, ChapterStatus, GenerationReadiness, GenerationRequest, NarrativeGraphDocument, NarrativeGraphViewsDocument, ChapterTaskResponse, ScenePlanResponse } from './types';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const success = (p: LocalProject) => ({ ok: true, project_ref: p.project_ref, message: '已保存在本浏览器。' });
const planResponse = (p: LocalProject, n: number) => p.chapter_tasks[n] || { ...success(p), chapter_number: n, task: null, approved: null, latest_draft: null, history: [] };
const sceneResponse = (p: LocalProject, n: number) => p.scene_plans[n] || { ...success(p), chapter_number: n, plan: null, approved: null, latest_draft: null, history: [], current_approved_chapter_task: p.chapter_tasks[n]?.approved || null };

export async function readiness(p: LocalProject, n: number): Promise<GenerationReadiness> {
  const blockers: GenerationReadiness['blockers'] = [];
  const fields = ['title', 'protagonist', 'supporting_characters', 'worldview', 'core_conflict', 'genre', 'style', 'word_count_range'];
  if (fields.some(k => !String(p.config[k] || '').trim())) blockers.push({ code: 'project_settings_missing', message: '请补全小说设定。', action: 'project_settings' });
  if (!await connectionConfigured(String(p.config.connection_id || 'legacy-deepseek')).catch(() => false)) blockers.push({ code: 'model_key_missing', message: '请填写或解锁 API Key。', action: 'model_settings' });
  const can_generate_assets = blockers.length === 0;
  if (!p.assets.outline || !p.assets.characters) blockers.push({ code: 'assets_missing', message: '请先生成大纲与人物卡。', action: 'generate_assets' });
  for (const c of Object.values(p.chapters)) if (c.chapter_number < n && (c.workflow.status !== 'confirmed' || c.workflow.summary_status !== 'ready')) {
    blockers.push({ code: 'previous_chapter_not_ready', message: `第 ${c.chapter_number} 章需要确认正文并完成摘要。`, chapter_number: c.chapter_number, action: c.workflow.status !== 'confirmed' ? 'confirm_chapter' : 'retry_summary' });
  }
  if (p.chapters[n]?.source_locked || p.chapters[n]?.workflow.locked_by_chapter) blockers.push({ code: 'chapter_locked', message: p.chapters[n].workflow.lock_reason, action: 'read_chapter', chapter_number: n });
  return { project_ref: p.project_ref, chapter_number: n, ready: blockers.length === 0, can_generate_assets, blockers };
}

function chapterStatus(p: LocalProject, n: number): ChapterStatus {
  const drafts = p.knowledge_drafts.filter(d => d.chapter_number === n);
  const changes = drafts.flatMap(d => d.candidate_changes);
  const count = (status: string) => changes.filter(c => c.status === status).length;
  const reviews = p.reviews[n] || [];
  const last = reviews[reviews.length - 1];
  const runs = p.ai_runs.filter(r => r.chapter_number === n);
  const runIds = (op: string) => runs.filter(r => r.operation === op).map(r => String(r.id));
  return { chapter_number: n, chapter: { exists: Boolean(p.chapters[n]), ref: p.chapters[n]?.filename || null },
    story_delta: { status: drafts.length ? 'analyzed' : 'not_analyzed', delta_ids: p.story_deltas.filter(d => d.chapter_number === n).map(d => String(d.id)), event_ids: [], ai_run_ids: runIds('story_delta') },
    knowledge_drafts: { status: drafts.some(d => d.status === 'pending_review') ? 'pending_review' : drafts.length ? 'reviewed' : 'none', draft_ids: drafts.map(d => d.id),
      counts: { total: changes.length, pending_review: count('pending_review'), accepted: count('accepted'), rejected: count('rejected'), failed: count('failed'), superseded: count('superseded'), unsupported: count('unsupported') } },
    review: { status: count('pending_review') ? 'pending_review' : 'ready', pending_count: count('pending_review'), accepted_count: count('accepted'), rejected_count: count('rejected'), failed_count: count('failed') },
    ai_runs: { chapter_generation: runIds('generate_chapter'), story_delta_analysis: runIds('story_delta') },
    events: { chapter_generated: [], story_delta_analyzed: [], knowledge_draft_change_accepted: [], knowledge_draft_change_rejected: [] },
    context_pack: { status: 'ready', message: '使用本浏览器已审核的故事记忆。' },
    latest_function_review: last ? { id: last.id || '', type: last.type, verdict: last.verdict, score: last.score, categories: last.categories, created_at: last.created_at || '', ai_run_id: last.ai_run_id || '' } : null,
    warnings: p.chapters[n]?.workflow.warnings || [], next_actions: count('pending_review') ? ['review_knowledge_drafts'] : [] };
}

export async function localRequest(path: string, init: RequestInit = {}): Promise<unknown> {
  init.signal?.throwIfAborted();
  const url = new URL(path, 'https://braipen.world');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const method = init.method || 'GET';
  const body = typeof init.body === 'string' ? record(JSON.parse(init.body)) : {};
  if (parts[1] === 'settings') {
    if (parts[3] === 'test') {
      return (await compute('connection_test', { request: { model: body.model || await getSetting('default_model') || 'deepseek-v4-flash' } }, newIdentity(), init.signal || undefined, String(body.api_key || getSessionKey()))).result;
    }
    if (method === 'POST') {
      const key = String(body.api_key || '').trim();
      if (key && !/^sk-[A-Za-z0-9_-]{16,256}$/.test(key)) throw new Error('API Key 格式无效。');
      if (!key && !getSessionKey()) throw new Error('请填写或解锁本次会话的 API Key。');
      const model = String(body.custom_model || body.default_model || 'deepseek-v4-flash').trim();
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(model)) throw new Error('模型名称无效。');
      await setSetting('default_model', model);
      if (key) setSessionKey(key);
      window.dispatchEvent(new Event('braipen:key-changed'));
      return { ok: true, default_model: model, message: '模型偏好已保存在本浏览器，Key 仅用于本次会话。' };
    }
    return { ok: true, configured: Boolean(getSessionKey()), source: 'browser_session', placeholder: false,
      env_exists: false, env_path: '', default_model: await getSetting('default_model') || 'deepseek-v4-flash', base_url: 'https://api.deepseek.com', message: '密钥由本浏览器管理。' };
  }
  if (parts[1] === 'generation') return localGenerationStatus();
  if (parts[1] !== 'projects') throw new Error('未知的本地操作。');
  if (parts.length === 2) {
    if (method === 'GET') return (await listProjects()).map(p => ({ project_ref: p.project_ref, title: p.title, storage_type: 'browser', updated_at: p.updated_at, description: String(p.config.seed_prompt || '') }));
    const title = String(body.title || '').trim(); const seed = String(body.seed_prompt || '').trim();
    if (!title || title.length > 80 || !seed || seed.length > 4000) throw new Error('标题应为 1–80 字，故事起点应为 1–4000 字。');
    const id = typeof body.connection_id === 'string' ? body.connection_id : await defaultConnectionId();
    const profile = await getConnection(id);
    const model = body.model || profile.revisions.find(r=>r.revision===profile.head)?.model;
    const p = emptyProject(title, { ...body, seed_prompt: seed, raw_story_idea: seed, connection_id: id, model,
      genre: body.genre || '未指定', style: body.style || '未指定', created_at: new Date().toISOString() });
    await putProject(p); return { ...success(p), title };
  }
  const ref = parts[2];
  let p = await getProject(ref);
  const kind = parts[3];
  if (parts.length === 3) {
    if (method === 'DELETE') { await projectLock(ref, () => deleteProject(ref)); changed(ref); return success(p); }
    return { project_ref: ref, title: p.title, config: p.config };
  }
  if (kind === 'generation-settings' || kind === 'config' || kind === 'assets') {
    if (method !== 'GET') {
      if (kind === 'generation-settings') {
        if (typeof body.model !== 'string' || !body.model.trim() || !Number.isInteger(body.max_tokens) || Number(body.max_tokens) < 512 || Number(body.max_tokens) > 32768 || !Number.isFinite(body.temperature) || Number(body.temperature) < 0 || Number(body.temperature) > 2) throw new Error('生成参数无效。');
      }
      p = await projectLock(ref, () => updateProject(ref, d => {
        if (kind === 'assets') {
          const asset = parts[4];
          if (!['outline', 'characters', 'setting_expansion'].includes(asset)) throw new Error('未知设定资产。');
          d.assets[asset as keyof typeof d.assets] = String(body.content || '');
        } else { d.config = { ...d.config, ...body }; if (body.title) d.title = String(body.title); }
      }, p.revision)); changed(ref);
    }
    if (kind === 'assets') return { ...success(p), content: p.assets[parts[4] as keyof typeof p.assets] || '' };
    return { ...success(p), config: p.config };
  }
  if (kind === 'setting-expansion') {
    const request = settingGenerationRequest({ ...body, raw_story_idea: body.raw_story_idea ?? p.config.raw_story_idea ?? p.config.seed_prompt ?? '' });
    return { ...success(p), ...await runOperation(p, 'expand_setting', contextInput(p, 1, request), { signal: init.signal || undefined }) };
  }
  if (kind === 'context-pack') return { ...success(p), ...(await compute('context_pack', contextInput(p, Number(body.chapter_number || 1), body))).result };
  if (kind === 'narrative-graph') {
    if (method === 'GET') return { ...success(p), graph: p.graph, views: p.views };
    const entity = parts[4]; const id = parts[5];
    const action = entity === 'import-assets' ? 'import_assets' : `${method === 'DELETE' ? 'delete' : method === 'PATCH' ? 'update' : 'create'}_${entity === 'nodes' ? 'node' : entity === 'edges' ? 'edge' : 'tag'}`;
    const input = { ...contextInput(p), action, node_id: entity === 'nodes' ? id : undefined, edge_id: entity === 'edges' ? id : undefined,
      tag_name: entity === 'tags' ? id : undefined, request: { ...body, delete_edges: url.searchParams.get('delete_edges') === 'true' } };
    return { ...success(p), ...await runOperation(p, 'graph_change', input) };
  }
  if (kind === 'chapter-tasks' || kind === 'scene-plans') {
    const n = Number(parts[4]); const task = kind === 'chapter-tasks';
    const document = task ? planResponse(p,n) : sceneResponse(p,n);
    if (method === 'GET') return document;
    const result = await runOperation(p, task ? 'chapter_task' : 'scene_plan', {
      ...contextInput(p,n), document, action: parts[5] === 'approve' ? 'approve' : 'save', payload: body, request: body,
    });
    return { ...success(p), chapter_number: n, ...result };
  }
  if (kind === 'knowledge-drafts') {
    if (parts.length === 4) return { ...success(p), drafts: p.knowledge_drafts };
    const draft = p.knowledge_drafts.find(d => d.id === parts[4]);
    if (!draft) throw new Error('审核草稿不存在。');
    if (method === 'GET') return { ...success(p), draft };
    return { ...success(p), ...await runOperation(p, 'review_change', { ...contextInput(p,draft.chapter_number), draft, change_id: parts[6], action: parts[7], request: body }) };
  }
  if (kind === 'story-deltas') return { ...success(p), items: p.story_deltas };
  if (kind === 'events') return { ...success(p), events: p.events };
  if (kind === 'snapshots') return { ...success(p), snapshots: p.snapshots };
  if (kind === 'ai-runs') return { ...success(p), runs: p.ai_runs, run: p.ai_runs.find(r => r.id === parts[4]) };
  if (kind === 'workflow-guard') {
    const check = await readiness(p, Number(body.chapter_number || 1));
    return { ...success(p), chapter_number: check.chapter_number, action: 'generate_chapter', blocking: check.blockers.length > 0,
      warnings: check.blockers.map(b => ({ ...b, severity: 'warning' })), suggested_actions: check.blockers.map(b => b.action) };
  }
  if (kind === 'generation' && parts[4] === 'batch') {
    if (parts[5] === 'stop') {
      return stopLocalBatch(ref, Boolean(body.immediate));
    }
    if (method === 'POST') return startLocalBatch(ref, body as unknown as BatchGenerationRequest, parts[5] === 'resume');
    return (await recoverInterrupted(ref)).batch;
  }
  if (kind === 'outline-characters') {
    if (!(await readiness(p,1)).can_generate_assets) throw new Error('请先补全设定并解锁 Key。');
    if (!p.assets.outline) await runOperation(p, 'generate_outline', contextInput(p,1,body), { signal: init.signal || undefined });
    p = await getProject(ref);
    if (!p.assets.characters) await runOperation(p, 'generate_characters', contextInput(p,1,body), { signal: init.signal || undefined });
    return { ...success(p), outline_file: 'novel_outline.md', characters_file: 'characters.md' };
  }
  if (kind === 'chapters') {
    if (parts.length === 4) return Object.values(p.chapters).sort((a,b) => a.chapter_number-b.chapter_number)
      .map(c => ({ chapter_number: c.chapter_number, title: c.title, filename: c.filename, is_version: false, version: c.versions.length+1, display_label: c.title }));
    const n = Number(parts[4]); const action = parts[5]; const c = p.chapters[n];
    if (action === 'generation-readiness') return readiness(p,n);
    if (action === 'generate') return generateLocalChapter(ref,n,body as unknown as GenerationRequest,{},init.signal || undefined);
    if (action === 'status') return { ...success(p), chapter_status: chapterStatus(p,n) };
    if (action === 'function-review') return { ...success(p), chapter_number: n, latest: (p.reviews[n] || []).slice(-1)[0] || null, history: p.reviews[n] || [] };
    if (!c) throw new Error('章节不存在。');
    if (!action) return { chapter_number: n, title: c.title, filename: c.filename, content: c.content };
    if (action === 'workflow') return (await recoverInterrupted(ref)).chapters[n].workflow;
    if (action === 'confirm') return confirmLocalChapter(ref,n,String(body.content || ''),String(body.expected_revision || ''));
    if (action === 'continue' && parts[6] === 'save') {
      p = await projectLock(ref, () => updateProject(ref, d => {
        const run = d.runs.find(r => r.run_id === body.run_id && r.operation === 'continue_chapter' && r.chapter_number === n);
        if (!run?.result || run.status === 'discarded') throw new Error('续写任务已保存或不存在，请刷新正文。');
        if (run.status !== 'completed' || run.result_revision !== d.revision) throw new Error('正文或上下文已变化，旧续写不能覆盖新版。');
        const content = String(body.content || '').trim(); if (!content || content !== String(run.result.content || '').trim()) throw new Error('续写结果与任务不匹配。');
        ensureEditable(d.chapters[n]);
        if (!['append', 'replace'].includes(String(body.mode))) throw new Error('保存模式无效。');
        setChapter(d, n, body.mode === 'replace' ? content : `${d.chapters[n].content}\n\n${content}`, String(body.chapter_title || d.chapters[n].title));
        d.chapters[n].workflow.review_scope = 'semantic_and_rules'; run.status = 'discarded';
      }, p.revision)); changed(ref); return { ...success(p), chapter_number: n, chapter_file: p.chapters[n].filename };
    }
    if (action === 'story-delta') return { ...success(p), chapter_number: n, ...await runOperation(p,'story_delta',contextInput(p,n,body)) };
  }
  throw new Error(`尚未识别的本地操作：${kind || 'project'}`);
}

export async function downloadLocalBook(ref: string, chapterNumber?: number) {
  const p = await getProject(ref);
  const chapters = Object.values(p.chapters).filter(c => !chapterNumber || c.chapter_number === chapterNumber).sort((a,b) => a.chapter_number-b.chapter_number);
  const url = URL.createObjectURL(new Blob([chapters.map(c => `${c.title}\n\n${c.content}`).join('\n\n')], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = `${p.title}${chapterNumber ? `-第${chapterNumber}章` : ''}.txt`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function localContinue(ref: string, number: number, request: Record<string, unknown>, handlers: { onDelta?: (text: string) => void; onReasoning?: (text: string) => void }, signal?: AbortSignal) {
  const p = await getProject(ref); if (!p.chapters[number]) throw new Error('章节不存在。'); ensureEditable(p.chapters[number]);
  return runOperation(p, 'continue_chapter', { ...contextInput(p,number,request), ...request }, { stream: true, handlers, signal });
}
