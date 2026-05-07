import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute } from "wouter";
import { SafeguardLayout } from "@/components/SafeguardLayout";
import { RemindersOptIn } from "@/components/RemindersOptIn";
import {
  useApi,
  type SafeguardFollowup,
  type SafeguardExportDelivery,
  type FollowupCadence,
  type Confidence,
} from "@/lib/api";

/**
 * Post-appointment follow-up screen. Lists translated reminders + escalations
 * for one appointment (or globally if no appointment id is in the route).
 * Each item shows BOTH the clinician's original wording and the translated
 * patient-facing wording, the AI-confidence indicator, and (when applicable)
 * the next scheduled phone reminder.
 */
export default function Followup() {
  const { t, i18n } = useTranslation();
  const { request } = useApi();
  const qc = useQueryClient();

  const [, params] = useRoute("/appointments/:id/followup");
  const apptId = params?.id;

  // Notification deep-link: `?fid=<id>` targets a specific reminder, and
  // `?show-original=1` (set by the SW's "View clinician's words" action)
  // tells the page to open that reminder's original wording immediately.
  const { focusFollowupId, showOriginal } = useMemo(() => {
    if (typeof window === "undefined") {
      return { focusFollowupId: null as string | null, showOriginal: false };
    }
    const sp = new URLSearchParams(window.location.search);
    return {
      focusFollowupId: sp.get("fid"),
      showOriginal: sp.get("show-original") === "1",
    };
  }, []);
  const detailsRefs = useRef<Map<string, HTMLDetailsElement | null>>(new Map());

  const path = apptId ? `/me/appointments/${apptId}` : `/me/followups`;
  const q = useQuery({
    queryKey: apptId ? ["appointment", apptId, "followups"] : ["followups"],
    queryFn: () => request<unknown>(path),
  });

  const items: SafeguardFollowup[] = (() => {
    const data = q.data as { followups?: SafeguardFollowup[] } | undefined;
    if (!data) return [];
    if (Array.isArray(data.followups)) return data.followups;
    return [];
  })();

  // Surface "sent to surgery" status for the appointment-scoped view.
  // The /me/followups list view doesn't carry deliveries, so this is empty
  // there — by design, since deliveries belong to a specific appointment.
  const deliveries: SafeguardExportDelivery[] = (() => {
    const data = q.data as
      | { deliveries?: SafeguardExportDelivery[] }
      | undefined;
    return data?.deliveries ?? [];
  })();
  const latestSuccessful = deliveries.find(
    (d) => d.status === "sent" || d.status === "delivered",
  );
  const latestFailure = deliveries.find((d) => d.status === "failed");

  // Once the items have loaded, honour the deep-link: scroll the targeted
  // reminder into view, and open its original-wording disclosure if the
  // notification action asked for it.
  useEffect(() => {
    if (!focusFollowupId || items.length === 0) return;
    const el = document.querySelector<HTMLElement>(
      `[data-testid="followup-${CSS.escape(focusFollowupId)}"]`,
    );
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (showOriginal) {
      const det = detailsRefs.current.get(focusFollowupId);
      if (det) det.open = true;
    }
  }, [focusFollowupId, showOriginal, items.length]);

  const invalidate = () => {
    void qc.invalidateQueries({
      queryKey: apptId ? ["appointment", apptId, "followups"] : ["followups"],
    });
    void qc.invalidateQueries({ queryKey: ["followups"] });
  };

  const complete = useMutation({
    mutationFn: (id: string) =>
      request<{ followup: SafeguardFollowup }>(
        `/me/followups/${id}/complete`,
        { method: "POST", body: "{}" },
      ),
    onSuccess: invalidate,
  });

  const patch = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: {
        remindersEnabled?: boolean;
        cadence?: FollowupCadence;
        dueAt?: string | null;
      };
    }) =>
      request<{ followup: SafeguardFollowup }>(`/me/followups/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: invalidate,
  });

  return (
    <SafeguardLayout>
      <h1 className="text-2xl font-semibold">{t("followup.title")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("followup.intro")}
      </p>
      <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 text-amber-900 text-xs px-3 py-2">
        {t("ai.generatedBanner")}
      </div>

      {latestSuccessful && (
        <div
          className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 text-emerald-900 px-3 py-2 text-sm"
          data-testid="delivery-banner-success"
        >
          {t("delivery.followupBanner.sent", {
            channel: t(
              `delivery.channel.${latestSuccessful.channel}.short`,
            ),
            recipient:
              latestSuccessful.recipient ||
              latestSuccessful.surgeryName ||
              t("delivery.unknownSurgery"),
            when: new Date(
              latestSuccessful.fetchedAt ??
                latestSuccessful.sentAt ??
                latestSuccessful.createdAt,
            ).toLocaleString(),
          })}
        </div>
      )}
      {!latestSuccessful && latestFailure && (
        <div
          className="mt-4 rounded-md border border-destructive bg-red-50 text-red-900 px-3 py-2 text-sm"
          data-testid="delivery-banner-failed"
        >
          {t("delivery.followupBanner.failed", {
            recipient:
              latestFailure.recipient ||
              latestFailure.surgeryName ||
              t("delivery.unknownSurgery"),
          })}{" "}
          {apptId && (
            <a
              href={`/safeguard/appointments/${apptId}/review`}
              className="underline"
              data-testid="delivery-banner-retry"
            >
              {t("delivery.followupBanner.retry")}
            </a>
          )}
        </div>
      )}

      <RemindersOptIn />

      {q.isLoading && <p className="mt-4 text-muted-foreground">…</p>}

      {items.length === 0 && !q.isLoading && (
        <p className="mt-6 text-base text-muted-foreground">
          {t("followup.empty")}
        </p>
      )}

      <ul className="mt-6 space-y-4">
        {items.map((it) => {
          const isEsc = it.kind === "escalation";
          return (
            <li
              key={it.id}
              className={`rounded-xl border p-4 bg-card ${
                isEsc ? "border-destructive" : "border-border"
              } ${it.completedAt ? "opacity-60" : ""}`}
              data-testid={`followup-${it.id}`}
            >
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t(`followup.kind.${it.kind}`)}
                </div>
                <Pill level={it.confidence} />
              </div>
              <h3
                className="mt-2 text-lg font-semibold"
                dir="auto"
                data-testid={`followup-${it.id}-title-translated`}
              >
                {it.titleTranslated || it.titleOriginal}
              </h3>
              {it.detailTranslated && (
                <p
                  className="mt-1 text-base"
                  dir="auto"
                  data-testid={`followup-${it.id}-detail-translated`}
                >
                  {it.detailTranslated}
                </p>
              )}
              {it.plainExplanation && (
                <p
                  className={`mt-2 text-sm ${
                    isEsc ? "text-destructive font-medium" : "text-muted-foreground"
                  }`}
                  dir="auto"
                >
                  {it.plainExplanation}
                </p>
              )}

              <ReminderRow
                followup={it}
                locale={i18n.language}
                onToggle={(enabled) =>
                  patch.mutate({
                    id: it.id,
                    body: { remindersEnabled: enabled },
                  })
                }
                onSnooze={(hours) => {
                  const at = new Date(Date.now() + hours * 60 * 60 * 1000);
                  patch.mutate({
                    id: it.id,
                    body: {
                      cadence: { kind: "once", at: at.toISOString() },
                    },
                  });
                }}
                disabled={patch.isPending}
              />

              <details
                className="mt-3 text-sm"
                ref={(node) => {
                  detailsRefs.current.set(it.id, node);
                }}
                data-testid={`followup-${it.id}-details`}
              >
                <summary className="cursor-pointer text-muted-foreground">
                  {t("followup.showOriginal")}
                </summary>
                <p
                  className="mt-2 whitespace-pre-wrap"
                  dir="auto"
                  data-testid={`followup-${it.id}-original`}
                >
                  <strong>{it.titleOriginal}</strong>
                  {it.detailOriginal ? ` — ${it.detailOriginal}` : ""}
                </p>
              </details>
              {!it.completedAt && !isEsc && (
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => complete.mutate(it.id)}
                    disabled={complete.isPending}
                    className="rounded-md bg-secondary text-secondary-foreground px-3 py-1.5 text-sm"
                    data-testid={`followup-${it.id}-complete`}
                  >
                    {t("followup.markDone")}
                  </button>
                </div>
              )}
              {it.completedAt && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t("followup.doneAt", {
                    when: new Date(it.completedAt).toLocaleString(),
                  })}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </SafeguardLayout>
  );
}

function ReminderRow({
  followup,
  locale,
  onToggle,
  onSnooze,
  disabled,
}: {
  followup: SafeguardFollowup;
  locale: string;
  onToggle: (enabled: boolean) => void;
  onSnooze: (hours: number) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const cadence = followup.cadence;
  if (!cadence || cadence.kind === "none") {
    // Escalation items + things the AI didn't schedule. No reminder UI.
    return null;
  }
  const next = followup.nextReminderAt
    ? new Date(followup.nextReminderAt)
    : null;
  const muted = !followup.remindersEnabled;
  return (
    <div
      className="mt-3 rounded-md border border-border bg-muted/30 p-3 text-sm"
      data-testid={`followup-${followup.id}-reminder`}
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="font-medium">{t("followup.reminder.heading")}</div>
          <div className="mt-0.5 text-muted-foreground">
            {describeCadence(cadence, t)}
          </div>
          {next && !muted && (
            <div
              className="mt-0.5 text-muted-foreground"
              data-testid={`followup-${followup.id}-next-reminder`}
            >
              {t("followup.reminder.next", {
                when: next.toLocaleString(locale),
              })}
            </div>
          )}
          {muted && (
            <div
              className="mt-0.5 text-muted-foreground"
              data-testid={`followup-${followup.id}-muted`}
            >
              {t("followup.reminder.muted")}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => onToggle(!followup.remindersEnabled)}
          disabled={disabled}
          className="rounded-md bg-secondary text-secondary-foreground px-3 py-1 text-xs"
          data-testid={`followup-${followup.id}-toggle-reminder`}
        >
          {muted ? t("followup.reminder.unmute") : t("followup.reminder.mute")}
        </button>
      </div>
      {!muted && (
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onSnooze(1)}
            disabled={disabled}
            className="rounded-md border border-border bg-background px-2.5 py-1 text-xs"
          >
            {t("followup.reminder.snooze1h")}
          </button>
          <button
            type="button"
            onClick={() => onSnooze(24)}
            disabled={disabled}
            className="rounded-md border border-border bg-background px-2.5 py-1 text-xs"
          >
            {t("followup.reminder.snooze24h")}
          </button>
        </div>
      )}
    </div>
  );
}

function describeCadence(
  cadence: FollowupCadence,
  t: (k: string, v?: Record<string, unknown>) => string,
): string {
  if (cadence.kind === "none") return t("followup.reminder.cadence.none");
  if (cadence.kind === "once") return t("followup.reminder.cadence.once");
  return t("followup.reminder.cadence.recurring", {
    times: cadence.timesPerDay,
    days: cadence.durationDays,
  });
}

function Pill({ level }: { level: Confidence }) {
  const { t } = useTranslation();
  const colour =
    level === "high"
      ? "bg-emerald-100 text-emerald-900 border-emerald-300"
      : level === "medium"
        ? "bg-amber-100 text-amber-900 border-amber-300"
        : "bg-red-100 text-red-900 border-red-300";
  return (
    <span
      className={`rounded-md border text-xs px-2 py-0.5 ${colour}`}
      data-testid={`confidence-${level}`}
    >
      {t("ai.confidence.label")}: {t(`ai.confidence.${level}`)}
    </span>
  );
}
