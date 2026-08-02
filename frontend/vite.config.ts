import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // 三方库按类别分包，避免单一 1MB 大包，提升缓存命中
          if (id.includes("node_modules/antd") || id.includes("node_modules/@ant-design") || id.includes("node_modules/rc-") || id.includes("node_modules/@rc-component")) {
            return "antd";
          }
          if (id.includes("node_modules/three") || id.includes("node_modules/@tweenjs")) {
            return "three";
          }
          if (id.includes("node_modules/@antv/g6") || id.includes("node_modules/@antv")) {
            return "g6";
          }
          if (id.includes("node_modules/react") || id.includes("node_modules/scheduler") || id.includes("node_modules/react-router") || id.includes("node_modules/zustand") || id.includes("node_modules/use-sync-external-store")) {
            return "react-vendor";
          }
          // three 是动态 import 的，拆成独立 chunk 后按需加载
          if (id.includes("node_modules")) {
            return "vendor";
          }
          return undefined;
        },
      },
    },
    chunkSizeWarningLimit: 700,
  },
});
