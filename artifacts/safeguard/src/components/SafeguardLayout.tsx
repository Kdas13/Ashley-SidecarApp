import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUser, useClerk } from "@clerk/clerk-react";
import { Link } from "wouter";
import {
  SUPPORTED,
  LANG_LABEL,
  SCAFFOLDED_LANGS,
  setLanguage,
  type SupportedLang,
} from "@/i18n";
import { SupportSheet } from "./SupportSheet";

interface Props {
  children: ReactNode;
  /** Hide the top bar (e.g. on the landing page). */
  bare?: boolean;
}

export function SafeguardLayout({ children, bare = false }: Props) {
  const { t, i18n } = useTranslation();
  const { user, isSignedIn } = useUser();
  const { signOut } = useClerk();
  const [supportOpen, setSupportOpen] = useState(false);
  const currentLang = i18n.language as SupportedLang;
  const isScaffolded = (SCAFFOLDED_LANGS as string[]).includes(currentLang);

  useEffect(() => {
    // Apply accessibility class on mount + when profile loads. Reads from
    // localStorage so we don't have to wait for the API.
    const lt = localStorage.getItem("safeguard.largeText") === "1";
    const hc = localStorage.getItem("safeguard.highContrast") === "1";
    document.documentElement.classList.toggle("large-text", lt);
    document.documentElement.classList.toggle("high-contrast", hc);
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {!bare && (
        <header className="border-b border-border bg-card/60 backdrop-blur sticky top-0 z-30">
          <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
            <Link
              href="/"
              className="font-semibold tracking-tight text-lg"
              data-testid="link-home"
            >
              {t("app.name")}
            </Link>
            <div className="flex-1" />
            <select
              aria-label={t("languages.label")}
              className="text-sm bg-secondary text-secondary-foreground rounded-md px-2 py-1 border border-border"
              value={currentLang}
              onChange={(e) => setLanguage(e.target.value as SupportedLang)}
              data-testid="select-language"
            >
              {SUPPORTED.map((l) => (
                <option key={l} value={l}>
                  {LANG_LABEL[l]}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setSupportOpen(true)}
              className="text-sm rounded-md px-3 py-1.5 bg-destructive text-destructive-foreground hover:opacity-90"
              data-testid="button-need-help-now"
            >
              {t("actions.needHelpNow")}
            </button>
            {isSignedIn && (
              <button
                type="button"
                onClick={() => void signOut()}
                className="text-sm text-muted-foreground hover:text-foreground"
                data-testid="button-sign-out"
              >
                {t("actions.signOut")}
              </button>
            )}
          </div>
          {isScaffolded && (
            <div className="bg-accent text-accent-foreground text-xs px-4 py-1.5 text-center">
              {t("languages.scaffoldedNotice")}
            </div>
          )}
        </header>
      )}
      <main className="flex-1 w-full max-w-3xl mx-auto px-4 py-6">
        {children}
      </main>
      <footer className="border-t border-border bg-card/40 px-4 py-4 text-xs text-muted-foreground text-center">
        {t("pilot.notice")}
        {user?.primaryEmailAddress?.emailAddress && (
          <div className="mt-1 opacity-70">
            {user.primaryEmailAddress.emailAddress}
          </div>
        )}
      </footer>
      <SupportSheet open={supportOpen} onClose={() => setSupportOpen(false)} />
    </div>
  );
}
