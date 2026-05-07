import { useState, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SafeguardLayout } from "@/components/SafeguardLayout";
import {
  useApi,
  type Lang,
  type SafeguardCheckin,
  type SafeguardProfile,
} from "@/lib/api";

interface Result {
  checkin: SafeguardCheckin;
  summary: string;
  observations: string[];
  flagged: boolean;
}

const SCORE_KEYS = [
  "generalFeeling",
  "pain",
  "foodWater",
  "medication",
  "sleep",
  "safety",
] as const;
type ScoreKey = (typeof SCORE_KEYS)[number];

// `pain` is the only inverted scale: 0=none, 10=worst. The others read
// 0=worst, 10=best. The UI uses this set to swap the endpoint labels.
const INVERTED: ReadonlySet<ScoreKey> = new Set(["pain"]);

/**
 * Single-question-at-a-time daily check-in. Each of the six required
 * questions gets its own screen, then a free-text screen, then submit.
 * Skip is always allowed — the spec says no answer is mandatory.
 */
export default function CheckIn({ profile }: { profile: SafeguardProfile }) {
  const { t } = useTranslation();
  const { request } = useApi();
  const qc = useQueryClient();
  const lang: Lang = profile.preferredLanguage || "en";
  const [scores, setScores] = useState<Record<ScoreKey, number | undefined>>({
    generalFeeling: undefined,
    pain: undefined,
    foodWater: undefined,
    medication: undefined,
    sleep: undefined,
    safety: undefined,
  });
  const [freeText, setFreeText] = useState("");
  const [step, setStep] = useState(0);
  const [result, setResult] = useState<Result | null>(null);

  const submit = useMutation({
    mutationFn: async () => {
      return await request<Result>("/me/checkins", {
        method: "POST",
        body: JSON.stringify({ lang, freeText, scores }),
      });
    },
    onSuccess: (r) => {
      setResult(r);
      void qc.invalidateQueries({ queryKey: ["checkins"] });
      void qc.invalidateQueries({ queryKey: ["observations"] });
    },
  });

  interface Step {
    id: string;
    title: string;
    render: ReactNode;
  }

  const steps: Step[] = useMemo(() => {
    const scoreSteps: Step[] = SCORE_KEYS.map((k) => ({
      id: k,
      title: t(`checkin.scores.${k}`),
      render: (
        <ScoreStrip
          value={scores[k]}
          inverted={INVERTED.has(k)}
          lowLabel={
            INVERTED.has(k) ? t("checkin.scores.none") : t("checkin.scores.low")
          }
          highLabel={
            INVERTED.has(k) ? t("checkin.scores.alot") : t("checkin.scores.high")
          }
          onChange={(v) => setScores((s) => ({ ...s, [k]: v }))}
          testid={`score-${k}`}
        />
      ),
    }));
    const freeTextStep: Step = {
      id: "freeText",
      title: t("checkin.freeText"),
      render: (
        <textarea
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          rows={6}
          placeholder={t("checkin.freeTextPlaceholder")}
          dir="auto"
          className="w-full rounded-md border border-border bg-card px-4 py-3 text-base"
          data-testid="textarea-checkin"
        />
      ),
    };
    return [...scoreSteps, freeTextStep];
  }, [scores, freeText, t]);

  const total = steps.length;
  const current = steps[step]!;
  const isLast = step === total - 1;

  if (result) {
    const flagged =
      result.flagged ||
      result.observations.some((o) => o.startsWith("[FLAG]"));
    return (
      <SafeguardLayout>
        <h1 className="text-2xl font-semibold">{t("checkin.title")}</h1>
        <p className="mt-3 text-base">{t("checkin.thanks")}</p>

        {flagged && (
          <div
            className="mt-4 rounded-xl border-2 border-destructive bg-destructive/10 p-4 text-destructive font-medium"
            data-testid="flag-banner"
          >
            {t("week.flagged")}
          </div>
        )}

        <section className="mt-6 rounded-xl border border-border bg-card p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t("checkin.summaryHeading")}
          </h2>
          <p className="mt-2 text-base whitespace-pre-wrap">{result.summary}</p>
          {result.observations.length > 0 && (
            <ul className="mt-3 space-y-1.5 text-sm">
              {result.observations.map((o, i) => (
                <li
                  key={i}
                  className={
                    o.startsWith("[FLAG]")
                      ? "text-destructive font-medium"
                      : "text-foreground"
                  }
                >
                  • {o}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-4 rounded-xl border border-border bg-card p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t("checkin.rawHeading")}
          </h2>
          {lang !== "en" && (
            <p className="mt-1 text-xs text-muted-foreground italic">
              {t("checkin.translatedNote", { from: lang.toUpperCase() })}
            </p>
          )}
          <p className="mt-2 text-base whitespace-pre-wrap" dir="auto">
            {result.checkin.freeText || "—"}
          </p>
        </section>

        <div className="mt-6 flex gap-3">
          <Link
            href="/home"
            className="rounded-md bg-secondary text-secondary-foreground px-4 py-2"
            data-testid="link-home-after-checkin"
          >
            {t("actions.continue")}
          </Link>
          <Link
            href="/week"
            className="rounded-md bg-primary text-primary-foreground px-4 py-2"
            data-testid="link-week-after-checkin"
          >
            {t("home.viewWeek")}
          </Link>
        </div>
      </SafeguardLayout>
    );
  }

  const onContinue = () => {
    if (!isLast) {
      setStep(step + 1);
    } else {
      submit.mutate();
    }
  };

  return (
    <SafeguardLayout>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{t("checkin.title")}</span>
        <span data-testid="checkin-step-indicator">
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

      <h1
        className="mt-6 text-2xl font-semibold"
        data-testid="checkin-question-title"
      >
        {current.title}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("checkin.skipHint")}
      </p>
      <div className="mt-6">{current.render}</div>

      <div className="mt-8 flex items-center justify-between gap-3">
        {step > 0 ? (
          <button
            type="button"
            className="rounded-md bg-secondary text-secondary-foreground px-4 py-2"
            onClick={() => setStep(step - 1)}
            data-testid="button-checkin-back"
          >
            {t("actions.back")}
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={onContinue}
          disabled={submit.isPending}
          className="rounded-md bg-primary text-primary-foreground px-5 py-2 font-medium disabled:opacity-50"
          data-testid={isLast ? "button-submit-checkin" : "button-checkin-next"}
        >
          {submit.isPending
            ? "…"
            : isLast
              ? t("checkin.submit")
              : t("actions.continue")}
        </button>
      </div>
      {submit.isError && (
        <p className="mt-3 text-destructive text-sm">
          {(submit.error as Error).message}
        </p>
      )}
    </SafeguardLayout>
  );
}

function ScoreStrip({
  value,
  onChange,
  lowLabel,
  highLabel,
  testid,
  inverted,
}: {
  value: number | undefined;
  onChange: (v: number) => void;
  lowLabel: string;
  highLabel: string;
  testid: string;
  inverted: boolean;
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground w-12 text-right">
          {lowLabel}
        </span>
        <div className="flex flex-1 gap-1">
          {Array.from({ length: 11 }).map((_, n) => (
            <button
              type="button"
              key={n}
              onClick={() => onChange(n)}
              className={`flex-1 h-12 rounded-md border text-base font-medium ${
                value === n
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card text-foreground border-border hover:bg-secondary"
              }`}
              data-testid={`${testid}-${n}`}
              aria-pressed={value === n}
              aria-label={`${n}/10`}
            >
              {n}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground w-12">{highLabel}</span>
      </div>
      <ScaleHint inverted={inverted} />
    </div>
  );
}

function ScaleHint({ inverted }: { inverted: boolean }) {
  const { t } = useTranslation();
  return (
    <p className="mt-2 text-xs text-muted-foreground">
      {inverted ? t("checkin.scaleInverted") : t("checkin.scaleNormal")}
    </p>
  );
}
