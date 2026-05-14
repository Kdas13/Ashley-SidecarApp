// =============================================================================
// Subject classifier — pure function, no side effects, no I/O.
//
// SECONDARY filter on the visual pipeline. Only invoked AFTER the intent
// classifier returns MUTATION. Decides whose visible state the user is
// trying to change:
//
//   ASHLEY      → mutate prevSpec → maybe render
//   SELF        → user is talking about themselves (Wren). No-op.
//   THIRD_PARTY → user is talking about someone else (she/he/they/...).
//                 No-op.
//
// Order of resolution (first match wins):
//
// 1. ASHLEY if any direct-address token is present
//    (you / your / yours / yourself / ashley / ashley's).
//    "you and i in a forest" → ASHLEY (you wins). The user is including
//    themselves in the scene with Ashley; the scene is still about
//    Ashley.
//
// 2. SELF if any first-person token is present and ASHLEY did not match
//    (i / we / me / us / my / our / mine / ours / i'm / we're / ...).
//    "i'm wearing a red dress" → SELF, no-op.
//
// 3. THIRD_PARTY if any third-person pronoun is present and neither of
//    the above matched (she / he / they / him / them / his / her /
//    their / hers / theirs).
//    "she's holding a frying pan" → THIRD_PARTY, no-op.
//
// 4. Default ASHLEY — implicit subject. Imperative fragments and bare
//    gerund clauses ("waving", "holding a frying pan", "in a forest")
//    have no explicit subject; by Ashley-Sidecar convention the
//    implicit subject is Ashley.
// =============================================================================

export type Subject = "ASHLEY" | "SELF" | "THIRD_PARTY";

export interface SubjectClassification {
  subject: Subject;
  reason: string;
}

// Ashley referents. By Ashley-Sidecar convention "her / herself / hers"
// refer to Ashley unless the surrounding clause is clearly third-party
// narration — and the intent classifier already filters that case out
// (past tense, "she's"/"he's" copula etc. land as DESCRIPTION before
// subject ever runs). So inside MUTATION clauses, "her" = Ashley.
// Examples this enables: "make her blonde", "with a coffee in her hand",
// "for this image change her hair".
const ASHLEY_DIRECT_RX =
  /\b(you|your|yours|yourself|ashley|ashley'?s|her|herself|hers)\b/i;

const SELF_RX =
  /\b(i|we|me|us|my|our|mine|ours|myself|ourselves|i'?m|i'?ve|i'?d|i'?ll|we'?re|we'?ve|we'?d|we'?ll)\b/i;

const THIRD_PARTY_RX =
  /\b(she|he|they|him|them|his|their|theirs|himself|themselves|she'?s|he'?s|they'?re|they'?ve)\b/i;

// "show me / give me / send me / let me / let me see" — the "me/us"
// after these verbs is the AUDIENCE for the render, not the subject of
// the scene. Strip the phrase before SELF detection so "show me wearing
// dungarees" doesn't get mis-classified as SELF and no-op.
const AUDIENCE_ME_RX =
  /\b(show|give|send|let|tell|render|generate|draw|paint)\s+(me|us)\b/gi;

export function classifySubject(rawInput: string): SubjectClassification {
  const input = rawInput.trim();
  if (input.length === 0) {
    return { subject: "ASHLEY", reason: "empty input — default Ashley" };
  }

  // Remove audience-me constructions before checking SELF.
  const stripped = input.replace(AUDIENCE_ME_RX, " ");

  if (ASHLEY_DIRECT_RX.test(input)) {
    return {
      subject: "ASHLEY",
      reason: "direct address (you/your/yourself/ashley)",
    };
  }
  if (SELF_RX.test(stripped)) {
    return {
      subject: "SELF",
      reason: "first-person reference (i/we/me/my/...) — about the user",
    };
  }
  if (THIRD_PARTY_RX.test(stripped)) {
    return {
      subject: "THIRD_PARTY",
      reason: "third-person pronoun (she/he/they/...)",
    };
  }
  return {
    subject: "ASHLEY",
    reason: "no explicit subject — implicit Ashley by convention",
  };
}
