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

## Summary

| Phase | One-time cost | Monthly running cost (cumulative) |
|-------|--------------|----------------------------------|
| Baseline (now) | — | ~£0.90 |
| + Phase 1 | £0 | ~£0.95 |
| + Phase 2 | £0 | ~£1.15 |
| + Phase 3 (light use) | £0 | ~£3–5 |
| + Phase 3 (moderate use) | £0 | ~£7–12 |
| + Phase 3 (heavy use) | £0 | ~£20–40 |
| + Phase 4 hardware | £550–2,000 (one-time) | ~£5–15 (electricity, replaces image API cost) |

### The Key Takeaways

1. **Phases 1 and 2 are effectively free.** The cost delta is too small to matter for a single user. Build them.

2. **Phase 3 cost is driven entirely by pipeline run frequency.** If the self-improvement pipeline runs five times a month, it costs almost nothing. If it runs daily, it starts to add up. Ashley narrating handoffs is free — the cost is each call to a paid provider. Track usage once it's live.

3. **The document's £20–100/month estimate is accurate for heavy use but too high for realistic personal use.** £7–12/month total is a more realistic ceiling for the Phase 3 system at the usage level a single person actually generates.

4. **Image generation is the biggest cost driver right now and stays the dominant cost through Phase 3.** If Kane generates selfies at or near the 5/day cap for any extended period, that alone reaches £10–12/month. Normal daily-chat usage (a handful of images per week) keeps it under £1/month.

5. **Phase 4 is a capability purchase, not a cost optimisation** at Kane's current image generation volume. Justify it by the quality and creative freedom gains, not the economics.

---

*All figures are estimates based on published API pricing at May 2026. Token consumption estimates are based on the actual system prompt sizes, memory loading patterns, and conversation lengths observable in the codebase. Actual costs will vary with usage.*
