// =============================================================================
// Client-side mirror of the server's content policy resolver. Used for UI
// gating ONLY — the server is always authoritative; this just lets the UI
// know what to show without a round trip on every interaction.
//
// IMPORTANT: keep this in sync with artifacts/api-server/src/lib/contentPolicy.ts.
// If the rules diverge, the server wins (the UI may briefly display a wrong
// state until the next /state hydration corrects it).
// =============================================================================

import type { AshleyProfile, ServerPolicy } from "./storage";

export const INTIMACY_MIN = 0;
export const INTIMACY_MAX = 5;
export const STANDARD_INTIMACY_CEILING = 3;
export const MATURE_INTIMACY_CEILING = 5;

const INTIMACY_RUNG_LABELS: ReadonlyArray<{ label: string; blurb: string }> = [
  { label: "Acquainted", blurb: "Polite and warm. Friendly distance." },
  { label: "Comfortable", blurb: "Relaxed. Light teasing okay." },
  { label: "Close", blurb: "Real warmth. Small affectionate gestures within the relationship mode." },
  { label: "Affectionate", blurb: "Tender, soft, present. Romantic language only if the relationship mode is romantic." },
  { label: "Intimate", blurb: "Mature mode only. Romantic depth and sensual emotional tone where consenting." },
  { label: "Deeply intimate", blurb: "Mature mode only. Full adult emotional openness within the provider floor." },
];

export function intimacyRung(level: number): { label: string; blurb: string } {
  const clamped = Math.max(
    INTIMACY_MIN,
    Math.min(INTIMACY_MAX, Math.floor(level)),
  );
  return INTIMACY_RUNG_LABELS[clamped]!;
}

/**
 * Resolve the policy view from the cached profile + the latest server-issued
 * policy snapshot. The snapshot carries the operator-flag bit (which the
 * client doesn't otherwise know about), so we need both inputs.
 *
 * If `serverPolicy` is null (we haven't hydrated yet), we return safe
 * defaults that DO NOT expose the mature UI under any circumstance.
 */
export function resolveClientPolicy(
  profile: AshleyProfile,
  serverPolicy: ServerPolicy | null,
): {
  effectiveMode: "standard" | "mature";
  intimacyLevel: number;
  intimacyCeiling: number;
  adultConfirmed: boolean;
  matureModeAvailable: boolean;
  operatorMatureModeAvailable: boolean;
} {
  const operatorAvailable = serverPolicy?.operatorMatureModeAvailable ?? false;
  const adultConfirmed =
    profile.adultConfirmedAt != null &&
    String(profile.adultConfirmedAt).length > 0;
  const requestedMature = profile.contentMode === "mature";
  const effectiveMode: "standard" | "mature" =
    requestedMature && operatorAvailable && adultConfirmed
      ? "mature"
      : "standard";
  const intimacyCeiling =
    effectiveMode === "mature"
      ? MATURE_INTIMACY_CEILING
      : STANDARD_INTIMACY_CEILING;
  const intimacyLevel = Math.max(
    INTIMACY_MIN,
    Math.min(intimacyCeiling, Math.floor(profile.intimacyLevel ?? 0)),
  );
  return {
    effectiveMode,
    intimacyLevel,
    intimacyCeiling,
    adultConfirmed,
    matureModeAvailable: operatorAvailable && adultConfirmed,
    operatorMatureModeAvailable: operatorAvailable,
  };
}
