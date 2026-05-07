import { useState, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SafeguardLayout } from "@/components/SafeguardLayout";
import { useApi, type Lang, type SafeguardProfile } from "@/lib/api";
import {
  SUPPORTED,
  LANG_LABEL,
  setLanguage,
  type SupportedLang,
} from "@/i18n";

interface Form {
  preferredName: string;
  preferredLanguage: Lang;
  nativeLanguage: Lang;
  secondaryLanguage: Lang | "";
  literacyLevel: "low" | "medium" | "high";
  countryOfOrigin: string;
  dateOfBirth: string;
  gpName: string;
  gpSurgery: string;
  ongoingConcerns: string;
  currentMedications: string;
  accessibilityLargeText: boolean;
  accessibilityHighContrast: boolean;
  accessibilityAudio: boolean;
  accessibilitySimplified: boolean;
  accessibilitySlowerPacing: boolean;
  trustedContactName: string;
  trustedContactRelation: string;
  trustedContactPhone: string;
  consentStorage: boolean;
  consentAiProcessing: boolean;
}

const INITIAL: Form = {
  preferredName: "",
  preferredLanguage: "en",
  nativeLanguage: "en",
  secondaryLanguage: "",
  literacyLevel: "medium",
  countryOfOrigin: "",
  dateOfBirth: "",
  gpName: "",
  gpSurgery: "",
  ongoingConcerns: "",
  currentMedications: "",
  accessibilityLargeText: false,
  accessibilityHighContrast: false,
  accessibilityAudio: false,
  accessibilitySimplified: false,
  accessibilitySlowerPacing: false,
  trustedContactName: "",
  trustedContactRelation: "",
  trustedContactPhone: "",
  consentStorage: false,
  consentAiProcessing: false,
};

/**
 * Single-question-at-a-time onboarding. Each question is its own screen
 * with explicit forward/back controls so users with low literacy or
 * cognitive load only ever see one prompt at a time. The "slower pacing"
 * accessibility toggle does not change anything here because pacing is
 * already one-at-a-time by default for everyone — it primarily signals to
 * future surfaces (check-in summary length, trend cards) to keep things
 * minimal.
 */
export default function Onboarding({
  initial,
}: {
  initial?: SafeguardProfile | null;
}) {
  const { t, i18n } = useTranslation();
  const { request } = useApi();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [form, setForm] = useState<Form>({
    ...INITIAL,
    ...(initial ?? {}),
    preferredLanguage:
      (initial?.preferredLanguage as Lang) ??
      ((i18n.language as Lang) || "en"),
    nativeLanguage:
      (initial?.nativeLanguage as Lang) ??
      ((i18n.language as Lang) || "en"),
  });
  const [step, setStep] = useState(0);

  const update = <K extends keyof Form>(k: K, v: Form[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: async () => {
      return await request<{ profile: SafeguardProfile }>("/me/profile", {
        method: "PUT",
        body: JSON.stringify(form),
      });
    },
    onSuccess: () => {
      localStorage.setItem(
        "safeguard.largeText",
        form.accessibilityLargeText ? "1" : "0",
      );
      localStorage.setItem(
        "safeguard.highContrast",
        form.accessibilityHighContrast ? "1" : "0",
      );
      document.documentElement.classList.toggle(
        "large-text",
        form.accessibilityLargeText,
      );
      document.documentElement.classList.toggle(
        "high-contrast",
        form.accessibilityHighContrast,
      );
      void qc.invalidateQueries({ queryKey: ["profile"] });
      navigate("/home");
    },
  });

  // One question per entry. `canAdvance` is per-question; required
  // questions block forward navigation when empty. `optional: true` shows
  // a "skip" affordance via canAdvance always-true.
  interface Question {
    id: string;
    title: string;
    body?: ReactNode;
    render: ReactNode;
    canAdvance: boolean;
  }

  const questions: Question[] = useMemo(() => {
    return [
      {
        id: "language",
        title: t("onboarding.q.language"),
        body: t("onboarding.q.languageBody"),
        canAdvance: true,
        render: (
          <div className="grid grid-cols-2 gap-2">
            {SUPPORTED.map((l) => (
              <button
                type="button"
                key={l}
                onClick={() => {
                  update("preferredLanguage", l);
                  setLanguage(l as SupportedLang);
                }}
                className={`rounded-lg border p-3 text-left ${
                  form.preferredLanguage === l
                    ? "border-primary bg-primary/5"
                    : "border-border bg-card"
                }`}
                data-testid={`onboarding-lang-${l}`}
              >
                <div className="font-medium">{LANG_LABEL[l]}</div>
              </button>
            ))}
          </div>
        ),
      },
      {
        id: "preferredName",
        title: t("onboarding.q.preferredName"),
        canAdvance: form.preferredName.trim().length > 0,
        render: (
          <TextInput
            value={form.preferredName}
            onChange={(v) => update("preferredName", v)}
            testid="input-preferred-name"
          />
        ),
      },
      {
        id: "nativeLanguage",
        title: t("onboarding.q.nativeLanguage"),
        body: t("onboarding.q.nativeLanguageBody"),
        canAdvance: true,
        render: (
          <SelectGrid
            value={form.nativeLanguage}
            onChange={(v) => update("nativeLanguage", v as Lang)}
            testid="select-native-lang"
            options={SUPPORTED.map((l) => ({
              value: l,
              label: LANG_LABEL[l],
            }))}
          />
        ),
      },
      {
        id: "secondaryLanguage",
        title: t("onboarding.q.secondaryLanguage"),
        body: t("onboarding.q.secondaryLanguageBody"),
        canAdvance: true,
        render: (
          <SelectGrid
            value={form.secondaryLanguage}
            onChange={(v) => update("secondaryLanguage", v as Lang | "")}
            testid="select-secondary-lang"
            options={[
              { value: "", label: t("onboarding.fields.none") },
              ...SUPPORTED.map((l) => ({
                value: l,
                label: LANG_LABEL[l],
              })),
            ]}
          />
        ),
      },
      {
        id: "literacy",
        title: t("onboarding.q.literacy"),
        body: t("onboarding.q.literacyBody"),
        canAdvance: true,
        render: (
          <SelectGrid
            value={form.literacyLevel}
            onChange={(v) =>
              update("literacyLevel", v as Form["literacyLevel"])
            }
            testid="select-literacy"
            options={[
              { value: "low", label: t("onboarding.fields.literacyLow") },
              {
                value: "medium",
                label: t("onboarding.fields.literacyMedium"),
              },
              { value: "high", label: t("onboarding.fields.literacyHigh") },
            ]}
          />
        ),
      },
      {
        id: "country",
        title: t("onboarding.q.country"),
        canAdvance: form.countryOfOrigin.trim().length > 0,
        render: (
          <TextInput
            value={form.countryOfOrigin}
            onChange={(v) => update("countryOfOrigin", v)}
            testid="input-country"
          />
        ),
      },
      {
        id: "dob",
        title: t("onboarding.q.dob"),
        body: t("onboarding.q.dobBody"),
        canAdvance: form.dateOfBirth.trim().length > 0,
        render: (
          <TextInput
            value={form.dateOfBirth}
            onChange={(v) => update("dateOfBirth", v)}
            testid="input-dob"
          />
        ),
      },
      {
        id: "gpName",
        title: t("onboarding.q.gpName"),
        body: t("onboarding.q.gpNameBody"),
        canAdvance: true,
        render: (
          <TextInput
            value={form.gpName}
            onChange={(v) => update("gpName", v)}
            testid="input-gp-name"
          />
        ),
      },
      {
        id: "gpSurgery",
        title: t("onboarding.q.gpSurgery"),
        canAdvance: true,
        render: (
          <TextInput
            value={form.gpSurgery}
            onChange={(v) => update("gpSurgery", v)}
            testid="input-gp-surgery"
          />
        ),
      },
      {
        id: "concerns",
        title: t("onboarding.q.concerns"),
        body: t("onboarding.q.concernsBody"),
        canAdvance: true,
        render: (
          <TextArea
            value={form.ongoingConcerns}
            onChange={(v) => update("ongoingConcerns", v)}
            testid="textarea-concerns"
          />
        ),
      },
      {
        id: "medications",
        title: t("onboarding.q.medications"),
        body: t("onboarding.q.medicationsBody"),
        canAdvance: true,
        render: (
          <TextArea
            value={form.currentMedications}
            onChange={(v) => update("currentMedications", v)}
            testid="textarea-medications"
          />
        ),
      },
      {
        id: "largeText",
        title: t("onboarding.q.largeText"),
        canAdvance: true,
        render: (
          <YesNo
            value={form.accessibilityLargeText}
            onChange={(v) => update("accessibilityLargeText", v)}
            testid="toggle-large-text"
            yesLabel={t("actions.yes")}
            noLabel={t("actions.no")}
          />
        ),
      },
      {
        id: "highContrast",
        title: t("onboarding.q.highContrast"),
        canAdvance: true,
        render: (
          <YesNo
            value={form.accessibilityHighContrast}
            onChange={(v) => update("accessibilityHighContrast", v)}
            testid="toggle-high-contrast"
            yesLabel={t("actions.yes")}
            noLabel={t("actions.no")}
          />
        ),
      },
      {
        id: "audio",
        title: t("onboarding.q.audio"),
        canAdvance: true,
        render: (
          <YesNo
            value={form.accessibilityAudio}
            onChange={(v) => update("accessibilityAudio", v)}
            testid="toggle-audio"
            yesLabel={t("actions.yes")}
            noLabel={t("actions.no")}
          />
        ),
      },
      {
        id: "simplified",
        title: t("onboarding.q.simplified"),
        canAdvance: true,
        render: (
          <YesNo
            value={form.accessibilitySimplified}
            onChange={(v) => update("accessibilitySimplified", v)}
            testid="toggle-simplified"
            yesLabel={t("actions.yes")}
            noLabel={t("actions.no")}
          />
        ),
      },
      {
        id: "slowerPacing",
        title: t("onboarding.q.slowerPacing"),
        canAdvance: true,
        render: (
          <YesNo
            value={form.accessibilitySlowerPacing}
            onChange={(v) => update("accessibilitySlowerPacing", v)}
            testid="toggle-slower-pacing"
            yesLabel={t("actions.yes")}
            noLabel={t("actions.no")}
          />
        ),
      },
      {
        id: "trustedName",
        title: t("onboarding.q.trustedName"),
        body: t("onboarding.q.trustedNameBody"),
        canAdvance: true,
        render: (
          <TextInput
            value={form.trustedContactName}
            onChange={(v) => update("trustedContactName", v)}
            testid="input-trusted-name"
          />
        ),
      },
      {
        id: "trustedRelation",
        title: t("onboarding.q.trustedRelation"),
        canAdvance: true,
        render: (
          <TextInput
            value={form.trustedContactRelation}
            onChange={(v) => update("trustedContactRelation", v)}
            testid="input-trusted-relation"
          />
        ),
      },
      {
        id: "trustedPhone",
        title: t("onboarding.q.trustedPhone"),
        canAdvance: true,
        render: (
          <TextInput
            value={form.trustedContactPhone}
            onChange={(v) => update("trustedContactPhone", v)}
            testid="input-trusted-phone"
          />
        ),
      },
      {
        id: "consentStorage",
        title: t("onboarding.q.consentStorage"),
        body: t("onboarding.q.consentStorageBody"),
        canAdvance: form.consentStorage,
        render: (
          <YesNo
            value={form.consentStorage}
            onChange={(v) => update("consentStorage", v)}
            testid="toggle-consent-storage"
            yesLabel={t("onboarding.consent.iAgree")}
            noLabel={t("onboarding.consent.notYet")}
          />
        ),
      },
      {
        id: "consentAi",
        title: t("onboarding.q.consentAi"),
        body: t("onboarding.q.consentAiBody"),
        canAdvance: form.consentAiProcessing,
        render: (
          <YesNo
            value={form.consentAiProcessing}
            onChange={(v) => update("consentAiProcessing", v)}
            testid="toggle-consent-ai"
            yesLabel={t("onboarding.consent.iAgree")}
            noLabel={t("onboarding.consent.notYet")}
          />
        ),
      },
    ];
  }, [form, t]);

  const total = questions.length;
  const current = questions[step]!;
  const isLast = step === total - 1;

  const onContinue = () => {
    if (!current.canAdvance) return;
    if (!isLast) {
      setStep(step + 1);
    } else {
      save.mutate();
    }
  };

  return (
    <SafeguardLayout>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{t("onboarding.title")}</span>
        <span data-testid="step-indicator">
          {step + 1} / {total}
        </span>
      </div>
      <div className="mt-2 h-1.5 w-full rounded bg-secondary">
        <div
          className="h-1.5 rounded bg-primary transition-all"
          style={{ width: `${((step + 1) / total) * 100}%` }}
          aria-hidden
        />
      </div>

      <h1 className="mt-6 text-2xl font-semibold" data-testid="question-title">
        {current.title}
      </h1>
      {current.body && (
        <p className="mt-2 text-sm text-muted-foreground">{current.body}</p>
      )}
      <div className="mt-6">{current.render}</div>

      {!current.canAdvance && current.id.startsWith("consent") && (
        <p
          className="mt-3 text-sm text-destructive"
          data-testid="consent-warning"
        >
          {t("onboarding.consentRequired")}
        </p>
      )}

      <div className="mt-8 flex items-center justify-between gap-3">
        {step > 0 ? (
          <button
            type="button"
            className="rounded-md bg-secondary text-secondary-foreground px-4 py-2"
            onClick={() => setStep(step - 1)}
            data-testid="button-onboarding-back"
          >
            {t("actions.back")}
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={onContinue}
          className="rounded-md bg-primary text-primary-foreground px-5 py-2 font-medium disabled:opacity-50"
          disabled={!current.canAdvance || save.isPending}
          data-testid="button-onboarding-next"
        >
          {!isLast ? t("actions.continue") : t("onboarding.complete")}
        </button>
      </div>
      {save.isError && (
        <p className="mt-3 text-destructive text-sm" data-testid="save-error">
          {(save.error as Error).message}
        </p>
      )}
    </SafeguardLayout>
  );
}

function TextInput({
  value,
  onChange,
  testid,
}: {
  value: string;
  onChange: (v: string) => void;
  testid: string;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border border-border bg-card px-4 py-3 text-base"
      data-testid={testid}
    />
  );
}

function TextArea({
  value,
  onChange,
  testid,
}: {
  value: string;
  onChange: (v: string) => void;
  testid: string;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={5}
      className="w-full rounded-md border border-border bg-card px-4 py-3 text-base"
      data-testid={testid}
    />
  );
}

function SelectGrid({
  value,
  onChange,
  options,
  testid,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  testid: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-2" data-testid={testid}>
      {options.map((o) => (
        <button
          type="button"
          key={o.value || "_none"}
          onClick={() => onChange(o.value)}
          className={`rounded-lg border p-3 text-left ${
            value === o.value
              ? "border-primary bg-primary/5"
              : "border-border bg-card"
          }`}
          data-testid={`${testid}-${o.value || "none"}`}
          aria-pressed={value === o.value}
        >
          <div className="font-medium">{o.label}</div>
        </button>
      ))}
    </div>
  );
}

function YesNo({
  value,
  onChange,
  testid,
  yesLabel,
  noLabel,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  testid: string;
  yesLabel: string;
  noLabel: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-3" data-testid={testid}>
      <button
        type="button"
        onClick={() => onChange(true)}
        aria-pressed={value === true}
        className={`rounded-lg border p-4 text-base font-medium ${
          value === true
            ? "border-primary bg-primary/5"
            : "border-border bg-card"
        }`}
        data-testid={`${testid}-yes`}
      >
        {yesLabel}
      </button>
      <button
        type="button"
        onClick={() => onChange(false)}
        aria-pressed={value === false}
        className={`rounded-lg border p-4 text-base font-medium ${
          value === false
            ? "border-primary bg-primary/5"
            : "border-border bg-card"
        }`}
        data-testid={`${testid}-no`}
      >
        {noLabel}
      </button>
    </div>
  );
}
