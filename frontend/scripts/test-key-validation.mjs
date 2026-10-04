import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/keyVault.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const exports = {};
runInNewContext(outputText, { exports, require: name => { assert.equal(name, './localStore'); return {}; } });

for (const [name, value, expected] of [
  ['未填写', '', '未填写 API Key。请在「偏好设置 → 模型连接」填写当前连接的 Key。'],
  ['只有空白', '  ', '未填写 API Key。请在「偏好设置 → 模型连接」填写当前连接的 Key。'],
  ['超过长度上限', 'A'.repeat(4097), 'API Key 长度为 4097 个字符，超过 4096 个字符的上限。请检查是否误粘贴了说明文字或重复内容。'],
  ['含换行', 'SYNTHETIC_PRIVATE_PREFIX\n', 'API Key 含换行符。请粘贴单行密钥，删除换行后重试。'],
  ['含回车', 'SYNTHETIC_PRIVATE_PREFIX\r', 'API Key 含换行符。请粘贴单行密钥，删除换行后重试。'],
  ['含Tab', 'SYNTHETIC_PRIVATE_PREFIX\t', 'API Key 含制表符（Tab）。请删除制表符后重试。'],
  ['含其他控制字符', 'SYNTHETIC_PRIVATE_PREFIX\0', 'API Key 含不可见控制字符。请重新复制密钥本身后重试。'],
  ['含DEL', 'SYNTHETIC_PRIVATE_PREFIX\x7f', 'API Key 含不可见控制字符。请重新复制密钥本身后重试。'],
  ['含中文或全角字符', 'SYNTHETIC_PRIVATE_PREFIX密钥', 'API Key 含非 ASCII 字符。请检查中文、全角字符或特殊空格，并重新复制密钥本身。'],
  ['含非ASCII空格', 'SYNTHETIC_PRIVATE_PREFIX\u00a0', 'API Key 含非 ASCII 字符。请检查中文、全角字符或特殊空格，并重新复制密钥本身。'],
]) test(name + '只提示实际原因且不显示密钥内容', () => {
  let message = '';
  try { exports.validateKey(value); } catch (error) { message = error.message; }
  assert.equal(message, expected);
  assert.ok(!message.includes('SYNTHETIC_PRIVATE_PREFIX'));
});

test('保留既有可打印ASCII、非sk密钥及长度边界', () => {
  for (const value of ['NON_SK_SYNTHETIC_KEY', '  SYNTHETIC_KEY  ', 'A'.repeat(4096), 'ASCII !#$%&()*+,-./:;<=>?@[\\]^_`{|}~']) assert.doesNotThrow(() => exports.validateKey(value));
});
