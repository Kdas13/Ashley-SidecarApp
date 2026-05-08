import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute, Link, useLocation } from "wouter";
import { SafeguardLayout } from "@/components/SafeguardLayout";
import {
  useApi,
  type SafeguardAppointment,
  type SafeguardAppointmentSummary,
  type SafeguardAppointmentIntake,
  type SafeguardExportDelivery,
  type SafeguardExportRef,
  type SafeguardDeliveryQrPayload,
  type SafeguardDeliverySharePayload,
  type SafeguardFollowup,
  type SafeguardUtterance,
} from "@/lib/api";

interface ApptDetail {
  appointment: SafeguardAppointment;
  intake: SafeguardAppointmentIntake | null;
  patientSummary: SafeguardAppointmentSummary | null;
  clinicianSummary: SafeguardAppointmentSummary | null;
  utterances: SafeguardUtterance[];
  followups: SafeguardFollowup[];
  exports: SafeguardExportRef[];
  deliveries: SafeguardExportDelivery[];
}

type DeliveryChannel = "qr" | "email" | "nhs_app";

interface DeliverResponse {
  delivery: SafeguardExportDelivery;
  qr?: SafeguardDeliveryQrPayload;
  share?: SafeguardDeliverySharePayload;
}

/**
 * Appointment review screen.
 * Lets the user (a) generate / re-generate a GP-export PDF and download it,
 * (b) capture clinician follow-up notes and turn them into translated
 * recap + reminders.
 */
export default function AppointmentReview() {
  const { t } = useTranslation();
  const { request } = useApi();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [, params] = useRoute("/appointments/:id/review");
  const id = params?.id ?? "";

  const q = useQuery({
    queryKey: ["appointment", id],
    queryFn: () => request<ApptDetail>(`/me/appointments/${id}`),
    enabled: !!id,
  });

  const [followupText, setFollowupText] = useState("");
  const [deliveryChannel, setDeliveryChannel] =
    useState<DeliveryChannel>("qr");
  const [surgeryName, setSurgeryName] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [lastQr, setLastQr] = useState<SafeguardDeliveryQrPayload | null>(null);
  const [shareNotice, setShareNotice] = useState<string>("");

  const exportPdf = useMutation({
    mutationFn: () =>
      request<{ export: SafeguardExportRef }>(
        `/me/appointments/${id}/export`,
        { method: "POST", body: "{}" },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["appointment", id] });
    },
  });

  const deliver = useMutation({
    mutationFn: () => {
      const exportId = q.data?.exports[0]?.id;
      if (!exportId) throw new Error("no_export");
      const body =
        deliveryChannel === "qr"
          ? { channel: "qr" as const, surgeryName: surgeryName.trim() }
          : deliveryChannel === "nhs_app"
            ? { channel: "nhs_app" as const, surgeryName: surgeryName.trim() }
            : {
                channel: "email" as const,
                recipientEmail: recipientEmail.trim(),
                surgeryName: surgeryName.trim(),
              };
      return request<DeliverResponse>(
        `/me/appointments/${id}/export/${exportId}/deliver`,
        { method: "POST", body: JSON.stringify(body) },
      );
    },
    onSuccess: async (data) => {
      setLastQr(data.qr ?? null);
      setShareNotice("");
      if (data.share && typeof navigator !== "undefined") {
        const nav = navigator as Navigator & {
          share?: (data: ShareData) => Promise<void>;
          clipboard?: { writeText: (s: string) => Promise<void> };
        };
        let shared = false;
        if (nav.share) {
          try {
            await nav.share({
              title: t("delivery.share.title") ?? "Patient summary",
              text: data.share.shareText,
              url: data.share.publicUrl,
            });
            setShareNotice(t("delivery.share.opened"));
            shared = true;
          } catch {
            setShareNotice(t("delivery.share.cancelled"));
          }
        } else if (nav.clipboard) {
          try {
            await nav.clipboard.writeText(data.share.shareText);
            setShareNotice(t("delivery.share.copied"));
            shared = true;
          } catch {
            setShareNotice(data.share.publicUrl);
          }
        } else {
          setShareNotice(data.share.publicUrl);
        }
        if (shared && data.delivery.channel === "nhs_app") {
          // Best-effort: bump the row from "queued" to "sent" now that
          // the patient has actually completed the share gesture.
          // Failures here don't change the on-screen result.
          try {
            await request(
              `/me/appointments/${id}/deliveries/${data.delivery.id}/share-confirmed`,
              { method: "POST", body: "{}" },
            );
          } catch {
            /* swallow — UI already shows the share notice */
          }
        }
      }
      void qc.invalidateQueries({ queryKey: ["appointment", id] });
    },
  });

  const submitFollowup = useMutation({
    mutationFn: () =>
      request<{
        recap: {
          original: string;
          translated: string;
          confidence: "high" | "medium" | "low";
          notes: string;
          sourceLang: string;
          targetLang: string;
        };
        followups: SafeguardFollowup[];
      }>(`/me/appointments/${id}/followup`, {
        method: "POST",
        body: JSON.stringify({ clinicianText: followupText }),
      }),
    onSuccess: () => {
      setFollowupText("");
      void qc.invalidateQueries({ queryKey: ["appointment", id] });
      void qc.invalidateQueries({ queryKey: ["followups"] });
      navigate(`/appointments/${id}/followup`);
    },
  });

  if (q.isLoading) {
    return (
      <SafeguardLayout>
        <p className="text-muted-foreground">…</p>
      </SafeguardLayout>
    );
  }
  if (!q.data) {
    return (
      <SafeguardLayout>
        <p className="text-destructive">{(q.error as Error)?.message ?? "—"}</p>
      </SafeguardLayout>
    );
  }

  const latestExport = q.data.exports[0];
  const deliveriesForLatest = latestExport
    ? q.data.deliveries.filter((d) => d.exportId === latestExport.id)
    : [];
  const deliverError = deliver.error as
    | (Error & { message: string })
    | null;
  const canDeliver =
    !!latestExport &&
    !deliver.isPending &&
    surgeryName.trim().length > 0 &&
    (deliveryChannel !== "email" || recipientEmail.trim().length > 0);

  return (
    <SafeguardLayout>
      <h1 className="text-2xl font-semibold">{t("appointment.reviewTitle")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("appointment.reviewIntro")}
      </p>

      <section className="mt-6 rounded-xl border border-border bg-card p-4">
        <h2 className="font-semibold">{t("pdf.heading")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t("pdf.body")}</p>
        <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 text-amber-900 text-xs px-3 py-2">
          {t("ai.generatedBanner")}
        </div>
        <div className="mt-3 flex flex-wrap gap-3 items-center">
          <button
            type="button"
            disabled={exportPdf.isPending}
            onClick={() => exportPdf.mutate()}
            className="rounded-md bg-primary text-primary-foreground px-5 py-2 font-medium disabled:opacity-50"
            data-testid="button-generate-pdf"
          >
            {exportPdf.isPending ? "…" : t("pdf.generate")}
          </button>
          {latestExport && (
            <a
              href={`/safeguard-api/me/appointments/${id}/export/${latestExport.id}.pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md bg-secondary text-secondary-foreground px-4 py-2 text-sm"
              data-testid="link-download-pdf"
            >
              {t("pdf.download")} ({Math.round(latestExport.byteSize / 1024)} KB)
            </a>
          )}
        </div>
        {exportPdf.isError && (
          <p className="mt-2 text-destructive text-sm">
            {(exportPdf.error as Error).message}
          </p>
        )}
        {q.data.exports.length > 1 && (
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              {t("pdf.previousExports")}
            </summary>
            <ul className="mt-2 space-y-1">
              {q.data.exports.slice(1).map((e) => (
                <li key={e.id}>
                  <a
                    href={`/safeguard-api/me/appointments/${id}/export/${e.id}.pdf`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline text-muted-foreground"
                  >
                    {new Date(e.generatedAt).toLocaleString()} ·{" "}
                    {Math.round(e.byteSize / 1024)} KB
                  </a>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section
        className="mt-6 rounded-xl border border-border bg-card p-4"
        data-testid="delivery-section"
      >
        <h2 className="font-semibold">{t("delivery.heading")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("delivery.body")}
        </p>
        {!latestExport && (
          <p
            className="mt-3 text-sm text-muted-foreground"
            data-testid="delivery-needs-pdf"
          >
            {t("delivery.needsPdf")}
          </p>
        )}
        {latestExport && (
          <div className="mt-4 space-y-3">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">
                {t("delivery.channelLabel")}
              </legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="delivery-channel"
                  value="qr"
                  checked={deliveryChannel === "qr"}
                  onChange={() => setDeliveryChannel("qr")}
                  data-testid="delivery-channel-qr"
                />
                <span>
                  <span className="font-medium">
                    {t("delivery.channel.qr.title")}
                  </span>
                  <span className="block text-muted-foreground">
                    {t("delivery.channel.qr.body")}
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="delivery-channel"
                  value="nhs_app"
                  checked={deliveryChannel === "nhs_app"}
                  onChange={() => setDeliveryChannel("nhs_app")}
                  data-testid="delivery-channel-nhs-app"
                />
                <span>
                  <span className="font-medium">
                    {t("delivery.channel.nhs_app.title")}
                  </span>
                  <span className="block text-muted-foreground">
                    {t("delivery.channel.nhs_app.body")}
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="delivery-channel"
                  value="email"
                  checked={deliveryChannel === "email"}
                  onChange={() => setDeliveryChannel("email")}
                  data-testid="delivery-channel-email"
                />
                <span>
                  <span className="font-medium">
                    {t("delivery.channel.email.title")}
                  </span>
                  <span className="block text-muted-foreground">
                    {t("delivery.channel.email.body")}
                  </span>
                </span>
              </label>
            </fieldset>
            <label className="block text-sm">
              <span className="font-medium">{t("delivery.surgeryName")}</span>
              <input
                type="text"
                value={surgeryName}
                onChange={(e) => setSurgeryName(e.target.value)}
                placeholder={
                  t("delivery.surgeryNamePlaceholder") ?? ""
                }
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-base"
                data-testid="delivery-surgery-name"
              />
            </label>
            {deliveryChannel === "email" && (
              <label className="block text-sm">
                <span className="font-medium">{t("delivery.email")}</span>
                <input
                  type="email"
                  value={recipientEmail}
                  onChange={(e) => setRecipientEmail(e.target.value)}
                  placeholder="team@surgery.nhs.uk"
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-base"
                  data-testid="delivery-recipient-email"
                />
              </label>
            )}
            <button
              type="button"
              disabled={!canDeliver}
              onClick={() => deliver.mutate()}
              className="rounded-md bg-primary text-primary-foreground px-5 py-2 font-medium disabled:opacity-50"
              data-testid="button-deliver"
            >
              {deliver.isPending
                ? "…"
                : deliveryChannel === "qr"
                  ? t("delivery.submitQr")
                  : deliveryChannel === "nhs_app"
                    ? t("delivery.submitNhsApp")
                    : t("delivery.submitEmail")}
            </button>
            {deliverError && (
              <p
                className="text-destructive text-sm"
                data-testid="delivery-error"
              >
                {deliverError.message}{" "}
                <button
                  type="button"
                  onClick={() => deliver.mutate()}
                  className="underline"
                  data-testid="delivery-retry"
                >
                  {t("delivery.retry")}
                </button>
              </p>
            )}
            {shareNotice && (
              <p
                className="text-sm text-muted-foreground"
                data-testid="delivery-share-notice"
              >
                {shareNotice}
              </p>
            )}
            {lastQr && (
              <div
                className="rounded-md border border-border bg-muted/30 p-3 text-sm"
                data-testid="delivery-qr"
              >
                <p className="font-medium">{t("delivery.qrReady")}</p>
                <p className="mt-1 text-muted-foreground">
                  {t("delivery.qrInstructions")}
                </p>
                <img
                  src={lastQr.dataUrl}
                  alt={t("delivery.qrAlt") ?? "QR code"}
                  className="mt-3 h-48 w-48 rounded-md bg-white p-2"
                  data-testid="delivery-qr-image"
                />
                <p className="mt-2 break-all text-xs text-muted-foreground">
                  {lastQr.publicUrl}
                </p>
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="mt-2 rounded-md bg-secondary text-secondary-foreground px-3 py-1.5 text-xs"
                  data-testid="delivery-qr-print"
                >
                  {t("delivery.print")}
                </button>
              </div>
            )}
            {deliveriesForLatest.length > 0 && (
              <ul
                className="mt-2 space-y-2"
                data-testid="delivery-history"
              >
                {deliveriesForLatest.map((d) => (
                  <li
                    key={d.id}
                    className="rounded-md border border-border bg-muted/20 p-2 text-sm flex items-start justify-between gap-3"
                    data-testid={`delivery-${d.id}`}
                  >
                    <DeliveryStatusLine delivery={d} />
                    <RevokeDeliveryButton
                      appointmentId={id}
                      delivery={d}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="mt-6 rounded-xl border border-border bg-card p-4">
        <h2 className="font-semibold">{t("followup.captureHeading")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("followup.captureBody")}
        </p>
        <textarea
          rows={6}
          value={followupText}
          dir="auto"
          onChange={(e) => setFollowupText(e.target.value)}
          placeholder={t("followup.placeholder") ?? ""}
          className="mt-3 w-full rounded-md border border-border bg-background px-3 py-2 text-base"
          data-testid="followup-input"
        />
        <div className="mt-3 flex justify-end gap-3">
          <Link
            href={`/appointments/${id}/translate`}
            className="rounded-md bg-secondary text-secondary-foreground px-4 py-2 text-sm"
            data-testid="link-back-translate"
          >
            {t("appointment.openTranslate")}
          </Link>
          <button
            type="button"
            disabled={
              submitFollowup.isPending || followupText.trim().length === 0
            }
            onClick={() => submitFollowup.mutate()}
            className="rounded-md bg-primary text-primary-foreground px-5 py-2 font-medium disabled:opacity-50"
            data-testid="button-followup-submit"
          >
            {submitFollowup.isPending ? "…" : t("followup.generate")}
          </button>
        </div>
        {submitFollowup.isError && (
          <p className="mt-2 text-destructive text-sm">
            {(submitFollowup.error as Error).message}
          </p>
        )}
      </section>

      {/* Delivery history is rendered above; nothing to add here. */}

      {q.data.followups.length > 0 && (
        <section className="mt-6">
          <Link
            href={`/appointments/${id}/followup`}
            className="text-sm underline text-muted-foreground"
            data-testid="link-go-followup"
          >
            {t("followup.viewExisting", { count: q.data.followups.length })}
          </Link>
        </section>
      )}
    </SafeguardLayout>
  );
}

function DeliveryStatusLine({
  delivery,
}: {
  delivery: SafeguardExportDelivery;
}) {
  const { t } = useTranslation();
  const recipient =
    delivery.recipient || delivery.surgeryName || t("delivery.unknownSurgery");
  const when = delivery.sentAt ?? delivery.createdAt;
  const channelLabel = t(`delivery.channel.${delivery.channel}.short`);
  if (delivery.revokedAt) {
    return (
      <span data-testid="delivery-revoked-line">
        {t("delivery.history.revoked", {
          channel: channelLabel,
          recipient,
          when: new Date(delivery.revokedAt).toLocaleString(),
        })}
      </span>
    );
  }
  if (delivery.status === "failed") {
    return (
      <span className="text-destructive">
        {t("delivery.history.failed", {
          channel: channelLabel,
          recipient,
          reason: delivery.errorMessage || t("delivery.unknownError"),
        })}
      </span>
    );
  }
  if (delivery.status === "delivered" && delivery.fetchedAt) {
    return (
      <span>
        {t("delivery.history.delivered", {
          channel: channelLabel,
          recipient,
          when: new Date(delivery.fetchedAt).toLocaleString(),
        })}
      </span>
    );
  }
  if (delivery.status === "queued") {
    return (
      <span className="text-muted-foreground">
        {t("delivery.history.queued", {
          channel: channelLabel,
          recipient,
        })}
      </span>
    );
  }
  return (
    <span>
      {t("delivery.history.sent", {
        channel: channelLabel,
        recipient,
        when: new Date(when).toLocaleString(),
      })}
    </span>
  );
}

function RevokeDeliveryButton({
  appointmentId,
  delivery,
}: {
  appointmentId: string;
  delivery: SafeguardExportDelivery;
}) {
  const { t } = useTranslation();
  const { request } = useApi();
  const qc = useQueryClient();
  const revoke = useMutation({
    mutationFn: () =>
      request<{ delivery: SafeguardExportDelivery }>(
        `/me/appointments/${appointmentId}/deliveries/${delivery.id}/revoke`,
        { method: "POST", body: "{}" },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["appointment", appointmentId] });
    },
  });
  // Already revoked, or this channel never minted a recallable token
  // (email PDFs are out of our hands once nodemailer accepts them).
  if (delivery.revokedAt) return null;
  if (delivery.channel !== "qr" && delivery.channel !== "nhs_app") return null;
  const expired =
    delivery.expiresAt &&
    new Date(delivery.expiresAt).getTime() < Date.now();
  if (expired) return null;
  return (
    <button
      type="button"
      disabled={revoke.isPending}
      onClick={() => {
        if (
          typeof window !== "undefined" &&
          !window.confirm(t("delivery.revoke.confirm"))
        ) {
          return;
        }
        revoke.mutate();
      }}
      className="shrink-0 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
      data-testid={`delivery-revoke-${delivery.id}`}
    >
      {revoke.isPending ? "…" : t("delivery.revoke.action")}
    </button>
  );
}
