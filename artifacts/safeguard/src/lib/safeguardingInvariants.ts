/**
 * Mirror of artifacts/safeguard-api/src/lib/safeguardingInvariants.ts.
 * Both copies must stay byte-equivalent for the rules to mean the same
 * thing on both sides of the boundary. If you change one, change both.
 */

export type InvariantId =
  | "human_authority"
  | "communication_clarity"
  | "transparency"
  | "safeguarding_support"
  | "emotional_boundary"
  | "pilot_scope";

export interface Invariant {
  id: InvariantId;
  title: string;
  rule: string;
  rationale: string;
}

export const SAFEGUARDING_INVARIANTS: readonly Invariant[] = [
  {
    id: "human_authority",
    title: "Humans hold clinical authority",
    rule:
      "Safeguard never gives medical advice, diagnoses, treatment plans, " +
      "medication changes, or triage decisions. It records, organises and " +
      "translates so a clinician (the user's GP or named professional) can " +
      "decide.",
    rationale:
      "The user is a refugee navigating an unfamiliar healthcare system. " +
      "Authority must remain with the human clinician they are continuous with.",
  },
  {
    id: "communication_clarity",
    title: "Plain language, in the user's language",
    rule:
      "Every user-facing surface ships in the user's chosen language with " +
      "plain wording (UK reading age ~9). When a translation is auto-generated " +
      "it is labelled as such and the original is preserved verbatim.",
    rationale:
      "Trauma + unfamiliar terminology compound risk. Clarity is a safeguard.",
  },
  {
    id: "transparency",
    title: "Show what is recorded and why",
    rule:
      "Anything Safeguard stores about the user is viewable by the user, with " +
      "a one-line reason. AI-generated summaries are clearly labelled and the " +
      "raw source check-in is always available alongside.",
    rationale:
      "Refugee users have well-founded reasons to distrust opaque records. " +
      "Transparency builds the consent the system depends on.",
  },
  {
    id: "safeguarding_support",
    title: "Warm escalation path is always one tap away",
    rule:
      "Every screen exposes a 'I need help now' control that surfaces " +
      "non-clinical safeguarding support information (UK GP, NHS 111, " +
      "Samaritans, Refugee Council). Safeguard does not call services on the " +
      "user's behalf; it shows the number and explains what to expect.",
    rationale:
      "Safeguarding is about reducing distance to a real human, not adding " +
      "another layer of automation.",
  },
  {
    id: "emotional_boundary",
    title: "Companion, not friend",
    rule:
      "Safeguard's voice is calm, observational and clinical-adjacent. It " +
      "does not flatter, simulate intimacy, use pet names, or claim to " +
      "remember a personal relationship. It refers to itself as 'the app' " +
      "or 'Safeguard' — never as 'I' in a personal sense.",
    rationale:
      "Companionship-style AI patterns are inappropriate here and would " +
      "compromise the clinical trust the user needs to extend.",
  },
  {
    id: "pilot_scope",
    title: "Pilot scope is honest",
    rule:
      "Safeguard is a pilot, not a service. The first screen and the export " +
      "footer both state: not affiliated with the NHS, not a clinical record " +
      "system, no data shared without explicit user action.",
    rationale:
      "Mis-attribution to the NHS would be both a safeguarding risk and a " +
      "regulatory one. Honesty about scope is non-negotiable.",
  },
] as const;
