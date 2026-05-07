/**
 * Safeguard service worker — Web Push receiver.
 *
 * Receives notifications fired by the Safeguard API reminder worker and
 * shows them as native browser notifications. The clinician's original
 * wording is bundled in the payload so the user can see it via the
 * notification's "View original" action without reopening the app.
 *
 * The SW is intentionally tiny: NO caching, NO routing, NO offline
 * shimming. Reminder delivery is the only responsibility.
 */

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {
    title: "Safeguard reminder",
    body: "",
    original: "",
    url: "/",
    followupId: "",
    kind: "followup",
  };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch (_err) {
    // Non-JSON payload; show a generic reminder.
  }
  const options = {
    body: payload.body || "Open Safeguard to see your reminder.",
    tag: payload.followupId || undefined,
    renotify: true,
    requireInteraction: payload.kind === "escalation",
    data: {
      url: payload.url,
      original: payload.original,
      followupId: payload.followupId,
    },
    actions: [
      { action: "open", title: "Open" },
      { action: "show-original", title: "View clinician's words" },
    ],
  };
  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const baseUrl = data.url || "/";
  const targetUrl =
    event.action === "show-original"
      ? baseUrl + (baseUrl.includes("?") ? "&" : "?") + "show-original=1"
      : baseUrl;
  event.waitUntil(
    (async () => {
      const clientsArr = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clientsArr) {
        if (client.url.includes(self.registration.scope) && "focus" in client) {
          await client.focus();
          if ("navigate" in client) {
            try {
              await client.navigate(self.registration.scope.replace(/\/$/, "") + targetUrl);
            } catch (_err) {
              // navigate may fail across origins; ignore.
            }
          }
          return;
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(self.registration.scope.replace(/\/$/, "") + targetUrl);
      }
    })(),
  );
});
