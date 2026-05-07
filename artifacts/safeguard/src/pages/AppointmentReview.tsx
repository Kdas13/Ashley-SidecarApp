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
  type SafeguardExportRef,
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
