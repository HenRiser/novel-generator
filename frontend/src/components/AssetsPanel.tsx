import { useCallback, useEffect, useState, useRef } from "react";
import { Alert, Empty, Spin, Tabs, Typography, Button, Input, Space } from "antd";
import { getProjectCharacters, getProjectOutline, expandProjectSetting, updateProjectConfig, getProject } from "../api";
import { useAppStore } from "../store/useAppStore";

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
  const controller = useRef<AbortController | null>(null);
  const fieldLabels: Record<string, string> = { raw_story_idea: '白话故事设想', protagonist: '主角', supporting_characters: '配角', worldview: '世界观', core_conflict: '核心冲突', genre: '类型', style: '风格', word_count_range: '单章字数' };
  useEffect(() => {
    setSetting(Object.fromEntries(Object.keys(fieldLabels).map(key => [key, String(selectedProject?.config[key] || (key === 'raw_story_idea' ? selectedProject?.config.seed_prompt : '') || '')])));
  }, [selectedProject]);
  useEffect(() => () => { controller.current?.abort(); }, [selectedProjectRef]);
  async function saveSetting(expand: boolean) {
    if (!selectedProjectRef) return;
    const ref = selectedProjectRef; setSaving(true); setError('');
    try {
      if (expand) { controller.current = new AbortController(); await expandProjectSetting(ref, setting.raw_story_idea || '', controller.current.signal); }
      else await updateProjectConfig(ref, setting);
      if (useAppStore.getState().selectedProjectRef === ref) useAppStore.getState().setSelectedProject(await getProject(ref));
    } catch (e) { if (useAppStore.getState().selectedProjectRef === ref) setError(e instanceof Error ? e.message : '设定未保存。'); }
    finally { if (useAppStore.getState().selectedProjectRef === ref) setSaving(false); }
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
              {Object.entries(fieldLabels).map(([key, label]) => <label key={key} style={{ display: 'block', width: '100%' }}>{label}<Input.TextArea value={setting[key] || ''} disabled={saving} onChange={event => setSetting(value => ({ ...value, [key]: event.target.value }))} autoSize={{ minRows: 2, maxRows: 8 }} /></label>)}
              <Space wrap><Button disabled={saving} onClick={() => void saveSetting(false)}>保存设定</Button><Button type="primary" loading={saving} disabled={apiStatus !== 'online' || !(setting.raw_story_idea || '').trim()} onClick={() => void saveSetting(true)}>扩写并保存设定 · 调用模型</Button>{saving && <Button onClick={() => controller.current?.abort()}>中断</Button>}</Space>
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
