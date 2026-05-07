import rateLimit from "express-rate-limit";
import type { RequestHandler } from "express";

export const apiRateLimit: RequestHandler = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});
