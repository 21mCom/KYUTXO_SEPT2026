import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import attachmentsRouter from "./attachments";

export async function registerRoutes(app: Express): Promise<Server> {
  // Attachment routes
  app.use('/api/attachments', attachmentsRouter);

  const httpServer = createServer(app);

  return httpServer;
}
