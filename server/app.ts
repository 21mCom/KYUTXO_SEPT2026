import { type Server } from "node:http";

import express, {
  type Express,
  type Request,
  Response,
  NextFunction,
} from "express";

import { registerRoutes } from "./routes";
import { MAX_INCOMING_CONTENT_LENGTH } from "./tor-proxy";

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

export const app = express();

declare module 'http' {
  interface IncomingMessage {
    rawBody: unknown
  }
}
// Baseline security response headers for EVERY response (API and static).
// Registered before the body parsers on purpose: when a parser rejects a
// malformed body, Express jumps straight to error dispatch and skips any
// normal middleware registered after the parsers — those error responses
// would otherwise go out without the header.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

// The Tor proxy accepts JSON envelopes up to its declared 1 MB cap, which is
// larger than the global default JSON limit (100 KB). Give it its own parser
// first so legitimate transaction broadcasts aren't rejected with 413 by
// generic parsing before the route's own policy runs. This parser-level limit
// is the hard cap; body-parser skips requests that are already parsed, so the
// global parser below never re-reads /api/tor bodies.
app.use("/api/tor", express.json({
  limit: MAX_INCOMING_CONTENT_LENGTH,
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));

app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: false }));

// Request logger. Deliberately logs only method/path/status/duration — never
// the response body. API responses here can carry attachment metadata, proxy
// target URLs, or error detail that must not end up in logs.
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
}
app.use(requestLogger);

// Global error handler. Internal (5xx) detail — filesystem paths, OS errors,
// stack text — stays server-side; production clients get a stable generic
// message. 4xx messages are intentional client-facing strings and pass
// through. The error is logged server-side and NEVER rethrown: throwing after
// the response is sent crashes the whole process.
export function errorMiddleware(
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  const status = err.status || err.statusCode || 500;
  const isProduction = req.app.get("env") === "production";
  const expose = !isProduction || status < 500;
  const message = expose
    ? err.message || "Internal Server Error"
    : "Internal Server Error";

  if (status >= 500) {
    console.error(`[express] ${req.method} ${req.path} failed:`, err);
  }

  res.status(status).json({ message });
}

export default async function runApp(
  setup: (app: Express, server: Server) => Promise<void>,
) {
  const server = await registerRoutes(app);

  app.use(errorMiddleware);

  // importantly run the final setup after setting up all the other routes so
  // the catch-all route doesn't interfere with the other routes
  await setup(app, server);

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);
  // Loopback-only by default: the API exposes vault attachment
  // read/write/delete and the Tor proxy, so it must never be reachable from
  // other machines on the LAN. Replit's preview/port forwarding requires a
  // 0.0.0.0 bind — the container is not the user's LAN, and /api is still
  // guarded by the per-launch token middleware. reusePort is intentionally
  // off — SO_REUSEPORT would let another local process bind the same port
  // and siphon half of the app's traffic.
  const host = process.env.HOST || (process.env.REPL_ID ? "0.0.0.0" : "127.0.0.1");
  server.listen({
    port,
    host,
  }, () => {
    log(`serving on ${host}:${port}`);
  });
}
