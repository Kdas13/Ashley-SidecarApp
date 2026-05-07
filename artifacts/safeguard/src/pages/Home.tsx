import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { SafeguardLayout } from "@/components/SafeguardLayout";
import { Principles } from "@/components/Principles";
import { useApi, type SafeguardCheckin, type SafeguardProfile } from "@/lib/api";

export default function Home({ profile }: { profile: SafeguardProfile }) {
  const { t } = useTranslation();
  const { request } = useApi();
  const today = useQuery({
    queryKey: ["checkins", "today"],
    queryFn: () =>
      request<{ checkin: SafeguardCheckin | null }>("/me/checkins/today"),
  });

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

      <section className="mt-10">
        <h2 className="text-lg font-semibold mb-3">
          {t("home.yourPrinciples")}
        </h2>
        <Principles />
      </section>
    </SafeguardLayout>
  );
}
