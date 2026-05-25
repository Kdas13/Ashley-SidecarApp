# Ashley Orchestration — Real Cash Cost Analysis

**Date:** 25 May 2026
**Basis:** Current API pricing for confirmed model IDs in the codebase.
**Scope:** Single user (Kane), personal use patterns.

---

## Pricing Reference (Models in Use or Proposed)

| Model | Input (per 1M tokens) | Output (per 1M tokens) |
|-------|----------------------|------------------------|
| Gemini 2.5 Flash (thinking disabled) | $0.15 | $0.60 |
| Claude Sonnet 4.6 (`claude-sonnet-4-6`) | $3.00 | $15.00 |
| Claude Haiku 4.5 (`claude-haiku-4-5`, summariser) | $0.80 | $4.00 |
| GPT-4o (if added for pipeline) | $2.50 | $10.00 |
| Grok-3 (if added as Breaker) | ~$3.00 | ~$15.00 |

| Service | Unit cost |
|---------|-----------|
| gpt-image-1, medium quality, 1024×1024 (fast selfie) | $0.042 per image |
| gpt-image-1, high quality, 1024×1536 (quality selfie) | $0.250 per image |
| OpenAI Whisper transcription | $0.006 per minute of audio |
| OpenAI TTS-1 | $15.00 per 1M characters |
| Tavily web search | Free up to 1,000 searches/month |
| Google Maps Directions API | $5.00 per 1,000 requests ($200/month free credit) |

*All prices in USD. At time of writing, £1 ≈ $1.27, so divide USD figures by ~1.27 for GBP.*

---

## Baseline — What Ashley Costs Right Now (Before Any Changes)

Estimated usage for a single personal user doing daily-ish chat:

| Cost driver | Estimate | Monthly cost |
|-------------|----------|-------------|
| Chat replies (Gemini 2.5 Flash, ~450 exchanges/month, ~2,000 input + 300 output tokens each) | 900k input + 135k output tokens | ~$0.22 |
| Conversation summariser (Claude Haiku 4.5, ~10 summaries/month) | ~30k input + 5k output tokens | ~$0.04 |
| Selfies (gpt-image-1 medium, ~20/month) | 20 × $0.042 | ~$0.84 |
| Proactive messages (Gemini, ~60/month, short outputs) | Negligible | ~$0.02 |
| Web search (Tavily, within free tier) | — | $0.00 |
| **Total baseline** | | **~$1.12/month (~£0.88)** |

**The biggest single cost right now is image generation, not text.**

---

## Phase 1 — Long Output Mode + Image Rail + .txt Reading

**One-time cost: £0.** All prompt/route changes. No new infrastructure.

| Change | Cost impact |
|--------|-------------|
| Long Output Mode (longer text replies) | Adds ~200 extra output tokens per relevant exchange. At $0.60/1M, if 50 exchanges/month hit this mode: 50 × 200 × $0.60/1M = $0.006. Rounding error. |
| Image rail loosening | Same gpt-image-1 model, same quality settings. Zero cost change. |
| .txt file reading | One document ingested ≈ 50,000 tokens at Gemini input rate = $0.0075 per document. At 4 docs/month = $0.03. |

**Phase 1 running cost delta: < $0.05/month (~£0.04)**

Total with Phase 1 active: ~**£0.92/month**

---

## Phase 2 — Project Dossier + Disregard Loop + Multi-AI Handoff

**One-time cost: £0.** DB schema changes, no hardware.

| Change | Cost impact |
|--------|-------------|
| Project Dossier (text entries, decisions, notes) | DB storage at Replit's scale for text: negligible. |
| Dossier image history (art iterations stored) | If 3 art projects/month × 10 iterations × ~1MB PNG each = ~30MB/month in object storage. Replit object storage pricing is cents per GB. ~$0.03/month. |
| Disregard Loop | No API calls. Schema and re-surfacing logic only. $0. |
| Multi-AI handoff, art project proof-of-concept (GPT-4o) | Each handoff call ≈ 5,000 input + 1,000 output tokens at GPT-4o rates = $0.0225 per call. 3 art projects × 3 handoffs each = 9 calls/month = $0.20/month. |

**Phase 2 running cost delta: ~$0.25/month (~£0.20)**

Total with Phase 2 active: ~**£1.12/month**

Note: Phase 2 is very cheap because multi-AI handoffs for a single personal user happen infrequently. The cost scales with how often the pipeline actually runs.

---

## Phase 3 — Navigation + Family Mode + Full Pipeline + Self-Improvement

**One-time cost:** None for software. Google Maps has a $200/month free credit — Kane will not exceed this for personal navigation use.

### Navigation (Google Maps Directions API)

| Usage | Cost |
|-------|------|
| 20 trips/month × ~4 API calls per trip = 80 calls | 80 × $0.005 = $0.40/month |
| $200/month Google Maps free credit | Covers up to 40,000 calls/month |
| **Effective navigation cost** | **$0 (well within free credit)** |

### Family Mode

No new API costs. Mode is a system prompt addition. $0.

### Full Role-Bounded Pipeline (Self-Improvement Proposals)

Each pipeline run: Architect + Coder + Breaker + Reviewer, each receiving a full dossier context.

| Scenario | Per run | Monthly (5 runs) | Monthly (20 runs) |
|----------|---------|-----------------|-----------------|
| All Claude Sonnet 4.6 | ~$0.22 | $1.10 | $4.40 |
| Claude Sonnet + GPT-4o mix | ~$0.19 | $0.95 | $3.80 |
| Add Grok as Breaker | +$0.05/run | +$0.25 | +$1.00 |

5 proposals/month is realistic for light use. 20 is heavy use (refining the system regularly).

### Multi-Project Dossier with Image History (Full Phase 3 Scale)

If art projects become a regular habit (5 projects/month, each with 15 iterations):
- 5 × 15 × $0.042 (fast selfie equivalent for AI art iterations) = $3.15/month in images
- Plus dossier storage: ~75MB/month, negligible cost

### Phase 3 Total

| Usage level | Monthly cost delta | Total monthly (on top of baseline) |
|-------------|-------------------|-----------------------------------|
| Light (navigation + occasional pipeline) | ~$2–4 | ~£2.50–3.50 |
| Moderate (regular pipeline runs, some art projects) | ~$8–15 | ~£7–12 |
| Heavy (daily pipeline runs, frequent art) | ~$25–50 | ~£20–40 |

**The document's £20–100/month estimate applies only to heavy daily pipeline use.** For the realistic personal use pattern, Phase 3 lands at **£7–12/month total** (not delta — total, including the Phase 1/2 baseline).

---

## Phase 4 — Local Image Generation (Autonomous Home Era)

This is a hardware cost, not a subscription cost.

| Hardware option | One-time cost | Notes |
|----------------|--------------|-------|
| NVIDIA RTX 4070 (GPU only, into existing PC) | £550–650 | Runs SDXL, Flux.1 Schnell comfortably |
| NVIDIA RTX 4070 Ti Super (better quality/speed) | £700–800 | Handles Flux.1 Dev at good speed |
| Full mini-PC build (e.g. NUC-style with dGPU) | £900–1,400 | Standalone, always-on |
| NVIDIA RTX 4090 (maximum local quality) | £1,600–2,000 | Overkill for personal use |

**Electricity running cost (GPU active ~2 hours/day):**

| GPU | TDP | 2hrs/day electricity at £0.25/kWh |
|-----|-----|----------------------------------|
| RTX 4070 | 200W | ~£3.00/month |
| RTX 4070 Ti Super | 285W | ~£4.30/month |
| RTX 4090 | 450W | ~£6.75/month |

**After the hardware cost is paid off, Phase 4 replaces OpenAI image generation (~$0.84/month currently) with electricity (~£3–5/month).** At light image gen use, this is not a cost saving — it's a capability and control gain (no content filter, no per-image charge at volume). It pays off financially only if Kane is generating many images per day.

---

## OpenRouter (If Adopted for Phase 3+)

OpenRouter acts as a single API gateway to multiple providers. Its pricing model:

- **Routes at provider cost for most models** (OpenRouter takes a margin from provider volume discounts, not from the user directly on many models)
- Some models have an explicit OpenRouter markup (typically 0–20%)
- For Grok specifically: xAI's direct API pricing vs OpenRouter pricing — check both; OpenRouter is often cheaper for low-volume users because of their negotiated rates

**Benefit at Kane's scale:** one API key, one invoice, easier to add providers. For personal use volumes, the financial difference vs direct API is small (< $1/month). The operational simplicity is the real argument.

---

## Build Cost Estimates (What It Costs to Actually Build Each Phase)

This is the section that was missing from the original analysis and is the more important number for planning. Running costs are what Ashley costs to operate once built. Build costs are what you pay to have the work done — Replit agent sessions, APK builds, and any one-off infrastructure setup.

### How the Estimate Is Anchored

Ashley-Sidecar as it stands today — the full Express API (6,000+ line chat route alone), the streaming SSE architecture, the memory system, the proactive scheduler, the two-provider text adapter, the selfie pipeline, the mobile app, onboarding, the ticket system, the whole thing — cost you roughly £800 to build. That project ran for many months and involved a substantial number of agent sessions plus ongoing Replit subscription costs.

A reasonable breakdown of that £800:

| Component | Estimated share |
|-----------|----------------|
| Replit subscription (~£20–25/month × ~12 months) | ~£250 |
| Agent session usage (above subscription) | ~£500 |
| EAS APK builds, API testing during development | ~£50 |

That puts the effective agent session rate at roughly **£8–15 per substantive session** (a session that does real design and implementation work, not just a quick fix). Some sessions cost less. Complex ones with many tool calls and long iteration loops cost more. This range is the anchor used for all estimates below.

---

### Phase 1 Build Cost

**What needs building:** Long Output Mode (heuristic trigger in `chat.ts` + `ashleyCoreSpec.ts`), image rail loosening (one function in `contentPolicy.ts`), .txt file reading (new API route + mobile document picker integration + ingestion logic).

| Work item | Sessions needed | Notes |
|-----------|----------------|-------|
| Long Output Mode | 1 | Prompt change + classifier heuristic. Straightforward. |
| Image rail loosening | 0.5 | One function edit. Can be combined with another session. |
| .txt file reading (API route + server ingestion) | 2–3 | New route, storage handling, summary prompt, error cases. |
| .txt file reading (mobile side — picker + upload UI) | 1–2 | `expo-document-picker` already installed; UI and upload call. |
| Testing and iteration | 1 | End-to-end test, edge cases, APK not needed if no native changes. |
| **Total sessions** | **5–7** | |
| **Estimated build cost** | **£40–105** | At £8–15/session |

EAS APK build needed: **No** — Phase 1 changes are server-side and the document picker is already in the installed APK. No new build required.

---

### Phase 2 Build Cost

**What needs building:** Project Dossier (new DB schema + API routes + mobile UI), Disregard Loop (memory schema extension + re-surfacing logic), one multi-AI handoff proof-of-concept (GPT-4o routing via extended `textLLM.ts` adapter, dossier-passing to the second provider).

| Work item | Sessions needed | Notes |
|-----------|----------------|-------|
| Dossier DB schema + migration | 1 | New table(s), Drizzle migration. Small but needs careful design. |
| Dossier API routes (CRUD + dossier-fetch) | 2–3 | Create, read, update, archive, attach images. |
| Dossier mobile UI (create, view, manage projects) | 3–5 | This is the biggest unknown — mobile UI work is iterative. |
| Disregard Loop (schema + re-surfacing trigger logic) | 2–3 | Additive to the memory schema. Re-surfacing logic is the real work. |
| Multi-AI handoff PoC (GPT-4o integration + routing) | 3–4 | Extend `textLLM.ts`, add provider key, test dossier passing end-to-end. |
| Testing, debugging, EAS APK build | 2–3 | APK needed because mobile UI is new. |
| **Total sessions** | **13–19** | |
| **Estimated build cost** | **£104–285** | At £8–15/session |

EAS APK build needed: **Yes** — mobile UI work requires a new build. One or two EAS builds within the free tier (30/month).

---

### Phase 3 Build Cost

**What needs building:** Google Maps integration + navigation voice layer, Android Auto detection or manual Family Mode trigger, Family Mode prompt system, full role-bounded pipeline (Architect/Coder/Breaker/Reviewer routing with provenance tagging), self-improvement proposal format and generation, multi-project dossier with cross-references and tag-based retrieval, mobile updates across all new features.

This is a substantial project. The estimates below reflect that the navigation piece is the most uncertain — Android Auto audio routing is a native problem and might require more iteration than expected.

| Work item | Sessions needed | Notes |
|-----------|----------------|-------|
| Google Maps API integration (server-side routing + optimisation) | 2–3 | API key setup, Directions API calls, waypoint ordering logic. |
| Navigation voice layer (Ashley voices directions in her register) | 3–4 | Server-side text generation with Maps data injected. Straightforward in principle. |
| Android Auto detection / voice command Family Mode trigger | 3–6 | High uncertainty. Android Auto is native territory. Voice command fallback is simpler. If Auto detection proves impossible without a native Expo plugin, this either gets scoped down or becomes its own mini-project. |
| Family Mode prompt system (mode flag, content rails, prompt block) | 2–3 | Same infrastructure as Mature Mode. Well-understood pattern. |
| Role-bounded pipeline (routing logic, role enforcement, handoff protocol) | 5–8 | The core of Phase 3. Getting provenance tagging right and failure routing right takes iteration. |
| Self-improvement proposal format + generation | 3–5 | The structured Markdown output format, the pipeline run that produces it, the output-to-Kane packaging. |
| Multi-project dossier with cross-references + tag retrieval | 4–6 | The tag-resolution pattern is new logic. Cross-project linking needs careful data model design. |
| Mobile UI updates (navigation UI, dossier browser, pipeline status) | 4–7 | Mobile UI work is always the most unpredictable in terms of iteration count. |
| Testing, debugging, EAS APK builds | 3–5 | Multiple builds likely — navigation and mobile UI both need device testing. |
| **Total sessions** | **29–47** | |
| **Estimated build cost** | **£232–705** | At £8–15/session |

EAS APK builds needed: **Yes, probably 2–3** — navigation requires device testing (not just Expo Go), and multiple mobile UI additions will need builds to test properly. All within EAS free tier.

**The Android Auto uncertainty is the most important caveat in Phase 3.** If that piece proves unworkable without a custom native Expo plugin (which is its own project), Phase 3 either scopes down (manual voice command trigger instead of auto-detect) or the Auto integration becomes Phase 3.5 with its own estimate. The rest of Phase 3 is not blocked by this.

---

### Phase 4 Build Cost

**What needs building:** Software integration for local image generation (Stable Diffusion / Flux server running on Kane's hardware, Ashley routing safe requests to OpenAI and artistic requests to local). Hardware installation is Kane's own time.

| Work item | Sessions needed | Notes |
|-----------|----------------|-------|
| Local image server setup (ComfyUI / Automatic1111 / Flux API wrapper) | 2–3 | Configuration and getting the local API running is hardware-side work. The agent handles the API wrapper. |
| Ashley server-side routing (local vs OpenAI decision logic) | 2–3 | Extend the image generation pathway in `chat.ts` with a new provider switch, similar to the text LLM provider switch. |
| Mobile changes (if any — routing is server-side so likely minimal) | 0–1 | Probably none visible to mobile. |
| Testing (end-to-end, both routes) | 1–2 | |
| **Total sessions** | **5–9** | |
| **Estimated build cost** | **£40–135** | At £8–15/session |
| **Hardware (separate)** | **£550–2,000** | See hardware table above. |

---

## Full Cost Picture — Running + Build Combined

| Phase | Build cost (one-time) | Monthly running cost (cumulative) |
|-------|----------------------|----------------------------------|
| Baseline (now, already spent) | ~£800 | ~£0.90 |
| Phase 1 | £40–105 | ~£0.95 |
| Phase 2 | £104–285 | ~£1.15 |
| Phase 3 | £232–705 | ~£3–40 (depends on pipeline use) |
| Phase 4 | £40–135 + £550–2,000 hardware | ~£5–15 (electricity replaces image API) |

**Phases 1–3 combined build cost: £376–1,095**

The wide range in Phase 3 reflects the Android Auto uncertainty. If that piece is scoped down to a manual trigger (which is the safe fallback), Phase 3 sits closer to £232–400. If Android Auto integration turns out to require a full custom Expo plugin, add another £80–150 to that.

---

### The Key Takeaways (Updated)

1. **The running cost analysis was accurate but incomplete.** The monthly figures are real and low. The build cost is where the money goes, same as it has been for the base Ashley system.

2. **Phase 1 is genuinely cheap to build** — £40–105 — and adds zero meaningful running cost. It delivers Long Output Mode, image rail flexibility, and document reading. If any single phase is worth doing first with minimal commitment, it's this one.

3. **Phase 2 costs £104–285 to build** and adds almost nothing to running costs. The dossier UI on mobile is the uncertainty — mobile UI work tends to run longer than expected because it requires iteration to feel right.

4. **Phase 3 is a meaningful investment: £232–705 to build**, with the Android Auto piece being the main wildcard. The navigation and pipeline capabilities are the most useful features in the design; the build cost reflects that. Running costs stay low unless the pipeline fires frequently.

5. **Phase 4 is a hardware purchase with a small software cost on top.** The software integration (£40–135) is the easy part. The GPU (£550–2,000) is the real decision.

6. **Total to get through Phases 1–3: £376–1,095**, roughly similar to what was spent building the base Ashley system. You would be buying a system that can orchestrate other AIs, manage art project dossiers, read documents, navigate with Ashley's voice, and generate its own improvement proposals. Phase 4 on top adds local image generation.

---

*All build cost figures are estimates based on the stated £800 spend on the base Ashley system as an anchor, translated to a per-session rate of £8–15 for substantive agent sessions. Actual costs will vary with session length, complexity, and how many iterations any given feature requires before it's right.*
