/**
 * Browser-side helpers for opting into reminder push notifications.
 *
 * Flow:
 *  1. Confirm the browser supports SW + Push + Notifications.
 *  2. Register `/sw.js` (resolved against the artifact's BASE_URL).
 *  3. Fetch the server's VAPID public key.
 *  4. `pushManager.subscribe(...)` and POST the result to the API.
 *
 * Returning `null` from `subscribeToReminders` means the caller should
 * surface a "couldn't enable reminders" message — the helper never throws
 * on the happy unsupported path, only on actual network/permission errors
 * the user can act on.
 */

const BASE = "/safeguard-api";

export interface PushSupport {
  supported: boolean;
  reason?: "no-sw" | "no-push" | "no-notifications" | "insecure";
}

export function checkPushSupport(): PushSupport {
  if (typeof window === "undefined") return { supported: false, reason: "no-sw" };
  if (!window.isSecureContext) return { supported: false, reason: "insecure" };
  if (!("serviceWorker" in navigator)) return { supported: false, reason: "no-sw" };
  if (!("PushManager" in window)) return { supported: false, reason: "no-push" };
  if (!("Notification" in window)) {
    return { supported: false, reason: "no-notifications" };
  }
  return { supported: true };
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function registerSW(): Promise<ServiceWorkerRegistration> {
  const swUrl = `${import.meta.env.BASE_URL}sw.js`;
  return navigator.serviceWorker.register(swUrl, {
    scope: import.meta.env.BASE_URL,
  });
}

export async function subscribeToReminders(
  getToken: () => Promise<string | null>,
): Promise<PushSubscription | null> {
  const support = checkPushSupport();
  if (!support.supported) return null;
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return null;

  const reg = await registerSW();

  // Pull the server's VAPID key. If the server isn't configured for push,
  // there's nothing to subscribe to — surface that to the caller.
  const token = await getToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const keyRes = await fetch(`${BASE}/me/push/public-key`, { headers });
  if (!keyRes.ok) throw new Error(`public-key ${keyRes.status}`);
  const { publicKey, configured } = (await keyRes.json()) as {
    publicKey: string;
    configured: boolean;
  };
  if (!configured || !publicKey) return null;

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      // The DOM lib types want a BufferSource backed by ArrayBuffer; the
      // Uint8Array we just decoded fits at runtime but TS's strict variance
      // doesn't know that, so cast through `BufferSource`.
      applicationServerKey: urlBase64ToUint8Array(publicKey)
        .buffer as ArrayBuffer,
    });
  }

  const json = sub.toJSON() as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    // Browser handed us an unusable subscription — drop it locally so the
    // next attempt re-subscribes from scratch instead of silently reusing
    // a broken handle.
    try {
      await sub.unsubscribe();
    } catch (_err) {
      // ignore
    }
    return null;
  }
  const registerRes = await fetch(`${BASE}/me/push/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      userAgent: navigator.userAgent,
    }),
  });
  if (!registerRes.ok) {
    // Backend rejected the subscription. Roll back the browser-side
    // subscription so the user can opt in again cleanly and so the UI
    // doesn't show "on" while the server has nothing to send to.
    try {
      await sub.unsubscribe();
    } catch (_err) {
      // ignore
    }
    throw new Error(`subscribe ${registerRes.status}`);
  }
  return sub;
}

export async function unsubscribeFromReminders(
  getToken: () => Promise<string | null>,
): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration(
    import.meta.env.BASE_URL,
  );
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  const token = await getToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}/me/push/subscribe`, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ endpoint }),
  });
  if (!res.ok) {
    throw new Error(`unsubscribe ${res.status}`);
  }
}

export async function getActiveSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration(
    import.meta.env.BASE_URL,
  );
  return (await reg?.pushManager.getSubscription()) ?? null;
}
