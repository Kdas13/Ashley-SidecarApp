import { describe, expect, it } from "vitest";
import { classifySubject } from "../subjectClassifier.js";

// =============================================================================
// Subject classifier tests — Wren spec May 2026.
//
// Only invoked AFTER intent === MUTATION. Decides whose state changes.
// =============================================================================

describe("classifySubject — ASHLEY cases", () => {
  const inputs: string[] = [
    "you in a red dress",
    "your hair ginger",
    "yourself waving",
    "ashley holding a frying pan",
    "ashley's hair ginger",
    "you waving at me",
    "show me you smiling",
    "imagine you in a forest",
    "picture you waving",
    // Mixed with first-person — Ashley still wins (the scene is about her).
    "you and i in a forest",
    "me and you on a beach",
    // Implicit subject — defaults to Ashley.
    "waving",
    "holding a frying pan",
    "blonde hair",
    "in a forest",
    "red dress",
    "now peace sign",
    "wearing an Amish hat",
    "sitting on a car bonnet",
  ];
  for (const input of inputs) {
    it(`ASHLEY: "${input}"`, () => {
      const result = classifySubject(input);
      expect(
        result.subject,
        `"${input}" should be ASHLEY. reason="${result.reason}"`,
      ).toBe("ASHLEY");
    });
  }
});

describe("classifySubject — SELF cases", () => {
  const inputs: string[] = [
    "i'm wearing a red dress",
    "i am holding a frying pan",
    "we are dancing in the kitchen",
    "my hair is ginger",
    "our garden",
    "me on a beach",
    "i'm in a forest",
  ];
  for (const input of inputs) {
    it(`SELF: "${input}"`, () => {
      const result = classifySubject(input);
      expect(
        result.subject,
        `"${input}" should be SELF. reason="${result.reason}"`,
      ).toBe("SELF");
    });
  }
});

describe("classifySubject — THIRD_PARTY cases", () => {
  const inputs: string[] = [
    "she's holding a frying pan",
    "he is waving",
    "they are dancing",
    "him in a red dress",
    "them on a beach",
    "his hair is ginger",
    "their garden",
    "she is wearing an Amish hat",
  ];
  for (const input of inputs) {
    it(`THIRD_PARTY: "${input}"`, () => {
      const result = classifySubject(input);
      expect(
        result.subject,
        `"${input}" should be THIRD_PARTY. reason="${result.reason}"`,
      ).toBe("THIRD_PARTY");
    });
  }
});
