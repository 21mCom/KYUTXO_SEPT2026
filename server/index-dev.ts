import fs from "node:fs";
import path from "node:path";
import { type Server } from "node:http";

import { nanoid } from "nanoid";
import { type Express } from "express";
import { createServer as createViteServer, createLogger, mergeConfig, type LogErrorOptions } from "vite";

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
  // Fields that MUST override vite.config.ts (security / dev-server plumbing):
  //   middlewareMode – required so Vite doesn't start its own HTTP server
  //   hmr            – must point at our already-running server instance
  //   allowedHosts   – scoped to loopback (+ .replit.dev when inside Replit)
  //   cors           – must stay false; Vite's default (true) would reflect the
  //                    request Origin and expose the launch-token <meta> tag to
  //                    cross-origin pages
  //
  // Fields that come from vite.config.ts automatically via mergeConfig:
  //   fs (strict, allow, deny), headers, origin, and any future additions
  //
  // mergeConfig performs a deep merge where the second argument wins for
  // scalar fields, so the explicit overrides below take precedence while
  // every other server field defined in vite.config.ts is preserved.
  const devServerOverrides = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts,
    cors: false,
  };

  const vite = await createViteServer(
    mergeConfig(
      {
        ...viteConfig,
        configFile: false,
        customLogger: {
          ...viteLogger,
          error: (msg: string, options?: LogErrorOptions) => {
            viteLogger.error(msg, options);
            // File-serving access denials are expected runtime events (a path
            // outside the allow list was requested).  Only hard-crash on
            // configuration/build errors that would leave the server broken.
            if (!msg.includes("outside of Vite serving allow list")) {
              process.exit(1);
            }
          },
        },
        appType: "custom",
      },
      { server: devServerOverrides },
    ),
  );

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
