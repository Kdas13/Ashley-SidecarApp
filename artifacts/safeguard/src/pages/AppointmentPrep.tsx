import { useState, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SafeguardLayout } from "@/components/SafeguardLayout";
import {
  useApi,
  type SafeguardAppointment,
  type SafeguardAppointmentSummary,
  type SafeguardProfile,
  type Lang,
} from "@/lib/api";
import { SUPPORTED, LANG_LABEL } from "@/i18n";

/**
 * Appointment prep — one question at a time. Captures the intake answers
 * in the patient's language, then sends them to the API which produces
 * BOTH the patient-facing plain-language summary and the clinician-facing
 * structured summary. The user reviews and can edit the patient version
 * before continuing into the translation workspace or the GP-export PDF.
 */

interface IntakeForm {
  mainConcern: string;
  symptomDuration: string;
  severity: string;
  medications: string;
  allergies: string;
  sleep: string;
  appetite: string;
  painLevel: string;
  mentalHealth: string;
  safeguarding: string;
}

const EMPTY_INTAKE: IntakeForm = {
  mainConcern: "",
  symptomDuration: "",
  severity: "",
  medications: "",
  allergies: "",
  sleep: "",
  appetite: "",
  painLevel: "",
  mentalHealth: "",
  safeguarding: "",
};

export default function AppointmentPrep({
  profile,
}: {
  profile: SafeguardProfile;
}) {
  const { t } = useTranslation();
  const { request } = useApi();
  const qc = useQueryClient();
  const [, navigate] = useLocation();

  const [appt, setAppt] = useState<SafeguardAppointment | null>(null);
  const [clinicianLang, setClinicianLang] = useState<Lang>("en");
  const patientLang: Lang = profile.preferredLanguage;
  const [step, setStep] = useState(0);
  const [intake, setIntake] = useState<IntakeForm>(EMPTY_INTAKE);
  const [summaries, setSummaries] = useState<{
    patient: SafeguardAppointmentSummary | null;
    clinician: SafeguardAppointmentSummary | null;
  } | null>(null);

  const create = useMutation({
    mutationFn: () =>
      request<{ appointment: SafeguardAppointment }>("/me/appointments", {
        method: "POST",
        body: JSON.stringify({
          patientLang,
          clinicianLang,
          title: "",
        }),
      }),
    onSuccess: (data) => {
      setAppt(data.appointment);
      setStep(1);
    },
  });

  const submitIntake = useMutation({
    mutationFn: () => {
      if (!appt) throw new Error("no appointment");
      return request<{
        intake: { lang: Lang; answers: Record<string, string> };
        patientSummary: SafeguardAppointmentSummary | null;
        clinicianSummary: SafeguardAppointmentSummary | null;
      }>(`/me/appointments/${appt.id}/intake`, {
        method: "PUT",
        body: JSON.stringify({ lang: patientLang, answers: intake }),
      });
    },
    onSuccess: (data) => {
      setSummaries({
        patient: data.patientSummary,
        clinician: data.clinicianSummary,
      });
      void qc.invalidateQueries({ queryKey: ["appointments"] });
    },
  });

  const editPatient = useMutation({
    mutationFn: (text: string) => {
      if (!appt) throw new Error("no appointment");
      return request<{ patientSummary: SafeguardAppointmentSummary }>(
        `/me/appointments/${appt.id}/patient-summary`,
        { method: "PUT", body: JSON.stringify({ summary: text }) },
      );
    },
    onSuccess: (data) => {
      setSummaries((s) =>
        s ? { ...s, patient: data.patientSummary } : s,
      );
    },
  });

  // -------------------------------------------------------------------------
  // Intake question list. Defined up-front (before any early return) so the
  // hooks order stays stable across re-renders — calling useMemo only after
  // step > 0 would trigger React's "Rendered more hooks than during the
  // previous render" guard the moment the user advances past step 0.
  // -------------------------------------------------------------------------
  interface Q {
    id: keyof IntakeForm;
    title: string;
    body?: string;
    required: boolean;
    long?: boolean;
  }
  const questions = useMemo<Q[]>(
    () => [
      {
        id: "mainConcern",
        title: t("appointment.q.mainConcern"),
        body: t("appointment.q.mainConcernBody"),
        required: true,
        long: true,
      },
      {
        id: "symptomDuration",
        title: t("appointment.q.symptomDuration"),
        required: false,
      },
      {
        id: "severity",
        title: t("appointment.q.severity"),
        required: false,
      },
      {
        id: "painLevel",
        title: t("appointment.q.painLevel"),
        required: false,
      },
      {
        id: "medications",
        title: t("appointment.q.medications"),
        required: false,
        long: true,
      },
      {
        id: "allergies",
        title: t("appointment.q.allergies"),
        required: false,
      },
      {
        id: "sleep",
        title: t("appointment.q.sleep"),
        required: false,
      },
      {
        id: "appetite",
        title: t("appointment.q.appetite"),
        required: false,
      },
      {
        id: "mentalHealth",
        title: t("appointment.q.mentalHealth"),
        body: t("appointment.q.mentalHealthBody"),
        required: false,
        long: true,
      },
      {
        id: "safeguarding",
        title: t("appointment.q.safeguarding"),
        body: t("appointment.q.safeguardingBody"),
        required: false,
        long: true,
      },
    ],
    [t],
  );

  // -------------------------------------------------------------------------
  // Step 0: language pair
  // -------------------------------------------------------------------------
  if (step === 0) {
    return (
      <SafeguardLayout>
        <h1 className="text-2xl font-semibold">{t("appointment.title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("appointment.intro")}
        </p>

        <div className="mt-6 rounded-xl border border-border bg-card p-4">
          <div className="text-sm">
            {t("appointment.yourLang")}: <strong>{LANG_LABEL[patientLang]}</strong>
          </div>
          <div className="mt-4 text-sm font-medium">
            {t("appointment.clinicianLangQ")}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {SUPPORTED.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setClinicianLang(l)}
                aria-pressed={clinicianLang === l}
                className={`rounded-lg border p-3 text-left ${
                  clinicianLang === l
                    ? "border-primary bg-primary/5"
                    : "border-border bg-card"
                }`}
                data-testid={`appt-clinician-lang-${l}`}
              >
                {LANG_LABEL[l]}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={() => create.mutate()}
            disabled={create.isPending}
            className="rounded-md bg-primary text-primary-foreground px-5 py-2 font-medium disabled:opacity-50"
            data-testid="button-appt-create"
          >
            {t("actions.continue")}
          </button>
        </div>
        {create.isError && (
          <p className="mt-3 text-destructive text-sm">
            {(create.error as Error).message}
          </p>
        )}
      </SafeguardLayout>
    );
  }

  // -------------------------------------------------------------------------
  // Step 1..N: one-question intake. After last step → submit & show summary.
  // (Question list is hoisted above the step===0 early return — see above.)
  // -------------------------------------------------------------------------
  const total = questions.length;
  const intakeStep = step - 1;
  const isReview = intakeStep >= total;

  if (!isReview) {
    const q = questions[intakeStep]!;
    const v = intake[q.id];
    const canAdvance = !q.required || v.trim().length > 0;
    const isLastQ = intakeStep === total - 1;

    return (
      <SafeguardLayout>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{t("appointment.title")}</span>
          <span data-testid="appt-step">{intakeStep + 1} / {total}</span>
        </div>
        <div className="mt-2 h-1.5 w-full rounded bg-secondary">
          <div
            className="h-1.5 rounded bg-primary transition-all"
            style={{ width: `${((intakeStep + 1) / total) * 100}%` }}
          />
        </div>
        <h2 className="mt-6 text-2xl font-semibold" data-testid="appt-question-title">
          {q.title}
        </h2>
        {q.body && (
          <p className="mt-2 text-sm text-muted-foreground">{q.body}</p>
        )}
        <div className="mt-6">
          {q.long ? (
            <textarea
              rows={5}
              value={v}
              dir="auto"
              onChange={(e) =>
                setIntake((s) => ({ ...s, [q.id]: e.target.value }))
              }
              className="w-full rounded-md border border-border bg-card px-4 py-3 text-base"
              data-testid={`appt-input-${q.id}`}
            />
          ) : (
            <input
              value={v}
              dir="auto"
              onChange={(e) =>
                setIntake((s) => ({ ...s, [q.id]: e.target.value }))
              }
              className="w-full rounded-md border border-border bg-card px-4 py-3 text-base"
              data-testid={`appt-input-${q.id}`}
            />
          )}
        </div>
        <div className="mt-8 flex justify-between gap-3">
          <button
            type="button"
            className="rounded-md bg-secondary text-secondary-foreground px-4 py-2"
            onClick={() => setStep(step - 1)}
            data-testid="button-appt-back"
          >
            {t("actions.back")}
          </button>
          <button
            type="button"
            disabled={!canAdvance}
            onClick={() => {
              if (isLastQ) {
                submitIntake.mutate(undefined, {
                  onSuccess: () => setStep(step + 1),
                });
              } else {
                setStep(step + 1);
              }
            }}
            className="rounded-md bg-primary text-primary-foreground px-5 py-2 font-medium disabled:opacity-50"
            data-testid="button-appt-next"
          >
            {isLastQ
              ? submitIntake.isPending
                ? "…"
                : t("appointment.generate")
              : t("actions.continue")}
          </button>
        </div>
        {submitIntake.isError && (
          <p className="mt-3 text-destructive text-sm">
            {(submitIntake.error as Error).message}
          </p>
        )}
      </SafeguardLayout>
    );
  }

  // -------------------------------------------------------------------------
  // Review: show dual summaries + edit-patient + actions
  // -------------------------------------------------------------------------
  return (
    <SafeguardLayout>
      <h1 className="text-2xl font-semibold">{t("appointment.reviewTitle")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("appointment.reviewIntro")}
      </p>

      <SummaryCard
        heading={t("appointment.patientSummaryHeading")}
        s={summaries?.patient ?? null}
        editable
        onSave={(text) => editPatient.mutate(text)}
        saving={editPatient.isPending}
        testidPrefix="appt-patient-summary"
      />
      <SummaryCard
        heading={t("appointment.clinicianSummaryHeading")}
        s={summaries?.clinician ?? null}
        testidPrefix="appt-clinician-summary"
      />

      <div className="mt-8 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => appt && navigate(`/appointments/${appt.id}/translate`)}
          className="rounded-md bg-primary text-primary-foreground px-5 py-2 font-medium"
          data-testid="button-appt-open-translate"
        >
          {t("appointment.openTranslate")}
        </button>
        <button
          type="button"
          onClick={() => appt && navigate(`/appointments/${appt.id}/review`)}
          className="rounded-md bg-secondary text-secondary-foreground px-4 py-2"
          data-testid="button-appt-open-review"
        >
          {t("appointment.openReview")}
        </button>
      </div>
    </SafeguardLayout>
  );
}

function SummaryCard({
  heading,
  s,
  editable,
  onSave,
  saving,
  testidPrefix,
}: {
  heading: string;
  s: SafeguardAppointmentSummary | null;
  editable?: boolean;
  onSave?: (text: string) => void;
  saving?: boolean;
  testidPrefix: string;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(s?.summary ?? "");
  if (!s) {
    return (
      <section className="mt-6 rounded-xl border border-border bg-card p-4">
        <h2 className="font-semibold">{heading}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("appointment.summaryMissing")}
        </p>
      </section>
    );
  }
  return (
    <section
      className="mt-6 rounded-xl border border-border bg-card p-4"
      data-testid={testidPrefix}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <h2 className="font-semibold">{heading}</h2>
        <ConfidenceInline level={s.confidence} notes={s.notes} />
      </div>
      <div className="mt-2 text-xs text-amber-700">
        {t("ai.generatedBanner")}
      </div>
      {editing ? (
        <>
          <textarea
            rows={6}
            value={draft}
            dir="auto"
            onChange={(e) => setDraft(e.target.value)}
            className="mt-3 w-full rounded-md border border-border bg-background px-3 py-2 text-base"
            data-testid={`${testidPrefix}-edit`}
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                onSave?.(draft);
                setEditing(false);
              }}
              className="rounded-md bg-primary text-primary-foreground px-4 py-1.5 text-sm font-medium"
              data-testid={`${testidPrefix}-save`}
            >
              {t("actions.save")}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft(s.summary);
              }}
              className="rounded-md bg-secondary text-secondary-foreground px-4 py-1.5 text-sm"
            >
              {t("actions.cancel")}
            </button>
          </div>
        </>
      ) : (
        <>
          <p
            className="mt-3 whitespace-pre-wrap text-base"
            dir="auto"
            data-testid={`${testidPrefix}-text`}
          >
            {s.summary}
          </p>
          {s.edited && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t("appointment.editedByYou")}
            </p>
          )}
          {editable && (
            <button
              type="button"
              onClick={() => {
                setDraft(s.summary);
                setEditing(true);
              }}
              className="mt-3 text-sm underline text-muted-foreground hover:text-foreground"
              data-testid={`${testidPrefix}-edit-btn`}
            >
              {t("appointment.editPatientSummary")}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function ConfidenceInline({
  level,
  notes,
}: {
  level: "high" | "medium" | "low";
  notes: string;
}) {
  const { t } = useTranslation();
  const colour =
    level === "high"
      ? "bg-emerald-100 text-emerald-900 border-emerald-300"
      : level === "medium"
        ? "bg-amber-100 text-amber-900 border-amber-300"
        : "bg-red-100 text-red-900 border-red-300";
  return (
    <div
      className={`rounded-md border text-xs px-2 py-1 ${colour}`}
      data-testid={`confidence-${level}`}
    >
      <span className="font-medium">
        {t("ai.confidence.label")}: {t(`ai.confidence.${level}`)}
      </span>
      {notes && <span className="ml-2 opacity-90">— {notes}</span>}
    </div>
  );
}
