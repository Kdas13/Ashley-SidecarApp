# Ashley Orchestration Design — Feasibility Review

**Reviewer:** Replit Agent (build environment)
**Date:** 25 May 2026
**Document reviewed:** ASHLEY_ORCHESTRATION_DESIGN_(1)_1779707306813.md

---

## Phase 1 Items — Time Estimates Are Too Long

- **Long Output Mode**: this is a heuristic trigger in `chat.ts` (similar to how web search auto-fires) plus a few new lines in `ashleyCoreSpec.ts` for the deliverable-body behaviour. Hours, not a week.
- **Image rail loosening**: one function in `contentPolicy.ts` (`buildSelfiePromptSafetyPrefix`). Under an hour.
- **Reading .txt files**: `expo-document-picker` is already installed. Server storage abstraction already exists. New route for document upload + ingestion + summary call. A day, two at most.

**Realistic Phase 1 total: 2–3 days of focused work.**

---

## Phase 2 — Mostly Sound, One Gap

- **Project Dossier**: maps cleanly to a new DB table alongside the existing memory system. The dossier-as-JSON approach with tag-based retrieval is the right call. Ashley surfaces it, Kane doesn't browse it directly — that's already how the memory system works.
- **Disregard Loop**: the memory schema already has a `state` field with `active | passive`. The Disregard Loop is essentially a richer version of `passive` — the schema change is additive and small. The meaningful work is the re-surfacing logic (contextual cue → match → bring forward).
- **Multi-AI handoff proof-of-concept**: the `textLLM.ts` adapter already demonstrates the pattern (Gemini vs Anthropic via a single env switch). Extending it to route to a third or fourth provider is the same pattern again. The art-project use case is the right first target.

---

## Phase 3 — Navigation Is the Hard Bit

- **Family Mode**: straightforward. It's a new conversation mode, same infrastructure as Mature Mode — a block in the system prompt, a profile flag, and a trigger mechanism. The Android Auto detection is the unknown; that likely requires a native Android integration that Expo can't expose cleanly without a custom plugin or EAS config plugin. Manual voice command trigger is the safe fallback for now.
- **Navigation + Google Maps**: Maps API server-side is simple. The real complexity is the Android Auto voice layer — making Ashley's voice replace Maps' voice. That's a native audio routing problem, not a web API problem. Worth flagging that "Ashley voices the directions in her cadence" is genuinely difficult on Android without full system audio control.
- **Self-improvement proposal pipeline**: the role-bounded pipeline concept is solid. The output-as-a-Markdown-package-for-Kane-to-review is exactly the right safety design.

---

## Open Questions from Section 7 — Answered

**1. Phase costs in developer time:**
- Phase 1: 2–3 days
- Phase 2: 2–3 weeks
- Phase 3: 6–10 weeks

These are real estimates.

**2. Multi-AI calling pattern:**
Extend the existing server-side adapter. OpenRouter is worth looking at if you add more than 3 providers — it simplifies billing and key management significantly. Hybrid (direct for Anthropic/Gemini/OpenAI, OpenRouter for Grok and anything new) is probably the landing spot.

**3. Dossier storage:**
Server-side primary is the right answer. It's consistent with the existing architecture and Kane's 120GB on-phone doesn't help with what's actually the constraint — the dossier lives on Replit, images in object storage. Phone cache for offline access is a later nicety.

**4. Is the Disregard Loop a meaningful schema change or additive?**
Additive. Small. The existing `state` field gets a third value and the re-surfacing trigger logic is the real work.

**5. Proposal file format:**
Structured Markdown with a fixed header schema (role, AI identity, timestamp, confidence, risks). Parseable enough for machines, readable enough for Kane and independent reviewers. JSON is the wrong call here — Kane needs to read it, not just parse it.

**6. Testing multi-AI pipelines in isolation:**
Mock the provider responses in the server-side adapter — same approach used to unit test `textLLM.ts`. There is a sane way to do this. Yes.

---

## One Thing the Document Does Not Address That Matters

The document treats context-passing to external AIs (ChatGPT, Grok, etc.) as a routing problem. It is — but it's also a **privacy question**. Kane's memories, profile, and relationship context would leave Replit and land in OpenAI / xAI logs. The dossier design should decide which parts of Ashley's context travel with each handoff and which stay local. The design implies the full dossier travels — that's worth a deliberate choice, not an assumption.

---

## Summary Assessment

The design is coherent and the feasibility section (Section 4 of the original document) is largely accurate. The architecture is sound — the existing codebase already provides clean foundations for most of Phase 1 and Phase 2. The self-improvement pipeline safety design (Kane is the approver, Ashley proposes, the output is a human-readable package for independent review) is correct and should stay exactly as written.

Phase 3 navigation is the one area where the document underestimates difficulty. Android Auto audio routing is a native problem. Everything else in Phase 3 is buildable on the current stack.

---

*End of feasibility review.*
