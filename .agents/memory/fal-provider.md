---
name: FAL.ai image provider
description: FAL.ai integration details, model choice, and provider isolation requirement
---

## Integration

- File: `artifacts/api-server/src/lib/fal.ts`
- Env var: `ASHLEY_IMAGE_PROVIDER=fal`
- Secret: `FAL_KEY` (user must create at fal.ai dashboard)
- Model: `fal-ai/flux-pro/v1.1` (overrideable via `FAL_MODEL` env var)
- Queue base: `https://queue.fal.run/{model}`
- Auth: `Authorization: Key {FAL_KEY}`

## Key parameters

- `safety_tolerance: "6"` — disables FAL content filtering
- `enable_safety_checker: false` — belt-and-suspenders safety disable
- Polls via `status_url` → fetches result from `response_url`
- Downloads image URL → returns base64 string

## Provider isolation rule

When `ASHLEY_IMAGE_PROVIDER=fal`, the call is direct — no try/catch fallback to gpt-image-1. OpenAI has its own moderation layer that will suppress borderline content regardless of what FAL allows. The fallback was removed deliberately.

**Why:** Kane is using FAL specifically because gpt-image-1 refuses swimwear/beach content by silently redirecting to safe alternatives. A fallback to OpenAI defeats the entire point.

**How to apply:** Never add a silent OpenAI fallback to the FAL or Pollo paths in `generateImageBase64`. If FAL throws, the error propagates — an image generation failure is preferable to a censored replacement.

## Prompt safety prefix

`buildSelfiePromptSafetyPrefix()` in contentPolicy.ts currently includes "No nudity. No explicit sexual acts." This is intentionally kept for the swimwear use case (it doesn't block swimwear). If Kane wants to go further, this prefix needs to be made conditional on the provider or a separate NSFW mode flag.
