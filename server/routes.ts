import type { Express } from "express";
import { createServer, type Server } from "http";
import attachmentsRouter from "./attachments";
import torProxyRouter from "./tor-proxy";
import { requireLaunchToken } from "./launch-token";

export async function registerRoutes(app: Express): Promise<Server> {
  // Every API route requires the per-launch token: the server is
  // loopback-only, but other local processes can still reach 127.0.0.1.
  app.use('/api', requireLaunchToken);

  // Attachment routes
  app.use('/api/attachments', attachmentsRouter);
  
  // Tor proxy routes for routing blockchain API requests through Tor
  app.use('/api/tor', torProxyRouter);

  const httpServer = createServer(app);

  return httpServer;
}
