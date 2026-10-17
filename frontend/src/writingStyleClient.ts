import { compute, newIdentity } from './computeClient';
import { capabilities, acquireConnection, resolveConnection } from './providerConnections';
import { createWritingStyle, STYLE_LIMITS, styleCharacters, validateStyleExample, validateStyleSource, validateWritingStyle, type StyleExample, type StyleSource } from './writingStyle';

export const DISTILLATION_STAGES = ['提取整体文风', '整理语言与段落', '梳理对白与节奏', '汇总文风卡', '核对原文'] as const;
type ExtractionResult = { card: ReturnType<typeof createWritingStyle>; candidates: StyleExample[]; warnings: string[] };

export async function requireWritingStyleSupport(signal?: AbortSignal): Promise<void> {
  const caps = await capabilities(true, signal);
  if (caps.writing_style?.version !== 1) throw new Error('当前服务尚未支持文风卡生成，请更新服务后重试。本地编辑和导入仍可使用。');
}
function checkInput(text: string, source: StyleSource) {
  if (!text.trim()) throw new Error('请先选择或粘贴一章正文。');
  if (styleCharacters(text) > STYLE_LIMITS.analysis) throw new Error('正文超过 20,000 字符，已拒绝提交。请在其他工具中整理为单章后重新输入。');
  validateStyleSource(source);
  if (source.kind === 'project' && source.chapter_numbers?.length !== 1) throw new Error('一次只可分析一章，请选择一个章节。');
}
function readResult(result: Record<string, unknown>, text: string, source: StyleSource): ExtractionResult {
  if (typeof result.name !== 'string' || typeof result.rules !== 'string' || !Array.isArray(result.candidate_examples) || result.candidate_examples.length > 6
    || !Array.isArray(result.warnings) || result.warnings.some(w => typeof w !== 'string')) throw new Error('模型返回的文风分析结果无效，当前草稿保留。');
  const card = createWritingStyle(result.name, result.rules, source); validateWritingStyle(card);
  const candidates: StyleExample[] = [], seen = new Set<string>();
  for (const example of result.candidate_examples) {
    validateStyleExample(example);
    if (!text.includes(example.text) || JSON.stringify(example.source) !== JSON.stringify(source)) throw new Error('候选范例与所选原文不匹配，未加入文风库。');
    if (!seen.has(example.text)) { candidates.push(example); seen.add(example.text); }
  }
  return { card, candidates, warnings: result.warnings as string[] };
}
export async function extractWritingStyle(sourceText: string, source: StyleSource, connectionId?: string, model?: string, signal?: AbortSignal) {
  checkInput(sourceText, source); await requireWritingStyleSupport(signal); signal?.throwIfAborted();
  const { result } = await compute('extract_style_card', { source_text: sourceText, source: structuredClone(source), config: { ...(connectionId ? { connection_id: connectionId } : {}), ...(model ? { model } : {}) } }, newIdentity(), signal);
  signal?.throwIfAborted(); return readResult(result, sourceText, source);
}

/** One user task, at most five calls; each step carries only the last verified draft. */
export async function distillWritingStyle(sourceText: string, source: StyleSource, connectionId?: string, model?: string, signal?: AbortSignal,
  handlers: { onProgress?: (round: number, stage: string) => void; onDraft?: (value: ExtractionResult, round: number) => void } = {}): Promise<ExtractionResult> {
  checkInput(sourceText, source); signal?.throwIfAborted();
  const caps = await capabilities(true, signal), support = caps.writing_style?.distillation;
  if (support?.version !== 1 || support.max_rounds !== 5 || support.max_output_tokens !== 20000 || !caps.operations?.includes('distill_style_step')) throw new Error('当前服务尚未支持五轮文风提取，请更新服务后重试。');
  const connection = await resolveConnection(connectionId, model), lease = await acquireConnection(connection, signal);
  const task = newIdentity();
  let value: ExtractionResult | undefined, previous: Record<string, unknown> | null = null;
  try {
    for (let round = 1; round <= DISTILLATION_STAGES.length; round++) {
      signal?.throwIfAborted(); await lease.check();
      handlers.onProgress?.(round, DISTILLATION_STAGES[round - 1]);
      const { result } = await compute('distill_style_step', { source_text: sourceText, source: structuredClone(source), round_number: round, previous_draft: previous },
        { ...newIdentity(), run_id: task.run_id }, signal, undefined, lease);
      signal?.throwIfAborted(); await lease.check();
      value = readResult(result, sourceText, source);
      previous = { name: value.card.name, rules: value.card.rules, examples: value.candidates.map(({ text, scene_tags, pov, pace }) => ({ text, scene_tags, pov, pace })) };
      handlers.onDraft?.(value, round);
    }
    return value!;
  } finally { lease.close(); }
}
