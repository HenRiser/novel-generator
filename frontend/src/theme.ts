import type { ThemeConfig } from "antd";

/** 纸张、墨色与低饱和标记：与创作内容保持同一套视觉语言。 */
export const braipenTheme: ThemeConfig = {
  token: {
    colorPrimary: "#173f35", colorInfo: "#416a5d", colorSuccess: "#527d59",
    colorWarning: "#ad7742", colorError: "#b45646", colorText: "#263b32",
    colorTextSecondary: "#728078", colorTextTertiary: "#909b94",
    colorBgLayout: "#f6f5f0", colorBgContainer: "#fffefa", colorBgElevated: "#fffefa",
    colorBorder: "#d8dfd6", colorBorderSecondary: "#e5e8e0",
    borderRadius: 8, borderRadiusLG: 12, controlHeight: 36, fontSize: 14,
    fontFamily: '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    boxShadow: "0 8px 32px rgba(27, 51, 39, .08)",
  },
  components: {
    Layout: { headerBg: "#f6f5f0", siderBg: "#163b32", bodyBg: "#f6f5f0" },
    Card: { headerBg: "transparent", headerFontSize: 14, paddingLG: 24 },
    Menu: { itemBg: "transparent", itemSelectedBg: "#e9eee5", itemSelectedColor: "#173f35", itemHoverBg: "#eff2eb" },
    Button: { primaryShadow: "none", defaultShadow: "none", fontWeight: 500 },
    Table: { headerBg: "#f0f3ec", headerColor: "#385446", rowHoverBg: "#f6f8f2" },
    Tabs: { horizontalItemGutter: 28 },
    Modal: { titleFontSize: 20 },
  },
};
