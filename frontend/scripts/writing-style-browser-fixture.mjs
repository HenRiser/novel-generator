import * as store from '/src/localStore.ts';
import * as workflow from '/src/localWorkflow.ts';
import * as style from '/src/writingStyle.ts';
import { emptyProject } from '/src/localTypes.ts';
import { ensureConnections, storeConnectionKey } from '/src/providerConnections.ts';
import { rememberProject } from '/src/workspacePreferences.ts';
import { extractWritingStyle } from '/src/writingStyleClient.ts';
import { localContinue, localRequest, readiness } from '/src/localApi.ts';
import { decodeNovel } from '/src/novelImport.ts';

const status = document.querySelector('#status'), results = document.querySelector('#results'), links = document.querySelector('#links');
const request = { model: 'deepseek-v4-flash', temperature: .7, max_tokens: 4000 }, checks = [];
const check = (condition, message) => { if (!condition) throw new Error(message); checks.push(message); const li = document.createElement('li'); li.textContent = '通过：' + message; results.append(li); };
const mode = value => fetch('/__style-test/mode', { method: 'POST', body: JSON.stringify({ mode: value }) });
async function project(title = '文风验收项目') {
  const p = emptyProject(title, { title, genre: '都市', style: '原有风格描述', protagonist: '合成主角', supporting_characters: '合成配角', worldview: '合成世界', core_conflict: '合成冲突', word_count_range: '3000-5000' });
  p.assets = { outline: '合成大纲', characters: '合成人物卡', setting_expansion: '' }; await store.putProject(p); return p;
}
function card(name = '克制冷幽默') {
  const c = style.createWritingStyle(name, '第三人称，旁白克制，以人物行动制造反差，笑点后留白。');
  c.examples = [{ id: 'example_' + crypto.randomUUID(), text: '门开了。他把辞职信换成了菜单。', source: { kind: 'manual', label: '合成验收片段' }, scene_tags: ['对话', '日常'], pov: '第三人称', pace: '低' }]; return c;
}
async function credentials() { await ensureConnections(); await storeConnectionKey('legacy-deepseek', 'sk-' + 's'.repeat(32), true); localStorage.setItem('braipen:intro-hidden', 'true'); }
async function seed() {
  await credentials(); await mode('ok');
  const p = await project('文风验收 · 取反'), q = await project('文风验收 · 独立项目'), a = await store.saveWritingStyle(card()), b = await store.saveWritingStyle(card('紧凑悬疑'));
  await store.selectProjectWritingStyle(p.project_ref, a);
  await store.updateProject(p.project_ref, draft => { workflow.setChapter(draft, 1, '# 第一章\n\n门开了。他把辞职信换成了菜单。', '确认过的正文'); Object.assign(draft.chapters[1].workflow, { status: 'confirmed', summary_status: 'ready', summary: '合成开场' }); });
  await store.updateProject(q.project_ref, draft => workflow.setChapter(draft, 1, '# 未确认章节\n\n未确认正文。', '未确认正文'));
  rememberProject(p.project_ref);
  sessionStorage.setItem('style-test-fixtures', JSON.stringify({ project: p.project_ref, other: q.project_ref, first: a.id, second: b.id }));
  links.innerHTML = ''; for (const [text, url] of [['打开文风库', '/settings?tab=styles'], ['打开创作台', '/writing?tab=generate&chapter=2'], ['查看模拟请求记录', '/__style-test/state']]) { const a = document.createElement('a'); a.textContent = text; a.href = url; a.style.marginRight = '20px'; links.append(a); }
  status.textContent = '样本就绪：两个本地项目、两张文风卡；所有模型请求均由本地模拟器处理。';
}
document.querySelector('#seed').onclick = () => { void seed().catch(e => status.textContent = '失败：' + e.message); };
document.querySelector('#run').onclick = async () => {
  results.textContent = ''; checks.length = 0; status.textContent = '验收中';
  try {
    await credentials(); await mode('ok');
    const p = await project('集成验收A'), q = await project('集成验收B'), a = await store.saveWritingStyle(card('集成文风A')), b = await store.saveWritingStyle(card('集成文风B'));
    await store.selectProjectWritingStyle(p.project_ref, a); check(!(await store.getProject(q.project_ref)).writing_style, '项目选择互不影响');
    await workflow.generateLocalChapter(p.project_ref, 1, { ...request, writing_style: b });
    let saved = await store.getProject(p.project_ref);
    check(saved.writing_style.id === a.id && saved.chapters[1].frozen_context.writing_style_context.card.id === b.id, '单章覆盖保存实际文风而不改项目默认');
    const continuation = await localContinue(p.project_ref, 1, { ...request, context_text: saved.chapters[1].content, instruction: '继续' }, {});
    const run = (await store.getProject(p.project_ref)).runs.at(-1);
    check(run.input.writing_style_context.card.id === b.id && continuation.content, '真实续写链路继承该章文风');
    await localRequest(`/api/projects/${encodeURIComponent(p.project_ref)}/chapters/1/continue/save`, { method: 'POST', body: JSON.stringify({ run_id: run.run_id, content: continuation.content, mode: 'append' }) });
    check((await store.getProject(p.project_ref)).chapters[1].frozen_context.writing_style_context.card.id === b.id, '续写保存后仍保留使用依据');
    await workflow.generateLocalChapter(p.project_ref, 1, { ...request, writing_style: 'none' }); saved = await store.getProject(p.project_ref);
    check(saved.chapters[1].frozen_context.writing_style_context === null && saved.chapters[1].versions.some(v => v.frozen_context?.writing_style_context?.card.id === b.id), '禁用卡与旧版本文风历史都保留');
    const updated = await store.saveWritingStyle({ ...a, rules: '库中新版规则' }, a.revision);
    check((await store.getProject(p.project_ref)).writing_style.revision === 1, '库中新版不自动应用到项目');
    await store.selectProjectWritingStyle(p.project_ref, updated);
    check((await store.getProject(p.project_ref)).writing_style.revision === 2, '项目主动更新后应用新版');
    const input = '门开了。他把辞职信换成了菜单。';
    const extracted = await extractWritingStyle(input, { kind: 'import', label: '合成参考.txt' }, 'legacy-deepseek', request.model);
    check(extracted.card.examples.length === 0 && extracted.candidates.length === 1 && input.includes(extracted.candidates[0].text), '提取结果只生成草稿，候选范例必须确认');
    await mode('bad-source'); let rejected = false;
    try { await extractWritingStyle(input, { kind: 'import', label: '合成参考' }, 'legacy-deepseek', request.model); } catch { rejected = true; }
    check(rejected, '无法核验的模型范例被客户端拒绝');
    await mode('failure'); rejected = false;
    try { await extractWritingStyle(input, { kind: 'import', label: '合成参考' }, 'legacy-deepseek', request.model); } catch (e) { rejected = e.message.includes('限流'); }
    check(rejected && (await store.getProject(p.project_ref)).writing_style.revision === 2, '模型限流不覆盖文风卡或项目设置');
    await mode('old-service'); rejected = false;
    try { await workflow.generateLocalChapter(q.project_ref, 1, { ...request, writing_style: b }); } catch (e) { rejected = e.message.includes('尚未支持'); }
    check(rejected && !(await store.getProject(q.project_ref)).chapters[1], '旧服务在正文生成前阻止忽略文风');
    await mode('ok');
    const readyInput = await store.getProject(q.project_ref); readyInput.config.style = ''; readyInput.writing_style = a;
    check((await readiness(readyInput, 1)).ready && (await readiness(readyInput, 1, 'selected')).ready && !(await readiness(readyInput, 1, 'none')).ready, '正文就绪校验按项目卡、单章卡和禁用三态执行');
    for (const choice of ['project', 'none']) {
      const legacy = await project('续写草稿边界验收'); await store.selectProjectWritingStyle(legacy.project_ref, b);
      await store.updateProject(legacy.project_ref, d => workflow.setChapter(d, 1, '旧章正文，尚无文风快照。'));
      await mode('stream-error');
      try { await localContinue(legacy.project_ref, 1, { ...request, writing_style: choice, context_text: '旧章正文', instruction: '继续' }, {}); } catch { /* Intentional mock stream interruption. */ }
      const pending = (await store.getProject(legacy.project_ref)).runs.at(-1); await workflow.resolveLocalRun(legacy.project_ref, pending.run_id, true);
      await store.selectProjectWritingStyle(legacy.project_ref, a);
      const chapter = (await store.getProject(legacy.project_ref)).chapters[1], ctx = chapter.frozen_context?.writing_style_context;
      check(choice === 'none' ? ctx === null : ctx?.card.id === b.id, `旧章中断续写草稿保存保留${choice === 'none' ? '显式禁用' : '原文风'}快照`);
    }
    await mode('ok');
    const backup = await store.createBackup(), refs = await store.restoreBackup(JSON.stringify(backup));
    check(backup.version === 4 && backup.writing_styles.length > 0 && refs.length === backup.projects.length, '真实IndexedDB备份v4完整恢复项目与文风库');
    check(!JSON.stringify(backup).includes('sk-' + 's'.repeat(32)), '备份不包含本地记住的合成Key');
    const decoded = decodeNovel(new Uint8Array([0xce, 0xc4, 0xb7, 0xe7])); check(decoded.normalized_text === '文风' && decoded.encoding === 'gb18030', 'GB18030参考正文按现有解码器读取');
    await mode('ok'); status.textContent = `全部通过：${checks.length} 项真实浏览器集成检查；外部模型调用 0 次。`;
  } catch (e) { status.textContent = '失败：' + e.message; await mode('ok'); console.error(e); }
};
