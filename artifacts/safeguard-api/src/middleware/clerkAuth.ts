import type { Request, Response, NextFunction } from "express";
import { createClerkClient, verifyToken } from "@clerk/express";

const secretKey = process.env["CLERK_SECRET_KEY"];
const publishableKey = process.env["CLERK_PUBLISHABLE_KEY"];

if (!secretKey || !publishableKey) {
  // Fail closed — never silently bypass.
  // eslint-disable-next-line no-console
  console.warn("[safeguard-api] CLERK keys not set — all auth will 401.");
}

export const clerkClient = secretKey
  ? createClerkClient({ secretKey, publishableKey })
  : null;

declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string };
    }
  }
}

export async function requireClerkUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!secretKey) {
    res.status(503).json({ error: "auth_unconfigured" });
    return;
  }
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "missing_token" });
    return;
  }
  try {
    const payload = await verifyToken(token, { secretKey });
    if (!payload.sub) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    req.auth = { userId: payload.sub };
    next();
  } catch (err) {
    req.log?.warn({ err }, "Clerk token verification failed");
    res.status(401).json({ error: "invalid_token" });
  }
}
