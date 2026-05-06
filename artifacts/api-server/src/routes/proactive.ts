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
import { maybeGenerateAppOpenGreeting } from "../lib/appOpenGreeting";

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

/**
 * POST /api/proactive/on-app-open — called by the mobile client on every
 * cold launch / foreground resume. The server decides whether Ashley should
 * drop a fresh "welcome back" message into chat history.
 *
 * Body (all optional, used only for opportunistic timezone tracking):
 *   { clientNow?: string, clientTimezone?: string }
 *
 * Response:
 *   200 { greeted: false, reason: string }    — no greeting (toggle off,
 *                                                quiet hours, recent activity,
 *                                                dedupe, model declined, etc)
 *   200 { greeted: true,  message: Message }  — fresh Ashley message inserted;
 *                                                client should invalidate the
 *                                                messages query.
 *
 * Always returns 200 — failures are surfaced as `greeted: false` so a
 * transient server hiccup never blocks the app's cold-start path.
 */
const OnAppOpenBodySchema = z
  .object({
    clientNow: z.string().max(64).optional(),
    clientTimezone: z.string().max(64).optional(),
  })
  .strip();

router.post("/proactive/on-app-open", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  const parsed = OnAppOpenBodySchema.safeParse(req.body ?? {});
  // Even if the body is malformed we still want to evaluate — the body is
  // best-effort metadata, not gating data. Just skip the timezone update.
  const tz = parsed.success ? parsed.data.clientTimezone : undefined;

  // Opportunistically refresh timezone so quiet-hours math stays accurate.
  if (tz && tz.length > 0) {
    try {
      await getOrCreateProfileFor(deviceId);
      await db
        .update(ashleyProfileTable)
        .set({ timezone: tz })
        .where(eq(ashleyProfileTable.deviceId, deviceId));
    } catch (err) {
      req.log.warn({ err }, "POST /proactive/on-app-open: tz update failed");
    }
  }

  try {
    const result = await maybeGenerateAppOpenGreeting(deviceId);
    if (result.greeted) {
      res.status(200).json({ greeted: true, message: result.message });
    } else {
      res.status(200).json({ greeted: false, reason: result.reason });
    }
  } catch (err) {
    // Defence in depth: maybeGenerateAppOpenGreeting catches its own errors,
    // but if anything ever escaped we still want a 200 so the client doesn't
    // log a noisy boot-time failure.
    req.log.error({ err }, "POST /proactive/on-app-open failed");
    res.status(200).json({ greeted: false, reason: "internal_error" });
  }
});

export default router;
