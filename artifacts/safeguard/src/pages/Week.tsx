import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { SafeguardLayout } from "@/components/SafeguardLayout";
import {
  useApi,
  type SafeguardCheckin,
  type SafeguardObservation,
  type SafeguardTrend,
} from "@/lib/api";

interface Row {
  observation: SafeguardObservation;
  checkin: SafeguardCheckin;
}

interface Response {
  observations: Row[];
  trends: SafeguardTrend[];
}

const SCORE_FIELDS = [
  "generalFeeling",
  "pain",
  "foodWater",
  "medication",
  "sleep",
  "safety",
] as const;

export default function Week() {
  const { t, i18n } = useTranslation();
  const { request } = useApi();
  const q = useQuery({
    queryKey: ["observations", 7],
    queryFn: () => request<Response>("/me/observations?days=7"),
  });

  return (
    <SafeguardLayout>
      <h1 className="text-2xl font-semibold">{t("week.title")}</h1>

      {q.isLoading && (
        <p className="mt-4 text-sm text-muted-foreground">…</p>
      )}

      {q.data && q.data.trends.length > 0 && (
        <section className="mt-4 space-y-3" data-testid="trends-section">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t("week.trendsHeading")}
          </h2>
          {q.data.trends.map((trend, i) => (
            <div
              key={i}
              className={`rounded-xl border p-4 bg-card ${
                trend.flagged ? "border-destructive" : "border-border"
              }`}
              data-testid={`trend-${trend.kind}`}
            >
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {t(`week.trendKind.${trend.kind}`)}
              </div>
              <p className="mt-2 text-base">{trend.summary}</p>
              {trend.bullets.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                  {trend.bullets.map((b, j) => (
                    <li
                      key={j}
                      className={
                        b.startsWith("[FLAG]")
                          ? "text-destructive font-medium"
                          : ""
                      }
                    >
                      • {b}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </section>
      )}

      {q.data && q.data.observations.length === 0 && (
        <p className="mt-4 text-base text-muted-foreground">
          {t("week.empty")}
        </p>
      )}

      <ul className="mt-6 space-y-4">
        {q.data?.observations.map(({ observation, checkin }) => {
          const date = new Date(checkin.createdAt).toLocaleDateString(
            i18n.language,
            { weekday: "long", day: "numeric", month: "short" },
          );
          return (
            <li
              key={observation.id}
              className={`rounded-xl border p-4 bg-card ${
                observation.flagged ? "border-destructive" : "border-border"
              }`}
              data-testid={`week-row-${observation.id}`}
            >
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {date}
              </div>
              {observation.flagged && (
                <div className="mt-1 text-destructive font-medium text-sm">
                  {t("week.flagged")}
                </div>
              )}
              <p className="mt-2 text-base">{observation.summary}</p>
              {observation.bullets.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                  {observation.bullets.map((b, i) => (
                    <li
                      key={i}
                      className={
                        b.startsWith("[FLAG]")
                          ? "text-destructive font-medium"
                          : ""
                      }
                    >
                      • {b}
                    </li>
                  ))}
                </ul>
              )}
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  {t("checkin.rawHeading")}
                </summary>
                <p className="mt-2 whitespace-pre-wrap" dir="auto">
                  {checkin.freeText || "—"}
                </p>
                <div className="mt-2 text-xs text-muted-foreground">
                  {SCORE_FIELDS.map((k) => {
                    const v = (checkin as unknown as Record<string, number | null>)[
                      `${k}Score`
                    ];
                    return v == null ? null : (
                      <span key={k} className="mr-3">
                        {t(`checkin.scores.${k}`)}: {v}/10
                      </span>
                    );
                  })}
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </SafeguardLayout>
  );
}
