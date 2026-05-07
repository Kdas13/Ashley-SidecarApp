import { useTranslation } from "react-i18next";
import { SignInButton, SignUpButton } from "@clerk/clerk-react";
import { SafeguardLayout } from "@/components/SafeguardLayout";
import { Principles } from "@/components/Principles";

export default function Landing() {
  const { t } = useTranslation();
  return (
    <SafeguardLayout>
      <section className="py-6">
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight leading-tight">
          {t("landing.title")}
        </h1>
        <p className="mt-4 text-base text-muted-foreground max-w-2xl">
          {t("landing.intro")}
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <SignUpButton mode="modal">
            <button
              type="button"
              className="rounded-md bg-primary text-primary-foreground px-5 py-2.5 font-medium hover:opacity-90"
              data-testid="button-sign-up"
            >
              {t("actions.signUp")}
            </button>
          </SignUpButton>
          <SignInButton mode="modal">
            <button
              type="button"
              className="rounded-md bg-secondary text-secondary-foreground px-5 py-2.5 font-medium hover:opacity-90"
              data-testid="button-sign-in"
            >
              {t("actions.signIn")}
            </button>
          </SignInButton>
        </div>
      </section>
      <section className="mt-10">
        <h2 className="text-xl font-semibold mb-4">
          {t("landing.principlesTitle")}
        </h2>
        <Principles />
      </section>
    </SafeguardLayout>
  );
}
