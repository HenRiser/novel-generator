// Real Edge, IndexedDB and chunked localhost NDJSON; no provider requests.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { providerFixtures, identity } from './provider-test-helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]+$/, '');
const workspace = resolve(root, '..');
const report = resolve(process.env.BRAIPEN_REPORT_DIR || join(workspace, 'reports/planning-progress-2026-10-03'));
const runtime = process.env.BRAIPEN_PLAYWRIGHT_PATH || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const { chromium } = await import(pathToFileURL(join(runtime, 'index.mjs')).href);
const python = process.env.BRAIPEN_TEST_PYTHON || resolve(workspace, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const fixtures = providerFixtures(root), KEY = 'OFFLINE_PLANNING_PROGRESS_KEY';
const runPython = (code, input) => {
  const run = spawnSync(python, ['-c', code], { cwd: workspace, input: JSON.stringify(input), encoding: 'utf8', timeout: 15000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  if (run.status !== 0) throw new Error(run.error?.message || run.stderr);
  return JSON.parse(run.stdout);
};
const candidate = runPython('import json; from tests.test_chapter_planning_contract import candidate; print(json.dumps(candidate()))');
const fixed = { author_intent: '让林默和周岚恢复有限信任', canon_budget: 'none', required_characters: ['林默', '周岚'], forbidden_advances: ['揭示组织秘密'] };
const pureOperations = new Set(['validate_planning_candidate', 'chapter_task', 'scene_plan']);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bounded = (promise, label) => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(label)), 12000); timer.unref(); })]);
const modernCapabilities = () => ({ ...fixtures.catalog, stream_operations: ['generate_chapter', 'continue_chapter', 'plan_chapter'], planning_stream_version: 1 });
const planningResult = number => ({ graph_version: 'chapter-planning-v1', chapter_number: number, status: 'draft_ready', ...structuredClone(candidate), issues: [], repair_count: 0, nodes: ['context_pack', 'initial_proposal', 'validate'], excluded_records: 0, warnings: ['离线模拟；作者仍需独立审核。'] });

function planningFrames(payload) {
  const common = { ...identity(payload), event_version: 1, chapter_number: payload.input.chapter_number };
  const rows = [{ type: 'started' }];
  for (const node of ['context_pack', 'initial_proposal', 'validate']) for (const status of ['started', 'finished']) {
    rows.push({ type: 'progress', node, visit: 1, status, elapsed_ms: rows.length });
  }
  rows.push({ type: 'done', result: planningResult(payload.input.chapter_number), metrics: { operation: 'plan_chapter', protocol_version: 2, call_count: 1, repair_used: false, elapsed_ms: 10 } });
  return rows.map((row, index) => ({ ...common, seq: index + 1, ...row }));
}

function pureCompute(operation, input) {
  return runPython(`import asyncio,json,sys
from services.compute_service import compute
p=json.load(sys.stdin)
assert p['operation'] in {'validate_planning_candidate','chapter_task','scene_plan'}
print(json.dumps(asyncio.run(compute(p['operation'],p['input'],{},{}))))`, { operation, input });
}

let capabilities, streamHandler, calls, fixtureErrors, capabilityRequests;
const sessions = new Set();
const server = await createServer({ root, define: { 'import.meta.env.VITE_API_BASE_URL': '""' }, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error', plugins: [{ name: 'offline-planning-progress', configureServer(vite) {
  vite.middlewares.use('/__planning_progress', (_, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><meta charset="utf-8"><title>Offline planning progress tests</title>'); });
  vite.middlewares.use('/api', (request, response) => {
    void (async () => {
      const path = request.url.split('?')[0];
      response.setHeader('Cache-Control', 'no-store');
      if (path === '/health') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ status: 'ok' })); return; }
      if (path === '/capabilities') { capabilityRequests++; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(capabilities)); return; }
      if (request.method !== 'POST') throw new Error(`Unexpected offline API request: ${request.method} ${path}`);
      let raw = ''; for await (const chunk of request) raw += chunk;
      const payload = JSON.parse(raw), operation = path.split('/compute/')[1]?.split('/')[0];
      if (operation === 'validate_connection') {
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ...identity(payload), result: { connection: fixtures.normalize(payload.connection) } })); return;
      }
      if (!['plan_chapter', ...pureOperations].includes(operation)) throw new Error(`Unexpected offline operation: ${operation}`);
      if (payload.connection) assert.equal(payload.request_fingerprint, fixtures.requestFingerprint(payload, operation));
      if (operation === 'plan_chapter') assert.equal(payload.credentials.api_key, KEY);
      else assert.deepEqual(payload.credentials, {});
      calls.push({ operation, stream: path.endsWith('/stream'), payload });
      if (pureOperations.has(operation)) {
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ...identity(payload), result: pureCompute(operation, payload.input), metrics: {} })); return;
      }
      if (!path.endsWith('/stream')) {
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ...identity(payload), result: planningResult(payload.input.chapter_number), metrics: { call_count: 1 } })); return;
      }
      assert.equal(capabilities.planning_stream_version, 1);
      response.setHeader('Content-Type', 'application/x-ndjson'); response.setHeader('X-Accel-Buffering', 'no'); response.flushHeaders();
      const events = planningFrames(payload), closed = deferred();
      const session = { payload, events, closed: closed.promise,
        send: event => { if (!response.destroyed) response.write(JSON.stringify(event) + '\n'); },
        finish: () => { for (const event of events.slice(4)) session.send(event); if (!response.destroyed) response.end(); },
        end: () => { if (!response.destroyed) response.end(); }, destroy: () => response.destroy() };
      sessions.add(session); response.on('close', () => { sessions.delete(session); closed.resolve(); });
      for (const event of events.slice(0, 4)) session.send(event);
      // The initial proposal remains open on a real HTTP socket until the test releases it.
      if (streamHandler) await streamHandler(session);
      else { await new Promise(done => setTimeout(done, 30)); session.finish(); }
    })().catch(error => {
      fixtureErrors.push(error.message);
      if (!response.headersSent) { response.statusCode = 500; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ error: { message: 'Offline fixture rejected a request.' } })); }
      else response.destroy();
    });
  });
} }] });
await server.listen();
const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
const results = [];
let browser;

async function test(name, body) {
  if (process.env.BRAIPEN_TEST_FILTER && !name.includes(process.env.BRAIPEN_TEST_FILTER)) return;
  capabilities = modernCapabilities(); streamHandler = undefined; calls = []; fixtureErrors = []; capabilityRequests = 0;
  const context = await browser.newContext(), page = await context.newPage();
  const violations = [], pageErrors = [];
  await context.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { violations.push(route.request().url()); return route.abort('blockedbyclient'); } return route.continue(); });
  page.on('pageerror', error => pageErrors.push(error.message)); page.setDefaultTimeout(12000);
  await page.goto(origin + '/__planning_progress');
  async function load() {
    await page.evaluate(async ({ key, fixed }) => {
      window.store = await import('/src/localStore.ts'); window.wf = await import('/src/localWorkflow.ts');
      window.pc = await import('/src/providerConnections.ts'); window.vault = await import('/src/keyVault.ts');
      window.types = await import('/src/localTypes.ts'); window.planning = await import('/src/chapterPlanning.ts'); window.api = await import('/src/api.ts');
      window.fixed = fixed;
      for (const profile of await pc.connections()) if (profile.id !== 'legacy-deepseek' && profile.enabled && !profile.deleted) vault.loadProfileKey(profile, profile.revisions.find(revision => revision.revision === profile.head), key);
      window.waitUntil = async predicate => { for (let index = 0; index < 500; index++) { if (await predicate()) return; await new Promise(done => setTimeout(done, 20)); } throw new Error('Browser condition timed out'); };
      window.makeProject = async () => {
        const raw = { profile_id: crypto.randomUUID(), revision: 1, preset: 'custom', protocol: 'chat_completions', base_url: 'https://offline-model.example/v1', model: 'planning-fixture', policy: { ...pc.defaultPolicy(), structured: 'prompt_only' }, auth_mode: 'key', destination_fingerprint: '', execution_fingerprint: '' };
        const profile = await pc.saveConnection('离线节点验收', raw); await pc.storeConnectionKey(profile.id, key);
        const project = types.emptyProject('节点进度验收', { connection_id: profile.id, model: raw.model, ...Object.fromEntries(['protagonist', 'supporting_characters', 'worldview', 'core_conflict', 'genre', 'style'].map(field => [field, '作者全局设定'])) });
        wf.setChapter(project, 1, 'CONFIRMED_PREFIX_BODY'); Object.assign(project.chapters[1].workflow, { status: 'confirmed', summary_status: 'ready', review_status: 'ready', summary: 'CONFIRMED_PREFIX_SUMMARY' });
        await store.putProject(project); return project.project_ref;
      };
    }, { key: KEY, fixed });
  }
  async function openUI(ref) {
    await page.evaluate(async ref => {
      const intro = await import('/src/appConfig.ts'); intro.setIntroHidden(true); intro.markIntroSeen();
      const { useAppStore } = await import('/src/store/useAppStore.ts'); useAppStore.getState().selectProject(ref);
    }, ref);
    await page.goto(origin + '/review?chapter=2'); await load();
    await page.evaluate(async () => { const { useAppStore } = await import('/src/store/useAppStore.ts'); useAppStore.getState().setApiStatus('online'); });
  }
  async function generateUI() {
    await page.getByRole('textbox', { name: '本章策划意图', exact: true }).fill(fixed.author_intent);
    await page.getByRole('textbox', { name: '策划必需人物', exact: true }).fill(fixed.required_characters.join('\n'));
    await page.getByRole('textbox', { name: '策划禁止推进', exact: true }).fill(fixed.forbidden_advances.join('\n'));
    await page.getByTestId('chapter-planning-panel').getByRole('button', { name: '生成策划提案', exact: true }).click();
  }
  await load();
  try {
    await body({ page, load, openUI, generateUI });
    assert.deepEqual(violations, [], 'An external URL was requested'); assert.deepEqual(fixtureErrors, [], 'Fixture rejected an API request'); assert.deepEqual(pageErrors, [], 'Browser exception');
    results.push({ name, status: 'passed', planning_requests: calls.filter(call => call.operation === 'plan_chapter').length, capability_requests: capabilityRequests }); console.log('PASS ' + name);
  } catch (error) {
    await mkdir(report, { recursive: true }); await page.screenshot({ path: join(report, `failed-${results.length}.png`), fullPage: true }).catch(() => {});
    const localRuns = await page.evaluate(async () => (await window.store.listProjects()).map(project => ({ revision: project.revision, runs: project.runs.map(run => ({ operation: run.operation, status: run.status, trace_entries: run.planning_trace?.length || 0, has_result: Boolean(run.result) })) }))).catch(() => []);
    results.push({ name, status: 'failed', error: error.message, local_runs: localRuns, page_text: (await page.locator('body').innerText().catch(() => '')).slice(0, 6000), fixture_errors: fixtureErrors, browser_errors: pageErrors });
    console.error('FAIL ' + name + '\n' + error.stack); process.exitCode = 1;
  } finally { for (const session of sessions) session.destroy(); await context.close(); }
}

try {
  browser = await chromium.launch({ channel: process.env.BRAIPEN_BROWSER || 'msedge', headless: true });

  await test('真实分块节点先于done可见，刷新保留轨迹与revision，中断不自动计费', async ({ page, load, openUI, generateUI }) => {
    const arrived = deferred(), gate = deferred();
    streamHandler = async session => { arrived.resolve(session); await gate.promise; session.finish(); };
    const ref = await page.evaluate(() => makeProject()); await openUI(ref);
    const before = await page.evaluate(ref => store.getProject(ref), ref); await generateUI();
    const session = await bounded(arrived.promise, 'Streaming request did not arrive');
    try {
      await page.getByTestId('planning-current-node').filter({ hasText: /起草提案.*正在执行/ }).waitFor();
      await page.evaluate(ref => waitUntil(async () => (await store.getProject(ref)).runs.at(-1)?.planning_trace?.length === 3), ref);
      const active = await page.evaluate(ref => store.getProject(ref), ref);
      assert.equal(active.revision, before.revision); assert.equal(active.runs.at(-1).status, 'running'); assert.equal(active.runs.at(-1).result, undefined);
      assert.deepEqual(active.chapter_tasks, {}); assert.deepEqual(active.scene_plans, {}); assert.equal(active.chapters[2], undefined);
      assert.ok(!JSON.stringify(active).includes(KEY));
      await page.getByTestId('planning-trace').locator(':scope > summary').click();
      await mkdir(report, { recursive: true }); await page.screenshot({ path: join(report, 'planning-live-progress.png'), fullPage: true });
      await page.reload(); await load(); await bounded(session.closed, 'Reload did not close the socket');
      await page.getByTestId('planning-current-node').filter({ hasText: /中断.*未知/ }).waitFor();
      const recovered = await page.evaluate(ref => store.getProject(ref), ref);
      assert.equal(recovered.revision, before.revision); assert.deepEqual(recovered.runs.at(-1).planning_trace, active.runs.at(-1).planning_trace);
      assert.equal(recovered.runs.at(-1).status, 'interrupted'); assert.equal(calls.filter(call => call.operation === 'plan_chapter').length, 1);
    } finally { gate.resolve(); }
  });

  await test('完成轨迹保留双编辑器未保存内容，任务与场景仍分别批准', async ({ page, openUI, generateUI }) => {
    const ref = await page.evaluate(() => makeProject()); await openUI(ref);
    const notes = page.getByRole('textbox', { name: '备注', exact: true }); await notes.fill('TASK_UNSAVED_SENTINEL');
    await page.getByRole('tab', { name: /02.*场景计划/ }).click();
    const title = page.getByRole('textbox', { name: '场景 1 · 场景标题', exact: true }), originalTitle = await title.inputValue(); await title.fill('SCENE_UNSAVED_SENTINEL');
    await generateUI(); await page.evaluate(ref => waitUntil(async () => (await store.getProject(ref)).runs.at(-1)?.status === 'completed'), ref);
    await page.getByTestId('planning-current-node').filter({ hasText: /请求已完成.*仍需作者审核/ }).waitFor();
    let project = await page.evaluate(ref => store.getProject(ref), ref);
    assert.equal(project.runs.at(-1).planning_trace.length, 6); assert.deepEqual(project.chapter_tasks, {}); assert.deepEqual(project.scene_plans, {});
    assert.equal(await title.inputValue(), 'SCENE_UNSAVED_SENTINEL'); await page.getByRole('tab', { name: /01.*章节任务单/ }).click(); assert.equal(await notes.inputValue(), 'TASK_UNSAVED_SENTINEL');
    const panel = page.getByTestId('chapter-planning-panel'); assert.equal(await panel.getByRole('button', { name: '保存任务草稿', exact: true }).isDisabled(), true);
    await notes.fill(''); await panel.getByRole('button', { name: '保存任务草稿', exact: true }).click();
    await page.evaluate(ref => waitUntil(async () => Boolean((await store.getProject(ref)).chapter_tasks[2]?.latest_draft)), ref);
    project = await page.evaluate(ref => store.getProject(ref), ref); assert.equal(project.chapter_tasks[2].approved, null);
    await page.getByRole('button', { name: '批准草稿', exact: true }).click(); await page.evaluate(ref => waitUntil(async () => Boolean((await store.getProject(ref)).chapter_tasks[2]?.approved)), ref);
    await page.getByRole('tab', { name: /02.*场景计划/ }).click(); assert.equal(await title.inputValue(), 'SCENE_UNSAVED_SENTINEL');
    assert.equal(await panel.getByRole('button', { name: '保存场景草稿', exact: true }).isDisabled(), true); await title.fill(originalTitle);
    await panel.getByRole('button', { name: '保存场景草稿', exact: true }).click(); await page.evaluate(ref => waitUntil(async () => Boolean((await store.getProject(ref)).scene_plans[2]?.latest_draft)), ref);
    project = await page.evaluate(ref => store.getProject(ref), ref); assert.equal(project.scene_plans[2].approved, null);
    await page.getByRole('button', { name: '批准草稿', exact: true }).click(); await panel.getByRole('link', { name: '前往创作台', exact: true }).waitFor();
    assert.equal(calls.filter(call => call.operation === 'plan_chapter').length, 1);
  });

  await test('未知结果显式重试重新查capability选JSON，不混入前attempt轨迹', async ({ page, openUI, generateUI }) => {
    streamHandler = async session => session.end();
    const ref = await page.evaluate(() => makeProject()); await openUI(ref); await generateUI();
    await page.evaluate(ref => waitUntil(async () => (await store.getProject(ref)).runs.at(-1)?.status === 'interrupted'), ref);
    const first = await page.evaluate(ref => store.getProject(ref), ref), previousCaps = capabilityRequests;
    assert.equal(first.runs.at(-1).planning_trace.length, 3); capabilities = { ...fixtures.catalog };
    await page.evaluate(async ref => { const project = await store.getProject(ref); await wf.resumeLocalRun(ref, project.runs.at(-1).run_id); }, ref);
    const final = await page.evaluate(ref => store.getProject(ref), ref), plans = calls.filter(call => call.operation === 'plan_chapter');
    assert.deepEqual(plans.map(call => call.stream), [true, false]); assert.ok(capabilityRequests > previousCaps);
    assert.notEqual(final.runs.at(-1).attempt_id, first.runs.at(-1).attempt_id); assert.equal(final.runs.at(-1).status, 'completed');
    assert.equal(final.runs.at(-1).planning_trace?.length || 0, 0); await page.getByTestId('planning-final-nodes').waitFor();
    const count = plans.length;
    await page.evaluate(async ref => {
      await store.updateProject(ref, project => { const run = project.runs.at(-1); run.status = 'interrupted'; run.result_revision = project.revision; }, undefined, false);
      const project = await store.getProject(ref); await wf.resumeLocalRun(ref, project.runs.at(-1).run_id);
    }, ref);
    assert.equal(calls.filter(call => call.operation === 'plan_chapter').length, count);
  });

  await test('旧capability首发JSON兼容，仅显示最终nodes', async ({ page, openUI, generateUI }) => {
    capabilities = { ...fixtures.catalog };
    const ref = await page.evaluate(() => makeProject()); await openUI(ref); await generateUI();
    await page.getByTestId('planning-final-nodes').filter({ hasText: /仅有最终节点记录/ }).waitFor();
    const plans = calls.filter(call => call.operation === 'plan_chapter'); assert.equal(plans.length, 1); assert.equal(plans[0].stream, false);
    assert.equal(await page.getByTestId('planning-trace').count(), 0);
  });

  await test('损坏旧备份trace安全忽略，不显示任意节点文本', async ({ page, openUI, generateUI }) => {
    const ref = await page.evaluate(() => makeProject()); await openUI(ref); await generateUI();
    await page.evaluate(ref => waitUntil(async () => (await store.getProject(ref)).runs.at(-1)?.status === 'completed'), ref);
    await page.evaluate(async ref => {
      await store.updateProject(ref, project => { project.runs.at(-1).planning_trace = [{ event_version: 1, seq: 2, node: 'TRACE_UNSAFE_TEXT', visit: 1, status: 'started', elapsed_ms: 0, raw_state: 'TRACE_SECRET_SENTINEL' }]; }, undefined, false);
      window.dispatchEvent(new CustomEvent('braipen:workflow-changed', { detail: { projectRef: ref } }));
    }, ref);
    await page.getByTestId('planning-execution').getByText('节点记录格式无效，已安全忽略。', { exact: true }).waitFor();
    const text = await page.getByTestId('planning-execution').innerText(); assert.ok(!text.includes('TRACE_UNSAFE_TEXT')); assert.ok(!text.includes('TRACE_SECRET_SENTINEL'));
    assert.equal(await page.getByTestId('planning-trace').count(), 0); assert.equal(calls.filter(call => call.operation === 'plan_chapter').length, 1);
  });

  await test('切换章节取消旧流，晚到进度不进入新章节', async ({ page, openUI, generateUI }) => {
    const arrived = deferred(), gate = deferred(); streamHandler = async session => { arrived.resolve(session); await gate.promise; session.finish(); };
    const ref = await page.evaluate(() => makeProject()); await openUI(ref); await generateUI();
    const session = await bounded(arrived.promise, 'Old stream did not arrive');
    try {
      await page.getByTestId('planning-current-node').filter({ hasText: /起草提案.*正在执行/ }).waitFor();
      await page.getByRole('spinbutton', { name: '指定规划章节', exact: true }).fill('3'); await page.waitForURL('**/review?chapter=3');
      await bounded(session.closed, 'Chapter switch did not close old stream'); gate.resolve();
      await page.evaluate(ref => waitUntil(async () => !(await store.getProject(ref)).runs.some(run => run.status === 'running')), ref);
      const project = await page.evaluate(ref => store.getProject(ref), ref);
      assert.equal(await page.getByTestId('planning-execution').count(), 0); assert.equal(project.chapters[3], undefined);
      assert.deepEqual(project.chapter_tasks, {}); assert.deepEqual(project.scene_plans, {}); assert.equal(project.runs.at(-1).planning_trace.length, 3);
    } finally { gate.resolve(); }
  });

  await test('流中目标身份错误不应用done，只保留已验证前缀', async ({ page, openUI, generateUI }) => {
    streamHandler = async session => { session.send({ ...session.events[4], chapter_number: 3 }); session.finish(); };
    const ref = await page.evaluate(() => makeProject()); await openUI(ref); const before = await page.evaluate(ref => store.getProject(ref), ref); await generateUI();
    await page.evaluate(ref => waitUntil(async () => (await store.getProject(ref)).runs.at(-1)?.status === 'interrupted'), ref);
    const project = await page.evaluate(ref => store.getProject(ref), ref);
    assert.equal(project.revision, before.revision); assert.equal(project.runs.at(-1).result, undefined); assert.equal(project.runs.at(-1).planning_trace.length, 3);
    assert.deepEqual(project.chapter_tasks, {}); assert.deepEqual(project.scene_plans, {}); assert.equal(calls.filter(call => call.operation === 'plan_chapter').length, 1);
  });

  console.log(`PASS ${results.filter(result => result.status === 'passed').length}/${results.length} planning progress scenarios`);
} finally {
  await mkdir(report, { recursive: true }); await writeFile(join(report, 'browser-planning-progress.json'), JSON.stringify({ browser: process.env.BRAIPEN_BROWSER || 'msedge', offline: true, real_model_calls: 0, real_chunked_http: true, scenarios: results }, null, 2));
  for (const session of sessions) session.destroy(); await browser?.close(); await server.close();
}
