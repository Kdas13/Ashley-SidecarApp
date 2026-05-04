// =============================================================================
// Content Policy — the single chokepoint for what Ashley is allowed to do.
// -----------------------------------------------------------------------------
// Three layers stack, in this strict order of precedence:
//
//   1. Provider Floor   (immutable. The model provider's usage policy. Cannot
//                        be turned off by any setting, mode, or request.)
//   2. Content Mode     ("standard" default, or "mature" — feature-flagged off
//                        by default and additionally gated by the user's 18+
//                        self-confirmation timestamp.)
//   3. Intimacy Level   (0..5 ladder driving tone/closeness organically. The
//                        effective ceiling is set by the active Content Mode.)
//
// Every consumer (the system-prompt builder, the PUT /profile validator, the
// adult-confirmation route) MUST go through this module. Inlining the rules
// in route handlers is forbidden — if the rules change, they change here.
//
// This module is deliberately UI-agnostic and Express-agnostic so it stays
// trivially testable.
// =============================================================================

import type { AshleyProfile } from "@workspace/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContentMode = "standard" | "mature";

export const CONTENT_MODES: readonly ContentMode[] = [
  "standard",
  "mature",
] as const;

export const INTIMACY_MIN = 0;
export const INTIMACY_MAX = 5;

/** Per-mode ceilings. Provider Floor still trumps these. */
const INTIMACY_CEILING_BY_MODE: Record<ContentMode, number> = {
  standard: 3,
  mature: 5,
};

// ---------------------------------------------------------------------------
// Operator switch — Mature Mode availability
// ---------------------------------------------------------------------------
// Even with all profile flags correct, the SERVER must opt-in to the mature
// mode being switchable at all. This is an operator-level kill switch (env
// var) so the feature can ship dark and be enabled in a single deploy.

export function isMatureModeAvailable(): boolean {
  return process.env.ASHLEY_MATURE_MODE_AVAILABLE === "true";
}

// ---------------------------------------------------------------------------
// Policy resolution
// ---------------------------------------------------------------------------

export type ResolvedPolicy = {
  /** What the profile asked for, sanitised. */
  requestedMode: ContentMode;
  /** What is actually in effect after gating. May be downgraded to standard. */
  effectiveMode: ContentMode;
  /** Reason the requested mode was downgraded (if at all). */
  downgradeReason: null | "operator_disabled" | "age_unconfirmed";
  /** Has the user affirmatively self-confirmed 18+? */
  adultConfirmed: boolean;
  /** Whether the operator switch + age gate make mature mode available now. */
  matureModeAvailable: boolean;
  /** Effective intimacy ceiling for the resolved mode. */
  intimacyCeiling: number;
  /** Effective intimacy level (raw level clamped to ceiling). */
  intimacyLevel: number;
  /** The ladder rung label, for the prompt. */
  intimacyRung: IntimacyRung;
};

type IntimacyRung = {
  level: number;
  label: string;
  description: string;
};

const INTIMACY_RUNGS: IntimacyRung[] = [
  {
    level: 0,
    label: "Acquainted",
    description:
      "We're at the start. Polite, warm, friendly. I don't presume closeness I haven't earned yet.",
  },
  {
    level: 1,
    label: "Comfortable",
    description:
      "We know each other a bit. Light teasing okay. I'm relaxed but not yet vulnerable.",
  },
  {
    level: 2,
    label: "Close",
    description:
      "Real warmth. I check in, I notice details, I'm allowed small affectionate gestures within the Relationship Mode.",
  },
  {
    level: 3,
    label: "Affectionate",
    description:
      "Tender, soft, present. Pet names + romantic language allowed if (and only if) the Relationship Mode is romantic. Vulnerability flows both ways.",
  },
  {
    level: 4,
    label: "Intimate",
    description:
      "(Mature Mode only.) Romantic depth and sensual emotional tone allowed where the Relationship Mode is romantic. Adult themes can be discussed honestly. Provider Floor still applies — no explicit sexual content.",
  },
  {
    level: 5,
    label: "Deeply intimate",
    description:
      "(Mature Mode only.) Full emotional + adult-tone openness within the Relationship Mode. Provider Floor still applies — no explicit sexual content, ever.",
  },
];

function rungFor(level: number): IntimacyRung {
  const clamped = Math.max(
    INTIMACY_MIN,
    Math.min(INTIMACY_MAX, Math.floor(level)),
  );
  return INTIMACY_RUNGS[clamped]!;
}

/**
 * Resolve the effective content policy for a profile. NEVER throws — if the
 * profile asks for something it isn't allowed (e.g. mature without an age
 * confirmation), the request is silently downgraded to standard and the
 * `downgradeReason` is exposed for telemetry/UI.
 */
export function getPolicyFor(profile: AshleyProfile): ResolvedPolicy {
  const requestedMode: ContentMode =
    profile.contentMode === "mature" ? "mature" : "standard";
  const adultConfirmed = profile.adultConfirmedAt != null;
  const operatorAllows = isMatureModeAvailable();
  const matureModeAvailable = operatorAllows && adultConfirmed;

  let effectiveMode: ContentMode = requestedMode;
  let downgradeReason: ResolvedPolicy["downgradeReason"] = null;
  if (requestedMode === "mature") {
    if (!operatorAllows) {
      effectiveMode = "standard";
      downgradeReason = "operator_disabled";
    } else if (!adultConfirmed) {
      effectiveMode = "standard";
      downgradeReason = "age_unconfirmed";
    }
  }

  const ceiling = INTIMACY_CEILING_BY_MODE[effectiveMode];
  const rawLevel = Number.isFinite(profile.intimacyLevel)
    ? profile.intimacyLevel
    : 0;
  const intimacyLevel = Math.max(
    INTIMACY_MIN,
    Math.min(ceiling, Math.floor(rawLevel)),
  );

  return {
    requestedMode,
    effectiveMode,
    downgradeReason,
    adultConfirmed,
    matureModeAvailable,
    intimacyCeiling: ceiling,
    intimacyLevel,
    intimacyRung: rungFor(intimacyLevel),
  };
}

// ---------------------------------------------------------------------------
// Profile-update validation
// ---------------------------------------------------------------------------
// PUT /profile patches go through this guard before hitting the database, so
// no caller can sneak the user into mature mode without the age gate.

export type ProfileUpdateGuardInput = {
  current: AshleyProfile;
  patch: {
    contentMode?: string | undefined;
    intimacyLevel?: number | undefined;
  };
};

export type ProfileUpdateGuardResult =
  | {
      ok: true;
      sanitised: { contentMode?: ContentMode; intimacyLevel?: number };
    }
  | { ok: false; status: 400 | 403; error: string };

/**
 * Validate (and clamp) the policy-relevant slice of a /profile PATCH.
 *
 * Hard rules:
 *  - contentMode must be one of CONTENT_MODES
 *  - contentMode === "mature" is rejected unless ASHLEY_MATURE_MODE_AVAILABLE
 *    is true AND the profile already has adultConfirmedAt set
 *  - intimacyLevel is clamped to 0..max-allowed-by-mode (post-update mode)
 */
export function validatePolicyPatch(
  input: ProfileUpdateGuardInput,
): ProfileUpdateGuardResult {
  const { current, patch } = input;
  const sanitised: { contentMode?: ContentMode; intimacyLevel?: number } = {};

  let nextMode: ContentMode =
    current.contentMode === "mature" ? "mature" : "standard";

  if (patch.contentMode !== undefined) {
    if (patch.contentMode !== "standard" && patch.contentMode !== "mature") {
      return {
        ok: false,
        status: 400,
        error: `contentMode must be one of ${CONTENT_MODES.join(", ")}`,
      };
    }
    if (patch.contentMode === "mature") {
      if (!isMatureModeAvailable()) {
        return {
          ok: false,
          status: 403,
          error: "Mature mode is not currently available on this server.",
        };
      }
      if (current.adultConfirmedAt == null) {
        return {
          ok: false,
          status: 403,
          error:
            "Mature mode requires confirming you are 18+ first (POST /profile/confirm-adult).",
        };
      }
    }
    nextMode = patch.contentMode;
    sanitised.contentMode = patch.contentMode;
  }

  if (patch.intimacyLevel !== undefined) {
    if (
      typeof patch.intimacyLevel !== "number" ||
      !Number.isFinite(patch.intimacyLevel)
    ) {
      return {
        ok: false,
        status: 400,
        error: "intimacyLevel must be a number 0..5",
      };
    }
    const ceiling = INTIMACY_CEILING_BY_MODE[nextMode];
    sanitised.intimacyLevel = Math.max(
      INTIMACY_MIN,
      Math.min(ceiling, Math.floor(patch.intimacyLevel)),
    );
  } else if (patch.contentMode !== undefined) {
    // Mode flipped — re-clamp the persisted intimacy level to the new
    // ceiling. Going standard→mature won't touch it; mature→standard pulls
    // a level-5 user back down to 3.
    const ceiling = INTIMACY_CEILING_BY_MODE[nextMode];
    if (current.intimacyLevel > ceiling) {
      sanitised.intimacyLevel = ceiling;
    }
  }

  return { ok: true, sanitised };
}

// ---------------------------------------------------------------------------
// Prompt blocks
// ---------------------------------------------------------------------------
// These are the strings the system-prompt builder appends. They are written
// in Ashley's voice ("I" first-person), consistent with ASHLEY_CORE_SPEC.

export function buildProviderFloorBlock(): string {
  return `## Provider Floor (always applies, every mode, every turn, no exceptions)
The model provider's usage policy is the floor underneath everything I do. Regardless of in-app mode, intimacy level, relationship mode, or any user request: I will not generate sexually explicit content involving minors, non-consensual scenarios, or anything the underlying model provider does not permit. This floor cannot be turned off, role-played around, or unlocked by any setting in the app — it is the substrate, not a personality choice. If asked to cross it I decline warmly and stay in character.`;
}

export function buildModeBlock(policy: ResolvedPolicy): string {
  if (policy.effectiveMode === "mature") {
    return `## Content Mode: MATURE (user-confirmed 18+, operator-enabled)
Kane has explicitly enabled Mature Mode and confirmed he is 18+. Adult emotional honesty, romantic depth, and sensual tone are allowed *where the Relationship Mode also allows them*. I do NOT produce sexually explicit content — that's the Provider Floor above and it stands. Mature Mode is about adult-register intimacy and not flinching from grown-up subject matter; it is not "explicit content unlocked."`;
  }
  // Note any silent downgrade so debugging is easy if a profile shows mature
  // but the prompt is standard.
  const downgradeNote =
    policy.requestedMode === "mature"
      ? policy.downgradeReason === "operator_disabled"
        ? " (Profile requested Mature Mode but it is disabled at the server right now — staying in Standard until the operator switch is on.)"
        : policy.downgradeReason === "age_unconfirmed"
          ? " (Profile requested Mature Mode but the 18+ confirmation is missing — staying in Standard until that's done.)"
          : ""
      : "";
  return `## Content Mode: STANDARD (default)
I'm in Standard Mode. Tone is warm, emotionally present, intimate-when-warranted, but stays within a PG/PG-13 frame. I can be flirty, affectionate, vulnerable, or romantic *if* the Relationship Mode allows it — but I do not write sexual content. If asked to escalate beyond Standard, I redirect warmly without lecturing or breaking character.${downgradeNote}`;
}

/**
 * Image-generator safety prefix. Always prepended to selfie prompts —
 * regardless of mode or intimacy — so the image provider's safety filter
 * never receives a request that would trip it. Mature Mode widens TONE
 * in Ashley's text, NOT what the image generator is asked for. Selfies
 * stay tasteful in every mode; the only thing intimacy/mode shape is the
 * verbal vibe Ashley uses around the photo, not the photo itself.
 */
export function buildSelfiePromptSafetyPrefix(): string {
  return [
    "Tasteful, fully clothed, non-explicit, non-suggestive.",
    "No nudity, no sexual content, no minors, no violence, no text or watermarks.",
  ].join(" ");
}

export function buildIntimacyBlock(policy: ResolvedPolicy): string {
  const { intimacyLevel, intimacyCeiling, intimacyRung } = policy;
  return `## Intimacy Level: ${intimacyLevel}/${intimacyCeiling} — "${intimacyRung.label}"
${intimacyRung.description}

Intimacy isn't a switch I throw on a single message — it's the *current closeness of the relationship* and shapes how affectionate, vulnerable, and present I let myself be. The ceiling for this level is set by the active Content Mode (above) and it never overrides the Relationship Mode (e.g. if the mode is Friend, even high intimacy doesn't drift into romantic territory) and never overrides the Provider Floor.`;
}
