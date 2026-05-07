import { useTranslation } from "react-i18next";

interface Props {
  open: boolean;
  onClose: () => void;
}

const ITEMS = ["emergency", "nhs111", "samaritans", "refugeeCouncil"] as const;

export function SupportSheet({ open, onClose }: Props) {
  const { t } = useTranslation();
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40"
      onClick={onClose}
      data-testid="dialog-support"
    >
      <div
        className="bg-card text-card-foreground rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md p-6 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">{t("support.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("support.intro")}
        </p>
        <ul className="mt-4 space-y-3">
          {ITEMS.map((key) => (
            <li
              key={key}
              className="rounded-xl border border-border p-3"
              data-testid={`support-item-${key}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium">
                  {t(`support.items.${key}.name`)}
                </div>
                <a
                  href={`tel:${t(`support.items.${key}.number`)}`}
                  className="text-primary font-semibold tabular-nums"
                >
                  {t(`support.items.${key}.number`)}
                </a>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {t(`support.items.${key}.what`)}
              </p>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={onClose}
          className="mt-5 w-full rounded-md bg-secondary text-secondary-foreground px-4 py-2 hover:opacity-90"
          data-testid="button-support-close"
        >
          {t("support.close")}
        </button>
      </div>
    </div>
  );
}
