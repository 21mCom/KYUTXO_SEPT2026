import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  oxc: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client", "src"),
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
  test: {
    include: [
      "client/src/**/*.test.ts",
      "client/src/**/*.test.tsx",
      "server/**/*.test.ts",
      "electron/**/*.test.ts",
    ],
  },
});
