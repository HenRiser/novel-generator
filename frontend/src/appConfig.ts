/**
 * 前端应用级配置。
 *
 * 优先读取环境变量 VITE_* 覆盖，缺省使用本地默认值。
 * 环境变量方式：在 frontend/.env.local 中设置
 *   VITE_SHOW_INTRO=false    （开屏动画）
 * 修改后需重启 vite dev server 生效。
 */

interface AppConfig {
  /** 是否在首次进入应用时播放开屏动画（IntroAnimation） */
  showIntro: boolean;
}

function envFlag(name: string, fallback: boolean): boolean {
  const value = (import.meta as unknown as {
    readonly env?: { readonly [key: string]: string | undefined };
  }).env?.[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  return value !== "false" && value !== "0" && value.toLowerCase() !== "off";
}

export const APP_CONFIG: AppConfig = {
  // 当前默认关闭开屏动画（three.js 开场动画体积较大，仅展示用）
  showIntro: envFlag("VITE_SHOW_INTRO", false),
};

export function shouldShowIntro(): boolean {
  return APP_CONFIG.showIntro;
}
