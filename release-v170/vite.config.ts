import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
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
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer(),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  define: {
    // Injected at build time so client code never needs @fs access to package.json.
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
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    // No cross-origin grants: the launch-token security model relies on the
    // browser refusing any other origin access to the served HTML (which
    // carries the token <meta> tag) and to /api. Vite's default (cors: true)
    // would stamp Access-Control-Allow-Origin: * on the token-bearing page.
    cors: false,
    fs: {
      strict: true,
      // Restrict serving to only the directories the browser client actually
      // needs. server/, package.json, and dotfiles all live outside these
      // directories and will be blocked.  The version string is already
      // injected via `define`, so package.json itself is no longer imported.
      allow: [
        path.resolve(import.meta.dirname, "client"),
        path.resolve(import.meta.dirname, "shared"),
        path.resolve(import.meta.dirname, "attached_assets"),
        // node_modules is needed for fonts and other assets that CSS imports
        // directly (e.g. @fontsource-variable/*). Pre-bundled dep cache paths
        // are inside node_modules so they also need to be reachable.
        path.resolve(import.meta.dirname, "node_modules"),
      ],
      deny: ["**/.*", "**/.env*"],
    },
  },
});
