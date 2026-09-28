import { useEffect, useState } from 'react';
import { Alert, Button, Card, Select, Space } from 'antd';
import { connections, getConnection } from '../providerConnections';
import { getProject } from '../localStore';
import { updateProjectConfig } from '../api';
import type { ConnectionProfile } from '../providerTypes';
export default function ConnectionPicker({projectRef,onChanged}:{projectRef:string|null;onChanged?:()=>void|Promise<void>}){
  const [list,setList]=useState<ConnectionProfile[]>([]),[selected,setSelected]=useState(''),[saved,setSaved]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{let current=true;const load=async()=>{try{const values=await connections();const p=projectRef?await getProject(projectRef):null;if(current){setList(values);setSelected(String(p?.config.connection_id||''));setSaved(String(p?.config.connection_id||''));}}catch(e){if(current)setError(String(e));}};void load();window.addEventListener('braipen:connections-changed',load);return()=>{current=false;window.removeEventListener('braipen:connections-changed',load);};},[projectRef]);
  if(!projectRef)return null;
  async function save(){if(!projectRef)return;setBusy(true);setError('');try{const profile=await getConnection(selected),snapshot=profile.revisions.find(r=>r.revision===profile.head);if(!snapshot)throw new Error('请先验证连接。');await updateProjectConfig(projectRef,{connection_id:selected,model:snapshot.model});setSaved(selected);await onChanged?.();}catch(e){setError(e instanceof Error?e.message:'连接绑定未保存。');}finally{setBusy(false);}}
  return <Card size="small" title="此作品使用的模型连接"><Space wrap><Select aria-label="作品模型连接" style={{minWidth:260}} value={selected||undefined} onChange={setSelected} options={list.map(p=>({value:p.id,label:`${p.name} · ${p.revisions.find(r=>r.revision===p.head)?.model||'待配置'}`,disabled:!p.enabled||!p.revisions.length}))}/><Button disabled={busy||selected===saved||!selected} loading={busy} onClick={()=>void save()}>绑定此连接</Button></Space><p className="muted-note">绑定会更新后续新任务的默认模型；已有任务、自动摘要和批次继续使用其冻结连接。切换现有任务请先结束任务。</p>{error&&<Alert type="error" title={error}/>}</Card>;
}
