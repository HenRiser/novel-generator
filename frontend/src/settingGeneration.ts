export const SETTING_RESULT_FIELDS = {
  protagonist: 'protagonist_setting',
  supporting_characters: 'supporting_characters_setting',
  worldview: 'world_setting',
  core_conflict: 'core_conflict',
} as const;
export type SettingField = keyof typeof SETTING_RESULT_FIELDS;
export type SettingGenerationOptions = { selected_fields: SettingField[]; draft?: Record<string, string> };
const DRAFT_FIELDS = ['raw_story_idea', ...Object.keys(SETTING_RESULT_FIELDS), 'genre', 'style', 'word_count_range'];

export function settingGenerationFields(request: Record<string, unknown>): SettingField[] {
  if (request.selected_fields === undefined) return Object.keys(SETTING_RESULT_FIELDS) as SettingField[];
  const fields = request.selected_fields;
  if (!Array.isArray(fields) || !fields.length || fields.some(field => typeof field !== 'string' || !Object.prototype.hasOwnProperty.call(SETTING_RESULT_FIELDS, field)) || new Set(fields).size !== fields.length) {
    throw new Error('请选择要生成的设定：主角、配角、世界观或核心冲突。');
  }
  return [...fields] as SettingField[];
}

function settingDraft(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([key, text]) => !DRAFT_FIELDS.includes(key) || typeof text !== 'string')) throw new Error('当前编辑的设定格式无效，请检查后重试。');
  return { ...value } as Record<string, string>;
}

export function settingGenerationRequest(request: Record<string, unknown>): Record<string, unknown> {
  settingGenerationFields(request);
  if (typeof request.raw_story_idea !== 'string' || !request.raw_story_idea.trim()) throw new Error('请先填写白话故事设想。');
  return { ...request, ...(request.selected_fields !== undefined ? { selected_fields: settingGenerationFields(request) } : {}), ...(request.draft !== undefined ? { draft: settingDraft(request.draft) } : {}) };
}

export function applySettingGeneration(config: Record<string, unknown>, result: Record<string, unknown>, request: Record<string, unknown>): Record<string, unknown> {
  const fields = settingGenerationFields(request), draft = settingDraft(request.draft);
  const data = result.expanded_data;
  if (!data || typeof data !== 'object' || Array.isArray(data) || fields.some(field => typeof (data as Record<string, unknown>)[SETTING_RESULT_FIELDS[field]] !== 'string' || !String((data as Record<string, unknown>)[SETTING_RESULT_FIELDS[field]]).trim())) throw new Error('扩写结果字段不完整。');
  const generated = Object.fromEntries(fields.map(field => [field, (data as Record<string, unknown>)[SETTING_RESULT_FIELDS[field]]]));
  return { ...config, ...draft, ...(typeof request.raw_story_idea === 'string' ? { raw_story_idea: request.raw_story_idea } : {}), ...generated };
}
