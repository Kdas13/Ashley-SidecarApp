import rateLimit from "express-rate-limit";

// Per-IP rate limit applied across all authenticated /api routes.
// 60 requests/minute is plenty for one human user; bursts of selfie
// polls (every 2s for ~60s) come well under this. Tune via env.
const WINDOW_MS = 60 * 1000;
const MAX = Number(process.env["API_RATE_LIMIT_PER_MIN"] ?? 60);

export const apiRateLimit = rateLimit({
  windowMs: WINDOW_MS,
  limit: Math.max(1, Math.floor(MAX)),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests — slow down for a minute." },
});
