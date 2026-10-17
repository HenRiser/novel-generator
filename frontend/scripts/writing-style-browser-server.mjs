// Local-only browser fixture. Every API route terminates here; no upstream model IO.
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { providerFixtures, identity } from './provider-test-helpers.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]+$/, ''), fixtures = providerFixtures(root);
let mode = 'ok'; const calls = [];
const json = (res, value, status = 200) => { if (res.destroyed) return; res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
const server = await createServer({ root, define: { 'import.meta.env.VITE_API_BASE_URL': '""' }, server: { host: '127.0.0.1', port: 5177, strictPort: true }, logLevel: 'error', plugins: [{ name: 'writing-style-local-fixture', configureServer(s) {
  s.middlewares.use(async (req, res, next) => {
    const path = req.url?.split('?')[0] || '';
    if (path === '/__writing-style-test') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>文风功能本地验收</title><style>body{font:16px/1.8 system-ui;margin:32px;max-width:1000px}button{padding:12px;margin:8px}li{margin:8px}pre{white-space:pre-wrap}</style><h1>文风功能本地验收</h1><p>仅合成资料、真实 IndexedDB 和模拟模型。不会连接外部模型服务。</p><button id="seed">建立可视验收样本</button><button id="run">运行浏览器集成验收</button><p id="status">就绪</p><ul id="results"></ul><div id="links"></div><script type="module" src="/scripts/writing-style-browser-fixture.mjs"></script></html>'); return; }
    if (path === '/__style-test/mode') { let raw = ''; for await (const chunk of req) raw += chunk; mode = JSON.parse(raw || '{}').mode || 'ok'; json(res, { mode }); return; }
    if (path === '/__style-test/state') { json(res, { mode, calls }); return; }
    if (!path.startsWith('/api/')) { next(); return; }
    if (path.endsWith('/health')) { json(res, { status: 'ok' }); return; }
    if (path === '/api/capabilities') { json(res, { ...fixtures.catalog, operations: ['extract_style_card', 'distill_style_step', 'generate_chapter', 'continue_chapter'], stream_operations: ['generate_chapter', 'continue_chapter'], ...(mode !== 'old-service' ? { writing_style: { version: 1, distillation: { version: 1, max_rounds: 5, max_output_tokens: 20000 } } } : {}) }); return; }
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 1024 * 1024) { json(res, { error: { message: '测试请求过大' } }, 413); return; } }
    let p; try { p = JSON.parse(raw || '{}'); } catch { json(res, { error: { message: '测试请求无效' } }, 400); return; }
    const op = path.split('/compute/')[1]?.split('/')[0];
    try {
      if (op === 'validate_connection') { json(res, { ...identity(p), result: { connection: fixtures.normalize(p.connection) } }); return; }
      if (p.connection && p.request_fingerprint !== fixtures.requestFingerprint(p, op)) { json(res, { error: { message: '测试发现前后端请求指纹不一致' } }, 400); return; }
      calls.push({ operation: op, input: p.input });
      if (mode === 'failure') { json(res, { error: { message: '模拟模型限流，请稍后重试；原有文风卡保留。' } }, 429); return; }
      if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 3000));
      let result;
      if (op === 'extract_style_card' || op === 'distill_style_step') {
        if (mode === 'round3-failure' && p.input.round_number === 3) { json(res, { error: { message: '模拟第三轮模型失败，最近有效草稿保留。' } }, 502); return; }
        const text = p.input.source_text, snippet = Array.from(text).slice(0, 400).join('');
        result = { name: '从正文提取的克制文风', rules: `第三人称叙述。以动作呈现判断，短句收尾，笑点后留白；不增加参考作品的剧情设定。第${p.input.round_number || 1}轮核验。`, candidate_examples: [{ id: 'example_' + Date.now(), text: mode === 'bad-source' ? '这不是原文中的片段。' : snippet, source: p.input.source, scene_tags: ['对话', '日常'], pov: '第三人称', pace: '低' }], warnings: [] };
      } else if (op === 'generate_chapter' || op === 'continue_chapter') result = { content: `# 第 ${p.input.chapter_number || 1} 章：模拟验收\n\n门开了。他把辞职信换成了菜单。这是合成测试正文。`, title: '模拟验收', frozen_context: { narrative_context_text: '', writing_style_context: mode === 'wrong-context' ? null : p.input.writing_style_context ?? null } };
      else if (op === 'summarize_chapter') result = { summary: '合成测试章节完成。', warnings: [], review_status: 'ready' };
      else if (op === 'context_pack') result = { ok: true, prompt_text: '', context_pack: { selected_nodes: [], selected_edges: [], warnings: [] } };
      else { json(res, { error: { message: '本地测试未配置此操作，已阻止外部调用。' } }, 404); return; }
      if (path.endsWith('/stream')) { res.setHeader('Content-Type', 'application/x-ndjson'); res.end([{ ...identity(p), type: 'started', frozen_context: result.frozen_context }, { ...identity(p), type: 'delta', text: result.content }, mode === 'stream-error' ? { ...identity(p), type: 'error', message: '模拟流中断，草稿保留。' } : { ...identity(p), type: 'done', result, metrics: { call_count: 1 } }].map(e => JSON.stringify(e)).join('\n') + '\n'); }
      else json(res, { ...identity(p), result, metrics: { call_count: 1 } });
    } catch (error) { json(res, { error: { message: error.message } }, 400); }
  });
} }] });
await server.listen();
console.log('Local mock UI ready at http://127.0.0.1:5177/__writing-style-test (no upstream calls).');
