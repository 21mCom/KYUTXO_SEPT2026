import type { Express } from "express";
import { createServer, type Server } from "http";
import attachmentsRouter, {
  sweepStaleUploadTempFiles,
  scheduleUploadTempSweep,
} from "./attachments";
import torProxyRouter from "./tor-proxy";
import { requireLaunchToken } from "./launch-token";

export async function registerRoutes(app: Express): Promise<Server> {
  // Every API route requires the per-launch token: the server is
  // loopback-only, but other local processes can still reach 127.0.0.1.
  app.use('/api', requireLaunchToken);

  // Attachment routes
  app.use('/api/attachments', attachmentsRouter);

  // Best-effort background sweep of upload temp files orphaned by a crash or
  // power loss mid-upload. Fire-and-forget: never delays or fails startup
  // (the sweep itself catches and logs all per-file errors).
  void sweepStaleUploadTempFiles();

  // Long-lived desktop sessions: re-run the same sweep on a coarse interval
  // (unref'd timer, never blocks shutdown) so orphans from a client crash
  // mid-session don't linger until the next launch.
  scheduleUploadTempSweep();
  
  // Tor proxy routes for routing blockchain API requests through Tor
  app.use('/api/tor', torProxyRouter);

  const httpServer = createServer(app);

  return httpServer;
}
