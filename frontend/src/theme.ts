import { theme as antdTheme, type ThemeConfig } from "antd";

export type Appearance = "editorial" | "silver" | "night";
export const APPEARANCE_KEY = "braipen.appearance.v1";
export const APPEARANCES = [
  { value: "editorial" as const, label: "铅印", description: "浅纸、墨黑与暗红，默认的书写底色。" },
  { value: "silver" as const, label: "银灰", description: "冷灰与石蓝，清晰而安静。" },
  { value: "night" as const, label: "午夜", description: "石墨黑与柔和珊瑚，适合低光环境。" },
];

export const appearancePalettes = {
  editorial: {
    paper: "#f5f4f1", surface: "#fbfaf8", "surface-soft": "#eeece7", ink: "#292623", muted: "#706963", faint: "#706963",
    border: "#dedbd5", "border-strong": "#b8b2aa", accent: "#8d302d", "accent-hover": "#aa403b", "accent-soft": "#efe4df", "on-accent": "#ffffff",
    success: "#456b4b", "success-soft": "#e6ede4", warning: "#8a642b", "warning-soft": "#f3ead8", danger: "#a43e35", "danger-soft": "#f4e4df",
  },
  silver: {
    paper: "#edf0f2", surface: "#fafbfc", "surface-soft": "#e4e8ec", ink: "#252d35", muted: "#5b6672", faint: "#5b6672",
    border: "#d4dae0", "border-strong": "#a3adb9", accent: "#455f79", "accent-hover": "#314b65", "accent-soft": "#dce4ec", "on-accent": "#ffffff",
    success: "#426951", "success-soft": "#e3ece7", warning: "#86612c", "warning-soft": "#f2e9d9", danger: "#a2403c", "danger-soft": "#f1e2e0",
  },
  night: {
    paper: "#1c1d20", surface: "#222327", "surface-soft": "#2a2b30", ink: "#e4e1dc", muted: "#b0aaa3", faint: "#b0aaa3",
    border: "#3b3c41", "border-strong": "#64636a", accent: "#d39484", "accent-hover": "#e1ad9e", "accent-soft": "#3b2b29", "on-accent": "#261a17",
    success: "#a4c0a6", "success-soft": "#29362e", warning: "#d5b77e", "warning-soft": "#383126", danger: "#e0a096", "danger-soft": "#3f2b2c",
  },
};

export function isAppearance(value: unknown): value is Appearance {
  return value === "editorial" || value === "silver" || value === "night";
}
export function readAppearance(): Appearance {
  try {
    const value = window.localStorage.getItem(APPEARANCE_KEY);
    return isAppearance(value) ? value : "editorial";
  } catch { return "editorial"; }
}
/** One palette drives native surfaces, canvas labels, and Ant Design controls. */
export function applyAppearance(appearance: Appearance) {
  const root = document.documentElement;
  root.dataset.appearance = appearance;
  root.style.colorScheme = appearance === "night" ? "dark" : "light";
  for (const [name, value] of Object.entries(appearancePalettes[appearance])) {
    root.style.setProperty(`--${name}`, value);
    // Reader surfaces override local paper/ink without CSS variable cycles.
    root.style.setProperty(`--app-${name}`, value);
  }
}
export function getAppearanceTheme(appearance: Appearance): ThemeConfig {
  const palette = appearancePalettes[appearance];
  return {
    algorithm: appearance === "night" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: palette.accent, colorInfo: palette.accent, colorSuccess: palette.success, colorWarning: palette.warning, colorError: palette.danger,
      colorText: palette.ink, colorTextSecondary: palette.muted, colorTextTertiary: palette.faint, colorTextLightSolid: "#ffffff",
      colorBgLayout: palette.paper, colorBgContainer: palette.surface, colorBgElevated: palette.surface,
      colorBorder: palette.border, colorBorderSecondary: palette.border,
      borderRadius: 3, borderRadiusLG: 4, controlHeight: 38, fontSize: 14,
      fontFamily: '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif', boxShadow: "0 8px 28px rgba(0, 0, 0, .12)",
    },
    components: {
      Card: { headerBg: "transparent", headerFontSize: 15, paddingLG: 24 },
      Button: { primaryShadow: "none", defaultShadow: "none", primaryColor: palette["on-accent"], fontWeight: 500 },
      Table: { headerBg: palette["surface-soft"], headerColor: palette.ink, rowHoverBg: palette["surface-soft"] },
      Tabs: { horizontalItemGutter: 28 }, Modal: { titleFontSize: 22 },
      Menu: { itemSelectedBg: palette["accent-soft"], itemSelectedColor: palette.accent },
    },
  };
}
