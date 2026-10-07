import { useEffect, useId, useRef, useState } from 'react';
import { Alert, App, AutoComplete, Button, Card, Checkbox, Collapse, Input, Popconfirm, Select, Space, Tag } from 'antd';
import { ApiOutlined, CopyOutlined, LockOutlined, PlusOutlined } from '@ant-design/icons';
import { getSetting } from '../localStore';
import { profileKey } from '../keyVault';
import { getConnection, manageConnection, recordConnectionResult, renameConnection, storeConnectionKey, unlockConnection } from '../providerConnections';
import { IMAGE_PRESETS, acquireImageConnection, blankImageConnection, defaultImageConnectionId, imageConnections, imageProviderPresets, imageSnapshot, saveImageConnection, setDefaultImageConnection, type ImageConnectionSnapshot, type ImageProviderPreset } from '../imageConnections';
import { requestImage } from '../imageClient';
import type { ConnectionProfile } from '../providerTypes';

export default function ImageConnectionsPanel() {
  const { message } = App.useApp(), fieldId = useId();
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]), [presets, setPresets] = useState<ImageProviderPreset[]>(IMAGE_PRESETS), [selected, setSelected] = useState('');
  const [form, setForm] = useState<ImageConnectionSnapshot>(blankImageConnection), [name, setName] = useState('Seedream · 火山方舟');
  const [key, setKey] = useState(''), [password, setPassword] = useState(''), [remember, setRemember] = useState(false), [vault, setVault] = useState(false);
  const [defaultId, setDefaultId] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState('');
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]), [modelsSource, setModelsSource] = useState<'catalog' | 'suggestions' | 'saved' | ''>(''), [truncated, setTruncated] = useState(false);
  const abort = useRef<AbortController | null>(null), mounted = useRef(true);
  const selectedProfile = profiles.find(p => p.id === selected), saved = selectedProfile?.revisions.find(r => r.revision === selectedProfile.head);
  const unlocked = !!(selectedProfile && saved && profileKey(selectedProfile, saved));
  const preset = presets.find(p => p.id === form.preset), disabled = Boolean(busy);
  const suggestedId = preset?.default_model ?? preset?.model ?? '';
  const suggestions = preset?.models || (suggestedId ? [{ id: suggestedId, name: suggestedId }] : []);
  const visibleSource = modelsSource || (form.preset !== 'custom' ? 'suggestions' : '');
  const visibleModels = modelsSource ? models : form.preset !== 'custom' ? suggestions : [];
  async function load() {
    const [list, id] = await Promise.all([imageConnections(), defaultImageConnectionId()]);
    if (mounted.current) { setProfiles(list); setDefaultId(id); } return list;
  }
  function select(profile?: ConnectionProfile) {
    const next = profile ? imageSnapshot(profile) : blankImageConnection();
    setSelected(profile?.id || ''); setForm(next || blankImageConnection()); setName(profile?.name || 'Seedream · 火山方舟');
    setKey(''); setPassword(''); setRemember(false); setError(''); setModels(profile?.models || []); setModelsSource(profile?.models ? (next?.preset === 'custom' ? 'saved' : 'suggestions') : ''); setTruncated(false);
  }
  useEffect(() => {
    mounted.current = true;
    void load().then(list => { if (mounted.current) select(list[0]); }).catch(e => { if (mounted.current) setError(e.message); });
    const controller = new AbortController();
    void imageProviderPresets(controller.signal).then(value => { if (mounted.current) setPresets(value); }).catch(e => { if (mounted.current) setError(e.message); });
    const update = () => { void load().catch(e => { if (mounted.current) setError(e.message); }); };
    window.addEventListener('braipen:connections-changed', update); window.addEventListener('braipen:key-changed', update);
    return () => { mounted.current = false; controller.abort(); abort.current?.abort(); window.removeEventListener('braipen:connections-changed', update); window.removeEventListener('braipen:key-changed', update); };
  }, []);
  useEffect(() => { let disposed = false; void getSetting('vault:' + selected).then(value => { if (!disposed) setVault(Boolean(value)); }); return () => { disposed = true; }; }, [selected, profiles]);
  async function action(label: string, task: () => Promise<void>) {
    setBusy(label); setError('');
    try { await task(); await load(); } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : '操作未完成。'); }
    finally { if (mounted.current) setBusy(''); }
  }
  function copy() {
    setForm({ ...form, profile_id: crypto.randomUUID(), revision: 1, preset: 'custom', destination_fingerprint: '', execution_fingerprint: '' });
    setSelected(''); setName(name + ' 副本'); setKey(''); setPassword(''); setRemember(false); setError(''); setModels([]); setModelsSource(''); setTruncated(false);
  }
  async function save(draft = false) {
    if (key && remember && password.length < 8 && !draft) throw new Error('本地解锁口令至少需要 8 个字符。');
    const profile = saved && JSON.stringify(saved) === JSON.stringify(form) ? await renameConnection(selected, name) : await saveImageConnection(name, form, draft);
    if (key && !draft) await storeConnectionKey(profile.id, key, remember ? password : undefined);
    if (!draft && !defaultId) await setDefaultImageConnection(profile.id);
    const next = await getConnection(profile.id);
    if (mounted.current) { select(next); void message.success(draft ? '图片连接草稿已保存在本浏览器。' : '图片连接已保存；保存不会生成图片。'); }
  }
  async function modelsList() {
    if (form.preset !== 'custom') { setModels(suggestions); setModelsSource('suggestions'); setTruncated(false); return; }
    if (!selectedProfile || !saved || JSON.stringify(saved) !== JSON.stringify(form)) throw new Error('请先保存连接及模型修改。');
    abort.current = new AbortController();
    const lease = await acquireImageConnection(saved, abort.current.signal, key || undefined);
    try {
      const result = await requestImage('models', {}, lease, abort.current.signal);
      await recordConnectionResult(lease, 'models', result);
      if (mounted.current) { setModels(result.models); setModelsSource(result.catalog_supported === false ? 'suggestions' : 'catalog'); setTruncated(Boolean(result.truncated)); }
    } finally { lease.close(); abort.current = null; }
  }
  return <div className="provider-connections">
    <div className="provider-list">
      <Space style={{ display: 'flex', justifyContent: 'space-between' }}><strong>我的图片连接</strong><Button aria-label="添加图片连接" icon={<PlusOutlined />} disabled={disabled} onClick={() => select()} /></Space>
      {profiles.map(p => <button key={p.id} className={selected === p.id ? 'provider-item selected' : 'provider-item'} disabled={disabled} onClick={() => select(p)}><strong>{p.name}</strong><small>{p.id === defaultId ? '封面默认 · ' : ''}{p.enabled ? '已启用' : '已禁用'} · {imageSnapshot(p)?.model || '草稿'}</small></button>)}
      <p className="muted-note">图片连接与文字连接分别选择。配置保存在此浏览器；Key 默认仅在当前标签页使用。</p>
    </div>
    <Card title={<Space><ApiOutlined />{selected ? '图片连接详情' : '添加图片连接'}</Space>} extra={<Button icon={<CopyOutlined />} disabled={disabled} onClick={copy}>复制配置</Button>}>
      {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />}
      <Space orientation="vertical" size={15} style={{ width: '100%' }}>
        <label className="provider-field" htmlFor={fieldId + 'name'}>连接名称<Input id={fieldId + 'name'} aria-label="图片连接名称" maxLength={80} value={name} disabled={disabled} onChange={e => setName(e.target.value)} /></label>
        <label className="provider-field" htmlFor={fieldId + 'provider'}>图片服务商<Select id={fieldId + 'provider'} aria-label="图片服务商" value={form.preset} disabled={disabled || Boolean(selected)} style={{ width: '100%' }} options={presets.map(p => ({ value: p.id, label: p.name }))} onChange={id => { const p = presets.find(p => p.id === id)!; setForm(blankImageConnection(p)); setName(p.name); setKey(''); setModels([]); setModelsSource(''); setTruncated(false); }} /></label>
        {preset?.regions && <label className="provider-field" htmlFor={fieldId + 'region'}>服务地域<Select id={fieldId + 'region'} aria-label="图片服务地域" value={form.base_url} disabled={disabled || Boolean(selected)} style={{ width: '100%' }} options={preset.regions.map(r => ({ value: r.url, label: r.name }))} onChange={base_url => setForm(f => ({ ...f, base_url }))} /><small>请选择创建 API Key 时对应的地域。</small></label>}
        <label className="provider-field" htmlFor={fieldId + 'url'}>API 服务地址<Input id={fieldId + 'url'} aria-label="图片 API 服务地址" value={form.base_url} disabled={disabled || Boolean(selected) || !['custom', 'qwen'].includes(form.preset)} placeholder="https://gateway.example/v1" onChange={e => setForm(f => ({ ...f, base_url: e.target.value }))} /><small>{form.preset === 'qwen' ? '使用百炼图片服务地址，也可填写控制台提供的专属工作空间地址。' : '填写服务商提供的基础地址。修改已保存的地址请复制为新连接。'}</small></label>
        <label className="provider-field" htmlFor={fieldId + 'key'}>API Key<Input.Password id={fieldId + 'key'} aria-label="图片连接 API Key" value={key} disabled={disabled} maxLength={4096} autoComplete="off" placeholder={unlocked ? '当前标签页已有 Key；留空保留' : '填写图片服务商 API Key'} onChange={e => setKey(e.target.value)} /></label>
        <label className="provider-field" htmlFor={fieldId + 'model'}>默认图片模型<AutoComplete id={fieldId + 'model'} aria-label="默认图片模型 ID" value={form.model} options={visibleModels.map(m => ({ value: m.id, label: m.name === m.id ? m.id : `${m.name} · ${m.id}` }))} style={{ width: '100%' }} disabled={disabled} filterOption={(value, option) => String(option?.value || '').toLowerCase().includes(value.toLowerCase())} onChange={model => setForm(f => ({ ...f, model }))} placeholder="选择建议模型，或输入服务商提供的模型 ID" /><small>{form.preset === 'seedream' ? '也可填写火山方舟的模型接入点 ID。' : ''}模型是否可用以服务商账号权限为准。</small></label>
        {visibleSource && <div role="region" aria-label="可选图片模型列表" style={{ width: '100%' }}>
          <p role="status" style={{ margin: '0 0 8px' }}><strong>{visibleSource === 'suggestions' ? '建议模型' : visibleSource === 'catalog' ? '已获取模型目录' : '已保存候选模型'} · {visibleModels.length} 个</strong>{visibleSource === 'suggestions' ? '（账号权限以调用结果为准）' : ''}。点击选择后保存连接。</p>
          {visibleModels.length ? <div style={{ display: 'grid', gap: 6, maxHeight: 220, overflowY: 'auto' }}>{visibleModels.map(m => <Button key={m.id} block aria-label={'选择图片模型 ' + m.id} aria-pressed={form.model === m.id} disabled={disabled} type={form.model === m.id ? 'primary' : 'default'} style={{ height: 'auto', minHeight: 36, whiteSpace: 'normal', textAlign: 'left', overflowWrap: 'anywhere', justifyContent: 'flex-start' }} onClick={() => setForm(f => ({ ...f, model: m.id }))}>{m.name === m.id ? m.id : `${m.name} · ${m.id}`}</Button>)}</div> : <Alert type="info" showIcon title="此服务未提供可用模型目录，请手动填写模型 ID。" />}
          {truncated && <p className="muted-note">目录已截断，仍可手动填写其他模型 ID。</p>}
        </div>}
        {form.preset === 'custom' && <Collapse style={{ width: '100%' }} items={[{ key: 'format', label: '高级设置（按服务商文档填写）', children: <label className="provider-field" htmlFor={fieldId + 'format'}>图片接口类型<Select id={fieldId + 'format'} aria-label="自定义图片接口类型" value={form.protocol} disabled={disabled || Boolean(selected)} style={{ width: '100%' }} options={[{ value: 'openai_images', label: 'OpenAI 图片接口' }, { value: 'seedream_images', label: 'Seedream 图片接口' }, { value: 'gemini_images', label: 'Gemini 图片接口' }, { value: 'qwen_images', label: '百炼图片接口' }]} onChange={protocol => setForm(f => ({ ...f, protocol }))} /><small>默认使用 OpenAI 图片接口；自定义服务的生成与修改能力取决于其实际支持。</small></label> }]} />}
        <Space wrap><Button type="primary" loading={busy === 'save'} disabled={disabled} onClick={() => void action('save', () => save())}>保存图片连接</Button><Button disabled={disabled || Boolean(selectedProfile?.revisions.length)} onClick={() => void action('draft', () => save(true))}>仅存草稿</Button><Button disabled={disabled || !selectedProfile?.enabled} onClick={() => void action('default', () => setDefaultImageConnection(selected))}>设为封面默认</Button></Space>
        <Space wrap><Button disabled={disabled || form.preset === 'custom' && !selectedProfile?.enabled} loading={busy === 'models'} onClick={() => void action('models', modelsList)}>{form.preset === 'custom' ? '获取图片模型列表' : '查看建议模型'}</Button>{busy === 'models' && <Button onClick={() => abort.current?.abort()}>取消获取</Button>}</Space>
        <p className="muted-note">保存连接、查看模型列表不会生成图片。只有在封面创作中明确点击生成或修改后才会调用图片模型，可能计费。</p>
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, width: '100%' }}>
          <Space wrap><LockOutlined /><strong>本地密钥保险箱</strong><Tag>{unlocked ? '已解锁' : '未解锁'}</Tag><Tag>{vault ? '有加密副本' : '无加密副本'}</Tag></Space>
          <p className="muted-note">用独立口令加密记住 Key。口令只用于本浏览器，刷新后需解锁；作品备份不包含 Key。</p>
          <Input.Password aria-label="图片连接解锁口令" value={password} disabled={disabled} onChange={e => setPassword(e.target.value)} autoComplete="off" maxLength={1024} placeholder="本地口令，至少 8 字符" />
          <Checkbox checked={remember} disabled={disabled} onChange={e => setRemember(e.target.checked)} style={{ margin: '10px 0' }}>保存新 Key 时加密记住</Checkbox>
          <Space wrap><Button disabled={disabled || !selected || !vault || !password} onClick={() => void action('unlock', async () => { await unlockConnection(selected, password); setPassword(''); })}>解锁</Button>
            <Button disabled={disabled || !selected || !unlocked || password.length < 8} onClick={() => void action('remember', async () => { const p = await getConnection(selected), s = p.revisions.find(r => r.revision === p.head)!; await storeConnectionKey(selected, profileKey(p, s), password); setPassword(''); })}>加密记住当前 Key</Button>
            <Button disabled={disabled || !selected} onClick={() => void action('lock', async () => { await manageConnection(selected, 'lock'); setPassword(''); })}>锁定并中断任务</Button>
            <Popconfirm title="忘记此图片连接的 Key 并中断相关任务？" onConfirm={() => action('forget', async () => { await manageConnection(selected, 'forget'); setKey(''); setPassword(''); })}><Button danger disabled={disabled || !selected}>忘记 Key</Button></Popconfirm>
          </Space>
        </div>
        {selectedProfile && <Space wrap><Button disabled={disabled} onClick={() => void action('enable', async () => { await manageConnection(selected, selectedProfile.enabled ? 'disable' : 'enable'); })}>{selectedProfile.enabled ? '禁用连接并中断任务' : '启用连接'}</Button><Popconfirm title="删除图片连接并中断相关任务？" description="作品和已保存封面保留。" onConfirm={() => action('delete', async () => { await manageConnection(selected, 'delete'); select(); })}><Button danger disabled={disabled}>删除图片连接</Button></Popconfirm></Space>}
      </Space>
    </Card>
  </div>;
}
