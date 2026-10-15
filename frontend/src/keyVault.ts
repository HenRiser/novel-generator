import type { ConnectionProfile, ConnectionSnapshot } from './providerTypes';
import { getSetting } from './localStore';

const VAULT = 'deepseek-key-vault.v1';
const ITERATIONS = 600_000;
let sessionKey = '';
export type KeyStorageMode = 'session' | 'remembered' | 'legacy' | 'invalid';
type LegacyVault = { version: number; iterations: number; salt: number[]; iv: number[]; ciphertext: number[]; destination?: string };

export function getSessionKey(): string { return sessionKey; }
export function setSessionKey(key: string): void {
  const value = key.trim();
  if (value.length > 300 || /[\r\n]/.test(value)) throw new Error('API Key 格式不正确。');
  sessionKey = value;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('braipen:key-changed'));
}

async function derive(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const password = new TextEncoder().encode(passphrase);
  try {
    const material = await crypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
      material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally { password.fill(0); }
}

function validLegacyVault(value: unknown): value is LegacyVault {
  if (!value || typeof value !== 'object') return false;
  const vault = value as LegacyVault;
  const bytes = (items: unknown, min: number, max: number) => Array.isArray(items) && items.length >= min && items.length <= max && items.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
  return [1, 2].includes(vault.version) && vault.iterations === ITERATIONS && bytes(vault.salt, 16, 16) && bytes(vault.iv, 12, 12) && bytes(vault.ciphertext, 17, 8192);
}

const originalDestination = (profile: ConnectionProfile, snapshot: ConnectionSnapshot) => profile.id === 'legacy-deepseek' && snapshot.base_url === 'https://api.deepseek.com' && snapshot.protocol === 'chat_completions' && snapshot.auth_mode === 'key';

// Decryption exists only for an explicit, one-time conversion of old records.
// Do not change storage or session state until the caller commits the new record.
export async function decryptLegacyProfileKey(profile: ConnectionProfile, snapshot: ConnectionSnapshot, passphrase: string): Promise<string> {
  if (!passphrase || passphrase.length > 1024) throw new Error('请填写旧版 Key 的解锁口令，最多 1024 字符。');
  let entry = await getSetting<unknown>('vault:' + profile.id);
  if (entry === undefined && originalDestination(profile, snapshot)) entry = await getSetting<unknown>(VAULT);
  if (!validLegacyVault(entry) || (entry.version === 1 ? !originalDestination(profile, snapshot) : entry.destination !== snapshot.destination_fingerprint)) throw new Error('没有可迁移的旧版加密 Key，或记录与当前连接不匹配。');
  let plaintext: Uint8Array | undefined;
  try {
    const key = await derive(passphrase, new Uint8Array(entry.salt));
    plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(entry.iv), ...(entry.version === 2 ? { additionalData: aad(profile.id, snapshot) } : {}) }, key, new Uint8Array(entry.ciphertext)));
    const value = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    validateKey(value); return value.trim();
  } catch { throw new Error('旧口令错误或加密 Key 记录已损坏。'); }
  finally { plaintext?.fill(0); }
}

// Persistent version 3 records are plaintext and require explicit user opt-in.
// The vault: prefix is retained so existing backups continue excluding all keys.
async function storedCredential(profile: ConnectionProfile, snapshot: ConnectionSnapshot): Promise<{ mode: KeyStorageMode; key?: string }> {
  const entry = await getSetting<Record<string, unknown>>('vault:' + profile.id);
  if (entry === undefined) return { mode: originalDestination(profile, snapshot) && await getSetting(VAULT) !== undefined ? 'legacy' : 'session' };
  if (validLegacyVault(entry)) return { mode: (entry.version === 1 ? originalDestination(profile, snapshot) : entry.destination === snapshot.destination_fingerprint) ? 'legacy' : 'invalid' };
  if (!entry || entry.version !== 3 || entry.destination !== snapshot.destination_fingerprint || entry.key_version !== profile.key_version || typeof entry.api_key !== 'string') return { mode: 'invalid' };
  try { validateKey(entry.api_key); } catch { return { mode: 'invalid' }; }
  return { mode: 'remembered', key: entry.api_key.trim() };
}
export async function keyStorageMode(profile: ConnectionProfile, snapshot: ConnectionSnapshot): Promise<KeyStorageMode> {
  return (await storedCredential(profile, snapshot)).mode;
}
export async function restoreProfileKey(profile: ConnectionProfile, snapshot: ConnectionSnapshot): Promise<void> {
  if (!profile.enabled || profile.deleted || snapshot.auth_mode === 'none' || profileKey(profile, snapshot)) return;
  const stored = await storedCredential(profile, snapshot);
  if (stored.mode === 'remembered' && stored.key) loadProfileKey(profile, snapshot, stored.key, false);
}
type ProfileSession = { key: string; destination: string; epoch: number; keyVersion: string };
const sessions = new Map<string, ProfileSession>();
const revocations = new Set<(id: string) => void>();
const keyChannel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('braipen:connections');
function revoked(id: string) { sessions.delete(id); if (id === 'legacy-deepseek') sessionKey = ''; for (const listener of revocations) listener(id); window.dispatchEvent(new Event('braipen:key-changed')); window.dispatchEvent(new Event('braipen:connections-changed')); }
keyChannel?.addEventListener('message', event => { if (event.data?.type === 'revoke' && typeof event.data.id === 'string') revoked(event.data.id); else window.dispatchEvent(new Event('braipen:connections-changed')); });
export function notifyConnection(id: string, revoke = false) { if (revoke) revoked(id); keyChannel?.postMessage({ type: revoke ? 'revoke' : 'changed', id }); window.dispatchEvent(new Event('braipen:connections-changed')); }
export function onConnectionRevoked(listener: (id: string) => void) { revocations.add(listener); return () => { revocations.delete(listener); }; }
export function validateKey(key: string) {
  if (!key.trim()) throw new Error('未填写 API Key。请在「偏好设置 → 模型连接」填写当前连接的 Key。');
  if (key.length > 4096) throw new Error(`API Key 长度为 ${key.length} 个字符，超过 4096 个字符的上限。请检查是否误粘贴了说明文字或重复内容。`);
  if (/[\r\n]/.test(key)) throw new Error('API Key 含换行符。请粘贴单行密钥，删除换行后重试。');
  if (/\t/.test(key)) throw new Error('API Key 含制表符（Tab）。请删除制表符后重试。');
  if (/[\x00-\x1f\x7f]/.test(key)) throw new Error('API Key 含不可见控制字符。请重新复制密钥本身后重试。');
  if (/[^\x20-\x7e]/.test(key)) throw new Error('API Key 含非 ASCII 字符。请检查中文、全角字符或特殊空格，并重新复制密钥本身。');
}
export function profileKey(profile: ConnectionProfile, snapshot: ConnectionSnapshot): string {
  const entry = sessions.get(profile.id);
  if (entry && entry.destination === snapshot.destination_fingerprint && entry.epoch === profile.epoch && entry.keyVersion === profile.key_version) return entry.key;
  // Legacy memory is scoped exclusively to the original official destination during the migration session.
  if (profile.id === 'legacy-deepseek' && profile.epoch === 0 && snapshot.base_url === 'https://api.deepseek.com' && snapshot.protocol === 'chat_completions') return sessionKey;
  return '';
}
export function loadProfileKey(profile: ConnectionProfile, snapshot: ConnectionSnapshot, key: string, emit = true) {
  validateKey(key); sessions.set(profile.id, { key: key.trim(), destination: snapshot.destination_fingerprint, epoch: profile.epoch, keyVersion: profile.key_version });
  if (emit) window.dispatchEvent(new Event('braipen:key-changed'));
}
const aad = (id: string, snapshot: ConnectionSnapshot) => new TextEncoder().encode(id + '\n' + snapshot.protocol + '\n' + snapshot.base_url);
