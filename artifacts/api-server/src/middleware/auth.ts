import type { RequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export const requireApiKey: RequestHandler = (req, res, next) => {
  const expected = (process.env["API_AUTH_KEY"] ?? "").trim();
  if (!expected) {
    req.log.error("API_AUTH_KEY is not set on the server");
    res.status(500).json({ error: "Server auth not configured" });
    return;
  }

  const header = req.header("authorization") ?? req.header("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim() ?? "";
  if (!token || !safeEqual(token, expected)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
};
