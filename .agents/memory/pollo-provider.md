---
name: Pollo AI image provider
description: How the Pollo AI image generation provider is wired into Ashley's selfie pipeline.
---

## Integration pattern

`lib/pollo.ts` wraps the Pollo REST API. `generateImageBase64` in `lib/openai.ts` checks `process.env["ASHLEY_IMAGE_PROVIDER"]` and calls `generateImageWithPollo` when it equals `"pollo"`. This means the routing is in the single shared entrypoint — nothing else in `chat.ts` needed to change.

## Env vars

- `ASHLEY_IMAGE_PROVIDER=pollo` — set as shared env var to activate Pollo.
- `Project_ashley` — Replit secret containing the Pollo API key.
- `POLLO_MODEL` — optional override, defaults to `black-forest-labs/flux-dev`.

## API contract

- Submit: `POST https://pollo.ai/api/platform/generation/{model}` with `x-api-key` header.
  - Body: `{ input: { prompt, width, height, steps } }`
  - Response: `{ taskId, status }`
- Poll: `GET https://pollo.ai/api/platform/generation/task/{taskId}` with `x-api-key` header.
  - Terminal states: `succeed` (has `output.imageUrl`), `failed`.
  - Non-terminal: `waiting`, `processing`.
- On `succeed`: fetch `output.imageUrl`, download as buffer, return base64 — same shape as `generateImageBase64` so the rest of the selfie pipeline is unchanged.

**Why:** gpt-image-1 via Replit's OpenAI proxy hits a model-level ceiling on scene location (always produces kitchens regardless of prompt). Pollo/FLUX gives access to a different diffusion stack (FLUX Dev) which may respond better to environment-first prompts.

**How to apply:** To revert to OpenAI, delete or change `ASHLEY_IMAGE_PROVIDER`. To switch model within Pollo, set `POLLO_MODEL` to any Pollo-supported slug (e.g. `black-forest-labs/flux-pro`, `black-forest-labs/flux-schnell`).
