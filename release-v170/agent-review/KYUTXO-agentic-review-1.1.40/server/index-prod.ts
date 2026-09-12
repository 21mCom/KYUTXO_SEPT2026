import fs from "node:fs";
import path from "node:path";
import { type Server } from "node:http";

import express, { type Express } from "express";
import runApp from "./app";
import { injectLaunchToken } from "./launch-token";

export async function serveStatic(app: Express, _server: Server) {
  const distPath = path.resolve(import.meta.dirname, "public");

  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  // Read index.html once and inject the per-launch API token so the served
  // page can authenticate to /api (see launch-token.ts). Static serving skips
  // index.html so every HTML response carries the token.
  const indexHtml = injectLaunchToken(
    fs.readFileSync(path.resolve(distPath, "index.html"), "utf-8"),
  );

  app.use(express.static(distPath, { index: false }));

  // fall through to index.html if the file doesn't exist
  app.use("*", (_req, res) => {
    res.status(200).set({ "Content-Type": "text/html" }).end(indexHtml);
  });
}

(async () => {
  await runApp(serveStatic);
})();
