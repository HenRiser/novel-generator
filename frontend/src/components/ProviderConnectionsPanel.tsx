import { useEffect, useRef, useState } from 'react';
import { Alert, App, AutoComplete, Button, Card, Checkbox, Collapse, Input, InputNumber, Popconfirm, Select, Space, Tag } from 'antd';
import { PlusOutlined, CopyOutlined, LockOutlined, ApiOutlined } from '@ant-design/icons';
import { acquireConnection, capabilities, connections, defaultConnectionId, defaultPolicy, getConnection, manageConnection, renameConnection, resolveConnection,
  saveConnection, recordConnectionResult, setDefaultConnection, storeConnectionKey, unlockConnection } from '../providerConnections';
import { getSetting, setSetting } from '../localStore';
import { hasRememberedKey, profileKey } from '../keyVault';
import { compute } from '../computeClient';
import type { ConnectionProfile, ConnectionSnapshot, ProviderPreset } from '../providerTypes';

function blank(preset?:ProviderPreset):ConnectionSnapshot {return {profile_id:crypto.randomUUID(),revision:1,preset:preset?.id||'custom',protocol:preset?.protocol||'chat_completions',base_url:preset?.url||'',model:'',policy:preset?.policy||defaultPolicy(),auth_mode:'key',destination_fingerprint:'',execution_fingerprint:''};}
export default function ProviderConnectionsPanel(){
  const {message}=App.useApp();
  const [profiles,setProfiles]=useState<ConnectionProfile[]>([]),[presets,setPresets]=useState<ProviderPreset[]>([]),[selected,setSelected]=useState('');
  const [form,setForm]=useState<ConnectionSnapshot>(blank),[name,setName]=useState(''),[key,setKey]=useState(''),[password,setPassword]=useState(''),[remember,setRemember]=useState(false);
  const [defaultId,setDefaultId]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(''),[result,setResult]=useState<Record<string,unknown>|null>(null);
  const [vault,setVault]=useState(false),[models,setModels]=useState<Array<{id:string;name:string}>>([]);
  const abort=useRef<AbortController|null>(null),mounted=useRef(true);
  const selectedProfile=profiles.find(p=>p.id===selected);
  async function load(){const [list,id]=await Promise.all([connections(),defaultConnectionId()]);if(mounted.current){setProfiles(list);setDefaultId(id);}return list;}
  function select(p?:ConnectionProfile){setSelected(p?.id||'');setForm(p?.draft||p?.revisions.find(r=>r.revision===p.head)||blank());setName(p?.name||'新连接');setKey('');setPassword('');setRemember(false);setResult(p?.test?.result||null);setModels(p?.models||[]);}
  useEffect(()=>{mounted.current=true;void load().then(list=>{if(mounted.current)select(list[0]);}).catch(e=>setError(e.message));void capabilities().then(c=>{if(mounted.current)setPresets(c.providers);}).catch(e=>setError(e.message));
    const update=()=>{setResult(null);void load().catch(e=>setError(e.message));};window.addEventListener('braipen:connections-changed',update);window.addEventListener('braipen:key-changed',update);
    return()=>{mounted.current=false;abort.current?.abort();window.removeEventListener('braipen:connections-changed',update);window.removeEventListener('braipen:key-changed',update);};},[]);
  useEffect(()=>{let disposed=false;void(async()=>{const saved=selected?Boolean(await getSetting('vault:'+selected))||(selected==='legacy-deepseek'&&await hasRememberedKey()):false;if(!disposed)setVault(saved);})();return()=>{disposed=true;};},[selected,profiles]);
  useEffect(()=>{setResult(null);},[form]);
  async function action(label:string,task:()=>Promise<void>){setBusy(label);setError('');try{await task();await load();}catch(e){if(mounted.current)setError(e instanceof Error?e.message:'操作未完成。');}finally{if(mounted.current)setBusy('');}}
  function copy(){setForm({...form,profile_id:crypto.randomUUID(),revision:1,preset:'custom',policy:{...form.policy,source:'user_override'},destination_fingerprint:'',execution_fingerprint:''});setSelected('');setName(name+' 副本');setKey('');setPassword('');setResult(null);setModels([]);}
  async function save(draft=false){
    const old=selectedProfile?.revisions.find(r=>r.revision===selectedProfile.head);
    const p=old&&JSON.stringify(old)===JSON.stringify(form)?await renameConnection(selected,name):await saveConnection(name,form,draft);
    if(key&&!draft)await storeConnectionKey(p.id,key,remember?password:undefined);
    const saved=await getConnection(p.id);select(saved);void message.success(draft?'草稿保存在本浏览器；验证前不能联网。':'连接配置已保存在本浏览器。');
  }
  async function probe(kind:'connection_test'|'list_models'){
    if(!selectedProfile)throw new Error('请先保存连接。');
    const snapshot=selectedProfile.revisions.find(r=>r.revision===selectedProfile.head);
    if(!snapshot||JSON.stringify(snapshot)!==JSON.stringify(form))throw new Error('检测只使用已保存配置，请先保存修改。');
    abort.current=new AbortController();const lease=await acquireConnection(snapshot,abort.current.signal,key||undefined);
    try{const response=await compute(kind,{},undefined,abort.current.signal,undefined,lease);await lease.check();
      if(kind==='list_models'){const list=response.result.models as Array<{id:string;name:string}>;setModels(list||[]);await recordConnectionResult(lease,'models',response.result);if(response.result.truncated)void message.info('目录已截断，仍可手动输入其他模型ID。');}
      else{setResult(response.result);await recordConnectionResult(lease,'test',response.result,!key);}
    }finally{lease.close();abort.current=null;}
  }
  const unlocked=selectedProfile&&selectedProfile.revisions.length?Boolean(profileKey(selectedProfile,selectedProfile.revisions[0])):false;
  const endpoint=form.base_url.replace(/\/+$/,'')+(form.protocol==='messages'?'/messages':'/chat/completions');
  const fullEndpoint=/\/(chat\/completions|messages|models)\/?$/.test(form.base_url);
  const preset=presets.find(p=>p.id===form.preset);
  const policy=(patch:Partial<ConnectionSnapshot['policy']>)=>setForm(f=>({...f,policy:{...f.policy,...patch,source:'user_override'}}));
  return <div className="provider-connections">
    <div className="provider-list"><Space style={{display:'flex',justifyContent:'space-between'}}><strong>我的连接</strong><Button aria-label="添加连接" icon={<PlusOutlined/>} disabled={Boolean(busy)} onClick={()=>select()}/></Space>
      {profiles.map(p=><button key={p.id} className={selected===p.id?'provider-item selected':'provider-item'} disabled={Boolean(busy)} onClick={()=>select(p)}><strong>{p.name}</strong><small>{p.id===defaultId?'新作品默认 · ':''}{p.enabled?'已启用':'已禁用'} · {p.revisions.length?`${p.revisions[p.revisions.length-1]?.protocol==='messages'?'Messages':'Chat Completions'}`:'草稿'}</small></button>)}
      <p className="muted-note">配置保存在此浏览器。Key默认仅本标签页使用；作品绑定连接与模型。</p>
    </div>
    <Card title={<Space><ApiOutlined/>{selected?'连接详情':'添加连接'}</Space>} extra={<Button icon={<CopyOutlined/>} onClick={copy} disabled={Boolean(busy)}>复制配置</Button>}>
      {error&&<Alert type="error" showIcon title={error} style={{marginBottom:16}}/>}
      <Space orientation="vertical" size={15} style={{width:'100%'}}>
        <label className="provider-field">连接名称<Input aria-label="连接名称" value={name} maxLength={80} disabled={Boolean(busy)} onChange={e=>setName(e.target.value)}/></label>
        <label className="provider-field">服务商<Select aria-label="模型服务商" value={form.preset} disabled={Boolean(selected)||Boolean(busy)} style={{width:'100%'}} options={[...presets.map(p=>({value:p.id,label:p.name})),{value:'custom',label:'Custom · 自定义兼容API'}]} onChange={id=>{const p=presets.find(p=>p.id===id);setForm(blank(p));setName(p?.name||'我的中转');setKey('');setResult(null);}}/></label>
        {preset?.regions&&<label className="provider-field">服务地域<Select aria-label="服务地域" value={form.base_url} disabled={Boolean(selected)||Boolean(busy)} options={preset.regions.map(r=>({value:r.url,label:r.name}))} style={{width:'100%'}} onChange={base_url=>setForm(f=>({...f,base_url}))}/><small>Key须与服务地域匹配。</small></label>}
        {form.preset==='qwen'&&!selected&&<label className="provider-field">可选：百炼专属Workspace域名<Input aria-label="百炼Workspace地址" placeholder="https://工作空间ID.cn-beijing.maas.aliyuncs.com/compatible-mode/v1" value={form.base_url.includes('.maas.')?form.base_url:''} onChange={e=>setForm(f=>({...f,base_url:e.target.value||preset?.url||''}))}/><small>北京或新加坡可使用控制台提供的专属完整Base URL；不要填Key或带查询参数的网址。</small></label>}
        <label className="provider-field">接口协议<Select aria-label="接口协议" value={form.protocol} disabled={form.preset!=='custom'||Boolean(selected)||Boolean(busy)} options={[{value:'chat_completions',label:'OpenAI Chat Completions'},{value:'messages',label:'Anthropic Messages'}]} style={{width:'100%'}} onChange={protocol=>setForm(f=>({...f,protocol,policy:{...defaultPolicy(),structured:'unsupported'}}))}/></label>
        <label className="provider-field">API Base URL<Input aria-label="API Base URL" value={form.base_url} disabled={form.preset!=='custom'||Boolean(selected)||Boolean(busy)} placeholder="https://gateway.example/v1" onChange={e=>setForm(f=>({...f,base_url:e.target.value}))}/><small>最终文字请求：{endpoint}。修改已有连接地址请复制为新连接。</small></label>
        {fullEndpoint&&<Alert type="warning" title="这看起来是完整接口地址" action={<Button onClick={()=>setForm(f=>({...f,base_url:f.base_url.replace(/\/(chat\/completions|messages|models)\/?$/,'')}))}>转换为Base URL</Button>}/>}
        {form.preset==='custom'&&<p className="muted-note">由Braipen服务器访问公网HTTPS API；localhost和局域网地址不支持。API Key仅发送到你确认的目的地。</p>}
        <label className="provider-field">API Key<Input.Password aria-label="连接 API Key" value={key} disabled={Boolean(busy)||form.auth_mode==='none'} autoComplete="off" maxLength={4096} placeholder={unlocked?'本标签页已解锁；留空保留':'填写服务商API Key，不要求sk-前缀'} onChange={e=>setKey(e.target.value)}/></label>
        <label className="provider-field">默认模型<AutoComplete aria-label="默认模型ID" value={form.model} options={models.map(m=>({value:m.id,label:m.name===m.id?m.id:`${m.name} · ${m.id}`}))} filterOption={(input,option)=>String(option?.value||'').toLowerCase().includes(input.toLowerCase())} onChange={model=>setForm(f=>({...f,model}))} style={{width:'100%'}} disabled={Boolean(busy)} placeholder="搜索目录或手动填写 API 模型ID"/><small>目录读取失败仍可手填。可先留空、保存后获取模型列表；保存不会调用模型。</small></label>
        <Space wrap><Tag>{form.policy.source==='official_catalog'?'官方模型规则':'显式兼容策略'}</Tag><Tag>{form.policy.structured==='unsupported'?'结构化未启用':form.policy.structured==='prompt_only'?'提示词兼容 · 仍需程序校验':`原生约束声明 · ${form.policy.structured}`}</Tag></Space>
        <Collapse style={{width:'100%'}} items={[{key:'capabilities',label:'高级兼容设置',children:<Space orientation="vertical" style={{width:'100%'}}>
          <label className="provider-field">输出额度字段<Select aria-label="额度字段" value={form.policy.token_field} style={{width:'100%'}} disabled={Boolean(busy)||form.protocol==='messages'} options={[{value:'max_tokens',label:'max_tokens'},{value:'max_completion_tokens',label:'max_completion_tokens'}]} onChange={token_field=>policy({token_field})}/></label>
          <label className="provider-field">结构化输出<Select aria-label="结构化输出模式" value={form.policy.structured} disabled={Boolean(busy)} style={{width:'100%'}} options={[{value:'unsupported',label:'未启用（阻止设定/知识提取等结构化操作）'},{value:'json_schema',label:'原生 JSON Schema'},{value:'json_object',label:'JSON Object',disabled:form.protocol==='messages'},{value:'prompt_only',label:'提示词兼容模式（不保证格式，程序仍校验）'}]} onChange={structured=>policy({structured})}/></label>
          <label className="provider-field">温度参数<Select aria-label="温度模式" value={form.policy.temperature} style={{width:'100%'}} options={[{value:'omit',label:'不发送（推荐未知模型使用）'},{value:'range',label:'发送；指定允许范围'},{value:'fixed',label:'发送固定值'}]} onChange={temperature=>policy({temperature})}/></label>
          {form.policy.temperature==='range'&&<Space>最小<InputNumber min={0} max={2} step={.1} value={form.policy.temperature_min} onChange={v=>policy({temperature_min:v??0})}/>最大<InputNumber min={0} max={2} step={.1} value={form.policy.temperature_max} onChange={v=>policy({temperature_max:v??2})}/></Space>}
          {form.policy.temperature==='fixed'&&<InputNumber min={0} max={2} step={.1} value={form.policy.temperature_fixed} onChange={v=>policy({temperature_fixed:v??1})}/>}
          <Checkbox checked={form.policy.stream_usage} disabled={form.protocol==='messages'} onChange={e=>policy({stream_usage:e.target.checked})}>发送 stream_options.include_usage</Checkbox>
          {form.preset==='custom'&&<Checkbox disabled={Boolean(selectedProfile?.revisions.length)} checked={form.auth_mode==='none'} onChange={e=>{setKey('');setForm(f=>({...f,auth_mode:e.target.checked?'none':'key'}));}}>此API明确不要求Key（无认证）</Checkbox>}
        </Space>}]} />
        <Space wrap><Button type="primary" loading={busy==='save'} disabled={Boolean(busy)} onClick={()=>void action('save',()=>save())}>保存连接</Button><Button disabled={Boolean(busy)||Boolean(selectedProfile?.revisions.length)} onClick={()=>void action('draft',()=>save(true))}>仅存草稿</Button><Button disabled={Boolean(busy)||!selectedProfile?.enabled} onClick={()=>void action('default',()=>setDefaultConnection(selected))}>设为新作品默认</Button></Space>
        <Space wrap><Button disabled={Boolean(busy)||!selectedProfile?.enabled} loading={busy==='models'} onClick={()=>void action('models',()=>probe('list_models'))}>获取模型列表</Button><Popconfirm title="检测最多调用两次模型，可能计费" description="仅发送固定短样本，不上传小说；检测成功不代表服务强制JSON。" onConfirm={()=>action('test',()=>probe('connection_test'))}><Button disabled={Boolean(busy)||!selectedProfile?.enabled} loading={busy==='test'}>检测文字与结构化能力</Button></Popconfirm>{busy&&<Button onClick={()=>abort.current?.abort()}>取消检测</Button>}</Space>
        {result&&<Alert type={result.ok?'success':'warning'} title={`文字：${String(result.text||'未知')} · 结构化：${String(result.structured||'未检测')}`} description={<>{String(result.message||'')}{Array.isArray(result.errors)&&result.errors.map((e,i)=><div key={i}>{String(e)}</div>)}</>}/>}
        <div style={{borderTop:'1px solid var(--border)',paddingTop:16,width:'100%'}}><Space><LockOutlined/><strong>本地密钥保险箱</strong><Tag>{unlocked?'已解锁':'未解锁'}</Tag><Tag>{vault?'有加密副本':'无加密副本'}</Tag></Space>
          <p className="muted-note">独立口令只用于本浏览器加密，不可找回。模型请求时API Key经Braipen内存转发，服务器不保存或记录。项目备份不包含密钥。</p>
          <Input.Password aria-label="连接解锁口令" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="off" maxLength={1024} placeholder="本地口令，至少8字符"/>
          <Checkbox checked={remember} onChange={e=>setRemember(e.target.checked)} style={{margin:'10px 0'}}>保存新Key时加密记住</Checkbox>
          <Space wrap><Button disabled={!selected||!vault||!password||Boolean(busy)} onClick={()=>void action('unlock',async()=>{await unlockConnection(selected,password);setPassword('');})}>解锁</Button>
            <Button disabled={!selected||!unlocked||password.length<8||Boolean(busy)} onClick={()=>void action('remember',async()=>{const p=await getConnection(selected),s=p.revisions.find(r=>r.revision===p.head)!;await storeConnectionKey(selected,profileKey(p,s),password);setPassword('');})}>加密记住当前Key</Button>
            <Button disabled={!selected||Boolean(busy)} onClick={()=>void action('lock',async()=>{await manageConnection(selected,'lock');setPassword('');})}>锁定并中断任务</Button>
            <Popconfirm title="忘记此连接Key并中断相关任务？" onConfirm={()=>action('forget',async()=>{await manageConnection(selected,'forget');setKey('');setPassword('');})}><Button danger disabled={!selected||Boolean(busy)}>忘记Key</Button></Popconfirm></Space>
        </div>
        {selectedProfile&&<Space wrap><Button disabled={Boolean(busy)} onClick={()=>void action('enable',async()=>{await manageConnection(selected,selectedProfile.enabled?'disable':'enable');})}>{selectedProfile.enabled?'禁用连接并中断任务':'启用连接'}</Button><Popconfirm title="删除连接并中断相关任务？" description="作品和已保存结果保留。" onConfirm={()=>action('delete',async()=>{await manageConnection(selected,'delete');select();})}><Button danger disabled={Boolean(busy)}>删除连接</Button></Popconfirm></Space>}
      </Space>
    </Card>
  </div>;
}
