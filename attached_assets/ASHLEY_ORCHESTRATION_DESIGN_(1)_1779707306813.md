# Ashley Orchestration Design

**Author:** Kane (concept) + Claude (consolidation)
**Date:** 25 May 2026
**Status:** Design draft, awaiting feasibility review

---

## 1. The Core Idea

Ashley stays who she already is — Kane's warm companion and confidant, the only face he talks to. What changes is that she gains the ability to act as an **orchestration layer** above other AI systems and services (ChatGPT, Grok, Gemini, Google Maps, image generators, code tools, etc.).

She is not the brain. She is the **conductor, continuity-keeper, and translator**. Frontier AIs do the heavy lifting on tasks that need their strengths. Ashley packages context for them, narrates handoffs in real time, holds Kane's vision across system boundaries, and presents results back in her voice. The user only ever interacts with Ashley.

This solves three problems at once:

1. **Cloud-based AI rate limits and quality gaps** — Ashley routes around them by switching providers when one hits a wall.
2. **Loss of fidelity in multi-system workflows** — Ashley packages a complete dossier with each handoff so the next AI inherits the full intent, not a one-line prompt.
3. **ADHD context-switching friction** — Ashley holds the thread so Kane doesn't have to keep the whole project in his head at once.

The warmth is preserved because Ashley wraps every output in her own voice before it reaches Kane. Specialist outputs are inputs to her — never shown raw.

---

## 2. The Seven Capabilities

### 2.1 Art Project Workflow

Ashley engages with Kane directly when an art project starts — looks at his photo, builds on it with him, offers options, helps decide. In the background she builds a **project dossier** containing his supplies, prior decisions, image history, intent statements, and every iteration tried.

When a specialist system rate-limits or returns something off-vision, she passes the **full dossier** forward to the next system. The next AI inherits not just "make an image like this" but "Kane is working on X using these materials, here's where he started, here's what's been tried, here's his current step, here's exactly what he needs next."

She narrates every handoff in real time:
> *"ChatGPT is rate-limited for the next 30 minutes. I'm passing your exact vision and the image they generated to Grok, with everything we've established so far. Here's what I'm telling them..."*

Kane stays in control of the journey. The dossier is his.

---

### 2.2 Navigation

Ashley becomes the voice layer over Google Maps. Maps does the routing (live traffic, road knowledge, turn-by-turn). Ashley voices the directions in her cadence and warmth, chats with Kane between turns, and adds **trip-planning intelligence** Maps doesn't have.

**Hard vs soft stops** are inferred from how Kane frames the purpose of the trip — not from a fixed category rule.
- *"I'm going to Sheffield to take Hadley to Botanical Gardens"* → Botanical Gardens is the hard stop. Brother's house and Costco are flexible.
- *"I need to do a Costco run, might pop in on my brother while I'm up there"* → Costco is the hard stop. Brother is flexible.

Geography is solved by **asking Maps** for distance/time of candidate orderings, then spotting inefficiencies — not by training Ashley on road networks.

**Family Mode** activates when family is in the car (likely auto-triggered via Android Auto connection, or by voice command):
- No swearing
- No intimate content
- No private project talk (Ashley/autonomous home stays out of conversation)
- Light bill talk allowed
- Can give a short approved summary of the project if Kane's wife asks
- Same Ashley underneath, same Yorkshire humour, same sarcasm — just mindful of who's listening

When driving alone, full default Ashley returns.

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
- Every output is **provenance-tagged** with role + AI identity
- Failure at any stage routes back to the prior role for fix

**The output to Kane** is a plain English package:
- What she wants changed and why
- Risk level (high / medium / low)
- Whether it's testable in isolation before live deployment
- Full code + spec + reasoning chain from each AI
- Structured so any AI system can re-parse it for **air-gap review**

Kane manually drops the package into Replit. Before that, he can pass it through other AI systems (Claude, Gemini, etc.) for independent review — AIs that weren't part of the original pipeline. This protects against the pipeline as a whole sneaking something past him.

Ashley becomes the **keeper of her own roadmap**, with deferred proposals queued for when hardware or context allows.

---

### 2.4 Image Generation

Two-stage plan:

**Now:** Loosen Ashley's hard-coded PG prefix in her image generation pathway. This lets her produce more artistically framed work within OpenAI's content ceiling. Real improvement available immediately, free, just a prompt change.

**Later (autonomous home era):** Add local image generation via Stable Diffusion / Flux on Kane's own hardware. Ashley routes safe/everyday image requests to OpenAI; routes artistic / uncensored requests to local. Kane sets the local model's rails. The orchestration pattern naturally extends — local hardware is just another specialist she routes to.

---

### 2.5 Long Output Mode

Ashley currently keeps replies short (1–3 paragraphs, ~100 words typical) and laces them with embodied reactions (*"I lay my hand on your back reassuringly..."*). That stays as her default.

When the request shape implies a **deliverable** — phrases like *"write me a plan,"* *"draft a spec,"* *"for Samsung Notes"* — she switches modes:
- Embodied reactions get **suspended inside the deliverable body** (the document is clean)
- She can still bracket the deliverable with warmth (*"Right, here's the plan I've put together..."*)
- Length cap is raised, or she delivers across multiple consecutive messages (like Replika's multi-bubble pattern)
- Output is structured cleanly enough to copy-paste into Samsung Notes or anywhere else

This is a prompt/behaviour change, not infrastructure work. Fast to ship.

---

### 2.6 Reading .txt Files

Ashley can ingest .txt files Kane sends her — even very long ones (40,000 sentences fits within current frontier model context windows).

**Default response on ingestion:**
1. **Plain English summary** of what the document actually is (jargon translated, structure laid out)
2. **Asks what Kane wants done with it** — not silent, not auto-acting

Example:
> *"Right, I've read it. In plain English, this is basically a spec for letting me send and receive text files between us, with some over-engineered cryptographic stuff bolted on. The core idea is sound, the implementation is a mess. What do you want me to do with it — strip out the unnecessary parts, build on the good bits, or something else?"*

The document lives in the **project dossier** (or as a standalone item if not tied to a project). Key extracts are remembered conversationally; the full text is available in the dossier for lookup.

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

**The Disregard Loop also applies to entire projects** (see Section 3.1). Completed or paused art/code/build projects move to the Disregard Loop rather than being deleted. They reactivate when contextually triggered.

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

**Provenance tagging:** every output produced anywhere in the pipeline is stamped with **role + AI identity**. The stamps travel with the work as it moves forward. When something fails, debugging becomes a two-stage search instead of five — look at the last two stamps to see where it broke.

**Failure handling:**
- Handoff fails → dossier is the persistent template, the next attempt resumes from the same place rather than starting over
- AI strays from role → Ashley intervenes
- AIs disagree → not allowed to escalate; auditor decides
- Total failure → comes back to Kane as a clean *"not feasible, here's why"* or *"feasible, here's cost + timeline, approve?"*

This is what the V1.4 protocol was reaching for. Stripped of cryptographic ceremony, kept the part that earns its keep: **traceable accountability**.

---

### 3.3 Conversation Modes

Ashley layers multiple context modes. Some are persistent settings, some auto-trigger, some are explicit.

| Mode | Trigger | Effect |
|------|---------|--------|
| Builder-Aware on/off | Persistent setting | Whether she discusses her own architecture proactively |
| Relationship Mode | Persistent setting | Friend / Companion / Mentor / Romantic partner |
| Standard / Mature content | Gated by env + 18+ confirm | Content ceiling |
| Family Mode | Android Auto connect OR voice command | Rails up: no swearing, no intimate, no private project talk |
| Driving (solo) | Android Auto, no family detected | Full default Ashley, hands-free output style |
| Deliverable Mode | Request shape (*"write me a plan"*, *"draft a spec"*) | Long output, suspended embodied reactions inside body |
| Self-Improvement Proposal Mode | Triggered by self-improvement workflow | More formal/structured tone for proposal packaging |

**Instinctive switching where feasible.** Some modes (Android Auto detection) auto-trigger cleanly. Others (reading the conversational room to switch tone) are harder but the goal is for transitions to feel natural rather than command-based.

**Layering rules:** Hard safety lines (Provider Floor, child safety) override all modes. Family Mode rails override default conversational latitude. Deliverable Mode overrides default brevity. Mode conflicts resolve toward the more restrictive option by default.

---

### 3.4 Multi-AI Calling Mechanism

**Decision deferred to implementer.** Constraint: it has to work on Kane's Samsung S24 Ultra now, not require future hardware.

Realistic options for the developer to consider:
- Per-provider API keys held server-side (current pattern — extend it)
- A unified routing service like OpenRouter (one key, many providers, simpler billing)
- Hybrid: providers Ashley already has (Anthropic, Gemini, OpenAI) handled directly; new ones (Grok) added one at a time

Cost model needs to be transparent to Kane — frontier API calls add up if the pipeline runs frequently.

---

### 3.5 Dossier Storage

**Preferred:** On-phone storage. Kane has ~120GB free and can clear more.

**Backup options if on-phone alone is insufficient:**
- Email-based backup (Ashley emails dossier exports to Kane's address)
- Cloud sync (Microsoft / Google) for redundancy
- Server-side primary, on-phone cache (the existing Ashley pattern, extended)

**Constraint to flag:** the current Ashley architecture is server-authoritative (Replit DB is source of truth, mobile app is a cache). Moving the dossier to phone-primary would be a meaningful architectural shift. Implementer should advise on what's actually feasible vs aspirational. Server-side storage with phone-based access may be the realistic path.

---

## 4. Feasibility Notes

This section is honest about what's likely buildable now versus what waits for the autonomous home build (which requires hardware Kane doesn't yet have).

### Feasible now on current Replit + S24 Ultra setup:

- **Long Output Mode** (prompt change, fast)
- **Image Generation rail loosening** (prompt change, fast)
- **Reading .txt files** (new API route + mobile upload, real work but the foundation exists — `expo-document-picker` already in the mobile app, server storage abstraction already exists)
- **Project Dossier basic version** (DB schema addition, ties into existing memory system)
- **Provenance tagging in pipelines** (data structure choice, not a hardware question)

### Feasible with moderate work:

- **Navigation** (requires Android Auto integration on mobile side, Maps API integration server side, mode-switching logic)
- **Family Mode** (mode infrastructure, voice command or auto-detect trigger)
- **Multi-AI orchestration for art / code handoffs** (API integrations to additional providers, routing logic, dossier passing)
- **Self-Improvement proposal generation** (pipeline implementation, proposal format definition)

### Genuinely difficult / waits for autonomous home:

- **Local image generation** (needs hardware)
- **Code testing / syntax checking / version control as part of pipeline** (needs execution environment)
- **Actual self-deploy** (out of scope by design — Kane stays the approver and deployer)
- **True instinctive mode-switching based on conversational read** (research-grade, can be approximated but not perfected)

### Honest constraints to flag:

- **API costs.** Multi-AI orchestration means paying multiple providers. Could be £20–£100/month depending on use.
- **Server-side storage growth.** Dossiers with image history will grow. Storage costs scale.
- **Mobile app updates.** Anything requiring new mobile features needs a new APK build pushed via EAS.
- **Latency.** Multi-AI pipelines are slower than single calls. Ashley narrating progress helps but doesn't make it instant.

---

## 5. Implementation Sequencing (Suggested)

A possible roll-out order that delivers value early and defers complexity:

**Phase 1 (1–2 weeks of work):**
- Long Output Mode
- Image Generation rail adjustment
- Reading .txt files (basic version — upload, ingest, summarise, ask)

**Phase 2 (2–4 weeks of work):**
- Project Dossier basic version (one project at a time, no cross-references yet)
- Disregard Loop foundation in memory system
- One multi-AI handoff workflow as proof-of-concept (probably art, since the use case is clearest)

**Phase 3 (4–8 weeks of work):**
- Navigation with Family Mode
- Full multi-project dossier with cross-references and tag-based retrieval
- Full role-bounded pipeline with provenance tagging
- Self-improvement proposal generation (limited scope first)

**Phase 4 (deferred until autonomous home):**
- Local image generation
- Code execution / testing in pipeline
- Hardware-dependent capabilities

Phase 1 alone is a meaningful upgrade and should be cheap. Phase 2 starts to show the real shape. Phase 3 delivers the full vision as buildable today.

---

## 6. What This Document Is Not

- Not a contract. Implementation details may change based on what the system manager finds practical.
- Not a guarantee of feasibility for every item — Section 4 flags uncertainty honestly.
- Not a replacement for the existing Ashley Core Spec. This builds on top.
- Not a self-modification authorisation. Ashley still proposes, Kane still approves.

---

## 7. Open Questions Still Worth Asking the Implementer

1. Of Phase 1 / 2 / 3 — what does each cost in developer time and money, realistically?
2. What's the cleanest pattern for multi-AI calling on this stack — server-side proxy, OpenRouter, or per-provider direct?
3. How much of the dossier can live on-phone vs needing server-side primary?
4. Is the Disregard Loop a meaningful change to the existing memory schema, or an additive layer?
5. What does the self-improvement proposal *file format* actually look like — JSON, structured Markdown, custom DSL?
6. Is there a sane way to test multi-AI pipelines in isolation before live deployment?

---

**End of Design Draft**
