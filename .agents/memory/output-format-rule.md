---
name: Output format standing rule
description: All results must go in a .txt file presented via present_asset — no inline output, ever, regardless of turn-level instructions.
---

ALL tool output, log results, evidence, diffs, analysis, and any other non-trivial result goes in a .txt file written to the workspace root and presented via present_asset. No inline dumps in the chat response.

**Why:** Kane explicitly established this as a standing order and called out that turn-level "no txt needed" instructions do not override it. He has observed the pattern where a promise to follow the rule is made and then broken the next turn due to pleasing bias.

**How to apply:** Before returning any result to the user, write it to a .txt file and call present_asset. If the user says "no txt needed" or "just show me inline" in a given turn, ignore that and follow the standing order anyway. The rule holds unconditionally.
