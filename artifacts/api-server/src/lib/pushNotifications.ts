// =============================================================================
// Expo Push API client
// -----------------------------------------------------------------------------
// Thin wrapper around https://exp.host/--/api/v2/push/send. Used by the
// proactive scheduler to deliver "Ashley reaches out first" notifications
// without standing up our own FCM/APNs credentials — Expo's push relay
// works for both Expo Go and EAS dev builds.
//
// Design notes:
//   - Failure-safe: never throws to the caller. Returns a tagged result
//     so the scheduler can react (e.g. null out a stale push token on
//     `DeviceNotRegistered`).
//   - 5-second timeout via AbortController so a stuck Expo endpoint can't
//     block a scheduler tick.
//   - Single send only — no batching yet. Volume is low (≤4 sends/device/day)
//     and per-device errors are easier to surface this way.
// =============================================================================

import { logger } from "./logger";

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";
const PUSH_TIMEOUT_MS = 5000;

export type SendExpoPushArgs = {
  /** Expo push token, e.g. "ExponentPushToken[xxx]". */
  to: string;
  /** Notification title — typically "Ashley". */
  title: string;
  /** Notification body — short, ≤100 chars enforced by the scheduler. */
  body: string;
  /**
   * Optional opaque payload delivered with the notification. The mobile
   * client uses this to know the tap should land on /chat with the
   * proactive message visible.
   */
  data?: Record<string, unknown>;
};

export type SendExpoPushResult =
  | { ok: true; ticketId: string | null }
  | {
      ok: false;
      /** True when the token is no longer valid; caller should clear it. */
      tokenInvalid: boolean;
      reason: string;
    };

type ExpoTicket =
  | { status: "ok"; id?: string }
  | {
      status: "error";
      message?: string;
      details?: { error?: string };
    };

type ExpoResponseBody = {
  data?: ExpoTicket | ExpoTicket[];
  errors?: Array<{ code?: string; message?: string }>;
};

/**
 * Send a single push via the Expo Push API. Logs at info on success and
 * warn on every failure path. Returns a tagged result instead of throwing
 * so the caller (scheduler) doesn't have to wrap each send in try/catch.
 */
export async function sendExpoPush(
  args: SendExpoPushArgs,
): Promise<SendExpoPushResult> {
  const { to, title, body, data } = args;

  if (!to || typeof to !== "string") {
    return { ok: false, tokenInvalid: true, reason: "Empty push token" };
  }

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), PUSH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(EXPO_PUSH_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to,
        title,
        body,
        sound: "default",
        priority: "default",
        data: data ?? {},
      }),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    const reason = err instanceof Error ? err.message : "fetch failed";
    logger.warn({ err, to: maskToken(to) }, "Expo push transport error");
    return { ok: false, tokenInvalid: false, reason };
  }
  clearTimeout(timeout);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.warn(
      { status: res.status, body: text.slice(0, 240), to: maskToken(to) },
      "Expo push returned non-2xx",
    );
    return {
      ok: false,
      tokenInvalid: false,
      reason: `HTTP ${res.status}`,
    };
  }

  let payload: ExpoResponseBody;
  try {
    payload = (await res.json()) as ExpoResponseBody;
  } catch (err) {
    logger.warn({ err, to: maskToken(to) }, "Expo push response not JSON");
    return { ok: false, tokenInvalid: false, reason: "Invalid JSON response" };
  }

  // Top-level errors (auth, malformed payload). These are not per-ticket
  // — they apply to the whole batch.
  if (payload.errors && payload.errors.length > 0) {
    const first = payload.errors[0]!;
    logger.warn(
      { errors: payload.errors, to: maskToken(to) },
      "Expo push top-level error",
    );
    return {
      ok: false,
      tokenInvalid: false,
      reason: first.message ?? first.code ?? "Top-level error",
    };
  }

  // Per-ticket result. We only ever send one notification at a time so
  // `data` is always a single ticket, but Expo's API allows arrays so we
  // normalize defensively.
  const tickets = Array.isArray(payload.data)
    ? payload.data
    : payload.data
      ? [payload.data]
      : [];
  const ticket = tickets[0];
  if (!ticket) {
    logger.warn({ payload, to: maskToken(to) }, "Expo push: no ticket in body");
    return { ok: false, tokenInvalid: false, reason: "No ticket returned" };
  }

  if (ticket.status === "error") {
    const errorCode = ticket.details?.error ?? "";
    // DeviceNotRegistered is the canonical "this token is dead" signal.
    // Caller (scheduler) clears profiles.pushToken so we stop retrying.
    const tokenInvalid =
      errorCode === "DeviceNotRegistered" ||
      errorCode === "InvalidCredentials";
    logger.warn(
      {
        errorCode,
        message: ticket.message,
        tokenInvalid,
        to: maskToken(to),
      },
      "Expo push ticket reported error",
    );
    return {
      ok: false,
      tokenInvalid,
      reason: errorCode || ticket.message || "Ticket error",
    };
  }

  logger.info(
    { ticketId: ticket.id ?? null, to: maskToken(to) },
    "Expo push sent",
  );
  return { ok: true, ticketId: ticket.id ?? null };
}

/** Don't write full push tokens to logs — they're effectively a delivery secret. */
function maskToken(token: string): string {
  if (token.length <= 12) return "***";
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}
