import type { Request, Response, NextFunction } from "express";

const secret = process.env["API_SECRET"];

if (!secret) {
  process.stderr.write(
    "[api-server] WARNING: API_SECRET environment variable is not set. " +
      "All /api requests (except /healthz) will be rejected with 503. " +
      "Set API_SECRET to a strong random string to enable access.\n",
  );
}

export function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!secret) {
    res.status(503).json({
      error:
        "API is not configured. Contact the administrator (API_SECRET is missing).",
    });
    return;
  }

  const key = req.headers["x-api-key"];
  if (!key || key !== secret) {
    req.log.warn({ ip: req.ip }, "Rejected request: missing or invalid API key");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}
