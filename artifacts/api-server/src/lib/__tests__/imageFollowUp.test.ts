import { describe, expect, it } from "vitest";
import { resolveImageFollowUp } from "../imageFollowUp.js";

// Architect-review fix May 2026: under the new state-based intent pipeline,
// "follow-up phrased" mutations addressed at Ashley (e.g. "make your hair
// ginger", "change the background", "different outfit", "add a car") MUST
// resolve to image generation even when no prior image attempt exists. The
// pre-fix resolver dead-ended these turns into the LLM and produced phantom
// prose. These tests lock the empty-history case down.

const EMPTY_HISTORY: Parameters<typeof resolveImageFollowUp>[1] = [];

describe("resolveImageFollowUp — empty history, follow-up-phrased mutation", () => {
  const cases = [
    "make your hair ginger",
    "make your hair blonde",
    "change the background",
    "different outfit",
    "add a car",
    "now wearing dungarees",
  ];

  it.each(cases)(
    "'%s' (no prior attempt) resolves to an image, not LLM fall-through",
    (latestUserText) => {
      const result = resolveImageFollowUp(latestUserText, EMPTY_HISTORY);
      expect(
        result,
        `"${latestUserText}" must resolve to an image action`,
      ).not.toBeNull();
      expect(result!.suggestedMode).toBeTruthy();
      expect(result!.kind).toBe("direct_image_request");
    },
  );
});

describe("resolveImageFollowUp — empty history, narration stays no-op", () => {
  // Negative controls: SELF / DESCRIPTION / past tense must NOT route to
  // image generation on a cold session.
  it.each([
    "i love this dress",
    "she was wearing a hat yesterday",
    "what colour is your hair",
  ])("'%s' returns null (no image action)", (latestUserText) => {
    const result = resolveImageFollowUp(latestUserText, EMPTY_HISTORY);
    expect(result).toBeNull();
  });
});
