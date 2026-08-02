import type { ThemeConfig } from "antd";

/**
 * Braipen 暖纸质感主题 —— 从旧 styles.css 的设计变量迁移而来
 * 保留：米色底、棕色主色、纸张质感、圆角体系
 */
export const braipenTheme: ThemeConfig = {
  token: {
    colorPrimary: "#5f4b32",
    colorInfo: "#5f4b32",
    colorSuccess: "#4f7354",
    colorWarning: "#a16d24",
    colorError: "#a6534e",
    colorText: "#26221c",
    colorTextSecondary: "#746b5f",
    colorTextTertiary: "#9a8f80",
    colorBgLayout: "#f4efe6",
    colorBgContainer: "#fffaf2",
    colorBgElevated: "#fffdf8",
    colorBorder: "#ddd0bd",
    colorBorderSecondary: "#e6dccb",
    borderRadius: 8,
    borderRadiusLG: 10,
    fontFamily:
      '"Segoe UI", "Microsoft YaHei", system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
    fontSize: 14,
  },
  components: {
    Layout: {
      headerBg: "#f4efe6",
      siderBg: "#f4efe6",
      bodyBg: "#f4efe6",
    },
    Card: {
      colorBgContainer: "#fffaf2",
      headerBg: "transparent",
    },
    Menu: {
      itemBg: "transparent",
      itemSelectedBg: "#efe4d3",
      itemSelectedColor: "#493821",
      itemHoverBg: "#f5eedd",
    },
    Button: {
      primaryShadow: "none",
    },
    Table: {
      headerBg: "#f0e8dc",
      headerColor: "#493821",
      rowHoverBg: "#f8f1e7",
    },
  },
};
