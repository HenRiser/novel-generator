import { compute, newIdentity } from './computeClient';
import { capabilities } from './providerConnections';
import { createWritingStyle, STYLE_LIMITS, styleCharacters, validateStyleExample, validateStyleSource, validateWritingStyle, type StyleExample, type StyleSource } from './writingStyle';

export async function requireWritingStyleSupport(signal?: AbortSignal): Promise<void> {
  const caps = await capabilities(true, signal);
  if (caps.writing_style?.version !== 1) throw new Error('当前服务尚未支持文风卡生成，请更新服务后重试。本地编辑和导入仍可使用。');
}

export async function extractWritingStyle(sourceText: string, source: StyleSource, connectionId?: string, model?: string, signal?: AbortSignal) {
  if (!sourceText.trim()) throw new Error('请先选择或粘贴要分析的小说正文。');
  if (styleCharacters(sourceText) > STYLE_LIMITS.analysis) throw new Error('分析材料超过 20,000 字符，请缩小编辑框中的实际提交范围。');
  validateStyleSource(source); await requireWritingStyleSupport(signal); signal?.throwIfAborted();
  const { result } = await compute('extract_style_card', { source_text: sourceText, source: structuredClone(source), config: { ...(connectionId ? { connection_id: connectionId } : {}), ...(model ? { model } : {}) } }, newIdentity(), signal);
  signal?.throwIfAborted();
  if (typeof result.name !== 'string' || typeof result.rules !== 'string' || !Array.isArray(result.candidate_examples) || result.candidate_examples.length > 6
    || !Array.isArray(result.warnings) || result.warnings.some(w => typeof w !== 'string')) throw new Error('模型返回的文风分析结果无效，当前草稿保留。');
  const card = createWritingStyle(result.name, result.rules, source); validateWritingStyle(card);
  const candidates: StyleExample[] = [], seen = new Set<string>();
  for (const example of result.candidate_examples) {
    validateStyleExample(example);
    if (!sourceText.includes(example.text) || JSON.stringify(example.source) !== JSON.stringify(source)) throw new Error('候选范例与所选材料不匹配，未加入文风库。');
    if (!seen.has(example.text)) { candidates.push(example); seen.add(example.text); }
  }
  return { card, candidates, warnings: result.warnings as string[] };
}
