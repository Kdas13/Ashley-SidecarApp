import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import uk from "./locales/uk.json";
import ar from "./locales/ar.json";
import ur from "./locales/ur.json";
import ps from "./locales/ps.json";
import so from "./locales/so.json";

export const SUPPORTED = ["en", "uk", "ar", "ur", "ps", "so"] as const;
export type SupportedLang = (typeof SUPPORTED)[number];

export const RTL_LANGS: SupportedLang[] = ["ar", "ur", "ps"];

// Languages whose bundle is intentionally a scaffold — only safety-critical
// strings translated, the rest fall back to English with a visible badge.
export const SCAFFOLDED_LANGS: SupportedLang[] = ["ur", "ps", "so"];

export const LANG_LABEL: Record<SupportedLang, string> = {
  en: "English",
  uk: "Українська",
  ar: "العربية",
  ur: "اردو",
  ps: "پښتو",
  so: "Soomaali",
};

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    uk: { translation: uk },
    ar: { translation: ar },
    ur: { translation: ur },
    ps: { translation: ps },
    so: { translation: so },
  },
  lng: typeof window !== "undefined"
    ? (localStorage.getItem("safeguard.lang") as SupportedLang) || "en"
    : "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  returnEmptyString: false,
});

export function applyDirection(lang: string): void {
  if (typeof document === "undefined") return;
  const dir = (RTL_LANGS as string[]).includes(lang) ? "rtl" : "ltr";
  document.documentElement.setAttribute("dir", dir);
  document.documentElement.setAttribute("lang", lang);
}

export function setLanguage(lang: SupportedLang): void {
  void i18n.changeLanguage(lang);
  if (typeof window !== "undefined") {
    localStorage.setItem("safeguard.lang", lang);
  }
  applyDirection(lang);
}

if (typeof document !== "undefined") {
  applyDirection(i18n.language);
}

export default i18n;
