import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const source = readFileSync(new URL('../src/settingGeneration.ts',import.meta.url),'utf8');
const {outputText}=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}});
const exports={};runInNewContext(outputText,{exports});
const {settingGenerationRequest,applySettingGeneration}=exports;
const config={title:'作者书名',model:'原模型',protagonist:'已保存主角',supporting_characters:'已保存配角',worldview:'旧世界',core_conflict:'原冲突',genre:'都市'};
test('单项只更新选择，保留未选手写草稿、标题、模型与新白话',()=>{
 const request=settingGenerationRequest({raw_story_idea:'新白话',selected_fields:['worldview'],draft:{protagonist:'手写主角',supporting_characters:'手写配角',core_conflict:'手写冲突',genre:'科幻'}});
 const next=applySettingGeneration(config,{expanded_data:{world_setting:'新世界',protagonist_setting:'不应应用',core_conflict:'不应覆盖'}},request);
 assert.equal(next.worldview,'新世界');assert.equal(next.protagonist,'手写主角');assert.equal(next.supporting_characters,'手写配角');assert.equal(next.core_conflict,'手写冲突');assert.equal(next.raw_story_idea,'新白话');assert.equal(next.genre,'科幻');assert.equal(next.title,config.title);assert.equal(next.model,config.model);assert.equal(config.worldview,'旧世界');
});
test('多项验证全量通过后才返回结果，缺任一字段不部分应用',()=>{
 const request={selected_fields:['worldview','core_conflict'],raw_story_idea:'设想'};
 assert.throws(()=>applySettingGeneration(config,{expanded_data:{world_setting:'候选'}},request),/扩写结果字段不完整/);
 assert.equal(config.worldview,'旧世界');
 const next=applySettingGeneration(config,{expanded_data:{world_setting:'世界',core_conflict:'冲突'}},request);assert.equal(next.worldview,'世界');assert.equal(next.core_conflict,'冲突');assert.equal(next.protagonist,config.protagonist);
});
test('旧请求未选字段时保持四项生成兼容',()=>{
 const next=applySettingGeneration(config,{expanded_data:{protagonist_setting:'主角',supporting_characters_setting:'配角',world_setting:'世界',core_conflict:'冲突'}},{raw_story_idea:'白话'});
 assert.equal(next.protagonist,'主角');assert.equal(next.worldview,'世界');
});
test('空、非法、重复选择及非文本草稿在发送前拒绝',()=>{
 for(const selected_fields of [[],null,'worldview',['missing'],['worldview','worldview'],['__proto__']])assert.throws(()=>settingGenerationRequest({raw_story_idea:'白话',selected_fields}),/请选择要生成/);
 for(const draft of [[],null,{api_key:'SYNTHETIC_NEVER_FORWARD'},{worldview:42}])assert.throws(()=>settingGenerationRequest({raw_story_idea:'白话',selected_fields:['worldview'],draft}),/设定格式无效/);
 assert.throws(()=>settingGenerationRequest({raw_story_idea:' ',selected_fields:['worldview']}),/先填写白话/);
});
