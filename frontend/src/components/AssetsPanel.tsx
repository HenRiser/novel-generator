import { useCallback, useEffect, useState, useRef } from "react";
import { Alert, Empty, Spin, Tabs, Typography, Button, Checkbox, Input, Space } from "antd";
import { getProjectCharacters, getProjectOutline, expandProjectSetting, updateProjectConfig, getProject } from "../api";
import { useAppStore } from "../store/useAppStore";
import { SETTING_RESULT_FIELDS, type SettingField } from '../settingGeneration';

const fieldLabels: Record<string, string> = { raw_story_idea: '白话故事设想', protagonist: '主角', supporting_characters: '配角', worldview: '世界观', core_conflict: '核心冲突', genre: '类型', style: '风格', word_count_range: '单章字数' };
const generationFields = Object.keys(SETTING_RESULT_FIELDS) as SettingField[];
// Keep unsaved author edits during in-page navigation, including a trip to unlock a model connection.
const editingDrafts = new Map<string, { snapshot: string; values: Record<string, string>; fields: SettingField[] }>();

/**
 * 设定资产面板：展示项目大纲（novel_outline.md）与人物卡（characters.md）。
 * 生成后即可在此查看，无需打开文件。
 */
export default function AssetsPanel() {
  const { selectedProjectRef, selectedProject, apiStatus } = useAppStore();
  const [outline, setOutline] = useState<string>("");
  const [characters, setCharacters] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [setting, setSetting] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [selectedFields, setSelectedFields] = useState<SettingField[]>([]);
  const controller = useRef<AbortController | null>(null);
  const requestEpoch = useRef(0);
  const currentProject = selectedProject?.project_ref === selectedProjectRef ? selectedProject : null;
  const settingSnapshot = JSON.stringify(Object.fromEntries(Object.keys(fieldLabels).map(key => [key, String(currentProject?.config[key] || (key === 'raw_story_idea' ? currentProject?.config.seed_prompt : '') || '')])));
  useEffect(() => {
    const values = JSON.parse(settingSnapshot) as Record<string, string>;
    const cached = selectedProjectRef ? editingDrafts.get(selectedProjectRef) : undefined;
    if (cached?.snapshot === settingSnapshot) { setSetting({ ...cached.values }); setSelectedFields([...cached.fields]); }
    else { if (selectedProjectRef && currentProject) editingDrafts.delete(selectedProjectRef); setSetting(values); setSelectedFields(generationFields.filter(field => !values[field]?.trim())); }
  }, [selectedProjectRef, settingSnapshot]);
  useEffect(() => {
    requestEpoch.current++; controller.current?.abort(); controller.current = null; setSaving(false); setError('');
    return () => { requestEpoch.current++; controller.current?.abort(); };
  }, [selectedProjectRef]);
  useEffect(() => {
    let live = true, sequence = 0;
    const refresh = async (event: Event) => {
      if ((event as CustomEvent<{ projectRef: string }>).detail?.projectRef !== selectedProjectRef || !selectedProjectRef) return;
      const ticket = ++sequence, ref = selectedProjectRef;
      try {
        const saved = await getProject(ref), state = useAppStore.getState();
        if (live && ticket === sequence && state.selectedProjectRef === ref && JSON.stringify(state.selectedProject?.config) !== JSON.stringify(saved.config)) state.setSelectedProject(saved);
      } catch { if (live && ticket === sequence && useAppStore.getState().selectedProjectRef === ref) setError('设定读取失败，请重新选择此作品后重试。'); }
    };
    window.addEventListener('braipen:workflow-changed', refresh);
    return () => { live = false; sequence++; window.removeEventListener('braipen:workflow-changed', refresh); };
  }, [selectedProjectRef]);
  function rememberDraft(values = setting, fields = selectedFields) {
    if (selectedProjectRef && currentProject) editingDrafts.set(selectedProjectRef, { snapshot: settingSnapshot, values: { ...values }, fields: [...fields] });
  }
  async function saveSetting(expand: boolean, fields = selectedFields) {
    if (!selectedProjectRef) return;
    if (expand && !fields.length) { setError('请勾选要生成的设定，或点击某项旁的「用白话生成」。'); return; }
    const ref = selectedProjectRef, epoch = ++requestEpoch.current;
    const active = () => requestEpoch.current === epoch && useAppStore.getState().selectedProjectRef === ref;
    rememberDraft();
    setSaving(true); setError('');
    try {
      if (expand) { controller.current = new AbortController(); await expandProjectSetting(ref, setting.raw_story_idea || '', controller.current.signal, { selected_fields: fields, draft: { ...setting } }); }
      else await updateProjectConfig(ref, setting);
      const saved = await getProject(ref);
      if (active()) { editingDrafts.delete(ref); useAppStore.getState().setSelectedProject(saved); }
    } catch (e) { if (active()) setError(e instanceof Error ? e.message : '设定未保存。'); }
    finally { if (active()) { setSaving(false); controller.current = null; } }
  }


  const loadAssets = useCallback(async () => {
    if (!selectedProjectRef) {
      setOutline("");
      setCharacters("");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const [outlineResult, charactersResult] = await Promise.all([
        getProjectOutline(selectedProjectRef),
        getProjectCharacters(selectedProjectRef),
      ]);
      setOutline(outlineResult.content ?? "");
      setCharacters(charactersResult.content ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "设定资产加载失败。");
    } finally {
      setLoading(false);
    }
  }, [apiStatus, selectedProjectRef]);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  if (!selectedProjectRef) {
    return <Alert type="info" showIcon message="请先选择项目查看设定资产。" />;
  }
  if (!currentProject) return <Spin aria-label="正在读取故事设定" />;

  const renderMarkdownish = (content: string) => (
    <div
      style={{
        whiteSpace: "pre-wrap",
        fontSize: 13,
        lineHeight: 1.7,
        color: "#4a4036",
        maxHeight: "calc(100vh - 320px)",
        overflowY: "auto",
      }}
    >
      {content || <Empty description="尚未生成，请在生成面板中先生成大纲与人物卡。" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {error && <Alert type="error" showIcon message={error} closable onClose={() => setError("")} />}
      {loading && !outline && !characters ? (
        <div style={{ textAlign: "center", padding: 24 }}>
          <Spin />
        </div>
      ) : (
        <Tabs
          size="small"
          items={[
            { key: 'setting', label: '创作设定', children: <Space orientation="vertical" style={{ width: '100%' }}>
              <Typography.Text type="secondary">用白话设想生成空缺，或勾选要重新生成的项目。只替换所选内容，其他手写内容保留；生成会使用当前模型连接，可能计费。</Typography.Text>
              {Object.entries(fieldLabels).map(([key, label]) => <div key={key} style={{ width: '100%' }}>
                <Space wrap style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <label htmlFor={`story-setting-${key}`}>{label}</label>
                  {generationFields.includes(key as SettingField) && <Space wrap>
                    <Checkbox aria-label={`选择生成${label}`} checked={selectedFields.includes(key as SettingField)} disabled={saving} onChange={event => { const fields = event.target.checked ? [...selectedFields, key as SettingField] : selectedFields.filter(field => field !== key); setSelectedFields(fields); rememberDraft(setting, fields); }}>生成此项</Checkbox>
                    <Button size="small" aria-label={`用白话生成${label}`} disabled={saving || apiStatus !== 'online' || !(setting.raw_story_idea || '').trim()} onClick={() => void saveSetting(true, [key as SettingField])}>用白话生成</Button>
                  </Space>}
                </Space>
                <Input.TextArea id={`story-setting-${key}`} aria-label={label} value={setting[key] || ''} disabled={saving} onChange={event => { const values = { ...setting, [key]: event.target.value }; setSetting(values); rememberDraft(values); }} autoSize={{ minRows: 2, maxRows: 8 }} />
              </div>)}
              <Space wrap><Button disabled={saving} onClick={() => void saveSetting(false)}>保存设定</Button><Button type="primary" loading={saving} disabled={saving || !selectedFields.length || apiStatus !== 'online' || !(setting.raw_story_idea || '').trim()} onClick={() => void saveSetting(true)}>生成所选设定 · 调用模型</Button>{saving && <Button onClick={() => controller.current?.abort()}>中断</Button>}</Space>
            </Space> },
            {
              key: "outline",
              label: (
                <span>
                  小说大纲
                  <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>
                    novel_outline.md
                  </Typography.Text>
                </span>
              ),
              children: renderMarkdownish(outline),
            },
            {
              key: "characters",
              label: (
                <span>
                  人物卡
                  <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>
                    characters.md
                  </Typography.Text>
                </span>
              ),
              children: renderMarkdownish(characters),
            },
          ]}
        />
      )}
    </div>
  );
}
