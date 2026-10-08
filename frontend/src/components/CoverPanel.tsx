import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AutoComplete, Button, Empty, Input, InputNumber, Select, Space, Spin, Tag } from 'antd';
import { DownloadOutlined, PictureOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useAppStore } from '../store/useAppStore';
import { useCoverProject } from '../hooks/useCoverProject';
import { imageConnections, imageSnapshot, resolveImageConnection, acquireImageConnection, defaultImageConnectionId, imageProviderPresets, type ImageProviderPreset } from '../imageConnections';
import { requestCoverImages } from '../imageClient';
import { acquireConnection, capabilities, connections, resolveConnection, type ConnectionLease } from '../providerConnections';
import { getProject } from '../localStore';
import { defaultCoverLayout, getCoverBlob, saveCoverVersion, selectCoverVersion, saveCoverLayout, saveCoverConnection, saveCoverPreferences, saveCoverAttempt, MAX_COVER_VERSIONS } from '../coverStorage';
import { coverSource, imageDataBlob, blobBase64, downloadCoverBlob, exportCover } from '../coverArtwork';
import type { ConnectionProfile, CoverStyleId, CoverEditKind } from '../providerTypes';
import type { CoverLayout } from '../coverTypes';
import { CoverPreview } from './CoverPreview';

const styles: Array<{ id: CoverStyleId; label: string }> = [{ id: 'cinematic', label: '电影写实' }, { id: 'ink', label: '国风水墨' }, { id: 'anime', label: '轻小说插画' }, { id: 'fantasy', label: '幻想写实' }, { id: 'minimal', label: '极简象征' }];
const plainLayout = defaultCoverLayout('');
export default function CoverPanel({ projectRef }: { projectRef: string }) {
  const { project, error: readError, refresh } = useCoverProject(projectRef);
  const apiStatus = useAppStore(s => s.apiStatus);
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]), [connectionId, setConnectionId] = useState(''), [model, setModel] = useState('');
  const [presets, setPresets] = useState<ImageProviderPreset[]>([]), [coverEnabled, setCoverEnabled] = useState(false);
  const [textProfiles, setTextProfiles] = useState<ConnectionProfile[]>([]), [textId, setTextId] = useState(''), [textModel, setTextModel] = useState('');
  const [styleId, setStyleId] = useState<CoverStyleId>('cinematic'), [count, setCount] = useState<1 | 2 | 4>(1), [editKind, setEditKind] = useState<CoverEditKind>('restyle');
  const [layout, setLayout] = useState<CoverLayout | null>(null), [stage, setStage] = useState('');
  const [previewId, setPreviewId] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false), [saving, setSaving] = useState(false), [exporting, setExporting] = useState(false);
  const [unsavedImage, setUnsavedImage] = useState<Blob | null>(null);
  const controller = useRef<AbortController | null>(null), live = useRef(true), layoutInitialized = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; controller.current?.abort(); }; }, []);
  const loadConnections = useCallback(async () => {
    try { const [images, texts] = await Promise.all([imageConnections(), connections()]); if (live.current) { setProfiles(images.filter(p => p.enabled && p.revisions.length)); setTextProfiles(texts.filter(p => p.enabled && p.revisions.length)); } }
    catch (e) { if (live.current) setError(e instanceof Error ? e.message : '图片连接读取失败。'); }
  }, []);
  useEffect(() => { void loadConnections(); window.addEventListener('braipen:connections-changed', loadConnections); return () => window.removeEventListener('braipen:connections-changed', loadConnections); }, [loadConnections]);
  useEffect(() => {
    const active = new AbortController();
    void imageProviderPresets(active.signal).then(value => { if (!active.signal.aborted) setPresets(value); }).catch(() => { /* Saved connections and artwork remain available offline. */ });
    void capabilities(false, active.signal).then(value => { if (!active.signal.aborted) setCoverEnabled(value.cover_generation?.version === 1 && value.cover_generation.template_version === 1 && styles.every(style => value.cover_generation?.styles.some(item => item.id === style.id))); }).catch(() => { /* Saved artwork remains available offline. */ });
    return () => active.abort();
  }, []);
  useEffect(() => {
    if (!project) return;
    if (!textId) { const id = project.cover?.text_connection_id || String(project.config.connection_id || 'legacy-deepseek'); setTextId(id); setTextModel(id === project.config.connection_id ? String(project.config.model || '') : ''); setStyleId(project.cover?.style_id || 'cinematic'); setCount(project.cover?.count || 1); }
    if (!layoutInitialized.current) { setLayout(project.cover?.layout || defaultCoverLayout(project.title)); layoutInitialized.current = true; }
    if (!previewId && project.cover?.versions.length) setPreviewId(project.cover.selected_id || project.cover.versions[project.cover.versions.length - 1].id);
  }, [project, textId, previewId]);
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
  const chosenText = textProfiles.find(p => p.id === textId);
  const selectedTextModel = textModel || chosenText?.revisions.find(s => s.revision === chosenText.head)?.model || '';
  async function chooseConnection(id: string) {
    setConnectionId(id); setModel(imageSnapshot(profiles.find(p => p.id === id)!)?.model || ''); setError('');
    try { await saveCoverConnection(projectRef, id); } catch (e) { setError(e instanceof Error ? e.message : '图片连接选择未保存。'); }
  }
  async function choosePreferences(update: { text_connection_id?: string; style_id?: CoverStyleId; count?: 1 | 2 | 4 }) {
    if (update.text_connection_id) { setTextId(update.text_connection_id); setTextModel(''); }
    if (update.style_id) setStyleId(update.style_id);
    if (update.count) setCount(update.count);
    try { await saveCoverPreferences(projectRef, update); } catch (e) { setError(e instanceof Error ? e.message : '封面选项未保存。'); }
  }
  async function generate(edit: boolean) {
    if (!project || busy) return;
    if (!navigator.locks) { setError('当前浏览器不支持安全图片任务锁，请使用新版 Edge 或 Chrome 打开 HTTPS 网站。'); return; }
    const parent = edit ? preview : undefined;
    if (!connectionId || !model.trim()) { setError('请先选择图片连接和模型。'); return; }
    if (!chosenText || !selectedTextModel) { setError('请先选择可用的文字连接，用于整理封面描述。'); return; }
    if (!coverEnabled) { setError('当前计算服务尚未支持受控封面生成，请更新计算服务。'); return; }
    if (edit && !parent) { setError('请先选择要修改的原图。'); return; }
    if (versions.length + count > MAX_COVER_VERSIONS) { setError(`本作品最多保存 ${MAX_COVER_VERSIONS} 个版本，本次还需 ${count} 个位置，请减少候选张数。`); return; }
    const attempt = crypto.randomUUID(), startedAt = new Date().toISOString();
    setBusy(true); setStage('准备连接'); setError(''); setNotice(''); setUnsavedImage(null);
    const active = new AbortController(); controller.current = active;
    let attempted = false, saved = 0;
    try {
      await navigator.locks.request('braipen:cover:' + projectRef, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('此作品正在另一个标签页生成图片，请等待完成。');
        const current = await getProject(projectRef);
        if (!current) throw new Error('作品已不存在，请重新选择。');
        if ((current.cover?.versions.length || 0) + count > MAX_COVER_VERSIONS) throw new Error('图片版本容量不足，请减少候选张数。');
        const frozenSource = coverSource(current);
        if (!frozenSource.idea.trim() || frozenSource.idea.length > 6000 || frozenSource.characters.length > 12000) throw new Error('请先保存白话设定。白话设定限 6000 字，人物卡限 12000 字。');
        const snapshot = await resolveImageConnection(connectionId, model.trim());
        const textSnapshot = await resolveConnection(textId, selectedTextModel), lease = await acquireImageConnection(snapshot, active.signal);
        let textLease: ConnectionLease | undefined;
        try {
          textLease = await acquireConnection(textSnapshot, active.signal);
          const input = { source: frozenSource, style_id: styleId, count, size: '2K' as const, ...(parent ? { edit_kind: editKind, image: { mime_type: parent.mime_type, data_base64: await blobBase64(await getCoverBlob(parent.media_id)) } } : {}) };
          active.signal.throwIfAborted();
          await Promise.all([lease.check(), textLease.check()]);
          await saveCoverAttempt(projectRef, { id: attempt, status: 'running', started_at: startedAt, requested: count, completed: 0 });
          attempted = true;
          const guardedText = textLease;
          await requestCoverImages(input, lease, guardedText, {
            onProgress: (phase, index, requested) => { if (live.current) setStage(phase === 'text' ? '整理描述' : `生成第 ${index + 1}/${requested} 张`); },
            onImage: async result => {
              const blob = imageDataBlob(result.image);
              if (live.current) setUnsavedImage(blob);
              active.signal.throwIfAborted();
              const version = await saveCoverVersion(projectRef, { parent_id: parent?.id, source: frozenSource, style_id: result.style_id, template_version: result.template_version, text_model: result.text_model,
                width: result.image.width, height: result.image.height, connection: { profile_id: snapshot.profile_id, revision: snapshot.revision, model: result.model, preset: snapshot.preset } }, blob, [lease.guard, guardedText.guard], { preserveAttempt: true, attemptId: attempt });
              saved++;
              await saveCoverAttempt(projectRef, { id: attempt, status: 'running', started_at: startedAt, requested: count, completed: saved }, attempt);
              if (live.current) { setPreviewId(version.id); setUnsavedImage(null); await refresh(); }
            },
          }, active.signal);
          active.signal.throwIfAborted(); await Promise.all([lease.check(), guardedText.check()]);
          await saveCoverAttempt(projectRef, undefined, attempt);
          if (live.current) { setNotice(`${saved} 张候选已保存。比较效果后点击「设为作品封面」采用。`); await refresh(); }
        } finally { lease.close(); textLease?.close(); }
      });
    } catch (e) {
      const message = active.signal.aborted ? '封面请求已停止，供应商可能已处理请求。再次生成可能计费。' : e instanceof Error ? e.message : '封面请求失败，结果未确认。';
      const text = saved ? `已保存 ${saved}/${count} 张候选，结果会保留。${message}` : message;
      if (attempted) try { await saveCoverAttempt(projectRef, { id: attempt, status: 'unknown', started_at: startedAt, requested: count, completed: saved, error: text }, attempt); } catch { /* Keep original failure and in-memory image for download. */ }
      if (live.current) setError(text);
    } finally { if (live.current) { setBusy(false); setStage(''); controller.current = null; } }
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
  if (!project || !layout) return readError ? <Alert type="error" showIcon message={readError} /> : <Spin aria-label="正在读取封面" />;
  return <div className="cover-workspace">
    <div className="cover-intro"><h2><PictureOutlined /> 作品封面</h2><p>从白话设定与人物卡准备画面，生成候选后由你决定采用哪一张。书名与作者名在本地排版。</p></div>
    {(error || readError) && <Alert type="error" showIcon message={error || readError} />}
    {notice && <Alert type="success" showIcon message={notice} closable onClose={() => setNotice('')} />}
    {!busy && cover?.attempt && <Alert type="warning" showIcon message="上次封面任务未完成" description={cover.attempt.error || `已保存 ${cover.attempt.completed || 0}/${cover.attempt.requested || 1} 张。页面关闭或中断后无法确认供应商是否已经生成，不会自动重试。再次生成可能计费。`} />}
    {unsavedImage && <Button onClick={() => downloadCoverBlob(unsavedImage, '未保存底图.' + unsavedImage.type.split('/')[1])}>下载未保存的底图</Button>}
    <div className="cover-columns">
      <div className="cover-controls">
        <label className="cover-field">图片连接<Select aria-label="封面图片连接" value={connectionId || undefined} placeholder="选择已保存的图片连接" disabled={busy} options={profiles.map(p => ({ value: p.id, label: p.name }))} onChange={id => void chooseConnection(id)} /></label>
        <label className="cover-field">图片模型<AutoComplete aria-label="封面图片模型" value={model} disabled={busy} onChange={setModel} options={modelOptions} placeholder="模型 ID，可选择或填写" /></label>
        <Link to="/settings?tab=images">配置图片模型连接</Link>
        {!profiles.length && <Alert type="info" showIcon message="先保存图片连接与 Key，再回到这里生成。" />}
        <label className="cover-field">整理描述的文字连接<Select aria-label="封面文字连接" value={textId || undefined} disabled={busy} options={textProfiles.map(p => ({ value: p.id, label: p.name }))} onChange={id => void choosePreferences({ text_connection_id: id })} /></label>
        <p className="field-caption">文字模型：{selectedTextModel || '尚未选择'}。仅用于封面，不会改动章节的模型设置。</p>
        {!chosenText && <Alert type="info" showIcon message="请在模型连接中保存并解锁文字连接，再选择它整理封面描述。" />}
        <fieldset className="cover-style"><legend>封面风格</legend><div className="cover-style-grid">{styles.map(style => <button type="button" key={style.id} aria-label={`封面风格：${style.label}`} aria-pressed={styleId === style.id} className={styleId === style.id ? 'is-active' : ''} disabled={busy} onClick={() => void choosePreferences({ style_id: style.id })}>{style.label}</button>)}</div></fieldset>
        <label className="cover-field">候选张数<Select aria-label="封面候选张数" value={count} disabled={busy} options={[1, 2, 4].map(value => ({ value, label: `${value} 张` }))} onChange={value => void choosePreferences({ count: value as 1 | 2 | 4 })} /></label>
        <p className="field-caption">使用当前已保存的白话设定（{source?.idea.length || 0} 字）和人物卡（{source?.characters.length || 0} 字），不读取大纲。先由文字模型整理，再生成 {count} 张 2K 底图，书名与作者名在本地排版。</p>
        <p className="cover-billing">本次会调用 1 次文字模型和 {count} 次图片模型，可能计费。每张生成后立即保存，失败或停止时保留已保存的候选。</p>
        {!coverEnabled && <Alert type="info" showIcon message="计算服务尚未提供受控封面生成能力，请检查服务版本。" />}
        <Space wrap><Button type="primary" loading={busy} disabled={busy || !connectionId || !model.trim() || !chosenText || !coverEnabled || apiStatus !== 'online'} onClick={() => void generate(false)}>生成候选图片 · 调用模型</Button>{busy && <Button onClick={() => controller.current?.abort()}>停止封面生成</Button>}</Space>
        {busy && <p className="cover-stage" role="status" aria-live="polite">{stage}</p>}
        <label className="cover-field">原图修改目标<Select aria-label="原图修改目标" value={editKind} disabled={busy} options={[{ value: 'restyle', label: '应用所选风格' }, { value: 'simplify_background', label: '简化背景' }, { value: 'lighting', label: '增强光影' }]} onChange={setEditKind} /></label>
        <Button disabled={busy || !preview || !connectionId || !chosenText || !coverEnabled || apiStatus !== 'online'} onClick={() => void generate(true)}>修改预览图片 · 调用模型</Button>
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
