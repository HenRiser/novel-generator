import type { ConnectionProfile, ConnectionSnapshot, ConnectionGuard } from './providerTypes';
import { deleteSetting, getSetting, setSetting, commitSettings } from './localStore';

const VAULT = 'deepseek-key-vault.v1';
const ITERATIONS = 600_000;
let sessionKey = '';
type Vault = { version: 1; iterations: number; salt: number[]; iv: number[]; ciphertext: number[] };

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

export async function rememberKey(key: string, passphrase: string): Promise<void> {
  const value = key.trim();
  if (!value || value.length > 300 || /[\r\n]/.test(value)) throw new Error('请先配置有效的 DeepSeek API Key。');
  if (passphrase.length < 8) throw new Error('本地解锁口令至少需要 8 个字符。');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptionKey = await derive(passphrase, salt);
  const plaintext = new TextEncoder().encode(value);
  try {
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encryptionKey, plaintext);
    await setSetting(VAULT, { version: 1, iterations: ITERATIONS, salt: Array.from(salt), iv: Array.from(iv), ciphertext: Array.from(new Uint8Array(encrypted)) } satisfies Vault);
    setSessionKey(value);
  } finally { plaintext.fill(0); }
}

function validVault(value: unknown): value is Vault {
  if (!value || typeof value !== 'object') return false;
  const vault = value as Vault;
  const bytes = (items: unknown, min: number, max: number) => Array.isArray(items) && items.length >= min && items.length <= max && items.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
  return vault.version === 1 && vault.iterations === ITERATIONS && bytes(vault.salt, 16, 16) && bytes(vault.iv, 12, 12) && bytes(vault.ciphertext, 17, 1216);
}

export async function unlockKey(passphrase: string): Promise<void> {
  const vault = await getSetting<unknown>(VAULT);
  if (!vault) throw new Error('此浏览器没有记住的 API Key。');
  if (!validVault(vault)) throw new Error('本地密钥记录已损坏，请清除后重新配置。');
  const key = await derive(passphrase, new Uint8Array(vault.salt));
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(vault.iv) }, key, new Uint8Array(vault.ciphertext)));
    setSessionKey(new TextDecoder().decode(plaintext));
  } catch { throw new Error('口令错误或密钥记录已损坏。'); }
  finally { plaintext?.fill(0); }
}

export async function forgetKey(): Promise<void> { await deleteSetting(VAULT); setSessionKey(''); }
export async function hasRememberedKey(): Promise<boolean> { return (await getSetting(VAULT)) !== undefined; }

// Version 2: per-connection sessions. Passwords and derived CryptoKeys never persist.
type ProfileSession = { key: string; destination: string; epoch: number; keyVersion: string };
const sessions = new Map<string, ProfileSession>();
const revocations = new Set<(id: string) => void>();
const keyChannel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('braipen:connections');
function revoked(id: string) { sessions.delete(id); if (id === 'legacy-deepseek') sessionKey = ''; for (const listener of revocations) listener(id); window.dispatchEvent(new Event('braipen:key-changed')); window.dispatchEvent(new Event('braipen:connections-changed')); }
keyChannel?.addEventListener('message', event => { if (event.data?.type === 'revoke' && typeof event.data.id === 'string') revoked(event.data.id); else window.dispatchEvent(new Event('braipen:connections-changed')); });
export function notifyConnection(id: string, revoke = false) { if (revoke) revoked(id); keyChannel?.postMessage({ type: revoke ? 'revoke' : 'changed', id }); window.dispatchEvent(new Event('braipen:connections-changed')); }
export function onConnectionRevoked(listener: (id: string) => void) { revocations.add(listener); return () => { revocations.delete(listener); }; }
export function validateKey(key: string) { if (!key.trim() || key.length > 4096 || /[^\x20-\x7e]/.test(key)) throw new Error('Key不能为空、超过4096字符或包含控制字符。'); }
export function profileKey(profile: ConnectionProfile, snapshot: ConnectionSnapshot): string {
  const entry = sessions.get(profile.id);
  if (entry && entry.destination === snapshot.destination_fingerprint && entry.epoch === profile.epoch && entry.keyVersion === profile.key_version) return entry.key;
  // Legacy memory is scoped exclusively to the original official destination during the migration session.
  if (profile.id === 'legacy-deepseek' && profile.epoch === 0 && snapshot.base_url === 'https://api.deepseek.com' && snapshot.protocol === 'chat_completions') return sessionKey;
  return '';
}
export function loadProfileKey(profile: ConnectionProfile, snapshot: ConnectionSnapshot, key: string) {
  validateKey(key); sessions.set(profile.id, { key: key.trim(), destination: snapshot.destination_fingerprint, epoch: profile.epoch, keyVersion: profile.key_version });
  window.dispatchEvent(new Event('braipen:key-changed'));
}
const aad = (id: string, snapshot: ConnectionSnapshot) => new TextEncoder().encode(id + '\n' + snapshot.protocol + '\n' + snapshot.base_url);
export async function encryptProfileKey(profile: ConnectionProfile, snapshot: ConnectionSnapshot, key: string, passphrase: string) {
  validateKey(key); if (passphrase.length < 8 || passphrase.length > 1024) throw new Error('本地口令长度为8–1024字符。');
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptionKey = await derive(passphrase, salt), plaintext = new TextEncoder().encode(key.trim());
  try {
    const cipher = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(profile.id,snapshot)},encryptionKey,plaintext);
    return {version:2,iterations:ITERATIONS,salt:Array.from(salt),iv:Array.from(iv),ciphertext:Array.from(new Uint8Array(cipher)), destination:snapshot.destination_fingerprint};
  } finally { plaintext.fill(0); }
}
export async function unlockProfileKey(profile: ConnectionProfile, snapshot: ConnectionSnapshot, passphrase: string): Promise<void> {
  const entry = await getSetting<Omit<Vault, 'version'> & { version: number; destination?: string }>('vault:' + profile.id);
  if (!entry && profile.id === 'legacy-deepseek' && await hasRememberedKey()) {
    // Crypto precedes the single commit; a failed transaction leaves the v1 ciphertext intact.
    await unlockKey(passphrase); const key = getSessionKey(); const encrypted = await encryptProfileKey(profile,snapshot,key,passphrase);
    await commitSettings([{key:'vault:' + profile.id,value:encrypted},{key:VAULT,remove:true}]);
    loadProfileKey(profile,snapshot,key); return;
  }
  if (!entry || Number(entry.version) !== 2 || entry.iterations !== ITERATIONS || entry.destination !== snapshot.destination_fingerprint ||
      !Array.isArray(entry.ciphertext) || entry.ciphertext.length > 8192 || entry.salt?.length !== 16 || entry.iv?.length !== 12) throw new Error('没有可解锁的密钥，或记录已损坏。');
  let plaintext: Uint8Array | undefined;
  try { const key=await derive(passphrase,new Uint8Array(entry.salt)); plaintext=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(entry.iv),additionalData:aad(profile.id,snapshot)},key,new Uint8Array(entry.ciphertext))); loadProfileKey(profile,snapshot,new TextDecoder().decode(plaintext)); }
  catch { throw new Error('口令错误或密钥记录已损坏。'); }
  finally { plaintext?.fill(0); }
}
