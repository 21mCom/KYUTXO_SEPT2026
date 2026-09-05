import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { version: pkgVersion } = require("./package.json") as { version: string };

export default defineConfig({
  plugins: [
    react(),
    {
      name: "app-version-html",
      transformIndexHtml(html) {
        return html.replaceAll("__APP_VERSION__", pkgVersion);
      },
    },
  ],
  define: {
    // Keep the packaged renderer aligned with the normal Vite build. Without
    // this replacement, the bare compile-time identifier throws before React
    // mounts and Electron displays a blank window.
    __APP_VERSION__: JSON.stringify(pkgVersion),
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  base: './',
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
});
