import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // GitHub Pages 프로젝트 사이트 배포 시: DEPLOY_BASE=/budongsan/ npm run build
  base: process.env.DEPLOY_BASE ?? "/",
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Hand-rolled vendor chunks so the heavy map runtime can be cached
        // independently from app code. Anything not matched falls into the
        // default page chunks (MapPage / DetailPage) via dynamic import().
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("maplibre-gl")) return "maplibre";
            if (id.includes("react-dom") || /\/react\//.test(id)) return "react";
            if (id.includes("@turf")) return "turf";
            return "vendor";
          }
          return undefined;
        },
      },
    },
    // We split deliberately; raise the threshold so the noisy 500 KB warning
    // only fires for unexpected regressions.
    chunkSizeWarningLimit: 900,
  },
});
