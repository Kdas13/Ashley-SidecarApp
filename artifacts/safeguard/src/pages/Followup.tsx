import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute } from "wouter";
import { SafeguardLayout } from "@/components/SafeguardLayout";
import {
  useApi,
  type SafeguardFollowup,
  type Confidence,
} from "@/lib/api";

/**
 * Post-appointment follow-up screen. Lists translated reminders + escalations
 * for one appointment (or globally if no appointment id is in the route).
 * Each item shows BOTH the clinician's original wording and the translated
 * patient-facing wording, plus the AI-confidence indicator.
 */
export default function Followup() {
  const { t } = useTranslation();
  const { request } = useApi();
  const qc = useQueryClient();

  const [, params] = useRoute("/appointments/:id/followup");
  const apptId = params?.id;

  const path = apptId ? `/me/appointments/${apptId}` : `/me/followups`;
  const q = useQuery({
    queryKey: apptId ? ["appointment", apptId, "followups"] : ["followups"],
    queryFn: () => request<unknown>(path),
  });

  const items: SafeguardFollowup[] = (() => {
    const data = q.data as
      | { followups?: SafeguardFollowup[] }
      | { followups?: SafeguardFollowup[] }
      | undefined;
    if (!data) return [];
    if (Array.isArray((data as { followups?: SafeguardFollowup[] }).followups)) {
      return (data as { followups: SafeguardFollowup[] }).followups;
    }
    return [];
  })();

  const complete = useMutation({
    mutationFn: (id: string) =>
      request<{ followup: SafeguardFollowup }>(
        `/me/followups/${id}/complete`,
        { method: "POST", body: "{}" },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: apptId ? ["appointment", apptId, "followups"] : ["followups"],
      });
      void qc.invalidateQueries({ queryKey: ["followups"] });
    },
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

      {q.isLoading && (
        <p className="mt-4 text-muted-foreground">…</p>
      )}

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
              <details className="mt-3 text-sm">
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
