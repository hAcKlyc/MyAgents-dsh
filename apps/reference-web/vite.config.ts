import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  build: {
    assetsInlineLimit: 0,
    emptyOutDir: true,
    manifest: true,
    outDir: resolve(import.meta.dirname, "dist"),
    reportCompressedSize: true,
    sourcemap: false,
    target: "es2024",
  },
  server: {
    host: "127.0.0.1",
    strictPort: true,
  },
});
