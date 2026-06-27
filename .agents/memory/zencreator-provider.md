---
name: ZenCreator image provider
description: ZenCreator async image generation provider wired into the Ashley image pipeline.
---

## Summary

ZenCreator Public API at `https://api.zencreator.pro/api/public/v1` — async poll pattern identical to FAL/Pollo.

## Activation

Set `ASHLEY_IMAGE_PROVIDER=zencreator` in env.

## Required env vars

- `Ashley_v3_Adult` — Bearer token (exact Replit secret name, case-sensitive)
- `ZENCREATOR_TOOL` — tool name from `GET /api/public/v1/tools`; server throws on start if missing when provider=zencreator

## Optional env vars

- `ZENCREATOR_EXTRA_INPUT` — JSON string merged into `{ prompt, width, height }` before submit; use for LoRA weights, negative prompts, model selection, etc.

## API flow

1. `POST /api/public/v1/generations` body: `{ tool, input: { prompt, width, height, ...extra } }` → `{ id, status }`
2. Poll `GET /api/public/v1/generations/{id}` → `{ id, status, progress, error }` (status enum: queued/processing/succeeded/partial/failed)
3. On succeeded/partial: `GET /api/public/v1/generations/{id}/result` → `{ outputs: [{ asset_id, url, download_url }] }`
4. Download from `download_url ?? url`, return as base64

Auth: `Authorization: Bearer <key>` (bearerAuth scheme).

**Why:** FAL has no native Ashley LoRA; ZenCreator was set up with an Ashley_v3_Adult model specifically for permissive adult-content image generation.

**How to apply:** When Kane sets ASHLEY_IMAGE_PROVIDER=zencreator + ZENCREATOR_TOOL, all selfie generation routes through lib/zencreator.ts. No other code changes needed. The tool's input_schema is discoverable at runtime via `GET /api/public/v1/tools/{tool_name}` — use ZENCREATOR_EXTRA_INPUT to pass any fields the tool requires beyond prompt/width/height.
