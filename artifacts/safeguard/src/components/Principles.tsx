import { useTranslation } from "react-i18next";
import { SAFEGUARDING_INVARIANTS } from "@/lib/safeguardingInvariants";

export function Principles() {
  const { t } = useTranslation();
  return (
    <ul className="space-y-3">
      {SAFEGUARDING_INVARIANTS.map((inv) => (
        <li
          key={inv.id}
          className="rounded-xl border border-border bg-card p-4"
          data-testid={`principle-${inv.id}`}
        >
          <div className="font-medium">
            {t(`principles.${inv.id}.title`, { defaultValue: inv.title })}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(`principles.${inv.id}.rule`, { defaultValue: inv.rule })}
          </p>
        </li>
      ))}
    </ul>
  );
}
