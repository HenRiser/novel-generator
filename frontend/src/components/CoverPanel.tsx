import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AutoComplete, Button, Collapse, Empty, Input, InputNumber, Select, Space, Spin, Tag } from 'antd';
import { DownloadOutlined, PictureOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useAppStore } from '../store/useAppStore';
import { useCoverProject } from '../hooks/useCoverProject';
import { imageConnections, imageSnapshot, resolveImageConnection, acquireImageConnection, defaultImageConnectionId, imageProviderPresets, type ImageProviderPreset } from '../imageConnections';
import { requestImage } from '../imageClient';
import { defaultCoverLayout, getCoverBlob, saveCoverVersion, selectCoverVersion, saveCoverLayout, saveCoverConnection, saveCoverAttempt, MAX_COVER_VERSIONS } from '../coverStorage';
import { coverSource, initialCoverDirection, buildCoverPrompt, buildCoverEditPrompt, imageDataBlob, blobBase64, downloadCoverBlob, exportCover } from '../coverArtwork';
import type { ConnectionProfile } from '../providerTypes';
import type { CoverLayout } from '../coverTypes';
import { CoverPreview } from './CoverPreview';

type Draft = { direction: string; prompt: string; source: { idea: string; characters: string }; change: string };
const drafts = new Map<string, Draft>();
const plainLayout = defaultCoverLayout('');
export default function CoverPanel({ projectRef }: { projectRef: string }) {
  const { project, error: readError, refresh } = useCoverProject(projectRef);
  const apiStatus = useAppStore(s => s.apiStatus);
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]), [connectionId, setConnectionId] = useState(''), [model, setModel] = useState('');
  const [presets, setPresets] = useState<ImageProviderPreset[]>([]);
  const [draft, setDraft] = useState<Draft | null>(drafts.get(projectRef) || null), [layout, setLayout] = useState<CoverLayout | null>(null);
  const [previewId, setPreviewId] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false), [saving, setSaving] = useState(false), [exporting, setExporting] = useState(false);
  const [unsavedImage, setUnsavedImage] = useState<Blob | null>(null);
  const controller = useRef<AbortController | null>(null), live = useRef(true), layoutInitialized = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; controller.current?.abort(); }; }, []);
  const loadConnections = useCallback(async () => {
    try { const list = (await imageConnections()).filter(p => p.enabled && p.revisions.length); if (live.current) setProfiles(list); }
    catch (e) { if (live.current) setError(e instanceof Error ? e.message : '图片连接读取失败。'); }
  }, []);
  useEffect(() => { void loadConnections(); window.addEventListener('braipen:connections-changed', loadConnections); return () => window.removeEventListener('braipen:connections-changed', loadConnections); }, [loadConnections]);
  useEffect(() => {
    const active = new AbortController();
    void imageProviderPresets(active.signal).then(value => { if (!active.signal.aborted) setPresets(value); }).catch(() => { /* Saved connections and artwork remain available offline. */ });
    return () => active.abort();
  }, []);
  useEffect(() => {
    if (!project) return;
    if (!draft) { const source = coverSource(project), direction = initialCoverDirection(project.title); setDraft({ direction, source, prompt: buildCoverPrompt(source, direction), change: '' }); }
    if (!layoutInitialized.current) { setLayout(project.cover?.layout || defaultCoverLayout(project.title)); layoutInitialized.current = true; }
    if (!previewId && project.cover?.versions.length) setPreviewId(project.cover.selected_id || project.cover.versions[project.cover.versions.length - 1].id);
  }, [project, draft, previewId]);
  useEffect(() => { if (draft) drafts.set(projectRef, draft); }, [draft, projectRef]);
  useEffect(() => {
    let active = true;
    if (!project || connectionId || !profiles.length) return;
    void defaultImageConnectionId().then(id => {
      if (!active) return;
      const desired = project?.cover?.connection_id || id;
      const profile = profiles.find(p => p.id === desired) || profiles[0];
      setConnectionId(profile.id); setModel(imageSnapshot(profile)?.model || '');
    }).catch(e => { if (active) setError(e instanceof Error ? e.message : '默认图片连接读取失败。'); });
    return () => { active = false; };
  }, [profiles, project?.cover?.connection_id, connectionId]);
  const cover = project?.cover, versions = cover?.versions || [], preview = versions.find(v => v.id === previewId);
  const chosen = profiles.find(p => p.id === connectionId), source = project ? coverSource(project) : null;
  const snapshot = chosen ? imageSnapshot(chosen) : undefined;
  const modelOptions = Array.from(new Set([snapshot?.model || '', ...(chosen?.models?.map(m => m.id) || []),
    ...(presets.find(p => p.id === snapshot?.preset)?.models?.map(m => m.id) || [])].filter(Boolean))).map(value => ({ value }));
  const sourceChanged = !!draft && !!source && (draft.source.idea !== source.idea || draft.source.characters !== source.characters);
  function updateDraft(update: Partial<Draft>) { if (draft) setDraft({ ...draft, ...update }); }
  function rearrange() { if (project && draft) { const source = coverSource(project); updateDraft({ source, prompt: buildCoverPrompt(source, draft.direction) }); setNotice('已用当前保存的白话设定与人物卡更新描述，请检查后生成。'); } }
  async function chooseConnection(id: string) {
    setConnectionId(id); setModel(imageSnapshot(profiles.find(p => p.id === id)!)?.model || ''); setError('');
    try { await saveCoverConnection(projectRef, id); } catch (e) { setError(e instanceof Error ? e.message : '图片连接选择未保存。'); }
  }
  async function generate(edit: boolean) {
    if (!project || !draft || busy) return;
    if (!navigator.locks) { setError('当前浏览器不支持安全图片任务锁，请使用新版 Edge 或 Chrome 打开 HTTPS 网站。'); return; }
    const parent = edit ? preview : undefined;
    const prompt = edit ? buildCoverEditPrompt(draft.change.trim()) : draft.prompt.trim();
    if (!connectionId || !model.trim()) { setError('请先选择图片连接和模型。'); return; }
    if (!prompt || prompt.length > 6000 || edit && (!parent || !draft.change.trim())) { setError(edit ? '请选择原图并填写修改要求（完整描述不能超过 6000 字符）。' : '请输入 1–6000 字符的完整生成描述。'); return; }
    if (versions.length >= MAX_COVER_VERSIONS) { setError(`本作品已达到 ${MAX_COVER_VERSIONS} 个图片版本上限，请先备份。`); return; }
    const frozenSource = structuredClone(parent?.source || draft.source), attempt = crypto.randomUUID();
    setBusy(true); setError(''); setNotice(''); setUnsavedImage(null);
    const active = new AbortController(); controller.current = active;
    let attempted = false;
    try {
      await navigator.locks.request('braipen:cover:' + projectRef, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('此作品正在另一个标签页生成图片，请等待完成。');
        const snapshot = await resolveImageConnection(connectionId, model.trim()), lease = await acquireImageConnection(snapshot, active.signal);
        try {
          const input = { prompt, size: '2K' as const, ...(parent ? { image: { mime_type: parent.mime_type, data_base64: await blobBase64(await getCoverBlob(parent.media_id)) } } : {}) };
          active.signal.throwIfAborted();
          await saveCoverAttempt(projectRef, { id: attempt, status: 'running', started_at: new Date().toISOString() });
          attempted = true;
          const result = await requestImage(edit ? 'edit' : 'generate', input, lease, active.signal), blob = imageDataBlob(result.image);
          if (live.current) setUnsavedImage(blob);
          const version = await saveCoverVersion(projectRef, { parent_id: parent?.id, prompt, source: frozenSource, width: result.image.width, height: result.image.height,
            connection: { profile_id: snapshot.profile_id, revision: snapshot.revision, model: result.model, preset: snapshot.preset } }, blob, lease.guard);
          if (live.current) { setPreviewId(version.id); setUnsavedImage(null); setNotice('图片候选已保存。确认效果后点击「设为作品封面」，即可在概览和阅读页展示。'); await refresh(); }
        } finally { lease.close(); }
      });
    } catch (e) {
      const text = active.signal.aborted ? '图片请求已中断，结果未确认；供应商可能已处理请求。再次生成会提交新请求。' : e instanceof Error ? e.message : '图片请求失败，结果未确认。';
      if (attempted) try { await saveCoverAttempt(projectRef, { id: attempt, status: 'unknown', started_at: new Date().toISOString(), error: text }, attempt); } catch { /* Keep original failure and in-memory image for download. */ }
      if (live.current) setError(text);
    } finally { if (live.current) { setBusy(false); controller.current = null; } }
  }
  async function applyVersion() {
    if (!preview) return;
    setSaving(true); setError('');
    try { await selectCoverVersion(projectRef, preview.id); setNotice('作品封面已更新，概览和阅读页会显示此版本。'); }
    catch (e) { setError(e instanceof Error ? e.message : '封面选择未保存。'); }
    finally { setSaving(false); }
  }
  async function saveTypography() {
    if (!layout) return;
    setSaving(true); setError('');
    try { await saveCoverLayout(projectRef, layout); setNotice('排版已保存，没有调用模型。'); }
    catch (e) { setError(e instanceof Error ? e.message : '排版未保存。'); }
    finally { setSaving(false); }
  }
  async function download(composed: boolean) {
    if (!preview || !layout || !project) return;
    setExporting(true); setError('');
    try { const blob = await getCoverBlob(preview.media_id); downloadCoverBlob(composed ? await exportCover(blob, layout) : blob, `${project.title}-${composed ? '封面.png' : `底图.${preview.mime_type.split('/')[1]}`}`); }
    catch (e) { setError(e instanceof Error ? e.message : '封面导出失败。'); }
    finally { setExporting(false); }
  }
  if (!project || !draft || !layout) return readError ? <Alert type="error" showIcon message={readError} /> : <Spin aria-label="正在读取封面" />;
  return <div className="cover-workspace">
    <div className="cover-intro"><h2><PictureOutlined /> 作品封面</h2><p>从白话设定与人物卡准备画面，生成候选后由你决定采用哪一张。书名与作者名在本地排版。</p></div>
    {(error || readError) && <Alert type="error" showIcon message={error || readError} />}
    {notice && <Alert type="success" showIcon message={notice} closable onClose={() => setNotice('')} />}
    {!busy && cover?.attempt && <Alert type="warning" showIcon message="上次图片请求的结果未保存" description={cover.attempt.error || '页面关闭或中断后无法确认供应商是否已经生成，不会自动重试。再次生成可能计费。'} />}
    {unsavedImage && <Button onClick={() => downloadCoverBlob(unsavedImage, '未保存底图.' + unsavedImage.type.split('/')[1])}>下载未保存的底图</Button>}
    <div className="cover-columns">
      <div className="cover-controls">
        <label className="cover-field">图片连接<Select aria-label="封面图片连接" value={connectionId || undefined} placeholder="选择已保存的图片连接" disabled={busy} options={profiles.map(p => ({ value: p.id, label: p.name }))} onChange={id => void chooseConnection(id)} /></label>
        <label className="cover-field">图片模型<AutoComplete aria-label="封面图片模型" value={model} disabled={busy} onChange={setModel} options={modelOptions} placeholder="模型 ID，可选择或填写" /></label>
        <Link to="/settings?tab=images">配置图片模型连接</Link>
        {!profiles.length && <Alert type="info" showIcon message="先保存图片连接与 Key，再回到这里生成。" />}
        <label className="cover-field">封面视觉要求<Input.TextArea aria-label="封面视觉要求" value={draft.direction} maxLength={2000} autoSize={{ minRows: 3, maxRows: 7 }} disabled={busy} onChange={e => updateDraft({ direction: e.target.value, prompt: buildCoverPrompt(draft.source, e.target.value) })} /></label>
        <Button disabled={busy} onClick={rearrange}>用当前设定整理生成描述</Button>
        {sourceChanged && <Alert type="info" showIcon message="白话设定或人物卡已更新，可点击上方按钮重新整理描述。" />}
        <Collapse items={[{ key: 'prompt', label: '查看并确认完整生成描述', children: <><Input.TextArea aria-label="完整封面生成描述" value={draft.prompt} autoSize={{ minRows: 6, maxRows: 14 }} disabled={busy} onChange={e => updateDraft({ prompt: e.target.value })} /><p className="field-caption">{draft.prompt.length} / 6000 字符。默认只使用已保存的白话设定与人物卡；不读取大纲。</p></> }]} />
        <p className="field-caption">默认每次生成一张，2K，保留平台水印。调用模型可能计费；生成期间请保留此页面。</p>
        <Space wrap><Button type="primary" loading={busy} disabled={busy || !connectionId || !model.trim() || apiStatus !== 'online'} onClick={() => void generate(false)}>生成候选图片 · 调用模型</Button>{busy && <Button onClick={() => controller.current?.abort()}>中断图片请求</Button>}</Space>
        <label className="cover-field">原图修改要求<Input.TextArea aria-label="原图修改要求" value={draft.change} maxLength={2000} autoSize={{ minRows: 2, maxRows: 5 }} placeholder="例如：保持人物与姿态，将背景改成深蓝色，增强两侧对比光。" disabled={busy} onChange={e => updateDraft({ change: e.target.value })} /></label>
        <Button disabled={busy || !preview || !draft.change.trim() || !connectionId || apiStatus !== 'online'} onClick={() => void generate(true)}>修改预览图片 · 调用模型</Button>
        <p className="field-caption">会携带当前预览的原图，修改结果保存为新候选。人物特征以实际结果为准，可比较后回退。</p>
      </div>
      <div className="cover-result">
        {preview ? <><div className="cover-version-heading"><strong>当前预览</strong>{cover?.selected_id === preview.id ? <Tag color="green">作品封面</Tag> : <Tag>候选图片</Tag>}</div><CoverPreview version={preview} layout={layout} title={project.title} /><p className="field-caption">{preview.width} × {preview.height} · {preview.connection?.model} · {new Date(preview.created_at).toLocaleString('zh-CN')}</p><Space wrap><Button type="primary" disabled={busy || saving || cover?.selected_id === preview.id} loading={saving} onClick={() => void applyVersion()}>设为作品封面</Button><Button icon={<DownloadOutlined />} loading={exporting} onClick={() => void download(true)}>导出含文字封面</Button><Button disabled={exporting} onClick={() => void download(false)}>下载底图</Button></Space></> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="生成的图片会显示在这里。" />}
        <div className="cover-layout"><h3>书名与作者排版</h3><label className="cover-field">封面书名<Input aria-label="封面书名" value={layout.title} maxLength={160} onChange={e => setLayout({ ...layout, title: e.target.value })} /></label><label className="cover-field">封面作者<Input aria-label="封面作者" value={layout.author} maxLength={80} onChange={e => setLayout({ ...layout, author: e.target.value })} /></label><Space wrap><label className="cover-field">文字位置<Select aria-label="封面文字位置" value={layout.titlePosition} options={[{ value: 'top', label: '顶部' }, { value: 'center', label: '中间' }, { value: 'bottom', label: '底部' }]} onChange={titlePosition => setLayout({ ...layout, titlePosition })} /></label><label className="cover-field">字体<Select aria-label="封面字体" value={layout.fontFamily} options={[{ value: 'serif', label: '宋体风格' }, { value: 'sans-serif', label: '黑体风格' }]} onChange={fontFamily => setLayout({ ...layout, fontFamily })} /></label><label className="cover-field">字号<InputNumber aria-label="封面书名字号" min={3} max={20} value={layout.titleSize} onChange={value => value !== null && setLayout({ ...layout, titleSize: value })} /></label><label className="cover-field">文字颜色<input type="color" aria-label="封面文字颜色" value={layout.titleColor} onChange={e => setLayout({ ...layout, titleColor: e.target.value, authorColor: e.target.value })} /></label></Space><Button disabled={saving} onClick={() => void saveTypography()}>保存排版 · 不调用模型</Button></div>
      </div>
    </div>
    {!!versions.length && <section className="cover-history"><h3>图片版本 · {versions.length} / {MAX_COVER_VERSIONS}</h3><p className="field-caption">选择旧版本即可比较；点击「设为作品封面」可回退。白话设定与人物卡不会被图片设计改写。</p><div className="cover-version-grid">{[...versions].reverse().map((version, index) => <button type="button" key={version.id} className={previewId === version.id ? 'is-active' : ''} aria-label={`预览图片版本 ${versions.length - index}`} onClick={() => setPreviewId(version.id)}><CoverPreview version={version} layout={plainLayout} maxDimension={384} title={`图片版本 ${versions.length - index}`} /><span>版本 {versions.length - index}{version.parent_id ? ' · 修改' : ' · 生成'}{cover?.selected_id === version.id ? ' · 已采用' : ''}</span></button>)}</div></section>}
  </div>;
}
