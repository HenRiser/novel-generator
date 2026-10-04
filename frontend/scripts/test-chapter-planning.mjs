// Real Edge/IndexedDB/Web Locks with offline planning responses and real pure Python contracts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { providerFixtures, identity } from './provider-test-helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]+$/, '');
const workspace = resolve(root, '..');
const report = process.env.BRAIPEN_REPORT_DIR ? resolve(process.env.BRAIPEN_REPORT_DIR) : resolve(workspace, 'reports/langgraph-implementation-2026-10-01');
const runtime = process.env.BRAIPEN_PLAYWRIGHT_PATH || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const { chromium } = await import(pathToFileURL(join(runtime, 'index.mjs')).href);
const python = process.env.BRAIPEN_TEST_PYTHON || resolve(workspace, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const fixtures = providerFixtures(root);
const KEY = 'OFFLINE_PLANNING_TEST_KEY';
const runPython = (code, input) => {
  const result = spawnSync(python, ['-c', code], { cwd: workspace, input: JSON.stringify(input), encoding: 'utf8', timeout: 15000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  if (result.status !== 0) throw new Error(result.error?.message || result.stderr);
  return JSON.parse(result.stdout);
};
const candidate = runPython('import json; from tests.test_chapter_planning_contract import candidate; print(json.dumps(candidate()))');
const request = { author_intent: '让林默和周岚恢复有限信任', canon_budget: 'none', required_characters: ['林默', '周岚'], forbidden_advances: ['揭示组织秘密'] };
const planningResult = (number, changes = {}) => ({ graph_version: 'chapter-planning-v1', chapter_number: number, status: 'draft_ready', ...structuredClone(candidate), issues: [], repair_count: 0, nodes: ['context_pack', 'initial_proposal', 'validate'], excluded_records: 0, warnings: ['离线模拟策划，最终判断由作者完成。'], ...changes });
const pureOperations = new Set(['validate_planning_candidate', 'chapter_task', 'scene_plan']);
function pureCompute(operation, input) {
  assert.ok(pureOperations.has(operation), `Unexpected Python operation: ${operation}`);
  return runPython(`import asyncio,json,sys
from services.compute_service import compute,ComputeError
p=json.load(sys.stdin)
assert p['operation'] in {'validate_planning_candidate','chapter_task','scene_plan'}
try:
 result=asyncio.run(compute(p['operation'],p['input'],{},{}))
 print(json.dumps({'status':200,'result':result}))
except ComputeError as exc:
 print(json.dumps({'status':exc.status,'error':{'code':exc.code,'message':exc.message}}))`, { operation, input });
}

const server = await createServer({ root, define: { 'import.meta.env.VITE_API_BASE_URL': '""' }, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error', plugins: [{ name: 'planning-test-page', configureServer(s) {
  s.middlewares.use('/__planning_test', (_, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><meta charset="utf-8"><title>Chapter planning core tests</title>'); });
} }] });
await server.listen();
const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
let browser;
const results = [];
const bounded = (promise, label) => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(label)), 10000); timer.unref(); })]);

async function test(name, body) {
  if (process.env.BRAIPEN_TEST_FILTER && !name.includes(process.env.BRAIPEN_TEST_FILTER)) return;
  const context = await browser.newContext();
  const calls = [], violations = [], routeErrors = [], pageErrors = [];
  let handler;
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) { violations.push(url.origin); return route.abort('blockedbyclient'); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    try {
      if (url.pathname === '/api/health') return route.fulfill({ json: { status: 'ok' } });
      if (url.pathname === '/api/capabilities') return route.fulfill({ json: fixtures.catalog });
      if (req.method() !== 'POST') throw new Error(`Unexpected API method: ${req.method()} ${url.pathname}`);
      const payload = req.postDataJSON(), operation = url.pathname.split('/compute/')[1]?.split('/')[0];
      if (operation === 'validate_connection') return route.fulfill({ json: { ...identity(payload), result: { connection: fixtures.normalize(payload.connection) } } });
      if (!['plan_chapter', 'generate_chapter', ...pureOperations].includes(operation)) throw new Error(`Unexpected API operation: ${operation}`);
      if (payload.connection) assert.equal(payload.request_fingerprint, fixtures.requestFingerprint(payload, operation));
      if (operation === 'plan_chapter' || operation === 'generate_chapter') assert.equal(payload.credentials.api_key, KEY);
      else assert.deepEqual(payload.credentials, {});
      calls.push({ operation, input: payload.input, payload });
      if (handler && await handler(route, payload, operation)) return;
      if (pureOperations.has(operation)) {
        const response = pureCompute(operation, payload.input);
        return route.fulfill({ status: response.status, json: { ...identity(payload), ...(response.error ? { error: response.error } : { result: response.result, metrics: {} }) } });
      }
      if (operation === 'generate_chapter') {
        const content = '第2章\n离线模拟正文，保留已批准任务与场景。';
        return route.fulfill({ contentType: 'application/x-ndjson', body: [
          { ...identity(payload), type: 'started', frozen_context: { chapter_task: payload.input.chapter_task, scene_plan: payload.input.scene_plan } },
          { ...identity(payload), type: 'delta', text: content },
          { ...identity(payload), type: 'done', result: { content, title: '离线模拟正文', frozen_context: {} }, metrics: { call_count: 1 } },
        ].map(value => JSON.stringify(value)).join('\n') + '\n' });
      }
      return route.fulfill({ json: { ...identity(payload), result: planningResult(payload.input.chapter_number), metrics: { call_count: 1 } } });
    } catch (error) {
      routeErrors.push(error.message);
      await route.fulfill({ status: 500, json: { error: { message: 'Offline fixture rejected an unexpected request.' } } }).catch(() => undefined);
    }
  });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.goto(origin + '/__planning_test');
  async function load(target = page) {
    await target.evaluate(async ({ key, candidate }) => {
      window.store = await import('/src/localStore.ts');
      window.wf = await import('/src/localWorkflow.ts');
      window.pc = await import('/src/providerConnections.ts');
      window.vault = await import('/src/keyVault.ts');
      window.types = await import('/src/localTypes.ts');
      window.planning = await import('/src/chapterPlanning.ts');
      window.inputs = await import('/src/planningInput.ts');
      window.api = await import('/src/api.ts');
      window.client = await import('/src/computeClient.ts');
      window.fixed = { author_intent: '让林默和周岚恢复有限信任', canon_budget: 'none', required_characters: ['林默', '周岚'], forbidden_advances: ['揭示组织秘密'] };
      window.candidateForTest = candidate;
      for (const profile of await pc.connections()) if (profile.id !== 'legacy-deepseek' && profile.enabled && !profile.deleted) vault.loadProfileKey(profile, profile.revisions.find(r => r.revision === profile.head), key);
      window.waitUntil = async predicate => { for (let i = 0; i < 400; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('Browser condition timed out'); };
      window.makeProject = async (prefix = true) => {
        const raw = { profile_id: crypto.randomUUID(), revision: 1, preset: 'custom', protocol: 'chat_completions', base_url: 'https://offline-model.example/v1', model: 'planning-fixture', policy: { ...pc.defaultPolicy(), structured: 'prompt_only' }, auth_mode: 'key', destination_fingerprint: '', execution_fingerprint: '' };
        const profile = await pc.saveConnection('离线策划测试', raw);
        await pc.storeConnectionKey(profile.id, key);
        const p = types.emptyProject('策划测试', { connection_id: profile.id, model: raw.model, ...Object.fromEntries(['protagonist', 'supporting_characters', 'worldview', 'core_conflict', 'genre', 'style'].map(field => [field, '作者全局设定'])) });
        p.assets = { outline: 'FULL_OUTLINE_SENTINEL', characters: 'FULL_CHARACTERS_SENTINEL', setting_expansion: 'EXPANSION_SENTINEL' };
        if (prefix) {
          wf.setChapter(p, 1, 'CONFIRMED_PREFIX_BODY');
          Object.assign(p.chapters[1].workflow, { status: 'confirmed', summary_status: 'ready', review_status: 'ready', summary: 'CONFIRMED_PREFIX_SUMMARY' });
        }
        await store.putProject(p);
        return p.project_ref;
      };
      window.generate = async ref => planning.generateChapterPlanning(ref, 2, fixed);
      window.approveTask = async ref => {
        const draft = (await store.getProject(ref)).chapter_tasks[2].latest_draft;
        return api.approveChapterTask(ref, 2, draft.id, draft.revision);
      };
      window.reject = async operation => { try { await operation(); } catch (error) { return error.message; } throw new Error('Unsafe operation unexpectedly succeeded'); };
    }, { key: KEY, candidate });
  }
  await load();
  try {
    await body({ page, context, load, calls, origin, setHandler: value => { handler = value; } });
    assert.deepEqual(violations, [], 'External network was attempted');
    assert.deepEqual(routeErrors, [], 'Fixture rejected a request');
    assert.deepEqual(pageErrors, [], 'Unexpected browser exception');
    results.push({ name, status: 'passed', planning_requests: calls.filter(c => c.operation === 'plan_chapter').length, pure_requests: calls.filter(c => pureOperations.has(c.operation)).length });
    console.log('PASS ' + name);
  } catch (error) {
    await mkdir(report, { recursive: true });
    await page.screenshot({ path: join(report, `failed-${results.length}.png`), fullPage: true }).catch(() => undefined);
    const bodyText = await page.locator('body').innerText().catch(() => '');
    results.push({ name, status: 'failed', error: error.message, url: page.url(), page_text: bodyText.slice(0, 8000), fixture_errors: routeErrors, browser_errors: pageErrors });
    console.error('FAIL ' + name + '\n' + error.stack);
    process.exitCode = 1;
  } finally { await context.close(); }
}

try {
  browser = await chromium.launch({ channel: process.env.BRAIPEN_BROWSER || 'msedge', headless: true });

  await test('来源投影与Python一致：拒未来/未审/计划/异常来源，剥离属性与档案', async ({ page }) => {
    const source = { kind: 'source_fact', chapter_number: 1, reviewed: true };
    const raw = { version: 1, metadata: { archive: 'METADATA_ARCHIVE_SENTINEL' }, tag_registry: { hidden: { description: 'TAG_ARCHIVE_SENTINEL' } }, graph: { nodes: [
      ...[['safe', source], ['global', { created_by: 'user' }], ['future', { ...source, chapter_number: 2 }], ['unreviewed', { ...source, reviewed: false }], ['malformed', { ...source, kind: ['source_fact'] }], ['planned', source], ['unicode-planned', source], ['control-planned', source], ['proposal', { created_by: 'knowledge_draft_review', chapter_number: 1, candidate_source: 'next_chapter_proposal' }]].map(([id, source]) => ({ id, type: 'character', label: id, summary: id, importance: 8, layer: 'detail', status: id === 'planned' ? ' Planned ' : id === 'unicode-planned' ? '\u0085planned\u0085' : id === 'control-planned' ? '\u001cplanned\u001f' : 'active', source, properties: { private_archive: { future_text: 'PROPERTY_ARCHIVE_SENTINEL' }, credentials: { api_key: 'PROPERTY_KEY_SENTINEL' } }, aliases: [], tags: [], notes: '' })),
    ], edges: [{ id: 'safe_edge', type: 'related_to', label: '关系', summary: '已审核关系', status: 'active', source: 'safe', target: 'global', source_info: source, properties: { archive: 'EDGE_ARCHIVE_SENTINEL' } }, { id: 'bad_edge', status: 'active', source: 'safe', target: 'future', source_info: source }] } };
    const projected = await page.evaluate(document => inputs.filterPlanningGraph(document, 1), raw);
    const expected = runPython('import json,sys; from services.chapter_planning_contract import filter_planning_graph; d=json.load(sys.stdin); graph,count=filter_planning_graph(d,1); print(json.dumps({"graph":graph,"excluded_records":count}))', raw);
    assert.deepEqual(projected, expected);
    for (const marker of ['METADATA_ARCHIVE_SENTINEL', 'TAG_ARCHIVE_SENTINEL', 'PROPERTY_ARCHIVE_SENTINEL', 'PROPERTY_KEY_SENTINEL', 'EDGE_ARCHIVE_SENTINEL']) assert.ok(!JSON.stringify(projected).includes(marker));
  });

  await test('实际策划请求只含已确认前缀与白名单，无全量资产/本地档案/未来信息', async ({ page, calls }) => {
    const ref = await page.evaluate(async () => {
      const ref = await makeProject();
      await store.updateProject(ref, p => {
        p.source = { archive: 'LOCAL_ARCHIVE_SENTINEL' };
        p.knowledge_drafts = [{ id: 'not-reviewed', chapter_number: 1, status: 'pending_review', candidate_changes: [], private_text: 'UNREVIEWED_DRAFT_SENTINEL' }];
        const node = (id, source, summary, properties = {}) => ({ id, type: 'character', label: id, summary, importance: 9, layer: 'detail', status: 'active', source, properties, aliases: [], tags: [], notes: '' });
        p.graph.metadata = { archive: 'GRAPH_ARCHIVE_SENTINEL' };
        p.graph.graph.nodes = [node('safe', { kind: 'source_fact', chapter_number: 1, reviewed: true }, 'SAFE_PREFIX_FACT', { archive: 'PROPERTY_ARCHIVE_SENTINEL' }), node('future', { kind: 'source_fact', chapter_number: 2, reviewed: true }, 'FUTURE_FACT_SENTINEL'), node('pending', { kind: 'source_fact', chapter_number: 1, reviewed: false }, 'UNREVIEWED_FACT_SENTINEL')];
      });
      await generate(ref); return ref;
    });
    const input = calls.find(c => c.operation === 'plan_chapter').input;
    assert.deepEqual(Object.keys(input).sort(), ['project_ref', 'chapter_number', 'prefix', 'author_intent', 'constraints', 'setting', 'graph', 'excluded_records'].sort());
    assert.ok(JSON.stringify(input).includes('SAFE_PREFIX_FACT'));
    assert.ok(JSON.stringify(input).includes('CONFIRMED_PREFIX_BODY'));
    for (const marker of ['FULL_OUTLINE_SENTINEL', 'FULL_CHARACTERS_SENTINEL', 'EXPANSION_SENTINEL', 'LOCAL_ARCHIVE_SENTINEL', 'UNREVIEWED_DRAFT_SENTINEL', 'GRAPH_ARCHIVE_SENTINEL', 'PROPERTY_ARCHIVE_SENTINEL', 'FUTURE_FACT_SENTINEL', 'UNREVIEWED_FACT_SENTINEL', KEY]) assert.ok(!JSON.stringify(input).includes(marker), marker);
    const p = await page.evaluate(ref => store.getProject(ref), ref);
    assert.equal(p.runs[0].status, 'completed'); assert.ok(!JSON.stringify(p).includes(KEY));
  });

  await test('未确认/摘要未就绪/断号/已有目标章全部零策划调用；空项目可策划首章', async ({ page, calls }) => {
    const outcomes = await page.evaluate(async () => {
      const outcomes = [];
      for (const kind of ['confirmation', 'summary', 'gap', 'existing']) {
        const ref = await makeProject();
        await store.updateProject(ref, p => {
          if (kind === 'confirmation') p.chapters[1].workflow.status = 'awaiting_confirmation';
          if (kind === 'summary') p.chapters[1].workflow.summary_status = 'pending';
          if (kind === 'gap') { wf.setChapter(p, 3, '断号正文'); }
          if (kind === 'existing') wf.setChapter(p, 2, 'FUTURE_BODY_SENTINEL');
        });
        outcomes.push(await reject(() => generate(ref)));
      }
      return outcomes;
    });
    assert.equal(outcomes.length, 4); assert.equal(calls.length, 0);
    await page.evaluate(async () => planning.generateChapterPlanning(await makeProject(false), 1, fixed));
    assert.equal(calls.filter(c => c.operation === 'plan_chapter').length, 1);
  });

  await test('候选重载仍可读取，零新增模型且不创建任务/场景/正文', async ({ page, load, calls }) => {
    const ref = await page.evaluate(async () => { const ref = await makeProject(); await generate(ref); return ref; });
    await page.reload(); await load();
    const snapshot = await page.evaluate(async ref => { const p = await store.getProject(ref); return { run: planning.getPlanningRun(p, 2), tasks: p.chapter_tasks, scenes: p.scene_plans, chapters: Object.keys(p.chapters) }; }, ref);
    assert.equal(snapshot.run.result.status, 'draft_ready'); assert.deepEqual(snapshot.tasks, {}); assert.deepEqual(snapshot.scenes, {}); assert.deepEqual(snapshot.chapters, ['1']);
    assert.equal(calls.filter(c => c.operation === 'plan_chapter').length, 1);
  });

  await test('多章前缀只上传最近正文，更早正文仅保留已确认摘要', async ({ page, calls }) => {
    await page.evaluate(async () => {
      const ref = await makeProject();
      await store.updateProject(ref, p => { wf.setChapter(p, 2, 'LATEST_PREFIX_BODY_SENTINEL'); Object.assign(p.chapters[2].workflow, { status: 'confirmed', summary_status: 'ready', review_status: 'ready', summary: '最新已确认摘要' }); });
      await planning.generateChapterPlanning(ref, 3, fixed);
    });
    const input = calls.find(c => c.operation === 'plan_chapter').input;
    assert.equal(input.prefix.length, 2); assert.equal(input.prefix[0].content, ''); assert.equal(input.prefix[1].content, 'LATEST_PREFIX_BODY_SENTINEL');
    assert.ok(!JSON.stringify(input).includes('CONFIRMED_PREFIX_BODY'));
    assert.ok(JSON.stringify(input).includes('CONFIRMED_PREFIX_SUMMARY'));
  });

  await test('needs_user_decision候选可查看，但不能采纳为正式任务或场景', async ({ page, calls, setHandler }) => {
    setHandler(async (route, payload, operation) => {
      if (operation !== 'plan_chapter') return false;
      await route.fulfill({ json: { ...identity(payload), result: planningResult(2, { status: 'needs_user_decision', repair_count: 1, task_payload: null, scene_proposal: null, issues: [{ code: 'invalid_json', path: 'candidate', message: '需要作者重新策划' }] }), metrics: { call_count: 2 } } });
      return true;
    });
    const snapshot = await page.evaluate(async () => {
      const ref = await makeProject(), result = await generate(ref);
      const errors = [await reject(() => planning.savePlanningTask(ref, result.run_id)), await reject(() => planning.savePlanningScenes(ref, result.run_id))];
      const p = await store.getProject(ref);
      return { errors, status: planning.getPlanningRun(p, 2).result.status, tasks: p.chapter_tasks, scenes: p.scene_plans };
    });
    assert.equal(snapshot.status, 'needs_user_decision'); assert.ok(snapshot.errors.every(Boolean)); assert.deepEqual(snapshot.tasks, {}); assert.deepEqual(snapshot.scenes, {});
    assert.equal(calls.length, 1);
  });

  await test('保存任务仅draft，人工批准推进revision后场景绑定真实任务且仅draft', async ({ page, calls }) => {
    const snapshot = await page.evaluate(async () => {
      const ref = await makeProject(), result = await generate(ref), before = await store.getProject(ref);
      const task = await planning.savePlanningTask(ref, result.run_id), afterTask = await store.getProject(ref);
      if (task.latest_draft.status !== 'draft' || task.approved) throw new Error('task auto-approved');
      await approveTask(ref);
      const afterApproval = await store.getProject(ref), scene = await planning.savePlanningScenes(ref, result.run_id), final = await store.getProject(ref);
      return { before: before.revision, afterTask: afterTask.revision, afterApproval: afterApproval.revision, task: afterApproval.chapter_tasks[2].approved, scene: scene.latest_draft, approvedScene: scene.approved, run: final.runs.find(r => r.run_id === result.run_id), chapters: Object.keys(final.chapters) };
    });
    assert.ok(snapshot.afterTask > snapshot.before); assert.ok(snapshot.afterApproval > snapshot.afterTask);
    assert.equal(snapshot.scene.status, 'draft'); assert.equal(snapshot.approvedScene, null); assert.deepEqual(snapshot.chapters, ['1']);
    assert.equal(snapshot.scene.source_chapter_task_id, snapshot.task.id); assert.equal(snapshot.scene.source_chapter_task_revision, snapshot.task.revision);
    assert.equal(snapshot.run.planning_application.task_id, snapshot.task.id); assert.equal(snapshot.run.planning_application.scene_plan_id, snapshot.scene.id);
    assert.equal(calls.filter(c => c.operation === 'plan_chapter').length, 1);
  });

  await test('场景必须等任务批准，重复采纳任务和场景均拒绝', async ({ page }) => {
    const errors = await page.evaluate(async () => {
      const ref = await makeProject(), result = await generate(ref);
      const premature = await reject(() => planning.savePlanningScenes(ref, result.run_id));
      await planning.savePlanningTask(ref, result.run_id);
      const unapproved = await reject(() => planning.savePlanningScenes(ref, result.run_id));
      const duplicateTask = await reject(() => planning.savePlanningTask(ref, result.run_id));
      await approveTask(ref); await planning.savePlanningScenes(ref, result.run_id);
      return [premature, unapproved, duplicateTask, await reject(() => planning.savePlanningScenes(ref, result.run_id))];
    });
    assert.ok(errors.every(value => value && !value.includes('unexpectedly succeeded')));
  });

  await test('作者正常编辑/保存/批准任务后场景重新绑定实际revision', async ({ page }) => {
    const snapshot = await page.evaluate(async () => {
      const ref = await makeProject(), result = await generate(ref), saved = await planning.savePlanningTask(ref, result.run_id);
      await approveTask(ref);
      await api.saveChapterTaskDraft(ref, 2, { ...Object.fromEntries(inputs.TASK_FIELDS.map(k => [k, saved.latest_draft[k]])), notes: '作者已复核' });
      await approveTask(ref);
      const task = (await store.getProject(ref)).chapter_tasks[2].approved;
      const firstScene = await planning.savePlanningScenes(ref, result.run_id);
      return { task, scene: firstScene.latest_draft };
    });
    assert.equal(snapshot.task.notes, '作者已复核'); assert.equal(snapshot.task.revision, 2); assert.equal(snapshot.scene.source_chapter_task_revision, snapshot.task.revision);
  });

  await test('实际批准任务增加必需人物或改变正典预算，原场景拒绝保存', async ({ page }) => {
    const errors = await page.evaluate(async () => {
      const errors = [];
      for (const field of ['required_characters', 'canon_budget']) {
        const ref = await makeProject(), result = await generate(ref), saved = await planning.savePlanningTask(ref, result.run_id);
        const payload = Object.fromEntries(inputs.TASK_FIELDS.map(k => [k, saved.latest_draft[k]]));
        payload[field] = field === 'required_characters' ? [...payload[field], '新增人物'] : 'normal';
        await api.saveChapterTaskDraft(ref, 2, { ...payload, id: saved.latest_draft.id, revision: saved.latest_draft.revision });
        await approveTask(ref);
        errors.push(await reject(() => planning.savePlanningScenes(ref, result.run_id)));
        if ((await store.getProject(ref)).scene_plans[2]) throw new Error('unsafe scene saved');
      }
      return errors;
    });
    assert.equal(errors.length, 2); assert.ok(errors.every(Boolean));
  });

  await test('前文/全局设定/已审核知识改变后拒绝旧场景，首次旧revision拒采纳', async ({ page }) => {
    const errors = await page.evaluate(async () => {
      const errors = [];
      for (const kind of ['prefix', 'setting', 'graph']) {
        const ref = await makeProject(), result = await generate(ref);
        await planning.savePlanningTask(ref, result.run_id); await approveTask(ref);
        await store.updateProject(ref, p => {
          if (kind === 'prefix') p.chapters[1].workflow.summary += '已修改';
          if (kind === 'setting') p.config.worldview += '已修改';
          if (kind === 'graph') p.graph.graph.nodes.push({ id: 'new-known', type: 'world_fact', label: '新设定', summary: '已审核新增事实', status: 'confirmed', importance: 9, source: { created_by: 'user' }, aliases: [], tags: [], properties: {} });
        });
        errors.push(await reject(() => planning.savePlanningScenes(ref, result.run_id)));
      }
      const ref = await makeProject(), result = await generate(ref);
      await store.updateProject(ref, p => { p.title += '已修改'; });
      errors.push(await reject(() => planning.savePlanningTask(ref, result.run_id)));
      return errors;
    });
    assert.equal(errors.length, 4); assert.ok(errors.every(Boolean));
  });

  await test('已有任务草稿或场景草稿保留，策划不会覆盖', async ({ page }) => {
    const snapshots = await page.evaluate(async () => {
      const snapshots = [];
      for (const kind of ['task', 'scene']) {
        const ref = await makeProject();
        if (kind === 'task') {
          const response = await api.saveChapterTaskDraft(ref, 2, { ...candidateForTest.task_payload, notes: 'EXISTING_TASK_SENTINEL' });
          const result = await generate(ref), error = await reject(() => planning.savePlanningTask(ref, result.run_id));
          snapshots.push({ error, value: (await store.getProject(ref)).chapter_tasks[2].latest_draft.notes, id: response.latest_draft.id });
        } else {
          const result = await generate(ref); await planning.savePlanningTask(ref, result.run_id); await approveTask(ref);
          const p = await store.getProject(ref), task = p.chapter_tasks[2].approved;
          await api.saveScenePlanDraft(ref, 2, { ...candidateForTest.scene_proposal, source_chapter_task_id: task.id, source_chapter_task_revision: task.revision });
          const id = (await store.getProject(ref)).scene_plans[2].latest_draft.id;
          snapshots.push({ error: await reject(() => planning.savePlanningScenes(ref, result.run_id)), id, preserved: (await store.getProject(ref)).scene_plans[2].latest_draft.id });
        }
      }
      return snapshots;
    });
    assert.equal(snapshots[0].value, 'EXISTING_TASK_SENTINEL'); assert.equal(snapshots[1].id, snapshots[1].preserved); assert.ok(snapshots.every(s => s.error));
  });

  await test('连接撤销分别阻止任务/场景采纳', async ({ page }) => {
    const errors = await page.evaluate(async () => {
      const errors = [];
      for (const stage of ['task', 'scene']) {
        const ref = await makeProject(), result = await generate(ref);
        if (stage === 'scene') { await planning.savePlanningTask(ref, result.run_id); await approveTask(ref); }
        const p = await store.getProject(ref); await pc.manageConnection(String(p.config.connection_id), 'forget');
        errors.push(await reject(() => stage === 'task' ? planning.savePlanningTask(ref, result.run_id) : planning.savePlanningScenes(ref, result.run_id)));
      }
      return errors;
    });
    assert.equal(errors.length, 2); assert.ok(errors.every(Boolean));
  });

  await test('纯保存结果晚到时CAS或连接撤销阻止正式写入', async ({ page, setHandler }) => {
    for (const conflict of ['revision', 'revocation']) {
      let enteredResolve, release;
      const entered = new Promise(resolve => { enteredResolve = resolve; }), gate = new Promise(resolve => { release = resolve; });
      setHandler(async (route, payload, operation) => {
        if (operation !== 'chapter_task') return false;
        enteredResolve(); await gate;
        const response = pureCompute(operation, payload.input);
        await route.fulfill({ status: response.status, json: { ...identity(payload), result: response.result, metrics: {} } });
        return true;
      });
      const ref = await page.evaluate(async () => {
        const ref = await makeProject(), result = await generate(ref);
        window.pendingAdoption = planning.savePlanningTask(ref, result.run_id).then(() => null, error => error.message);
        return ref;
      });
      await bounded(entered, 'Pure task save did not start');
      await page.evaluate(async ({ ref, conflict }) => {
        if (conflict === 'revision') await store.updateProject(ref, p => { p.title += '并发修改'; });
        else await pc.manageConnection(String((await store.getProject(ref)).config.connection_id), 'forget');
      }, { ref, conflict });
      release();
      const snapshot = await page.evaluate(async ref => { const error = await pendingAdoption, p = await store.getProject(ref); return { error, tasks: p.chapter_tasks, application: p.runs[0].planning_application }; }, ref);
      assert.ok(snapshot.error); assert.deepEqual(snapshot.tasks, {}); assert.equal(snapshot.application, undefined);
      setHandler(undefined);
    }
  });

  await test('完整策划result已保存但提交失败：重载resume零新模型且仍无正式计划', async ({ page, load, calls }) => {
    const ref = await page.evaluate(async () => {
      const ref = await makeProject(), original = IDBObjectStore.prototype.put; let writes = 0;
      IDBObjectStore.prototype.put = function (...args) { if (this.name === 'projects' && ++writes === 3) throw new DOMException('injected planning apply failure', 'UnknownError'); return original.apply(this, args); };
      try { await generate(ref); } catch {} finally { IDBObjectStore.prototype.put = original; }
      const p = await store.getProject(ref);
      if (!p.runs[0].result || p.runs[0].status !== 'interrupted') throw new Error('saved result recovery fixture failed');
      return ref;
    });
    const count = calls.filter(c => c.operation === 'plan_chapter').length;
    await page.reload(); await load();
    const snapshot = await page.evaluate(async ref => { const p = await wf.recoverInterrupted(ref); await wf.resumeLocalRun(ref, p.runs[0].run_id); return store.getProject(ref); }, ref);
    assert.equal(calls.filter(c => c.operation === 'plan_chapter').length, count); assert.equal(snapshot.runs[0].status, 'completed');
    assert.deepEqual(snapshot.chapter_tasks, {}); assert.deepEqual(snapshot.scene_plans, {});
  });

  await test('真实备份恢复提案，显式关联原连接后零新模型完成任务与场景采纳', async ({ page, calls }) => {
    const original = await page.evaluate(async () => { const ref = await makeProject(), result = await generate(ref), p = await store.getProject(ref); return { ref, run_id: result.run_id, connection_id: p.config.connection_id }; });
    const download = page.waitForEvent('download'); await page.evaluate(() => store.exportBackup());
    const backup = await readFile(await (await download).path(), 'utf8');
    assert.ok(!backup.includes(KEY));
    const count = calls.filter(c => c.operation === 'plan_chapter').length;
    const restored = await page.evaluate(async ({ backup, original }) => {
      const [ref] = await store.restoreBackup(backup);
      await wf.rebindFrozenConnection(ref, original.connection_id);
      await reject(() => planning.savePlanningTask(ref, original.run_id));
      await planning.authorizePlanningRun(ref, original.run_id, original.connection_id);
      const task = await planning.savePlanningTask(ref, original.run_id);
      await approveTask(ref);
      const scene = await planning.savePlanningScenes(ref, original.run_id);
      return { ref, task: task.latest_draft, scene: scene.latest_draft };
    }, { backup, original });
    assert.notEqual(restored.ref, original.ref); assert.equal(restored.task.status, 'draft'); assert.equal(restored.scene.status, 'draft');
    assert.equal(restored.scene.source_chapter_task_id, restored.task.id);
    assert.equal(calls.filter(c => c.operation === 'plan_chapter').length, count);
  });

  await test('备份已有任务关联，重新显式授权后继续场景采纳且零新模型', async ({ page, calls }) => {
    const original = await page.evaluate(async () => {
      const ref = await makeProject(), result = await generate(ref);
      await planning.savePlanningTask(ref, result.run_id); await approveTask(ref);
      const p = await store.getProject(ref);
      return { ref, run_id: result.run_id, connection_id: p.config.connection_id, task_id: p.chapter_tasks[2].approved.id };
    });
    const download = page.waitForEvent('download'); await page.evaluate(() => store.exportBackup());
    const backup = await readFile(await (await download).path(), 'utf8');
    const count = calls.filter(c => c.operation === 'plan_chapter').length;
    const scene = await page.evaluate(async ({ backup, original }) => {
      const [ref] = await store.restoreBackup(backup);
      await wf.rebindFrozenConnection(ref, original.connection_id);
      await planning.authorizePlanningRun(ref, original.run_id, original.connection_id);
      return (await planning.savePlanningScenes(ref, original.run_id)).latest_draft;
    }, { backup, original });
    assert.equal(scene.status, 'draft'); assert.equal(scene.source_chapter_task_id, original.task_id);
    assert.equal(calls.filter(c => c.operation === 'plan_chapter').length, count);
  });

  await test('显式续授权保持冻结模型，并拒绝不同目的地或策略', async ({ page, calls }) => {
    const errors = await page.evaluate(async () => {
      const errors = [];
      for (const kind of ['policy', 'destination']) {
        const ref = await makeProject(), result = await generate(ref), run = (await store.getProject(ref)).runs[0];
        const raw = { ...run.connection, profile_id: crypto.randomUUID(), revision: 1 };
        if (kind === 'destination') raw.base_url = 'https://other-offline-model.example/v1';
        else raw.policy = { ...raw.policy, temperature: 'fixed', temperature_fixed: 1 };
        const profile = await pc.saveConnection('不匹配的续授权目标', raw);
        await pc.storeConnectionKey(profile.id, 'OFFLINE_PLANNING_TEST_KEY');
        try { await planning.authorizePlanningRun(ref, result.run_id, profile.id); errors.push(null); }
        catch (error) { errors.push(error.message); }
      }
      return errors;
    });
    assert.ok(errors.every(Boolean), `Mismatched target was authorized: ${JSON.stringify(errors)}`);
    assert.equal(calls.filter(c => c.operation === 'plan_chapter').length, 2);
  });

  await test('作品覆盖默认模型后更换Key可续授权，仍使用原冻结模型且不重复调用', async ({ page, calls }) => {
    const state = await page.evaluate(async () => {
      const ref = await makeProject();
      await store.updateProject(ref, p => { p.config.model = 'custom-project-model'; });
      const result = await generate(ref), before = await store.getProject(ref), original = before.runs[0].connection;
      await pc.storeConnectionKey(original.profile_id, 'OFFLINE_PLANNING_TEST_KEY');
      const denied = await reject(() => planning.savePlanningTask(ref, result.run_id));
      await planning.authorizePlanningRun(ref, result.run_id);
      const after = await store.getProject(ref);
      const saved = await planning.savePlanningTask(ref, result.run_id);
      return { denied, frozen: original.model, current: after.runs[0].connection.model,
        fingerprint: after.runs[0].connection.execution_fingerprint, originalFingerprint: original.execution_fingerprint,
        defaultModel: (await pc.resolveConnection(original.profile_id)).model, status: saved.latest_draft.status };
    });
    assert.ok(state.denied); assert.notEqual(state.defaultModel, state.frozen);
    assert.equal(state.current, 'custom-project-model'); assert.equal(state.fingerprint, state.originalFingerprint);
    assert.equal(state.status, 'draft'); assert.equal(calls.filter(c => c.operation === 'plan_chapter').length, 1);
  });

  await test('续授权不洗白过期result_revision，首次采纳仍拒绝', async ({ page, calls }) => {
    const snapshot = await page.evaluate(async () => {
      const ref = await makeProject(), result = await generate(ref), before = await store.getProject(ref);
      await store.updateProject(ref, p => { p.title += '作者更新'; });
      const edited = await store.getProject(ref);
      await planning.authorizePlanningRun(ref, result.run_id);
      const final = await store.getProject(ref);
      return { error: await reject(() => planning.savePlanningTask(ref, result.run_id)), before: before.runs[0].result_revision, after: final.runs[0].result_revision, edited: edited.revision, revision: final.revision, tasks: final.chapter_tasks };
    });
    assert.ok(snapshot.error); assert.equal(snapshot.before, snapshot.after); assert.equal(snapshot.edited, snapshot.revision); assert.deepEqual(snapshot.tasks, {});
    assert.equal(calls.filter(c => c.operation === 'plan_chapter').length, 1);
  });

  async function openUI(page, load, ref, path = '/review?chapter=2') {
    await page.evaluate(async ref => {
      const intro = await import('/src/appConfig.ts'); intro.setIntroHidden(true); intro.markIntroSeen();
      const { useAppStore } = await import('/src/store/useAppStore.ts'); useAppStore.getState().selectProject(ref);
    }, ref);
    await page.goto(origin + path); await load();
    await page.evaluate(async () => {
      const { useAppStore } = await import('/src/store/useAppStore.ts'); useAppStore.getState().setApiStatus('online');
      window.appForTest = useAppStore;
    });
  }
  async function fillIntent(page) {
    await page.getByRole('textbox', { name: '本章策划意图', exact: true }).fill(request.author_intent);
    await page.getByRole('textbox', { name: '策划必需人物', exact: true }).fill(request.required_characters.join('\n'));
    await page.getByRole('textbox', { name: '策划禁止推进', exact: true }).fill(request.forbidden_advances.join('\n'));
  }
  const planPanel = page => page.getByTestId('chapter-planning-panel');
  async function editorFocused(page, kind) {
    const selector = `[data-testid="planning-${kind}-editor"]`;
    await page.waitForFunction(selector => {
      const target = document.querySelector(selector), top = target?.getBoundingClientRect().top;
      return target?.contains(document.activeElement) && top >= 0 && top < window.innerHeight;
    }, selector);
    const rect = await page.locator(selector).boundingBox();
    assert.ok(rect && rect.y >= 0 && rect.y < page.viewportSize().height, 'Editor heading should be in view after navigation');
  }

  await test('实际页面完整链：策划刷新保留→任务批准→场景批准→正文引用批准版本', async ({ page, load, calls }) => {
    const ref = await page.evaluate(() => makeProject());
    await openUI(page, load, ref); await fillIntent(page);
    await planPanel(page).getByRole('button', { name: '生成策划提案', exact: true }).click();
    await page.evaluate(ref => waitUntil(async () => (await store.getProject(ref)).runs.some(r => r.operation === 'plan_chapter' && r.status === 'completed')), ref);
    let p = await page.evaluate(ref => store.getProject(ref), ref);
    assert.deepEqual(p.chapter_tasks, {}); assert.deepEqual(p.scene_plans, {}); assert.equal(p.chapters[2], undefined);
    await page.reload(); await load();
    const details = planPanel(page).getByTestId('planning-proposal-details');
    await details.locator(':scope > summary').click();
    assert.equal(await details.evaluate(element => element.open), false);
    await planPanel(page).getByRole('button', { name: '保存任务草稿', exact: true }).click();
    await page.evaluate(ref => waitUntil(async () => Boolean((await store.getProject(ref)).chapter_tasks[2]?.latest_draft)), ref);
    await editorFocused(page, 'task');
    p = await page.evaluate(ref => store.getProject(ref), ref);
    assert.equal(p.chapter_tasks[2].latest_draft.status, 'draft'); assert.equal(p.chapter_tasks[2].approved, null);
    await page.getByRole('button', { name: '批准草稿', exact: true }).click();
    await page.evaluate(ref => waitUntil(async () => Boolean((await store.getProject(ref)).chapter_tasks[2]?.approved)), ref);
    await planPanel(page).getByRole('button', { name: '保存场景草稿', exact: true }).click();
    await page.evaluate(ref => waitUntil(async () => Boolean((await store.getProject(ref)).scene_plans[2]?.latest_draft)), ref);
    await editorFocused(page, 'scene');
    p = await page.evaluate(ref => store.getProject(ref), ref);
    assert.equal(p.scene_plans[2].latest_draft.status, 'draft'); assert.equal(p.scene_plans[2].approved, null);
    assert.equal(p.scene_plans[2].latest_draft.source_chapter_task_id, p.chapter_tasks[2].approved.id);
    assert.equal(p.scene_plans[2].latest_draft.source_chapter_task_revision, p.chapter_tasks[2].approved.revision);
    await page.getByRole('button', { name: '批准草稿', exact: true }).click();
    await page.evaluate(ref => waitUntil(async () => Boolean((await store.getProject(ref)).scene_plans[2]?.approved)), ref);
    await mkdir(report, { recursive: true });
    await page.screenshot({ path: join(report, 'planning-approved-ui.png'), fullPage: true });
    await planPanel(page).getByRole('link', { name: /前往创作台/ }).click();
    await page.getByRole('button', { name: /生成这一章/ }).click();
    await page.evaluate(ref => waitUntil(async () => Boolean((await store.getProject(ref)).chapters[2])), ref);
    p = await page.evaluate(ref => store.getProject(ref), ref);
    const body = calls.find(c => c.operation === 'generate_chapter').input;
    assert.equal(body.chapter_task.id, p.chapter_tasks[2].approved.id);
    assert.equal(body.scene_plan.id, p.scene_plans[2].approved.id);
    assert.equal(body.scene_plan.source_chapter_task_revision, body.chapter_task.revision);
    assert.equal(p.chapters[2].workflow.status, 'awaiting_confirmation');
    assert.equal(calls.filter(c => c.operation === 'plan_chapter').length, 1);
    await page.screenshot({ path: join(report, 'planning-writing-ui.png'), fullPage: true });
  });

  await test('实际页面保护双编辑器未保存内容，定向刷新不覆写另一面板', async ({ page, load, calls }) => {
    const ref = await page.evaluate(() => makeProject()); await openUI(page, load, ref); await fillIntent(page);
    const taskNotes = page.getByRole('textbox', { name: '备注', exact: true });
    await taskNotes.fill('TASK_UNSAVED_SENTINEL');
    await page.getByRole('tab', { name: /02.*场景计划/ }).click();
    const sceneTitle = page.getByRole('textbox', { name: '场景 1 · 场景标题', exact: true });
    const initialTitle = await sceneTitle.inputValue(); await sceneTitle.fill('SCENE_UNSAVED_SENTINEL');
    await planPanel(page).getByRole('button', { name: '生成策划提案', exact: true }).click();
    await page.evaluate(ref => waitUntil(async () => (await store.getProject(ref)).runs.some(r => r.operation === 'plan_chapter' && r.status === 'completed')), ref);
    assert.equal(await sceneTitle.inputValue(), 'SCENE_UNSAVED_SENTINEL');
    await page.getByRole('tab', { name: /01.*章节任务单/ }).click();
    assert.equal(await taskNotes.inputValue(), 'TASK_UNSAVED_SENTINEL');
    assert.equal(await planPanel(page).getByRole('button', { name: '保存任务草稿', exact: true }).isDisabled(), true);
    await page.evaluate(() => appForTest.getState().setApiStatus('offline')); await page.waitForTimeout(30);
    await page.evaluate(() => appForTest.getState().setApiStatus('online')); await page.waitForTimeout(100);
    assert.equal(await taskNotes.inputValue(), 'TASK_UNSAVED_SENTINEL');
    await taskNotes.fill('');
    await planPanel(page).getByRole('button', { name: '保存任务草稿', exact: true }).click();
    await page.evaluate(ref => waitUntil(async () => Boolean((await store.getProject(ref)).chapter_tasks[2]?.latest_draft)), ref);
    await page.getByRole('button', { name: '批准草稿', exact: true }).click();
    await page.evaluate(ref => waitUntil(async () => Boolean((await store.getProject(ref)).chapter_tasks[2]?.approved)), ref);
    await taskNotes.fill('TASK_OTHER_PANEL_SENTINEL');
    await page.getByRole('tab', { name: /02.*场景计划/ }).click();
    assert.equal(await sceneTitle.inputValue(), 'SCENE_UNSAVED_SENTINEL');
    assert.equal(await planPanel(page).getByRole('button', { name: '保存场景草稿', exact: true }).isDisabled(), true);
    await sceneTitle.fill(initialTitle);
    await planPanel(page).getByRole('button', { name: '保存场景草稿', exact: true }).click();
    await page.evaluate(ref => waitUntil(async () => Boolean((await store.getProject(ref)).scene_plans[2]?.latest_draft)), ref);
    await page.getByRole('tab', { name: /01.*章节任务单/ }).click();
    assert.equal(await taskNotes.inputValue(), 'TASK_OTHER_PANEL_SENTINEL');
    assert.equal(calls.filter(c => c.operation === 'plan_chapter').length, 1);
  });

  for (const pendingOperation of ['plan_chapter', 'validate_planning_candidate']) await test(`实际页面切换章节取消延迟${pendingOperation}，旧结果不写新章`, async ({ page, load, calls, setHandler }) => {
    const ref = await page.evaluate(() => makeProject()); await openUI(page, load, ref); await fillIntent(page);
    let release, arrived;
    const gate = new Promise(r => { release = r; }), started = new Promise(r => { arrived = r; });
    setHandler(async (route, payload, operation) => {
      if (operation !== pendingOperation) return false;
      arrived(); await gate;
      try {
        const response = operation === 'plan_chapter' ? { status: 200, result: planningResult(2) } : pureCompute(operation, payload.input);
        await route.fulfill({ status: response.status, json: { ...identity(payload), result: response.result, metrics: {} } });
      } catch { /* The page intentionally cancelled this response. */ }
      return true;
    });
    try {
      await planPanel(page).getByRole('button', { name: '生成策划提案', exact: true }).click();
      if (pendingOperation === 'validate_planning_candidate') {
        await page.evaluate(ref => waitUntil(async () => (await store.getProject(ref)).runs.some(r => r.operation === 'plan_chapter' && r.status === 'completed')), ref);
        await planPanel(page).getByRole('button', { name: '保存任务草稿', exact: true }).click();
      }
      await bounded(started, 'Delayed UI request did not start');
      await page.getByRole('spinbutton', { name: '指定规划章节', exact: true }).fill('3');
      await page.waitForURL('**/review?chapter=3'); release();
      await page.evaluate(ref => waitUntil(async () => !(await store.getProject(ref)).runs.some(r => r.status === 'running')), ref);
      await page.waitForTimeout(150);
      const p = await page.evaluate(ref => store.getProject(ref), ref);
      assert.deepEqual(p.chapter_tasks, {}); assert.deepEqual(p.scene_plans, {}); assert.equal(p.chapters[3], undefined);
      assert.equal(await planPanel(page).getByText('脆弱共识', { exact: true }).count(), 0);
      assert.equal(calls.filter(c => c.operation === 'plan_chapter').length, 1);
    } finally { release(); }
  });

  await test('实际页面恢复提案必须点击同目标重新授权，零新策划请求', async ({ page, load, calls }) => {
    await page.evaluate(async () => { const ref = await makeProject(); await generate(ref); });
    const download = page.waitForEvent('download'); await page.evaluate(() => store.exportBackup());
    const backup = await readFile(await (await download).path(), 'utf8');
    const restored = await page.evaluate(async backup => {
      const [copy] = await store.restoreBackup(backup);
      const p = await store.getProject(copy), id = String(p.config.connection_id);
      await pc.manageConnection(id, 'enable'); await pc.storeConnectionKey(id, 'OFFLINE_PLANNING_TEST_KEY');
      return copy;
    }, backup);
    await openUI(page, load, restored);
    await planPanel(page).getByRole('button', { name: '重新授权已有提案', exact: true }).click();
    await planPanel(page).getByRole('button', { name: '保存任务草稿', exact: true }).click();
    await page.evaluate(ref => waitUntil(async () => Boolean((await store.getProject(ref)).chapter_tasks[2]?.latest_draft)), restored);
    assert.equal(calls.filter(c => c.operation === 'plan_chapter').length, 1);
  });

  await test('实际创作台可跳过策划直接生成，原正文路径保留', async ({ page, load, calls }) => {
    const ref = await page.evaluate(() => makeProject()); await openUI(page, load, ref, '/writing?chapter=2');
    await page.getByRole('button', { name: /生成这一章/ }).click();
    await page.evaluate(ref => waitUntil(async () => Boolean((await store.getProject(ref)).chapters[2])), ref);
    assert.equal(calls.filter(c => c.operation === 'plan_chapter').length, 0);
    assert.equal(calls.filter(c => c.operation === 'generate_chapter').length, 1);
    const p = await page.evaluate(ref => store.getProject(ref), ref);
    assert.deepEqual(p.chapter_tasks, {}); assert.deepEqual(p.scene_plans, {});
    assert.equal(p.chapters[2].workflow.status, 'awaiting_confirmation');
  });

  await test('实际页面拒绝损坏备份中的提案结构，保留项目且不崩溃', async ({ page, load, calls }) => {
    const ref = await page.evaluate(async () => {
      const ref = await makeProject(); await generate(ref);
      await store.updateProject(ref, p => { p.runs[0].result.task_payload = {}; }, undefined, false);
      return ref;
    });
    await openUI(page, load, ref);
    await planPanel(page).getByText(/已保存提案的格式无效/).waitFor();
    assert.equal(await planPanel(page).getByRole('button', { name: '保存任务草稿', exact: true }).count(), 0);
    const p = await page.evaluate(ref => store.getProject(ref), ref);
    assert.deepEqual(p.chapter_tasks, {}); assert.deepEqual(p.scene_plans, {});
    assert.equal(calls.filter(c => c.operation === 'plan_chapter').length, 1);
  });

  await test('策划交互：未采纳提案过期说明原因，已有草稿可直接前往审核', async ({ page, load, calls }) => {
    const stale = await page.evaluate(async () => {
      const ref = await makeProject(); await generate(ref);
      await store.updateProject(ref, p => { p.title += '已更新'; }); return ref;
    });
    await openUI(page, load, stale);
    await planPanel(page).getByTestId('planning-next-step').getByText(/过期|已更新|旧版本/).first().waitFor();
    assert.equal(await planPanel(page).getByRole('button', { name: '保存任务草稿', exact: true }).isDisabled(), true);
    const draft = await page.evaluate(async () => {
      const ref = await makeProject(); await generate(ref);
      const response = await api.saveChapterTaskDraft(ref, 2, candidateForTest.task_payload);
      return { ref, id: response.latest_draft.id };
    });
    await openUI(page, load, draft.ref);
    await planPanel(page).getByTestId('planning-next-step').getByText(/打开任务单/).waitFor();
    await planPanel(page).getByRole('button', { name: '前往审核任务单', exact: true }).click();
    await editorFocused(page, 'task');
    const p = await page.evaluate(ref => store.getProject(ref), draft.ref);
    assert.equal(p.chapter_tasks[2].latest_draft.id, draft.id); assert.equal(p.chapter_tasks[2].approved, null);
    assert.equal(calls.filter(c => c.operation === 'plan_chapter').length, 2);
  });

  await test('策划交互：批准后连接失效仍可浏览创作台，且不自动生成正文', async ({ page, load, calls }) => {
    const ref = await page.evaluate(async () => {
      const ref = await makeProject(), result = await generate(ref);
      await planning.savePlanningTask(ref, result.run_id); await approveTask(ref);
      const scene = (await planning.savePlanningScenes(ref, result.run_id)).latest_draft;
      await api.approveScenePlan(ref, 2, scene.id, scene.revision);
      await pc.manageConnection(String((await store.getProject(ref)).config.connection_id), 'disable');
      return ref;
    });
    await openUI(page, load, ref);
    await planPanel(page).getByRole('link', { name: /前往创作台/ }).click();
    await page.waitForURL('**/writing?chapter=2');
    assert.equal(calls.filter(c => c.operation === 'plan_chapter').length, 1);
    assert.equal(calls.filter(c => c.operation === 'generate_chapter').length, 0);
  });

  await test('策划交互：已批准场景关联旧任务版本时明确提示并导航检查', async ({ page, load, calls }) => {
    const ref = await page.evaluate(async () => {
      const ref = await makeProject(), result = await generate(ref);
      await planning.savePlanningTask(ref, result.run_id); await approveTask(ref);
      const scene = (await planning.savePlanningScenes(ref, result.run_id)).latest_draft;
      await api.approveScenePlan(ref, 2, scene.id, scene.revision);
      await api.saveChapterTaskDraft(ref, 2, { ...candidateForTest.task_payload, notes: '作者更新任务版本' });
      await approveTask(ref); return ref;
    });
    await openUI(page, load, ref);
    await planPanel(page).getByTestId('planning-next-step').getByText(/更新|不匹配|关联/).first().waitFor();
    assert.equal(await planPanel(page).getByRole('link', { name: /前往创作台/ }).count(), 0);
    await planPanel(page).getByRole('button', { name: '前往审核场景', exact: true }).click();
    await editorFocused(page, 'scene');
    assert.equal(calls.filter(c => c.operation === 'plan_chapter').length, 1);
  });

  console.log(`PASS ${results.filter(result => result.status === 'passed').length}/${results.length} chapter planning scenarios (${process.env.BRAIPEN_BROWSER || 'msedge'})`);
} finally {
  await mkdir(report, { recursive: true });
  await writeFile(join(report, 'browser-planning-final.json'), JSON.stringify({ browser: process.env.BRAIPEN_BROWSER || 'msedge', offline: true, real_model_calls: 0, scenarios: results }, null, 2));
  await browser?.close(); await server.close();
}
