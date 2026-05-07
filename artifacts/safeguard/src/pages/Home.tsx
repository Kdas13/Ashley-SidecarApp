import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { SafeguardLayout } from "@/components/SafeguardLayout";
import { Principles } from "@/components/Principles";
import {
  useApi,
  type SafeguardCheckin,
  type SafeguardProfile,
  type SafeguardAppointment,
  type SafeguardFollowup,
} from "@/lib/api";

export default function Home({ profile }: { profile: SafeguardProfile }) {
  const { t } = useTranslation();
  const { request } = useApi();
  const today = useQuery({
    queryKey: ["checkins", "today"],
    queryFn: () =>
      request<{ checkin: SafeguardCheckin | null }>("/me/checkins/today"),
  });
  const appointments = useQuery({
    queryKey: ["appointments"],
    queryFn: () =>
      request<{ appointments: SafeguardAppointment[] }>("/me/appointments"),
  });
  const followups = useQuery({
    queryKey: ["followups"],
    queryFn: () =>
      request<{ followups: SafeguardFollowup[] }>("/me/followups"),
  });

  const activeAppt = appointments.data?.appointments.find(
    (a) => a.status !== "completed",
  );
  const openFollowups =
    followups.data?.followups.filter((f) => !f.completedAt) ?? [];

  return (
    <SafeguardLayout>
      <h1 className="text-2xl font-semibold">
        {t("home.greeting", { name: profile.preferredName || "—" })}
      </h1>

      <div className="mt-6 rounded-2xl border border-border bg-card p-5">
        {today.data?.checkin ? (
          <>
            <p className="text-base">{t("home.todayDone")}</p>
            <Link
              href="/week"
              className="mt-4 inline-block rounded-md bg-secondary text-secondary-foreground px-4 py-2"
              data-testid="link-week"
            >
              {t("home.viewWeek")}
            </Link>
          </>
        ) : (
          <>
            <p className="text-base">{t("home.todayPrompt")}</p>
            <Link
              href="/checkin"
              className="mt-4 inline-block rounded-md bg-primary text-primary-foreground px-5 py-2.5 font-medium"
              data-testid="link-start-checkin"
            >
              {t("home.startCheckin")}
            </Link>
          </>
        )}
      </div>

      <section className="mt-6 rounded-2xl border border-border bg-card p-5">
        <h2 className="text-lg font-semibold">{t("home.appointmentHeading")}</h2>
        {activeAppt ? (
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              {t(`home.apptStatus.${activeAppt.status}`)}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link
                href={`/appointments/${activeAppt.id}/translate`}
                className="rounded-md bg-secondary text-secondary-foreground px-4 py-2 text-sm"
                data-testid="home-link-translate"
              >
                {t("appointment.openTranslate")}
              </Link>
              <Link
                href={`/appointments/${activeAppt.id}/review`}
                className="rounded-md bg-secondary text-secondary-foreground px-4 py-2 text-sm"
                data-testid="home-link-review"
              >
                {t("appointment.openReview")}
              </Link>
            </div>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("home.appointmentBody")}
            </p>
            <Link
              href="/appointments/new"
              className="mt-3 inline-block rounded-md bg-primary text-primary-foreground px-5 py-2 font-medium"
              data-testid="home-link-new-appointment"
            >
              {t("home.startAppointment")}
            </Link>
          </>
        )}
      </section>

      {openFollowups.length > 0 && (
        <section
          className="mt-6 rounded-2xl border border-border bg-card p-5"
          data-testid="home-followups-section"
        >
          <h2 className="text-lg font-semibold">{t("home.followupsHeading")}</h2>
          <ul className="mt-3 space-y-2">
            {openFollowups.slice(0, 5).map((f) => (
              <li
                key={f.id}
                className={`rounded-md border p-3 text-sm ${
                  f.kind === "escalation"
                    ? "border-destructive bg-destructive/5"
                    : "border-border"
                }`}
                data-testid={`home-followup-${f.id}`}
              >
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t(`followup.kind.${f.kind}`)}
                </div>
                <div className="mt-1 font-medium" dir="auto">
                  {f.titleTranslated || f.titleOriginal}
                </div>
                {f.detailTranslated && (
                  <div className="mt-0.5 text-muted-foreground" dir="auto">
                    {f.detailTranslated}
                  </div>
                )}
              </li>
            ))}
          </ul>
          <Link
            href="/followups"
            className="mt-3 inline-block text-sm underline text-muted-foreground"
            data-testid="home-link-followups"
          >
            {t("home.viewAllFollowups")}
          </Link>
        </section>
      )}

      <section className="mt-10">
        <h2 className="text-lg font-semibold mb-3">
          {t("home.yourPrinciples")}
        </h2>
        <Principles />
      </section>
    </SafeguardLayout>
  );
}
