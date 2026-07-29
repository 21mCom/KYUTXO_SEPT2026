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
    // Fork workers can be slow to shut down when the machine is loaded (e.g.
    // several validation suites running in parallel). The default 10s teardown
    // budget then trips "[vitest-pool]: Timeout terminating forks worker",
    // which makes vitest exit 1 even though every test passed. Give teardown a
    // generous budget so load never turns a green run into a spurious failure.
    teardownTimeout: 60_000,
    include: [
      "client/src/**/*.test.ts",
      "client/src/**/*.test.tsx",
      "server/**/*.test.ts",
      "electron/**/*.test.ts",
    ],
  },
});
