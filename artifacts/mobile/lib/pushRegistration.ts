// =============================================================================
// Push notification registration (Expo)
// -----------------------------------------------------------------------------
// Asks the OS for notification permission, exchanges the device for an
// Expo push token, and uploads it to the api-server so the proactive
// scheduler can target this device. Safe to call multiple times — both
// the OS permission ask and the server upsert are idempotent.
//
// Failure model: nothing here ever throws. Every step is wrapped so a
// missing permission, an Expo Go quirk, or a backend hiccup surfaces as
// a `null` return + a warn log rather than a crashed root layout.
//
// Used from `app/_layout.tsx` on root mount.
// =============================================================================

import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import {
  setPushTokenOnServer,
  setPushTokenOnServerWithStatus,
} from "./aiClient";
import { resetPushStatus, setPushStatus } from "./pushStatus";

// -----------------------------------------------------------------------------
// Expo Go gate
// -----------------------------------------------------------------------------
// Expo dropped REMOTE push notifications from Expo Go in SDK 53 — calling
// `getExpoPushTokenAsync` (and a few other remote APIs) now throws a noisy
// "Android Push notifications functionality was removed from Expo Go" error
// at runtime. The fix Expo recommends is "use a development build", which is
// a real one-time EAS build and not something we want to gate the entire
// app on. So in Expo Go we silently no-op the whole push registration flow
// — the user can still save their cadence preference (it persists on the
// server), and the moment they switch to a dev/standalone build the next
// launch picks up the token and starts delivering pushes for real.
//
// `Constants.executionEnvironment === "storeClient"` is the official way to
// detect Expo Go at runtime; `appOwnership` is deprecated.
const IS_EXPO_GO = Constants.executionEnvironment === "storeClient";

// Foreground display behaviour: when a proactive Ashley message arrives
// while the user is already in the app, show the banner + play the sound
// so they notice the new chat bubble even if they aren't on the chat
// screen. Skipped in Expo Go because the underlying remote-push pipeline
// is gone there; setting the handler is harmless on its own but we
// keep all push-related side-effects in one branch for clarity.
if (!IS_EXPO_GO) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      // Newer SDK fields — duplicate of shouldShowAlert for SDK 50+ compat.
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

// Module-level guard so we don't re-prompt within the same JS session
// even if _layout re-renders. AsyncStorage isn't needed: getPermissionsAsync
// already short-circuits on subsequent app launches.
let inFlight: Promise<string | null> | null = null;
let lastResult: string | null | undefined = undefined;

export type RegisterResult = {
  token: string | null;
  reason?:
    | "not_a_device"
    | "permission_denied"
    | "no_token_returned"
    | "registration_failed"
    | "ok";
};

/**
 * Resolve the EAS / Expo projectId from app.json's `extra.eas.projectId`
 * (preferred) or `expoConfig.extra.eas.projectId`. Returns undefined when
 * the project hasn't been linked to EAS yet — `getExpoPushTokenAsync`
 * still works in Expo Go without it, but newer SDKs emit a warning.
 */
function resolveProjectId(): string | undefined {
  const cfgExtra = (Constants.expoConfig?.extra ?? {}) as {
    eas?: { projectId?: string };
  };
  const easExtra = (Constants.easConfig ?? {}) as {
    projectId?: string;
  };
  const fromExtra = cfgExtra.eas?.projectId;
  const fromEas = easExtra.projectId;
  const candidate =
    typeof fromExtra === "string" && fromExtra.trim().length > 0
      ? fromExtra.trim()
      : typeof fromEas === "string" && fromEas.trim().length > 0
        ? fromEas.trim()
        : undefined;
  return candidate;
}

/**
 * Register this device for proactive push notifications. Idempotent.
 *
 * Flow:
 *   1. Ensure we're on a real device (skip simulators / web).
 *   2. Ensure an Android notification channel exists (required for
 *      heads-up banners on Android 8+).
 *   3. Ask for permission if not already granted. If the user denies,
 *      give up cleanly and tell the server to clear any stale token.
 *   4. Fetch the Expo push token. If the call fails (Expo Go quirks,
 *      network blip, etc), log + bail.
 *   5. POST the token to /api/devices/push-token. Failures here aren't
 *      fatal — the next launch will retry.
 *
 * Returns the token string on success, `null` otherwise. Multiple
 * concurrent callers share the same in-flight promise so we don't
 * double-prompt on rapid re-mounts.
 */
export async function registerForPushNotificationsAsync(): Promise<RegisterResult> {
  // Web preview never gets push — fail fast, no ask.
  if (Platform.OS === "web") {
    return { token: null, reason: "not_a_device" };
  }

  // Expo Go (SDK 53+) — remote push removed. Quietly bail without
  // touching any of the Notifications APIs that would log the
  // "remote notifications was removed from Expo Go" warning. The
  // user's cadence preference still saves; pushes will start working
  // automatically the moment they switch to a dev / standalone build.
  if (IS_EXPO_GO) {
    return { token: null, reason: "not_a_device" };
  }

  // De-dup: if a registration is already in flight, await it.
  if (inFlight) {
    const t = await inFlight;
    return { token: t, reason: t ? "ok" : "registration_failed" };
  }

  // De-dup: if we already resolved this session, return the cached result.
  if (lastResult !== undefined) {
    return {
      token: lastResult,
      reason: lastResult ? "ok" : "registration_failed",
    };
  }

  inFlight = (async (): Promise<string | null> => {
    resetPushStatus();
    try {
      // Step 1 — must be a real device. Notifications never deliver to
      // simulators (iOS) and the token call fails on the Android emulator
      // when Google Play services aren't present.
      console.log("[push] isDevice", Device.isDevice);
      setPushStatus({ isDevice: Device.isDevice });
      if (!Device.isDevice) {
        setPushStatus({ lastError: "not a real device" });
        return null;
      }

      // Step 2 — Android needs a default channel for heads-up display.
      // Set it BEFORE asking for permission so the OS shows the user the
      // right notification importance preview.
      if (Platform.OS === "android") {
        try {
          await Notifications.setNotificationChannelAsync("default", {
            name: "Ashley",
            importance: Notifications.AndroidImportance.DEFAULT,
            // Brand accent — matches the chat screen's primaryColor.
            lightColor: "#d97757",
            // Neutral notification sound; explicit so the channel
            // doesn't end up silenced if the user has app sounds off.
            sound: "default",
          });
        } catch (err) {
          console.warn("[push] setNotificationChannelAsync failed", err);
        }
      }

      // Step 3 — permission. If already granted, skip the prompt.
      const existing = await Notifications.getPermissionsAsync();
      const existingStatus = existing.status;
      console.log("[push] permission existing", existingStatus);
      let finalStatus = existingStatus;
      if (finalStatus !== "granted") {
        const requested = await Notifications.requestPermissionsAsync();
        finalStatus = requested.status;
      }
      console.log("[push] permission final", finalStatus);
      setPushStatus({ permission: finalStatus });
      if (finalStatus !== "granted") {
        setPushStatus({ lastError: `permission=${finalStatus}` });
        // Best-effort: clear any previously saved token so the server
        // stops trying to push to a device that just opted out.
        await setPushTokenOnServer(null).catch(() => undefined);
        return null;
      }

      // Step 4 + 5 — exchange device for a push token, then upsert it
      // to the server. Wrapped together so any failure (token fetch
      // OR upload) surfaces with the same shape in logs.
      const projectId = resolveProjectId();
      console.log("[push] projectId", projectId);
      setPushStatus({ projectId: projectId ?? null });
      let tokenValue: string;
      try {
        const token = await Notifications.getExpoPushTokenAsync(
          projectId ? { projectId } : undefined,
        );
        console.log("[push] token result", token?.data);
        if (!token?.data || typeof token.data !== "string") {
          setPushStatus({
            tokenStatus: "fail",
            lastError: "getExpoPushTokenAsync returned no data",
          });
          return null;
        }
        tokenValue = token.data;
        setPushStatus({ tokenStatus: "ok", token: tokenValue });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[push] token fetch failed", err);
        setPushStatus({ tokenStatus: "fail", lastError: msg });
        return null;
      }

      // Upload the token to the server, capturing HTTP status so the
      // diagnostic banner can show whether the API actually accepted it.
      try {
        const upload = await setPushTokenOnServerWithStatus(tokenValue);
        console.log(
          "[push] upload status",
          upload.status,
          upload.bodyPreview,
        );
        setPushStatus({
          uploadStatus: upload.ok ? "ok" : "fail",
          lastError: upload.ok
            ? null
            : `HTTP ${upload.status} ${upload.bodyPreview}`,
        });
        if (!upload.ok) return null;
        console.log("[push] registered", tokenValue);
        return tokenValue;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[push] upload threw", err);
        setPushStatus({ uploadStatus: "fail", lastError: msg });
        return null;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[push] registerForPushNotificationsAsync threw", err);
      setPushStatus({ lastError: msg });
      return null;
    }
  })();

  try {
    const token = await inFlight;
    lastResult = token;
    return {
      token,
      reason: token ? "ok" : "registration_failed",
    };
  } finally {
    inFlight = null;
  }
}

/**
 * Explicitly unregister this device from proactive pushes. Used when the
 * user picks the "Off" cadence from the profile screen.
 *
 * Three-step teardown (best-effort, never throws):
 *   1. Clear the server-side push token so the scheduler can't target
 *      this device. This is the most important step — it's the one
 *      that actually stops new pushes immediately on the next tick.
 *   2. Drop the in-process cache so a subsequent flip back to
 *      Low/Normal/High triggers a fresh permission check + token fetch.
 *   3. Tear down the OS-level subscription via
 *      `Notifications.unregisterForNotificationsAsync()` (iOS APNS /
 *      Android FCM). The Off intent is "stop being a push target on
 *      this device entirely", not just "stop the server from sending"
 *      — without this the OS still holds an active registration that
 *      can wake the app on stale notifications and shows up in the
 *      system push registry. Spec requires the full teardown.
 *
 * Each step is independently try/caught so a failure on one doesn't
 * block the others.
 */
export async function unregisterPushNotificationsAsync(): Promise<void> {
  lastResult = null;
  try {
    await setPushTokenOnServer(null);
  } catch (err) {
    console.warn("[push] unregister: server clear failed", err);
  }
  // Skip the OS-level unsubscribe in Expo Go — the API itself is part of
  // the removed-in-SDK-53 surface and would emit the noisy warning. Server
  // token is already cleared above which is the only thing that matters
  // for "stop sending pushes to this device" intent in Expo Go.
  if (IS_EXPO_GO) return;
  try {
    await Notifications.unregisterForNotificationsAsync();
  } catch (err) {
    // Non-fatal: on Expo Go this can be a no-op; on managed dev builds
    // it's the real OS unsubscribe. Either way the server-side clear
    // above already stopped fresh pushes.
    console.warn("[push] unregister: OS unsubscribe failed", err);
  }
}

/**
 * Reset the in-process registration cache so the next call re-runs the
 * full flow (re-checks permission, re-fetches token). Useful from the
 * profile screen when the user toggles cadence back on after Off.
 */
export function resetPushRegistrationCache(): void {
  lastResult = undefined;
  inFlight = null;
}
