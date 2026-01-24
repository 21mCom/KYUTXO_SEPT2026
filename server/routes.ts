import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import attachmentsRouter from "./attachments";
import torProxyRouter from "./tor-proxy";

export async function registerRoutes(app: Express): Promise<Server> {
  // Attachment routes
  app.use('/api/attachments', attachmentsRouter);
  
  // Tor proxy routes for routing blockchain API requests through Tor
  app.use('/api/tor', torProxyRouter);

  const httpServer = createServer(app);

  return httpServer;
}
