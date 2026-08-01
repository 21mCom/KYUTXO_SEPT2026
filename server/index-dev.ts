import fs from "node:fs";
import path from "node:path";
import { type Server } from "node:http";

import { nanoid } from "nanoid";
import { type Express } from "express";
import { createServer as createViteServer, createLogger } from "vite";

import viteConfig from "../vite.config";
import runApp from "./app";
import { injectLaunchToken } from "./launch-token";

export async function setupVite(app: Express, server: Server) {
  const viteLogger = createLogger();
  // Scope the Host allowlist to loopback. Replit's preview proxy connects
  // from its own *.replit.dev hostname, so that suffix is allow-listed too
  // when running inside a Replit environment.
  const allowedHosts = ["localhost", "127.0.0.1"];
  if (process.env.REPL_ID) {
    allowedHosts.push(".replit.dev");
  }
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    customLogger: {
      ...viteLogger,
      error: (msg, options) => {
        viteLogger.error(msg, options);
        process.exit(1);
      },
    },
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "..",
        "client",
        "index.html",
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`,
      );
      // Authenticate the served page to the local API (see launch-token.ts).
      template = injectLaunchToken(template);
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

(async () => {
  await runApp(setupVite);
})();
