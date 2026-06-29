import { type Request, type Response, type NextFunction } from "express";
import { logger } from "../lib/logger.js";

const ADMIN_API_KEY = process.env["ADMIN_API_KEY"]?.trim();
if (!ADMIN_API_KEY) {
  logger.warn(
    "ADMIN_API_KEY not set — all /admin/* requests will return 503 until the secret is configured",
  );
}

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  if (!ADMIN_API_KEY) {
    res.status(503).json({ error: "admin_not_configured", detail: "Set ADMIN_API_KEY in Replit Secrets" });
    return;
  }
  const key = ((req.headers["x-admin-api-key"] as string) ?? "").trim();
  if (!key || key !== ADMIN_API_KEY) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}
