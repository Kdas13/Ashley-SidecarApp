import type { RequestHandler } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      deviceId?: string;
    }
  }
}

const DEVICE_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

/**
 * Per-device identifier carried on every authenticated call as the
 * `X-Device-Id` header. The mobile client generates a UUID on first launch
 * and includes it on every request — that id is the user. Combined with
 * `requireApiKey`, this gates all stateful endpoints.
 *
 * Format is intentionally permissive (any URL-safe-ish string 8..128 chars)
 * so the client is free to use UUID v4, ULID, or any other scheme without
 * a server change.
 */
export const requireDeviceId: RequestHandler = (req, res, next) => {
  const raw =
    req.header("x-device-id") ?? req.header("X-Device-Id") ?? "";
  const id = raw.trim();
  if (!id || !DEVICE_ID_RE.test(id)) {
    res.status(400).json({ error: "Missing or invalid X-Device-Id header" });
    return;
  }
  req.deviceId = id;
  next();
};

export function getDeviceId(req: { deviceId?: string }): string {
  if (!req.deviceId) {
    throw new Error("deviceId missing — requireDeviceId middleware not wired");
  }
  return req.deviceId;
}
