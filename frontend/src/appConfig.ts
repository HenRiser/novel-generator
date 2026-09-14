/** 开场偏好只保存在当前浏览器，存储不可用时仍可正常进入工作台。 */
const INTRO_SEEN_KEY = "braipen:intro-seen:v2";
const INTRO_HIDDEN_KEY = "braipen:intro-hidden";

function envFlag(name: string, fallback: boolean): boolean {
  const value = (import.meta as unknown as { readonly env?: Record<string, string | undefined> }).env?.[name];
  if (value === undefined || value === "") return fallback;
  return !["false", "0", "off"].includes(value.toLowerCase());
}

export const APP_CONFIG = { showIntro: envFlag("VITE_SHOW_INTRO", true) };

function readFlag(key: string): boolean {
  try { return window.localStorage.getItem(key) === "true"; } catch { return false; }
}

export function isIntroHidden(): boolean { return readFlag(INTRO_HIDDEN_KEY); }

export function setIntroHidden(hidden: boolean): void {
  try { window.localStorage.setItem(INTRO_HIDDEN_KEY, String(hidden)); } catch { /* 浏览器禁用存储时，偏好只在当前界面生效。 */ }
}

export function markIntroSeen(): void {
  try { window.localStorage.setItem(INTRO_SEEN_KEY, "true"); } catch { /* 存储失败不影响进入应用。 */ }
}

export function shouldShowIntro(): boolean {
  return APP_CONFIG.showIntro && !isIntroHidden() && !readFlag(INTRO_SEEN_KEY);
}
