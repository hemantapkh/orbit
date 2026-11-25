import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // ECharts is one large, lazily loaded chunk on purpose (only pages with charts load it).
  build: { chunkSizeWarningLimit: 800 },
  server: {
    port: 5173,
    proxy: { "/api": process.env.ORBIT_API ?? "http://127.0.0.1:8000" },
  },
});
