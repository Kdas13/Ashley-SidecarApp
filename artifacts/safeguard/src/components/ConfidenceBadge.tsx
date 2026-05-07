import { useTranslation } from "react-i18next";
import type { Confidence } from "@/lib/api";

/**
 * Standing AI-confidence indicator surfaced on every translated or
 * AI-generated surface. Always visible, never collapsed — a refugee user
 * with low literacy must be able to see at a glance how confident the
 * model is, and a clinician must see the same banner on the PDF.
 */
export function ConfidenceBadge({
  level,
  notes,
  className = "",
}: {
  level: Confidence;
  notes?: string;
  className?: string;
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
      className={`rounded-md border text-xs px-2 py-1 inline-flex flex-col gap-0.5 ${colour} ${className}`}
      data-testid={`confidence-${level}`}
    >
      <span className="font-medium">
        {t("ai.confidence.label")}: {t(`ai.confidence.${level}`)}
      </span>
      {notes && notes.length > 0 && (
        <span className="opacity-90 font-normal">{notes}</span>
      )}
    </div>
  );
}

export function AiGeneratedBanner({ className = "" }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <div
      className={`rounded-md border border-amber-300 bg-amber-50 text-amber-900 text-xs px-3 py-2 ${className}`}
      data-testid="ai-generated-banner"
    >
      {t("ai.generatedBanner")}
    </div>
  );
}
