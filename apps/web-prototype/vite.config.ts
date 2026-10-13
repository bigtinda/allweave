import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    strictPort: true,
    proxy: {
      "/api/model-runtime": { target: "http://127.0.0.1:5192", changeOrigin: false },
      "/api/session": { target: "http://127.0.0.1:5192", changeOrigin: false },
      "/api/workspace": { target: "http://127.0.0.1:5192", changeOrigin: false },
      "/api/health": { target: "http://127.0.0.1:5192", changeOrigin: false },
    },
  },
});
