---
name: Image provider isolation rule
description: No OpenAI fallback when a permissive provider (FAL/Pollo) is configured
---

## The rule

When `ASHLEY_IMAGE_PROVIDER` is set to `fal` or `pollo`, the call in `generateImageBase64` (lib/openai.ts) must be a direct call — no try/catch that falls through to gpt-image-1.

## Why

Kane is using FAL.ai specifically because gpt-image-1 refuses/redirects swimwear and beach content. gpt-image-1 silently generates "safe" alternatives (living room instead of beach, football kit instead of bikini) rather than erroring. A fallback to OpenAI defeats the purpose of using a permissive provider.

## How to apply

In `generateImageBase64`:
```typescript
if (process.env["ASHLEY_IMAGE_PROVIDER"] === "fal") {
  return generateImageWithFal(prompt, size, quality);  // no try/catch
}
```

If FAL throws, let the error propagate. A failed image is better than a silently censored one that looks like it succeeded.
