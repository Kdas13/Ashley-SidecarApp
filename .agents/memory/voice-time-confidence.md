---
name: Voice time context confidence issue
description: Gemini sometimes answers time/date from training intuition before reading the injected time context block in voice calls.
---

Ashley occasionally leads with a training-data guess on time/date questions before checking the injected `## Time context` block. When corrected she immediately uses the correct value — so the block is being read, just not prioritised.

**Why:** Gemini Flash has strong training-data priors on time/date and may answer from those before attending to injected context, especially when the instruction is phrased as a preference ("use this as ground truth") rather than an absolute prohibition.

**How to apply:** The time context block wording needs an explicit hard prohibition: "NEVER answer time or date questions from memory or training data — ALWAYS use the time context block above." Applies to `buildVoiceTimeContext()` in `VoiceContextAssembler.ts` and the time context prepend in `chat.ts`. The location block in `ashleyCoreSpec.ts` (`kaneLocationBlock`) does not need this — location is static and Ashley has no training-data prior to override.
