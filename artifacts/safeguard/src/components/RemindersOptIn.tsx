import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@clerk/clerk-react";
import {
  checkPushSupport,
  getActiveSubscription,
  subscribeToReminders,
  unsubscribeFromReminders,
} from "@/lib/pushSubscribe";

/**
 * Opt-in card surfaced on the Followup page. Three states:
 *   - unsupported: the browser can't do push (insecure context, no SW).
 *     We still tell the user why so they don't think the toggle is broken.
 *   - off: SW + Push available but the user hasn't subscribed yet.
 *   - on: subscription is live; offer to disable.
 */
export function RemindersOptIn() {
  const { t } = useTranslation();
  const { getToken } = useAuth();
  const support = checkPushSupport();
  const [status, setStatus] = useState<"loading" | "off" | "on" | "denied">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!support.supported) {
      setStatus("off");
      return;
    }
    void (async () => {
      const sub = await getActiveSubscription();
      if (sub) {
        setStatus("on");
      } else if (Notification.permission === "denied") {
        setStatus("denied");
      } else {
        setStatus("off");
      }
    })();
  }, [support.supported]);

  async function enable() {
    setBusy(true);
    setError(null);
    try {
      const sub = await subscribeToReminders(getToken);
      if (sub) {
        setStatus("on");
      } else if (Notification.permission === "denied") {
        setStatus("denied");
      } else {
        setError(t("reminders.errorEnable"));
      }
    } catch (err) {
      setError((err as Error).message || t("reminders.errorEnable"));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      await unsubscribeFromReminders(getToken);
      setStatus("off");
    } catch (err) {
      setError((err as Error).message || t("reminders.errorDisable"));
    } finally {
      setBusy(false);
    }
  }

  if (!support.supported) {
    return (
      <div
        className="mt-4 rounded-xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground"
        data-testid="reminders-unsupported"
      >
        <strong className="block text-foreground">
          {t("reminders.unsupportedTitle")}
        </strong>
        <p className="mt-1">
          {t(`reminders.unsupportedReason.${support.reason ?? "no-sw"}`)}
        </p>
      </div>
    );
  }

  return (
    <div
      className="mt-4 rounded-xl border border-border bg-card p-4"
      data-testid="reminders-optin"
    >
      <h3 className="text-base font-semibold">{t("reminders.title")}</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("reminders.body")}
      </p>
      {error && (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {status === "loading" && (
        <p className="mt-2 text-sm text-muted-foreground">…</p>
      )}
      {status === "off" && (
        <button
          type="button"
          onClick={enable}
          disabled={busy}
          className="mt-3 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium"
          data-testid="reminders-enable"
        >
          {t("reminders.enable")}
        </button>
      )}
      {status === "denied" && (
        <p
          className="mt-2 text-sm text-destructive"
          data-testid="reminders-denied"
        >
          {t("reminders.denied")}
        </p>
      )}
      {status === "on" && (
        <div className="mt-2 flex items-center justify-between gap-3 flex-wrap">
          <p
            className="text-sm text-emerald-700"
            data-testid="reminders-on"
          >
            {t("reminders.on")}
          </p>
          <button
            type="button"
            onClick={disable}
            disabled={busy}
            className="rounded-md bg-secondary text-secondary-foreground px-3 py-1.5 text-sm"
            data-testid="reminders-disable"
          >
            {t("reminders.disable")}
          </button>
        </div>
      )}
    </div>
  );
}
