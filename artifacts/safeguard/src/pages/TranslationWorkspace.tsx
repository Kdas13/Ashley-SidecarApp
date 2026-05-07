import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useRoute } from "wouter";
import { SafeguardLayout } from "@/components/SafeguardLayout";
import {
  useApi,
  type SafeguardAppointment,
  type SafeguardUtterance,
  type SafeguardTranslation,
  type Confidence,
} from "@/lib/api";
import { LANG_LABEL } from "@/i18n";

interface ApptDetail {
  appointment: SafeguardAppointment;
  utterances: SafeguardUtterance[];
}

export default function TranslationWorkspace() {
  const { t } = useTranslation();
  const { request } = useApi();
  const qc = useQueryClient();
  const [, params] = useRoute("/appointments/:id/translate");
  const id = params?.id ?? "";

  const q = useQuery({
    queryKey: ["appointment", id],
    queryFn: () => request<ApptDetail>(`/me/appointments/${id}`),
    enabled: !!id,
    refetchInterval: false,
  });

  const [speaker, setSpeaker] = useState<"patient" | "clinician">("patient");
  const [text, setText] = useState("");

  const send = useMutation({
    mutationFn: () =>
      request<{ utterance: SafeguardUtterance["utterance"]; translation: SafeguardTranslation }>(
        `/me/appointments/${id}/utterances`,
        { method: "POST", body: JSON.stringify({ speaker, text }) },
      ),
    onSuccess: () => {
      setText("");
      void qc.invalidateQueries({ queryKey: ["appointment", id] });
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

  const appt = q.data.appointment;
  const fromLang = speaker === "patient" ? appt.patientLang : appt.clinicianLang;
  const toLang = speaker === "patient" ? appt.clinicianLang : appt.patientLang;

  return (
    <SafeguardLayout>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("translateWs.title")}</h1>
        <Link
          href={`/appointments/${id}/review`}
          className="text-sm underline text-muted-foreground"
          data-testid="link-review"
        >
          {t("translateWs.openReview")}
        </Link>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {LANG_LABEL[appt.patientLang]} ↔ {LANG_LABEL[appt.clinicianLang]}
      </p>

      <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 text-amber-900 text-xs px-3 py-2">
        {t("translateWs.aiBanner")}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setSpeaker("patient")}
          aria-pressed={speaker === "patient"}
          className={`rounded-lg border p-3 text-left ${
            speaker === "patient"
              ? "border-primary bg-primary/5"
              : "border-border bg-card"
          }`}
          data-testid="speaker-patient"
        >
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            {t("translateWs.speakerPatient")}
          </div>
          <div className="font-medium">{LANG_LABEL[appt.patientLang]}</div>
        </button>
        <button
          type="button"
          onClick={() => setSpeaker("clinician")}
          aria-pressed={speaker === "clinician"}
          className={`rounded-lg border p-3 text-left ${
            speaker === "clinician"
              ? "border-primary bg-primary/5"
              : "border-border bg-card"
          }`}
          data-testid="speaker-clinician"
        >
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            {t("translateWs.speakerClinician")}
          </div>
          <div className="font-medium">{LANG_LABEL[appt.clinicianLang]}</div>
        </button>
      </div>

      <div className="mt-3">
        <label className="text-xs uppercase tracking-wide text-muted-foreground">
          {t("translateWs.inputLabel", {
            from: LANG_LABEL[fromLang],
            to: LANG_LABEL[toLang],
          })}
        </label>
        <textarea
          rows={3}
          value={text}
          dir="auto"
          onChange={(e) => setText(e.target.value)}
          placeholder={t("translateWs.inputPlaceholder") ?? ""}
          className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-base"
          data-testid="translate-input"
        />
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            disabled={send.isPending || text.trim().length === 0}
            onClick={() => send.mutate()}
            className="rounded-md bg-primary text-primary-foreground px-5 py-2 font-medium disabled:opacity-50"
            data-testid="button-translate-send"
          >
            {send.isPending ? "…" : t("translateWs.translate")}
          </button>
        </div>
        {send.isError && (
          <p className="mt-2 text-destructive text-sm">
            {(send.error as Error).message}
          </p>
        )}
      </div>

      <ul className="mt-6 space-y-3">
        {q.data.utterances.length === 0 && (
          <li className="text-sm text-muted-foreground">
            {t("translateWs.empty")}
          </li>
        )}
        {[...q.data.utterances].reverse().map((u) => {
          const tr = u.translation;
          return (
            <li
              key={u.utterance.id}
              className="rounded-xl border border-border bg-card p-4"
              data-testid={`utterance-${u.utterance.id}`}
            >
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  {u.utterance.speaker === "patient"
                    ? t("translateWs.speakerPatient")
                    : t("translateWs.speakerClinician")}
                  {tr ? ` · ${LANG_LABEL[tr.sourceLang]} → ${LANG_LABEL[tr.targetLang]}` : ""}
                </div>
                {tr && <Pill level={tr.confidence} />}
              </div>
              <div className="mt-2">
                <div className="text-xs text-muted-foreground">
                  {t("translateWs.original")}
                </div>
                <p className="text-base whitespace-pre-wrap" dir="auto">
                  {tr?.sourceText ?? "—"}
                </p>
              </div>
              <div className="mt-3">
                <div className="text-xs text-muted-foreground">
                  {t("translateWs.translated")}
                </div>
                <p className="text-base whitespace-pre-wrap" dir="auto">
                  {tr?.translatedText ?? "—"}
                </p>
                {tr?.notes && (
                  <p className="mt-1 text-xs text-amber-800">{tr.notes}</p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </SafeguardLayout>
  );
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
