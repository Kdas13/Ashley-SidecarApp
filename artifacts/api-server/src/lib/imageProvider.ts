// =============================================================================
// Image Provider Adapter
// -----------------------------------------------------------------------------
// Single chokepoint for selfie image generation. Routes to one of:
//
//   - "openai"        OpenAI gpt-image-1 (default; high quality, restrictive
//                     content policy enforced server-side by the provider)
//   - "pollinations"  Pollinations.ai Flux endpoint (free, community-hosted,
//                     permissive content policy; no API key required)
//
// Selected by env: ASHLEY_IMAGE_PROVIDER ("openai" | "pollinations").
// Default is "openai" — switching to a permissive provider is a deliberate
// operator opt-in. The content-unlock decision (whether to ALSO drop the
// safety prefix on the prompt) is owned by lib/contentPolicy.ts so the
// provider switch and the policy gate stay independent.
// =============================================================================

import { generateImageBase64 as generateOpenAIImage } from "./openai";
import { logger } from "./logger";

export type ImageProvider = "openai" | "pollinations";
export type ImageSize = "1024x1024" | "1024x1536" | "1536x1024";
export type ImageQuality = "low" | "medium" | "high";

export function imageProviderName(): ImageProvider {
  return process.env.ASHLEY_IMAGE_PROVIDER === "pollinations"
    ? "pollinations"
    : "openai";
}

export async function generateSelfieImageBase64(
  prompt: string,
  size: ImageSize = "1024x1024",
  quality: ImageQuality = "low",
): Promise<string> {
  const provider = imageProviderName();
  if (provider === "pollinations") {
    return generatePollinationsImage(prompt, size);
  }
  return generateOpenAIImage(prompt, size, quality);
}

// ---------------------------------------------------------------------------
// Pollinations.ai Flux endpoint
// ---------------------------------------------------------------------------
// Public HTTP GET, no API key. Returns a JPEG/PNG body. We convert to base64
// to keep the same return shape as the OpenAI path so the route handler
// doesn't have to branch on provider.
//
// Notes:
//   - `model=flux`     uses the Flux-dev family (best quality on the free
//                      endpoint right now; Flux-schnell is faster but lower
//                      quality and not exposed by default).
//   - `nologo=true`    drops the watermark badge.
//   - `private=true`   keeps the image off the public feed.
//   - `enhance=true`   lets the upstream rewrite the prompt for better
//                      composition; harmless for our prompts and helps
//                      especially on shorter "vibe" descriptions.
//   - `safe=false`     disables the upstream safety filter. Required for
//                      mature-mode prompts; the contentPolicy gate decides
//                      whether the *prompt itself* is permissive in the
//                      first place. Locked-mode prompts are safe by
//                      construction (the safety prefix is still prepended
//                      by the route handler).
//   - 30s timeout      Pollinations can take 8-25s on busy nodes. Anything
//                      past 30s is dead — we surface the error so the
//                      route's error path runs (Ashley says "couldn't get
//                      the shot, try a different vibe") instead of
//                      blocking the response forever.
// ---------------------------------------------------------------------------

const POLLINATIONS_TIMEOUT_MS = 30_000;

async function generatePollinationsImage(
  prompt: string,
  size: ImageSize,
): Promise<string> {
  const [wStr, hStr] = size.split("x");
  const width = Number(wStr);
  const height = Number(hStr);
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    model: "flux",
    nologo: "true",
    private: "true",
    enhance: "true",
    safe: "false",
  });
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POLLINATIONS_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const bodyPreview = await res
        .text()
        .then((t) => t.slice(0, 200))
        .catch(() => "");
      throw new Error(
        `Pollinations returned HTTP ${res.status}: ${bodyPreview}`,
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) {
      throw new Error("Pollinations returned empty body");
    }
    return buf.toString("base64");
  } catch (err) {
    logger.warn(
      { err, urlSig: url.slice(0, 80) },
      "Pollinations image generation failed",
    );
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
