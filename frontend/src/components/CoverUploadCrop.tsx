import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Alert, Button, Space } from 'antd';
import { getProject } from '../localStore';
import { getCoverBlob, inspectCoverBlob, MAX_COVER_VERSIONS, saveCoverVersion } from '../coverStorage';
import { coverCropRect, cropCoverBlob, initialCoverCrop, type CoverCropControls } from '../coverCrop';
import type { CoverVersion } from '../coverTypes';
import '../styles/coverCrop.css';

type CropSource = { blob: Blob; url: string; width: number; height: number; parentId?: string };
export default function CoverUploadCrop({ projectRef, preview, disabled = false, onSaved }: {
  projectRef: string; preview?: CoverVersion; disabled?: boolean; onSaved: (version: CoverVersion) => void | Promise<void>;
}) {
  const [source, setSource] = useState<CropSource | null>(null), [controls, setControls] = useState(initialCoverCrop);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [loading, setLoading] = useState(false), [saving, setSaving] = useState(false);
  const sequence = useRef(0), live = useRef(true), frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; controls: CoverCropControls } | null>(null);
  const locked = disabled || loading || saving;
  const rect = source ? coverCropRect(source.width, source.height, controls) : null;
  useEffect(() => { live.current = true; return () => { live.current = false; sequence.current++; }; }, []);
  useEffect(() => { if (source) return () => URL.revokeObjectURL(source.url); }, [source]);
  useEffect(() => { sequence.current++; setSource(null); setError(''); setNotice(''); setLoading(false); setSaving(false); }, [projectRef]);

  async function prepare(blob: Blob | (() => Promise<Blob>), parentId?: string) {
    if (locked) return;
    const ticket = ++sequence.current;
    setLoading(true); setError(''); setNotice('');
    try {
      const project = await getProject(projectRef);
      if (!project) throw new Error('此浏览器中找不到该项目。');
      if ((project.cover?.versions.length || 0) >= MAX_COVER_VERSIONS) throw new Error(`本作品最多保存 ${MAX_COVER_VERSIONS} 个版本，请先备份。`);
      const original = typeof blob === 'function' ? await blob() : blob, image = await inspectCoverBlob(original);
      coverCropRect(image.width, image.height, initialCoverCrop);
      if (!live.current || ticket !== sequence.current) return;
      setControls(initialCoverCrop); setSource({ blob: original, url: URL.createObjectURL(original), ...image, parentId });
    } catch (e) { if (live.current && ticket === sequence.current) setError(e instanceof Error ? e.message : '图片未能读取。'); }
    finally { if (live.current && ticket === sequence.current) setLoading(false); }
  }
  function cancel() { sequence.current++; drag.current = null; setSource(null); setLoading(false); setError(''); setNotice('裁剪已取消，没有保存或更换封面。'); }
  async function save() {
    if (!source || !rect || locked) return;
    const ticket = sequence.current;
    setSaving(true); setError(''); setNotice('');
    try {
      const blob = await cropCoverBlob(source.blob, rect), image = await inspectCoverBlob(blob);
      const current = () => live.current && ticket === sequence.current;
      if (!current()) return;
      const persist = () => current() ? saveCoverVersion(projectRef, { origin: 'upload', parent_id: source.parentId, source: { idea: '', characters: '' }, width: image.width, height: image.height }, blob, undefined, { preserveAttempt: true, isCurrent: current }) : undefined;
      const version = navigator.locks ? await navigator.locks.request('braipen:cover:' + projectRef, { ifAvailable: true }, async lock => {
        if (!current()) return;
        if (!lock) throw new Error('此作品正在另一个标签页生成或保存封面，请稍后保存裁剪候选。');
        return persist();
      }) : await persist();
      if (!version || !current()) return;
      setSource(null); setNotice('裁剪图片已保存为新候选。比较效果后，点击「设为作品封面」采用。');
      await onSaved(version);
    } catch (e) { if (live.current && ticket === sequence.current) setError(e instanceof Error ? e.message : '裁剪候选未能保存，请重试。'); }
    finally { if (live.current && ticket === sequence.current) setSaving(false); }
  }
  function move(horizontal: number, vertical: number, start = controls) {
    if (!source || !rect) return;
    setControls({ ...start, horizontal: Math.max(0, Math.min(100, start.horizontal + (source.width > rect.width ? horizontal / (source.width - rect.width) * 100 : 0))),
      vertical: Math.max(0, Math.min(100, start.vertical + (source.height > rect.height ? vertical / (source.height - rect.height) * 100 : 0))) });
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current || locked || !source || !frame.current) return;
    const bounds = frame.current.getBoundingClientRect();
    move((event.clientX - drag.current.x) * source.width / bounds.width, (event.clientY - drag.current.y) * source.height / bounds.height, drag.current.controls);
  }
  function keyMove(event: KeyboardEvent<HTMLDivElement>) {
    if (locked || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    move(event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0);
  }
  return <section className="cover-upload" aria-label="本地上传与裁剪">
    <h3>本地上传与裁剪</h3>
    <p className="field-caption">PNG、JPEG 或 WebP，每张最多 8 MiB。在本机按 2:3 裁剪，不上传服务器、不调用模型。只保存裁剪后的新候选，请自行保留原文件。</p>
    <label className="cover-field">上传本地图片<input type="file" aria-label="上传封面图片" accept="image/png,image/jpeg,image/webp" disabled={locked} onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ''; if (file) void prepare(file);
    }} /></label>
    <Space wrap><Button disabled={locked || !preview} onClick={() => preview && void prepare(() => getCoverBlob(preview.media_id), preview.id)}>裁剪当前预览 · 本地</Button>{loading && <span role="status">正在读取本地图片…</span>}</Space>
    {error && <Alert type="error" showIcon message={error} />}
    {notice && <Alert type="success" showIcon message={notice} />}
    {source && rect && <div className="cover-crop-editor">
      <p className="field-caption">{source.parentId ? '从当前预览裁剪' : '上传原图'}：{source.width} × {source.height}。拖动框选区域，或用下方滑块调整；方向键移动，Shift + 方向键加快移动。</p>
      <div ref={frame} className="cover-crop-stage" style={{ width: `min(100%, ${Math.min(600, 460 * source.width / source.height)}px)`, aspectRatio: `${source.width}/${source.height}` }}>
        <img src={source.url} alt="待裁剪的本地图片" draggable={false} />
        <div className="cover-crop-box" role="group" aria-label="2:3 封面裁剪框" aria-disabled={locked} tabIndex={locked ? -1 : 0}
          style={{ left: `${rect.x / source.width * 100}%`, top: `${rect.y / source.height * 100}%`, width: `${rect.width / source.width * 100}%`, height: `${rect.height / source.height * 100}%` }}
          onKeyDown={keyMove} onPointerDown={event => { if (locked || event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, controls }; }}
          onPointerMove={pointerMove} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}><span>2:3</span></div>
      </div>
      <label className="cover-field">裁剪范围 · {controls.size}%<input type="range" aria-label="裁剪范围" min={20} max={100} value={controls.size} disabled={locked} onChange={event => setControls({ ...controls, size: Number(event.target.value) })} /></label>
      <label className="cover-field">水平位置<input type="range" aria-label="裁剪水平位置" min={0} max={100} step={0.1} value={controls.horizontal} disabled={locked || source.width === rect.width} onChange={event => setControls({ ...controls, horizontal: Number(event.target.value) })} /></label>
      <label className="cover-field">垂直位置<input type="range" aria-label="裁剪垂直位置" min={0} max={100} step={0.1} value={controls.vertical} disabled={locked || source.height === rect.height} onChange={event => setControls({ ...controls, vertical: Number(event.target.value) })} /></label>
      <p className="field-caption" role="status">保存尺寸：{Math.min(rect.width / 2, 1024) * 2} × {Math.min(rect.width / 2, 1024) * 3} · PNG · 固定 2:3</p>
      <Space wrap><Button type="primary" disabled={locked} loading={saving} onClick={() => void save()}>保存裁剪为候选 · 本地</Button><Button disabled={saving} onClick={cancel}>取消裁剪</Button></Space>
    </div>}
  </section>;
}
