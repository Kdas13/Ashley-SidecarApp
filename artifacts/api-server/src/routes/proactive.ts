// =============================================================================
// Proactive routes
// -----------------------------------------------------------------------------
// Endpoints the mobile client uses to register / clear its Expo push token.
// Cadence selection (off | low | normal | high) lives on the existing
// PUT /profile endpoint to keep the profile shape coherent — see
// routes/state.ts for that.
// =============================================================================

import { Router, type IRouter } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { db, ashleyProfileTable } from "@workspace/db";
import { getDeviceId } from "../middleware/deviceId";
import { getOrCreateProfileFor } from "../lib/profile";
import { forceTickForDevice } from "../lib/proactiveScheduler";

const router: IRouter = Router();

// Expo push tokens look like "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]" (40-60
// chars typical) but EAS dev builds also issue raw FCM/APNs tokens that
// can be longer. Cap at 256 to avoid pathological inputs.
const PushTokenBodySchema = z
  .object({
    // null clears the token (used when the user picks Off cadence or
    // denies notification permission). Empty string is treated as null.
    token: z.union([z.string().max(256), z.null()]),
  })
  .strict();

/**
 * POST /api/devices/push-token — upsert (or clear) this device's Expo
 * push token. Idempotent: posting the same token twice is a no-op write.
 *
 * Body: { token: string | null }
 *   token === null      → clear the saved token (mobile is unregistering).
 *   token === ""        → treated as null.
 *   token === "Expon…"  → save it; replaces any previous value (one
 *                          device == one token).
 *
 * 204 on success (no body needed; profile state is already cached client-side).
 */
router.post("/devices/push-token", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  const parsed = PushTokenBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const raw = parsed.data.token;
  const next = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;

  try {
    // Ensure the profile row exists so the update has a target.
    await getOrCreateProfileFor(deviceId);
    await db
      .update(ashleyProfileTable)
      .set({ pushToken: next })
      .where(eq(ashleyProfileTable.deviceId, deviceId));
    res.status(204).end();
  } catch (err) {
    req.log.error({ err }, "POST /devices/push-token failed");
    res.status(500).json({ error: "Could not save push token" });
  }
});

/**
 * POST /api/proactive/debug-tick — DEV ONLY. Force-evaluate the proactive
 * scheduler for the calling device, bypassing the 5-minute interval. Returns
 * a JSON body describing what happened (sent / skipped + reason / which
 * category fired). Useful for QA — never call from production.
 *
 * Gated by NODE_ENV !== "production". In prod the route 404s so the surface
 * area stays clean.
 */
router.post("/proactive/debug-tick", async (req, res): Promise<void> => {
  if (process.env["NODE_ENV"] === "production") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const deviceId = getDeviceId(req);
  try {
    const result = await forceTickForDevice(deviceId);
    res.status(200).json(result);
  } catch (err) {
    req.log.error({ err }, "POST /proactive/debug-tick failed");
    res.status(500).json({ error: "debug tick failed" });
  }
});

export default router;
