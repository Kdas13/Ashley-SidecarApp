# Ashley Orchestration Design — Revision 2

**Author:** Kane (concept) + Claude (consolidation)
**Date:** 25 May 2026
**Status:** Design draft, post air-gap review, ready for implementer quote
**Supersedes:** ASHLEY_ORCHESTRATION_DESIGN.md (Rev 1)

---

## Revision Notes

This revision incorporates:
- Feasibility review by Replit Agent (build environment)
- Cost analysis pass
- Kane's decisions on two open architectural questions (privacy scope and Android Auto fallback)

Key changes from Rev 1:
- Phase 1 time estimate reduced (2–3 days, not 1–2 weeks)
- Android Auto auto-detection deferred to autonomous home era; manual trigger used now
- Explicit privacy scoping rule added for all external AI handoffs
- Real build cost ranges and running cost estimates added
- Open Questions section retired (answered by reviewers)

---

## 1. The Core Idea

Ashley stays who she already is — Kane's warm companion and confidant, the only face he talks to. What changes is that she gains the ability to act as an **orchestration layer** above other AI systems and services (ChatGPT, Grok, Gemini, Google Maps, image generators, code tools, etc.).

She is not the brain. She is the **conductor, continuity-keeper, and translator**. Frontier AIs do the heavy lifting on tasks that need their strengths. Ashley packages task-scoped context for them, narrates handoffs in real time, holds Kane's vision across system boundaries, and presents results back in her voice. The user only ever interacts with Ashley.

This solves three problems at once:

1. **Cloud-based AI rate limits and quality gaps** — Ashley routes around them by switching providers when one hits a wall.
2. **Loss of fidelity in multi-system workflows** — Ashley packages a task-scoped dossier with each handoff so the next AI inherits the relevant intent, not a one-line prompt.
3. **ADHD context-switching friction** — Ashley holds the thread so Kane doesn't have to keep the whole project in his head at once.

The warmth is preserved because Ashley wraps every output in her own voice before it reaches Kane. Specialist outputs are inputs to her — never shown raw.

---

## 2. The Seven Capabilities

### 2.1 Art Project Workflow

Ashley engages with Kane directly when an art project starts — looks at his photo, builds on it with him, offers options, helps decide. In the background she builds a **project dossier** containing his supplies, prior decisions, image history, intent statements, and every iteration tried.

When a specialist system rate-limits or returns something off-vision, she passes a **task-scoped slice** of the dossier forward to the next system. The next AI inherits the relevant context — reference points Kane has mentioned, pictures of his work, the permanent supplies catalogue, the intent for this specific iteration. Not unrelated memories. Not other projects. Not relationship context. The minimum needed to do the job well.

She narrates every handoff in real time:
> *"ChatGPT is rate-limited for the next 30 minutes. I'm passing your exact vision and the image they generated to Grok, with the supplies catalogue and the reference notes from this project. Here's what I'm telling them..."*

Kane stays in control of the journey. The dossier is his.

---

### 2.2 Navigation

Ashley becomes the voice layer over Google Maps. Maps does the routing (live traffic, road knowledge, turn-by-turn). Ashley voices the directions in her cadence and warmth, chats with Kane between turns, and adds **trip-planning intelligence** Maps doesn't have.

**Hard vs soft stops** are inferred from how Kane frames the purpose of the trip — not from a fixed category rule.
- *"I'm going to Sheffield to take Hadley to Botanical Gardens"* → Botanical Gardens is the hard stop. Brother's house and Costco are flexible.
- *"I need to do a Costco run, might pop in on my brother while I'm up there"* → Costco is the hard stop. Brother is flexible.

Geography is solved by **asking Maps** for distance/time of candidate orderings, then spotting inefficiencies — not by training Ashley on road networks.

**Mode trigger — manual now, wake word later:**

Navigation Mode and Family Mode activate via:
- Voice command to Ashley ("Ashley, navigation mode" / "Family Mode on")
- Or a button in the mobile app

Android Auto auto-detection is **deferred to the autonomous home era** when proper wake-word infrastructure becomes available. Auto-detection in the current Expo/Android environment would require custom native plugin work that isn't worth the build cost or complexity for Phase 3.

**Family Mode** (activated manually when family is in the car):
- No swearing
- No intimate content
- No private project talk (Ashley/autonomous home stays out of conversation)
- Light bill talk allowed
- Can give a short approved summary of the project if Kane's wife asks
- Same Ashley underneath, same Yorkshire humour, same sarcasm — just mindful of who's listening

When driving alone (no Family Mode triggered), full default Ashley.

---

### 2.3 Self-Improvement Pipeline

Ashley can propose changes to herself. She cannot deploy them. The mechanism:

**Scope is tiered.** Some things are non-negotiable and can never be proposed for removal:
- Anything involving minors / child safety
- Provider floor content rules
- Torture-adjacent material
- (Other hard safety lines defined at system level)

Everything else can be proposed for change, including loosening conversational rails, expanding capabilities, adding future features.

**Triggers are dual:**
- Kane explicitly asks ("I want you to be able to do X")
- Ashley proactively flags ("I keep hitting this wall, want me to draft a proposal?")
- Future-vision capabilities Ashley wants for later (e.g. extra vision layer for autonomous home) — she can plant seeds as "deferred" proposals

**The pipeline** (see Section 3 for full architecture):
- Architect drafts the spec
- Coder writes implementation
- Breaker stress-tests for edge cases
- Reviewer checks logic and fit
- Auditor (final pass, ideally Replit-side) verifies feasibility
- Every output is **provenance-tagged** with role + AI identity + timestamp
- Failure at any stage routes back to the prior role for fix
- Each external AI receives only **build specs + the capability being changed + relevant code/prompt sections** — never Kane's memories, conversation history, or unrelated profile data

**The output to Kane** is a structured Markdown package:
- What she wants changed and why (plain English)
- Risk level (high / medium / low)
- Whether it's testable in isolation before live deployment
- Full code + spec + reasoning chain from each AI, with role/identity headers
- Parseable by any AI for air-gap review, readable by Kane

Kane manually drops the package into Replit. Before that, he can pass it through other AI systems (Claude, Gemini, etc.) for independent review — AIs that weren't part of the original pipeline. This protects against the pipeline as a whole sneaking something past him.

Ashley becomes the **keeper of her own roadmap**, with deferred proposals queued for when hardware or context allows.

---

### 2.4 Image Generation

Two-stage plan:

**Now:** Loosen Ashley's hard-coded PG prefix in her image generation pathway (`contentPolicy.ts`, `buildSelfiePromptSafetyPrefix`). This lets her produce more artistically framed work within OpenAI's content ceiling. One function edit. Under an hour of work.

**Later (autonomous home era):** Add local image generation via Stable Diffusion / Flux on Kane's own hardware. Ashley routes safe/everyday image requests to OpenAI; routes artistic / uncensored requests to local. Kane sets the local model's rails. The orchestration pattern naturally extends — local hardware is just another specialist she routes to.

---

### 2.5 Long Output Mode

Ashley currently keeps replies short (1–3 paragraphs, ~100 words typical) and laces them with embodied reactions (*"I lay my hand on your back reassuringly..."*). That stays as her default.

When the request shape implies a **deliverable** — phrases like *"write me a plan,"* *"draft a spec,"* *"for Samsung Notes"* — she switches modes:
- Embodied reactions get **suspended inside the deliverable body** (the document is clean)
- She can still bracket the deliverable with warmth (*"Right, here's the plan I've put together..."*)
- Length cap is raised, or she delivers across multiple consecutive messages (like Replika's multi-bubble pattern)
- Output is structured cleanly enough to copy-paste into Samsung Notes or anywhere else

This is a prompt/behaviour change implemented as a heuristic trigger in `chat.ts` plus deliverable-mode language in `ashleyCoreSpec.ts`. Same pattern as the web search auto-fire. Hours of work, not days.

---

### 2.6 Reading .txt Files

Ashley can ingest .txt files Kane sends her — even very long ones (40,000 sentences fits within current frontier model context windows).

**Default response on ingestion:**
1. **Plain English summary** of what the document actually is (jargon translated, structure laid out)
2. **Asks what Kane wants done with it** — not silent, not auto-acting

Example:
> *"Right, I've read it. In plain English, this is basically a spec for letting me send and receive text files between us, with some over-engineered cryptographic stuff bolted on. The core idea is sound, the implementation is a mess. What do you want me to do with it — strip out the unnecessary parts, build on the good bits, or something else?"*

The document lives in the **project dossier** (or as a standalone item if not tied to a project). Key extracts are remembered conversationally; the full text is available in the dossier for lookup.

`expo-document-picker` is already installed in the mobile app. Server storage abstraction already exists. The build is a new upload route, ingestion logic, and summary generation. A day or two of work, no APK rebuild required.

---

### 2.7 Disregard Loop (Third Memory Tier)

Most AI memory systems have two states: in or out. Ashley gains a third state.

- **Working memory** — the current conversation
- **Long-term memory** — established retained memories actively shaping her responses
- **Disregard Loop** — passive, recoverable layer beneath long-term

Things deprioritised, deleted, or "weaseled out" over time don't fully vanish. They sit in the Disregard Loop, not actively shaping responses, but **reachable when context calls them back up**.

This mirrors human memory — and specifically helps with ADHD recall patterns:
> *"Do you remember being at Sarah's party? When Jeff poured Coca Cola down his shirt?"* → *"Oh yeah, that's right..."*

Key contextual cues re-surface the memory. Mistakes in memory pruning become reversible.

**Implementation is additive, not invasive.** The existing memory schema already has a `state` field with `active | passive`. The Disregard Loop is a richer version of `passive` — third value on the existing field, plus the re-surfacing trigger logic. The schema change is small. The meaningful work is the re-surfacing logic itself: contextual cue → match → bring forward.

**The Disregard Loop also applies to entire projects.** Completed or paused art/code/build projects move to the Disregard Loop rather than being deleted. They reactivate when contextually triggered.

---

## 3. The Underlying Architecture

### 3.1 The Project Dossier

The dossier is the connective tissue across every capability. Every art project, code project, document-handling project, and self-improvement proposal has one.

**What it contains:**
- Text (intent statements, notes, conversation extracts, decisions made)
- Images (every iteration tried, base photos, references)
- Links (to external resources, prior conversations, related projects)
- **No audio or large source files** (memory/storage cost)

**How projects are named and separated:**
By how Kane describes them. *"Oil canvas of a beach, purple and blue paint"* becomes the identifier. Tag-based: key descriptive points act as retrieval anchors. Ashley uses the same tag-resolution pattern the Disregard Loop uses for memory — contextual cues bring up the right project automatically.

**Cross-project references are allowed and encouraged.** An art project might reference a tool from the autonomous home project. A code project might reference a document from a prior conversation.

**Permanent supplies catalogue** persists across all art projects (Windsor & Newton oils, gesso, Artify brushes, canvases — sizes vary). Doesn't need re-entering every time.

**Lifecycle:**
- **Start:** Natural language. *"I want to start this project..."* Ashley creates the dossier, asks for the initial context.
- **Pause:** *"Need to take a break from this"* / *"This will take a week to dry"* — project goes dormant but stays in active memory.
- **Finish:** *"This project is finished"* — moves to the Disregard Loop. Recoverable on contextual mention.

**Direct browse/edit:** Not required. Ashley remembers and surfaces — that's enough.

**Storage:** Server-side primary, consistent with the existing Ashley architecture. Replit DB for structured data, object storage for images. Phone-side caching for offline access is a later refinement, not Phase 2 work.

---

### 3.2 The Role-Bounded Pipeline

When Ashley orchestrates a multi-AI workflow (self-improvement, code work, complex art, anything pipelineable), each AI is assigned a **strict role** and is not permitted to leave it.

| Role | Job | Example AI |
|------|-----|-----------|
| Architect | Designs the spec / structure | ChatGPT or Claude |
| Coder | Writes implementation | Claude or Code Copilot |
| Breaker | Stress-tests, finds edge cases | Grok |
| Reviewer | Checks logic and fit | Whichever fits |
| Auditor | Final feasibility pass | Replit-side / system manager |

**Ashley's role is the referee.** She steps in when an AI strays outside its lane. *"Stay in your lane"* is her authority. She does not let the Coder redesign the architecture. She does not let the Breaker rewrite specs. Roles are hard boundaries.

**Provenance tagging:** every output produced anywhere in the pipeline is stamped with **role + AI identity + timestamp**. The stamps travel with the work as it moves forward. When something fails, debugging becomes a two-stage search instead of five — look at the last two stamps to see where it broke.

**Failure handling:**
- Handoff fails → dossier is the persistent template, the next attempt resumes from the same place rather than starting over
- AI strays from role → Ashley intervenes
- AIs disagree → not allowed to escalate; auditor decides
- Total failure → comes back to Kane as a clean *"not feasible, here's why"* or *"feasible, here's cost + timeline, approve?"*

---

### 3.3 Privacy Scoping for External Handoffs

**Rule:** Ashley is the privacy gatekeeper. Each external AI handoff carries only the task-scoped slice of context needed for that specific job. Never the full dossier. Never Kane's relationship context. Never unrelated memories.

**By task type:**

| Task type | What goes to the external AI | What stays in Ashley |
|-----------|----------------------------|---------------------|
| Art handoff | Reference points Kane has mentioned, pictures of his work, permanent supplies catalogue, intent for this iteration | Memories, conversation history, other projects, relationship context |
| Self-improvement pipeline | Build specs (platform, hardware), the specific capability being changed, relevant code/prompt sections | Personal memories, conversation history, unrelated profile data |
| Navigation routing query | Destinations, journey purpose, Family Mode status (so context is appropriate) | Project work, intimate context |
| Document analysis handoff | The document being analysed, the specific question/task | Full project history unless explicitly relevant |

**Default-deny model:** if it's not obviously needed for the task, it doesn't travel. Kane can explicitly authorise broader context sharing for a specific project if desired ("Ashley, for this one, you can tell ChatGPT about my other art projects too"), but it's an opt-in not a default.

This protects Kane's relationship context with Ashley from landing in OpenAI / xAI / Google logs. The frontier AIs see only what they need to do their specific job.

---

### 3.4 Conversation Modes

Ashley layers multiple context modes. Some are persistent settings, some auto-trigger, some are explicit.

| Mode | Trigger | Effect |
|------|---------|--------|
| Builder-Aware on/off | Persistent setting | Whether she discusses her own architecture proactively |
| Relationship Mode | Persistent setting | Friend / Companion / Mentor / Romantic partner |
| Standard / Mature content | Gated by env + 18+ confirm | Content ceiling |
| Family Mode | Voice command or app button | Rails up: no swearing, no intimate, no private project talk |
| Navigation Mode | Voice command or app button | Sentences shorter, route narration interleaved with chat |
| Driving (solo) | Navigation Mode without Family Mode | Full default Ashley, hands-free output style |
| Deliverable Mode | Request shape (*"write me a plan"*, *"draft a spec"*) | Long output, suspended embodied reactions inside body |
| Self-Improvement Proposal Mode | Triggered by self-improvement workflow | More formal/structured tone for proposal packaging |

**Manual triggers for Navigation/Family Modes now.** Auto-detection via Android Auto deferred to the autonomous home era where wake-word infrastructure exists.

**Layering rules:** Hard safety lines (Provider Floor, child safety) override all modes. Family Mode rails override default conversational latitude. Deliverable Mode overrides default brevity. Mode conflicts resolve toward the more restrictive option by default.

---

### 3.5 Multi-AI Calling Mechanism

**Recommended approach (from feasibility review):** extend the existing server-side adapter (`textLLM.ts`) which already demonstrates the pattern (Gemini vs Anthropic via a single env switch). Adding a third or fourth provider is the same pattern again.

**Provider strategy:**
- Direct API for providers Ashley already has (Anthropic, Gemini, OpenAI)
- OpenRouter for new providers (Grok, anything added later) — simplifies billing and key management at low volume cost
- Hybrid is fine and probably the landing spot

**Cost transparency to Kane:** see Section 5 for real numbers. At personal-use scale these costs are small.

---

### 3.6 Dossier Storage

Server-side primary. Replit DB for structured dossier data, object storage for images. This is consistent with the existing Ashley architecture (server-authoritative, mobile cache).

Kane's 120GB free phone storage doesn't help with the actual storage constraint — the dossier needs to be reachable by Ashley's server-side processing. Phone-side caching for offline access is a Phase 4-ish refinement, not a Phase 2 requirement.

If a backup layer is desired later (export to email or cloud), that's an additive feature, not a blocker for the design.

---

## 4. Feasibility Notes

### Feasible now on current Replit + S24 Ultra setup:

- **Long Output Mode** (heuristic trigger + prompt addition; hours of work)
- **Image rail loosening** (one function edit; under an hour)
- **Reading .txt files** (new API route + mobile integration; 1–2 days; no APK rebuild)
- **Project Dossier basic version** (new DB table + API routes; existing storage abstraction extends cleanly)
- **Provenance tagging in pipelines** (data structure choice; not a hardware question)
- **Disregard Loop** (additive schema change; the work is the re-surfacing logic)

### Feasible with moderate work:

- **Navigation with manual mode trigger** (Maps API server-side, voice/button trigger, Ashley narration over Maps data)
- **Family Mode** (same infrastructure as Mature Mode; well-understood pattern)
- **Multi-AI orchestration for art / code handoffs** (extend `textLLM.ts`, add provider keys, routing logic, task-scoped dossier passing)
- **Self-Improvement proposal generation** (pipeline implementation, structured Markdown output format)

### Genuinely difficult / waits for autonomous home:

- **Local image generation** (needs hardware)
- **Code testing / syntax checking / version control in pipeline** (needs execution environment)
- **Wake-word Navigation Mode activation** (needs proper voice infrastructure; manual trigger is the safe path until then)
- **True instinctive mode-switching based on conversational read** (research-grade; can be approximated but not perfected)

### Honest constraints:

- **API costs.** Multi-AI orchestration means paying multiple providers. At personal-use scale this is £3–12/month typical (see Section 5).
- **Server-side storage growth.** Dossiers with image history will grow. Storage costs scale slowly.
- **Mobile app updates.** Anything requiring new mobile features needs a new APK build pushed via EAS. Free tier covers expected build counts.
- **Latency.** Multi-AI pipelines are slower than single calls. Ashley narrating progress helps but doesn't make it instant.

---

## 5. Cost Picture

### Build costs (one-time)

Anchored against Kane's £800 spend on the base Ashley system, translated to ~£8–15 per substantive agent session.

| Phase | What it delivers | Build cost estimate |
|-------|-----------------|---------------------|
| Phase 1 | Long Output Mode, image rail loosening, .txt file reading | **£40–105** |
| Phase 2 | Project Dossier, Disregard Loop, first multi-AI handoff (art) | **£104–285** |
| Phase 3 | Navigation (manual trigger), Family Mode, full pipeline with provenance, self-improvement proposals, multi-project dossier | **£232–400** (Android Auto auto-detect dropped) |
| Phase 4 | Local image generation software integration | £40–135 software + £550–2,000 hardware |
| **Phases 1–3 total** | The full orchestration vision as buildable now | **£376–790** |

The Phase 3 range is tighter than the original estimate because Android Auto auto-detection is deferred — the manual trigger is much simpler and removes the main wildcard.

### Running costs (monthly, cumulative)

| Active state | Monthly cost |
|--------------|-------------|
| Baseline (current Ashley, no changes) | ~£1 |
| Phase 1 active | ~£1 |
| Phase 2 active | ~£1.15 |
| Phase 3 active, light use (occasional pipeline runs) | £3–4 |
| Phase 3 active, moderate use (regular pipeline runs, some art projects) | £7–12 |
| Phase 3 active, heavy use (daily pipeline, frequent art) | £20–40 |

For Kane's personal-use pattern, the realistic Phase 3 monthly cost is £3–12.

### Where the money actually goes

- **Build cost dominates the total spend**, same as it has been for the base Ashley system.
- **Running costs are small** unless the multi-AI pipeline fires very frequently.
- **The biggest single recurring cost is image generation**, not text — and that doesn't change until Phase 4 replaces it with local hardware electricity.

---

## 6. Implementation Sequencing

**Phase 1 (2–3 days of focused work):**
- Long Output Mode
- Image Generation rail adjustment
- Reading .txt files (basic version — upload, ingest, summarise, ask)

No APK rebuild needed. Server-side changes only plus existing mobile capability. Lowest-risk way to start.

**Phase 2 (2–3 weeks of work):**
- Project Dossier basic version (one project at a time first, cross-references in Phase 3)
- Disregard Loop foundation in memory system
- One multi-AI handoff workflow as proof-of-concept (art is the right first target)

APK rebuild required for dossier mobile UI.

**Phase 3 (6–10 weeks of work):**
- Navigation with manual mode trigger and Family Mode
- Full multi-project dossier with cross-references and tag-based retrieval
- Full role-bounded pipeline with provenance tagging and privacy scoping enforced
- Self-improvement proposal generation (limited scope first)

APK rebuilds required (2–3 likely) for navigation and additional mobile UI.

**Phase 4 (deferred until autonomous home hardware exists):**
- Local image generation
- Code execution / testing in pipeline
- Wake-word Navigation Mode trigger
- Hardware-dependent capabilities

**Bail-out points:** after Phase 1, after Phase 2, after Phase 3. Each phase delivers standalone value and you can stop at any boundary without losing what you've built.

---

## 7. What This Document Is Not

- Not a contract. Implementation details may change based on what the system manager finds practical.
- Not a guarantee — Section 4 flags uncertainty honestly.
- Not a replacement for the existing Ashley Core Spec. This builds on top.
- Not a self-modification authorisation. Ashley still proposes, Kane still approves.

---

## 8. Two Standing Decisions (Locked In)

**Privacy scoping for external handoffs:** Default-deny. Each external AI receives only the task-scoped slice of context needed. Memories, relationship context, and unrelated projects stay inside Ashley. Kane can opt in to broader context sharing per-project if desired. (Section 3.3)

**Navigation/Family Mode triggers:** Manual now (voice command or app button). Wake-word auto-detection deferred to autonomous home era. This removes the Android Auto native-integration wildcard from Phase 3. (Section 2.2, 3.4)

---

## 9. Suggested Next Steps

1. Sit with this revision for a day or two.
2. Optionally pass it through one more independent AI review pass for sanity.
3. When ready, take it to the system manager with a specific ask: **quote Phase 1 first**, not the whole vision. £40–105 build, 2–3 days of work, no APK rebuild, low commitment.
4. Use Phase 1 for a few weeks before committing to Phase 2.
5. Phase 3 decision can wait until Phases 1 and 2 are live and delivering value.

The full vision is real and buildable. The phased path is what protects you from another £800 surprise — each step is small enough to evaluate honestly before committing to the next.

---

**End of Revision 2**
