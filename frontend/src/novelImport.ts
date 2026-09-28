import type { ConnectionSnapshot } from './providerTypes';
import { emptyProject, type LocalProject } from './localTypes';

export const IMPORT_LIMITS = { bytes: 10 * 1024 * 1024, chapters: 50, characters: 200000, chapterCharacters: 20000 };
export type ImportEncoding = 'utf-8' | 'gb18030';
export type ChapterBoundary = { title: string; start_line: number };
export type ImportCandidate = {
  id: string; kind: 'characters' | 'relationships' | 'facts' | 'foreshadows';
  label: string; summary: string; aliases: string[]; evidence: string;
  source_chapter: number; source_hash: string;
  status: 'pending' | 'accepted' | 'rejected'; provenance: 'source_fact' | 'user_setting';
};
export type ImportChapterResult = { summary: string; candidates: ImportCandidate[]; warnings: string[]; reviewed: boolean };
export type ImportDraft = {
  connection?: ConnectionSnapshot; connection_history?: ConnectionSnapshot[];
  id: string; schema_version: 1; revision: number; title: string; filename: string;
  original_base64: string; encoding: ImportEncoding; normalized_text: string; normalized_hash: string;
  boundaries: ChapterBoundary[]; prefix: number; updated_at: string;
  phase: 'preview' | 'extract' | 'review' | 'synthesize' | 'ready' | 'committed';
  results: Record<string, ImportChapterResult>; synthesis?: Record<string, unknown>;
  attempt?: { step_id: string; attempt_id: string; chapter: number | null; status: 'running' | 'interrupted' | 'completed'; };
  error: string; project_ref?: string;
};
const kinds = ['characters', 'relationships', 'facts', 'foreshadows'] as const;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
export const characterCount = (value: string) => Array.from(value.replace(/\s/g, '')).length;

export async function textHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function bytesToBase64(bytes: Uint8Array): string {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) result += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(result);
}
export function originalBytes(draft: ImportDraft): Uint8Array {
  return Uint8Array.from(atob(draft.original_base64), char => char.charCodeAt(0));
}
export function decodeNovel(bytes: Uint8Array, requested?: ImportEncoding): { encoding: ImportEncoding; normalized_text: string } {
  if (!bytes.length || bytes.length > IMPORT_LIMITS.bytes) throw new Error('文件必须非空，且不超过 10 MiB。');
  const decode = (encoding: ImportEncoding) => new TextDecoder(encoding, { fatal: true }).decode(bytes);
  let encoding = requested || 'utf-8';
  let decoded: string;
  try { decoded = decode(encoding); }
  catch {
    if (requested) throw new Error(`无法按 ${requested} 解码，请切换编码并检查预览。`);
    encoding = 'gb18030';
    try { decoded = decode(encoding); } catch { throw new Error('文件不是有效 UTF-8 或 GB18030 文本。'); }
  }
  const normalized_text = decoded.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!normalized_text.trim() || normalized_text.includes('\0')) throw new Error('文件为空或包含非文本内容。');
  return { encoding, normalized_text };
}
export function detectBoundaries(value: string): ChapterBoundary[] {
  const lines = value.split('\n');
  const found: ChapterBoundary[] = [];
  lines.forEach((line, index) => {
    const heading = line.trim();
    if (/^(?:#{1,6}\s+)?第[零〇一二三四五六七八九十百千万两\d]+[章节回][\s　:：、.．]?.*$/.test(heading)
      || /^#{1,6}\s+(?:chapter\s+\d+|\d+[.、．\s]|序章|楔子|尾声)/i.test(heading)
      || /^(?:chapter\s+\d+|序章|楔子|尾声)(?:\s.*|[：:].*|$)/i.test(heading)) {
      found.push({ title: heading.replace(/^#{1,6}\s+/, ''), start_line: index + 1 });
    }
  });
  if (!found.length) return [{ title: '第一章', start_line: 1 }];
  if (found[0].start_line > 1) {
    if (lines.slice(0, found[0].start_line - 1).join('\n').trim()) found.unshift({ title: '序言', start_line: 1 });
    else found[0].start_line = 1;
  }
  return found;
}
export function boundaryDeclaration(boundaries: ChapterBoundary[]): string {
  return boundaries.map(boundary => `${boundary.start_line}|${boundary.title}`).join('\n');
}
export function parseBoundaries(value: string, normalized: string): ChapterBoundary[] {
  const total = normalized.split('\n').length;
  const boundaries = value.split('\n').filter(line => line.trim()).map(line => {
    const match = /^(\d+)\s*\|\s*(.+)$/.exec(line.trim());
    if (!match) throw new Error('每行填写“起始行号|章节标题”，例如 1|第一章。');
    return { start_line: Number(match[1]), title: match[2].trim() };
  });
  if (!boundaries.length || boundaries[0].start_line !== 1) throw new Error('第一章必须从第 1 行开始，以免丢弃原文。');
  boundaries.forEach((boundary, index) => {
    if (boundary.start_line > total || (index > 0 && boundary.start_line <= boundaries[index - 1].start_line)) throw new Error('章节起始行必须递增，且不能超过原文总行数。');
    if (boundary.title.length > 200) throw new Error('章节标题不能超过 200 字符。');
  });
  return boundaries;
}
export function importChapter(draft: Pick<ImportDraft, 'normalized_text' | 'boundaries'>, number: number) {
  if (!Number.isInteger(number) || number < 1 || number > draft.boundaries.length) throw new Error('章节编号无效。');
  const lines = draft.normalized_text.split('\n');
  const boundary = draft.boundaries[number - 1];
  return { chapter_number: number, title: boundary.title,
    content: lines.slice(boundary.start_line - 1, draft.boundaries[number]?.start_line ? draft.boundaries[number].start_line - 1 : lines.length).join('\n') };
}
export function validatePrefix(draft: Pick<ImportDraft, 'normalized_text' | 'boundaries' | 'prefix'>): void {
  if (!Number.isInteger(draft.prefix) || draft.prefix < 1 || draft.prefix > Math.min(IMPORT_LIMITS.chapters, draft.boundaries.length)) throw new Error('请选择从第 1 章开始、最多 50 章的连续前缀。');
  let total = 0;
  for (let number = 1; number <= draft.prefix; number++) {
    const count = characterCount(importChapter(draft, number).content);
    if (!count || count > IMPORT_LIMITS.chapterCharacters) throw new Error(`第 ${number} 章必须非空且不超过 2 万字；请先修正分章。`);
    total += count;
  }
  if (total > IMPORT_LIMITS.characters) throw new Error('选定前缀超过 20 万字，请减少章节数。');
}
export async function createImportDraft(filename: string, bytes: Uint8Array, requested?: ImportEncoding): Promise<ImportDraft> {
  if (!/\.(txt|md)$/i.test(filename)) throw new Error('只支持 TXT / MD 文件。');
  const decoded = decodeNovel(bytes, requested);
  return { id: crypto.randomUUID(), schema_version: 1, revision: 0,
    filename, title: filename.replace(/\.(txt|md)$/i, ''), original_base64: bytesToBase64(bytes), ...decoded,
    normalized_hash: await textHash(decoded.normalized_text), boundaries: detectBoundaries(decoded.normalized_text),
    prefix: 1, updated_at: new Date().toISOString(), phase: 'preview', results: {}, error: '' };
}
export async function chapterComputeInput(draft: ImportDraft, number: number): Promise<Record<string, unknown>> {
  validatePrefix(draft);
  if (number > draft.prefix) throw new Error('未选后文不能发送到模型。');
  const chapter = importChapter(draft, number);
  return { chapter_number: number, chapter: { content: chapter.content, title: chapter.title, revision: await textHash(chapter.content) } };
}
export async function reviewChapterResult(draft: ImportDraft, number: number, raw: Record<string, unknown>): Promise<ImportChapterResult> {
  const chapter = importChapter(draft, number);
  const hash = await textHash(chapter.content);
  const summary = text(raw.summary);
  if (!summary) throw new Error('章节摘要缺失；已完成的前章仍保留。');
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.filter((item): item is string => typeof item === 'string') : [];
  const candidates: ImportCandidate[] = [];
  for (const kind of kinds) {
    if (raw[kind] !== undefined && !Array.isArray(raw[kind])) throw new Error('候选知识不是数组，请人工重试本章。');
    for (const [index, value] of (Array.isArray(raw[kind]) ? raw[kind] as unknown[] : []).entries()) {
      const item = record(value), evidence = text(item.evidence);
      if (!evidence || !chapter.content.includes(evidence)) {
        warnings.push(`${kind} 第 ${index + 1} 项没有精确原文证据，已排除。`); continue;
      }
      const label = text(item.label) || text(item.name);
      if (!label || !text(item.summary)) { warnings.push('已排除缺少名称或描述的候选。'); continue; }
      candidates.push({ id: `${number}:${kind}:${index}`, kind, label, summary: text(item.summary), evidence,
        aliases: Array.isArray(item.aliases) ? item.aliases.filter((alias): alias is string => typeof alias === 'string').map(alias => alias.trim()).filter(Boolean) : [],
        source_chapter: number, source_hash: hash, status: 'pending', provenance: 'source_fact' });
    }
  }
  return { summary, candidates, warnings, reviewed: false };
}
export function aliasConflicts(draft: ImportDraft): string[] {
  const aliases = new Map<string, Set<string>>();
  for (const result of Object.values(draft.results)) for (const candidate of result.candidates) {
    if (candidate.kind !== 'characters' || candidate.status !== 'accepted') continue;
    for (const alias of new Set([candidate.label, ...candidate.aliases])) {
      const labels = aliases.get(alias) || new Set<string>(); labels.add(candidate.label); aliases.set(alias, labels);
    }
  }
  return [...aliases.entries()].filter(([, labels]) => labels.size > 1).map(([alias, labels]) => `${alias} → ${[...labels].join(' / ')}`);
}
export function synthesisComputeInput(draft: ImportDraft): Record<string, unknown> {
  validatePrefix(draft);
  if (aliasConflicts(draft).length) throw new Error('人物名称或别名存在冲突，请先修改或拒绝冲突条目；不会自动合并。');
  const results = Array.from({ length: draft.prefix }, (_, index) => {
    const result = draft.results[String(index + 1)];
    if (!result?.reviewed || !result.summary.trim() || result.candidates.some(candidate => candidate.status === 'pending')) throw new Error(`请完成第 ${index + 1} 章摘要和候选审核。`);
    return { chapter_number: index + 1, summary: result.summary,
      ...Object.fromEntries(kinds.map(kind => [kind, result.candidates.filter(candidate => candidate.kind === kind && candidate.status === 'accepted')])) };
  });
  return { title: draft.title, results };
}
export function readyErrors(synthesis: Record<string, unknown> | undefined): string[] {
  if (!synthesis) return ['尚未整理设定与写作资产。'];
  const config = record(synthesis.config), assets = record(synthesis.assets);
  const missing = ['genre', 'style', 'word_count_range', 'protagonist', 'supporting_characters', 'worldview', 'core_conflict'].filter(key => !text(config[key]));
  if (!text(assets.outline)) missing.push('outline');
  if (!text(assets.characters)) missing.push('characters');
  return missing.map(key => `缺少 ${key}`);
}
export async function buildImportedProject(draft: ImportDraft): Promise<LocalProject> {
  synthesisComputeInput(draft);
  const errors = readyErrors(draft.synthesis);
  if (errors.length) throw new Error(errors.join('；'));
  const synthesis = draft.synthesis!;
  const project = emptyProject(draft.title, { ...record(synthesis.config), ...(draft.connection ? { connection_id: draft.connection.profile_id, model: draft.connection.model } : {}) });
  const assets = record(synthesis.assets);
  project.assets = { outline: text(assets.outline), characters: text(assets.characters), setting_expansion: text(assets.setting_expansion) };
  // Reviewed source facts remain distinct from user-authored settings. No model-generated graph is trusted implicitly.
  project.source = { import_id: draft.id, filename: draft.filename, encoding: draft.encoding,
    original_base64: draft.original_base64, normalized_text: draft.normalized_text, normalized_hash: draft.normalized_hash,
    boundaries: draft.boundaries, prefix: draft.prefix, archive_local_only: true, reviewed_results: draft.results };
  const nodeTypes = { characters: 'character', relationships: 'relationship_note', facts: 'world_fact', foreshadows: 'foreshadowing' };
  for (const result of Object.values(draft.results)) for (const candidate of result.candidates) {
    if (candidate.status !== 'accepted' || candidate.source_chapter > draft.prefix) continue;
    project.graph.graph.nodes.push({ id: `import_${candidate.id.replace(/:/g, '_')}`, type: nodeTypes[candidate.kind],
      label: candidate.label, aliases: candidate.aliases, summary: candidate.summary, importance: 5, layer: 'detail',
      parent_id: null, status: 'active', tags: [], properties: {}, notes: '',
      source: { kind: candidate.provenance, chapter_number: candidate.source_chapter, source_hash: candidate.source_hash,
        evidence: candidate.provenance === 'source_fact' ? candidate.evidence : '', reviewed: true } });
  }
  for (let number = 1; number <= draft.prefix; number++) {
    const chapter = importChapter(draft, number), revision = await textHash(chapter.content);
    const filename = `chapter_${String(number).padStart(3, '0')}.md`;
    project.chapters[String(number)] = { ...chapter, filename, revision, versions: [], source_locked: true, connection: draft.connection,
      workflow: { project_ref: project.project_ref, chapter_number: number, revision, chapter_file: filename,
        content: chapter.content, status: 'confirmed', summary_status: 'ready', review_status: 'ready',
        summary_file: `chapter_${String(number).padStart(3, '0')}_summary.md`, summary: draft.results[String(number)].summary,
        error: '', review_error: '', warnings: [], editable: false, locked_by_chapter: null, lock_reason: '导入原文已锁定，请从下一章继续创作。' } };
  }
  project.events.push({ type: 'source_imported', chapters: draft.prefix, created_at: new Date().toISOString() });
  return project;
}
