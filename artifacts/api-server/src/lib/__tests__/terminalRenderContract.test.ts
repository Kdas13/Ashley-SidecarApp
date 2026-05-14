// Wren May 2026 terminal-render contract — Wren's 7 acceptance cases.
//
// The contract: if intent === MUTATION AND subject === ASHLEY AND
// diffNonEmpty(prevSpec, nextSpec) then renderImage() must be called and
// the LLM narration branch MUST NOT execute. These tests pin the gate
// logic that enforces it (extractVisualSpec → resolveImageFollowUp →
// synthesizeImageActionReply must produce a non-null marker).

import { describe, expect, it } from "vitest";
import { classifyIntent } from "../intentClassifier";
import { classifySubject } from "../subjectClassifier";
import {
  diffNonEmpty,
  extractVisualSpec,
  makeEmptySpec,
} from "../visualSpec";
import {
  resolveImageFollowUp,
  synthesizeImageActionReply,
} from "../imageFollowUp";

function expectsTerminalRender(input: string, history: Parameters<typeof resolveImageFollowUp>[1] = []) {
  const intent = classifyIntent(input);
  expect(intent.intent, `intent for "${input}"`).toBe("MUTATION");
  const subject = classifySubject(input);
  expect(subject.subject, `subject for "${input}"`).toBe("ASHLEY");
  const next = extractVisualSpec(input);
  expect(next.imageIntent, `imageIntent for "${input}"`).toBe(true);
  expect(diffNonEmpty(makeEmptySpec(), next), `diffNonEmpty for "${input}"`).toBe(true);
  const resolution = resolveImageFollowUp(input, history);
  expect(resolution, `resolveImageFollowUp for "${input}"`).not.toBeNull();
  const synth = synthesizeImageActionReply(resolution!);
  expect(synth, `synthesizeImageActionReply for "${input}"`).not.toBeNull();
  return { synth: synth!, resolution: resolution! };
}

function expectsLLMFallback(input: string) {
  const intent = classifyIntent(input);
  expect(intent.intent, `intent for "${input}"`).toBe("DESCRIPTION");
  const next = extractVisualSpec(input);
  expect(next.imageIntent, `imageIntent for "${input}"`).toBe(false);
}

describe("terminal-render contract (Wren May 2026)", () => {
  it("[1] holding a frying pan doing a peace sign → terminal render", () => {
    expectsTerminalRender("holding a frying pan doing a peace sign");
  });

  it("[2] playing Connect Four with a friend whilst balancing cheese on your head → terminal render", () => {
    // Question form: also covered.
    expectsTerminalRender(
      "playing Connect Four with a friend whilst balancing cheese on your head",
    );
    expectsTerminalRender(
      "playing Connect Four with a friend whilst balancing cheese on your head?",
    );
  });

  it("[3] same but ginger hair → terminal render (follow-up cue)", () => {
    const history = [
      {
        role: "user" as const,
        content: "you in a red dress on a beach",
        selfieVibe: null,
        imageUrl: null,
      },
      {
        role: "ashley" as const,
        content: "Selfie incoming.\n\n[image: SCENE_MODE | red dress on a beach]",
        selfieVibe: "SCENE_MODE | red dress on a beach",
        imageUrl: "https://example/x.png",
      },
    ];
    expectsTerminalRender("same but ginger hair", history);
  });

  it('[4] "I had a coffee with you, were you waving at the dog?" → DESCRIPTION, no render', () => {
    expectsLLMFallback("I had a coffee with you, were you waving at the dog?");
  });

  it('[5] "you look happy" → DESCRIPTION, no render', () => {
    expectsLLMFallback("you look happy");
  });

  it("[6] red dress → terminal render (verbless visual fragment)", () => {
    expectsTerminalRender("red dress");
  });

  it("[7] imagine you in a red dress → terminal render (imagine-framing)", () => {
    expectsTerminalRender("imagine you in a red dress");
  });
});

describe("diffNonEmpty (cold-start vs follow-up)", () => {
  it("cold-start with any visible delta is non-empty", () => {
    const next = extractVisualSpec("red dress");
    expect(diffNonEmpty(null, next)).toBe(true);
    expect(diffNonEmpty(makeEmptySpec(), next)).toBe(true);
  });

  it("identical raw text + empty deltas is empty", () => {
    const a = makeEmptySpec("hello");
    const b = makeEmptySpec("hello");
    expect(diffNonEmpty(a, b)).toBe(false);
  });

  it("rawUserText change alone (with content) is non-empty", () => {
    const prev = makeEmptySpec("");
    const next = makeEmptySpec("playing connect four with cheese on your head");
    expect(diffNonEmpty(prev, next)).toBe(true);
  });
});
