import { describe, expect, it } from "vitest";
import { classifyIntent } from "../intentClassifier.js";

// =============================================================================
// Intent classifier tests — Wren spec May 2026.
//
// MUTATION inputs MUST classify as MUTATION.
// DESCRIPTION inputs MUST classify as DESCRIPTION.
// Default for ambiguous: DESCRIPTION (under-render is safer).
// =============================================================================

describe("classifyIntent — MUTATION cases", () => {
  const mutations: string[] = [
    // Bare gerund / present participle
    "waving",
    "holding a frying pan",
    "sitting on a car bonnet",
    "standing in a forest",
    "kneeling on the grass",
    "smiling",
    "pointing at the camera",
    "holding a frying pan doing a peace sign",

    // Verbless fragments
    "blonde hair",
    "in a forest",
    "red dress",
    "on a beach",
    "with ginger hair",
    "an Amish hat",

    // Follow-up cues
    "now peace sign",
    "same but ginger hair",
    "but with a red dress",
    "make it blonde",
    "change it to a forest",
    "wearing an Amish hat",
    "with a frying pan",
    "in a red dress",

    // Explicit imperatives
    "make your hair ginger",
    "show me you waving",
    "give me a peace sign",
    "wear a red dress",
    "hold a frying pan",
    "put on an Amish hat",
    "take off the hat",
    "add a frying pan",
    "remove the hat",
    "change your hair to ginger",
    "swap the dress for a forest dress",
    "render you in a red dress",
    "draw you waving",

    // Render-framing verbs
    "imagine you in a red dress",
    "picture you waving",
    "visualise you on a beach",
    "envision you holding a frying pan",
    "imagine a red dress",
    "picture standing on a beach",

    // Casual asks with trailing `?` — question mark does NOT win when
    // the clause also has imperative/show-me/imagine framing. Wren
    // writes asks like this all the time.
    "show me sitting on the bonnet?",
    "how about you on a beach?",
    "make it ginger?",
    "imagine you waving?",
  ];

  for (const input of mutations) {
    it(`MUTATION: "${input}"`, () => {
      const result = classifyIntent(input);
      expect(
        result.intent,
        `"${input}" should be MUTATION. reason="${result.reason}"`,
      ).toBe("MUTATION");
    });
  }
});

describe("classifyIntent — DESCRIPTION cases", () => {
  const descriptions: string[] = [
    // Past tense / past progressive
    "you were smiling at me earlier",
    "i was waving him off",
    "she was holding a frying pan",
    "they were dancing in the kitchen",
    "we were sitting on the bonnet",
    "he was pointing the whole time",
    "you had been smiling all day",
    "i had coffee with you",

    // Present perfect
    "you have been quiet lately",
    "she has been waving for ages",

    // Past time markers
    "yesterday you wore a red dress",
    "earlier you were waving",
    "the other day you sat on a bonnet",
    "last night we were dancing",
    "moments ago you smiled",
    "five minutes ago you were holding it",

    // Question forms
    "are you waving?",
    "were you waving at the dog?",
    "do you like the red dress?",
    "is that a frying pan?",
    "have you seen this before?",

    // Copula + attribute
    "you look happy",
    "you seem tired",
    "you are beautiful",
    "you're so cute",
    "you look gorgeous",
    "you sound annoyed",
    "ashley looks tired",
    "you feel sad",

    // Combined narration
    "i had a coffee with you, were you waving at the dog?",
    "she's just smiling at me",
    "you were smiling at me earlier",
    "imagine yesterday you were waving",

    // Bare conversation
    "thanks",
    "i love you",
    "ok cool",
  ];

  for (const input of descriptions) {
    it(`DESCRIPTION: "${input}"`, () => {
      const result = classifyIntent(input);
      expect(
        result.intent,
        `"${input}" should be DESCRIPTION. reason="${result.reason}"`,
      ).toBe("DESCRIPTION");
    });
  }
});

describe("classifyIntent — render-framing override does NOT bypass past tense", () => {
  it("'imagine yesterday you were waving' stays DESCRIPTION (recall wins)", () => {
    const result = classifyIntent("imagine yesterday you were waving");
    expect(result.intent).toBe("DESCRIPTION");
  });
  it("'picture you smiling earlier' stays DESCRIPTION (time marker wins)", () => {
    const result = classifyIntent("picture you smiling earlier");
    expect(result.intent).toBe("DESCRIPTION");
  });
});
