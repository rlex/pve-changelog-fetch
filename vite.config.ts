import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // In dev, the frontend talks to the local `wrangler dev` API.
      "/api": "http://localhost:8787",
    },
  },
});