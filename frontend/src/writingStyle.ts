/** Local writing rules and approved examples; no model calls or persistence here. */
export const STYLE_LIMITS = { analysis: 20_000, rules: 6000, examples: 100, example: 2000, selectedExamples: 3, selectedCharacters: 2000 } as const;
export type StyleSource = { kind: 'manual' | 'project' | 'import'; label: string; project_ref?: string; chapter_numbers?: number[] };
export type StyleExample = { id: string; text: string; source: StyleSource; scene_tags: string[]; pov: string; pace: string };
export type WritingStyleCard = { version: 1; id: string; revision: number; name: string; rules: string; source: StyleSource; examples: StyleExample[]; updated_at: string };
export type WritingStyleContext = { version: 1; card: Omit<WritingStyleCard, 'version' | 'examples' | 'updated_at'>; examples: StyleExample[] };
export type WritingStyleChoice = 'project' | 'none' | WritingStyleCard;
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
export const styleCharacters = (v: string) => Array.from(v).length;
const text = (v: unknown, max: number, required = false): v is string => typeof v === 'string' && styleCharacters(v) <= max && (!required || Boolean(v.trim())) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
const fields = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && /^[\w:-]{1,200}$/.test(v);

export function validateStyleSource(v: unknown): asserts v is StyleSource {
  if (!object(v) || !fields(v, ['kind', 'label', 'project_ref', 'chapter_numbers']) || !['manual', 'project', 'import'].includes(String(v.kind)) || !text(v.label, 300, true)
    || (v.project_ref !== undefined && !text(v.project_ref, 200, true)) || (v.chapter_numbers !== undefined && (!Array.isArray(v.chapter_numbers) || v.chapter_numbers.length > 2000 || v.chapter_numbers.some(n => !Number.isSafeInteger(n) || Number(n) < 1)))) throw new Error('文风来源无效，请填写来源名称并检查所选章节。');
}
export function validateStyleExample(v: unknown): asserts v is StyleExample {
  if (!object(v) || !fields(v, ['id', 'text', 'source', 'scene_tags', 'pov', 'pace']) || !id(v.id) || !text(v.text, STYLE_LIMITS.example, true)
    || !Array.isArray(v.scene_tags) || v.scene_tags.length > 8 || v.scene_tags.some(tag => !text(tag, 50, true)) || !text(v.pov, 50) || !text(v.pace, 50)) throw new Error('范例需为完整非空段落，每段最多 2,000 字符，场景标签最多 8 个。');
  validateStyleSource(v.source);
}
export function validateWritingStyle(v: unknown): asserts v is WritingStyleCard {
  if (!object(v) || !fields(v, ['version', 'id', 'revision', 'name', 'rules', 'source', 'examples', 'updated_at']) || v.version !== 1 || !id(v.id) || !Number.isSafeInteger(v.revision) || Number(v.revision) < 1
    || !text(v.name, 120, true) || !text(v.rules, STYLE_LIMITS.rules, true) || !text(v.updated_at, 100, true) || !Number.isFinite(Date.parse(v.updated_at))
    || !Array.isArray(v.examples) || v.examples.length > STYLE_LIMITS.examples) throw new Error('文风卡格式无效：名称不能为空，规则须为 1–6,000 字符，范例最多 100 段。');
  validateStyleSource(v.source);
  const ids = new Set<string>();
  for (const example of v.examples) { validateStyleExample(example); if (ids.has(example.id)) throw new Error('文风卡包含重复的范例标识。'); ids.add(example.id); }
}
export function validateStyleContext(v: unknown): asserts v is WritingStyleContext {
  if (!object(v) || !fields(v, ['version', 'card', 'examples']) || v.version !== 1 || !object(v.card) || !Array.isArray(v.examples) || v.examples.length > STYLE_LIMITS.selectedExamples) throw new Error('生成使用的文风上下文无效。');
  validateWritingStyle({ ...v.card, version: 1, examples: v.examples, updated_at: new Date(0).toISOString() });
  if (v.examples.reduce((n, e) => n + styleCharacters((e as StyleExample).text), 0) > STYLE_LIMITS.selectedCharacters) throw new Error('生成范例总量不得超过 2,000 字符。');
}
export function createWritingStyle(name = '', rules = '', source: StyleSource = { kind: 'manual', label: '手动编写' }, examples: StyleExample[] = []): WritingStyleCard {
  return { version: 1, id: `style_${crypto.randomUUID()}`, revision: 1, name, rules, source: structuredClone(source), examples: structuredClone(examples), updated_at: new Date().toISOString() };
}
export function exportWritingStyle(card: WritingStyleCard): string {
  validateWritingStyle(card);
  return JSON.stringify({ format: 'braipen-style-card', version: 1, card }, null, 2);
}
export function importWritingStyle(content: string): WritingStyleCard {
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new Error('文风卡 JSON 无法解析，请选择 Braipen 导出的文风卡文件。'); }
  if (!object(value) || !fields(value, ['format', 'version', 'card']) || value.format !== 'braipen-style-card' || value.version !== 1) throw new Error('请选择版本受支持的 Braipen 文风卡；正文请使用“根据导入文本生成”。');
  validateWritingStyle(value.card);
  return createWritingStyle(value.card.name, value.card.rules, value.card.source, value.card.examples.map(example => ({ ...example, id: `example_${crypto.randomUUID()}` })));
}

/** Small curated libraries use deterministic tag matching, without embedding calls. */
export function writingStyleContext(card: WritingStyleCard, task?: unknown, plan?: unknown): WritingStyleContext {
  validateWritingStyle(card);
  const t = object(task) ? task : {}, p = object(plan) ? plan : {};
  const sceneTags = [t.primary_function, ...(Array.isArray(t.allowed_scene_types) ? t.allowed_scene_types : []), ...(Array.isArray(p.scenes) ? p.scenes.flatMap(s => object(s) ? [s.scene_function] : []) : [])].filter(v => typeof v === 'string').map(v => (v as string).trim().toLocaleLowerCase());
  const matches = (tag: string, values: string[]) => Boolean(tag.trim()) && values.some(value => value === tag.trim().toLocaleLowerCase() || value.includes(tag.trim().toLocaleLowerCase()));
  const pov = String(t.pov || t.narrative_pov || ''), pace = String(t.intensity || t.pace || '');
  const ranked = card.examples.map(example => ({ example, score: [Number(example.scene_tags.some(tag => matches(tag, sceneTags))), Number(matches(example.pov, [pov.toLowerCase()])), Number(matches(example.pace, [pace.toLowerCase()]))] }));
  ranked.sort((a, b) => b.score[0] - a.score[0] || b.score[1] - a.score[1] || b.score[2] - a.score[2] || (a.example.id < b.example.id ? -1 : a.example.id > b.example.id ? 1 : 0));
  const examples: StyleExample[] = []; let characters = 0;
  for (const { example } of ranked) {
    const length = styleCharacters(example.text);
    if (examples.length < STYLE_LIMITS.selectedExamples && characters + length <= STYLE_LIMITS.selectedCharacters) { examples.push(structuredClone(example)); characters += length; }
  }
  const { version: _version, examples: _examples, updated_at: _updated, ...identity } = card;
  return { version: 1, card: structuredClone(identity), examples };
}

/** Remap only structured style references; never replace words in prose or rules. */
export function remapWritingStyleIds(value: unknown, ids: Map<string, string>): void {
  if (Array.isArray(value)) { value.forEach(item => remapWritingStyleIds(item, ids)); return; }
  if (!object(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'writing_style' && object(item) && typeof item.id === 'string') item.id = ids.get(item.id) ?? item.id;
    if (key === 'writing_style_context' && object(item) && object(item.card) && typeof item.card.id === 'string') item.card.id = ids.get(item.card.id) ?? item.card.id;
    remapWritingStyleIds(item, ids);
  }
}
