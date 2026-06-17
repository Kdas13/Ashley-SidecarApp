// ---------------------------------------------------------------------------
// AudioClipRegistry.ts — P1-4 Stage 7: pre-generated ElevenLabs audio clips.
//
// Clips are generated once at server startup via ElevenLabs and cached to
// disk at assets/audio/. Startup is non-blocking — if keys are absent or
// generation fails the registry holds empty Buffers and runtime falls back
// to the text TTS path.
//
// SHA256 checksums gate disk cache validity. On mismatch: regenerate.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { streamSpeechElevenLabs } from "./elevenlabsStream.js";
import { logger } from "./logger.js";

export type ClipName =
  | "thinking"
  | "say-that-again"
  | "gone-quiet"
  | "call-dropped";

const CLIP_TEXTS: Record<ClipName, string> = {
  "thinking":       "Hang on, I'm thinking...",
  "say-that-again": "Sorry, say that again?",
  "gone-quiet":     "You've gone quiet — everything okay?",
  "call-dropped":   "Sorry about that — looks like we dropped. Where were we?",
};

const clips = new Map<ClipName, Buffer>();

const AUDIO_DIR = join(process.cwd(), "assets", "audio");

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function generateBufferFromElevenLabs(text: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of streamSpeechElevenLabs(text)) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function loadOrGenerateClip(name: ClipName): Promise<Buffer | null> {
  const filePath     = join(AUDIO_DIR, `${name}.mp3`);
  const checksumPath = join(AUDIO_DIR, `${name}.sha256`);
  const text         = CLIP_TEXTS[name];

  // Try disk cache first.
  try {
    const existing          = await readFile(filePath);
    const storedChecksum    = (await readFile(checksumPath, "utf8").catch(() => "")).trim();
    const computedChecksum  = createHash("sha256").update(existing).digest("hex");

    if (storedChecksum === computedChecksum && existing.byteLength > 0) {
      logger.info({ clip: name, bytes: existing.byteLength }, "AudioClipRegistry: loaded from disk");
      return existing;
    }
    logger.warn({ clip: name }, "AudioClipRegistry: checksum mismatch — regenerating");
  } catch {
    // File absent — fall through to generation.
  }

  // Generate from ElevenLabs.
  let buf: Buffer;
  try {
    buf = await generateBufferFromElevenLabs(text);
  } catch (err) {
    logger.warn({ err, clip: name }, "AudioClipRegistry: ElevenLabs generation failed");
    return null;
  }

  if (buf.byteLength === 0) {
    logger.warn({ clip: name }, "AudioClipRegistry: ElevenLabs returned empty buffer");
    return null;
  }

  // Write to disk (best-effort — failure is non-fatal).
  try {
    await mkdir(AUDIO_DIR, { recursive: true });
    const checksum = createHash("sha256").update(buf).digest("hex");
    await writeFile(filePath, buf);
    await writeFile(checksumPath, checksum, "utf8");
    logger.info({ clip: name, bytes: buf.byteLength }, "AudioClipRegistry: clip saved to disk");
  } catch (diskErr) {
    logger.warn({ err: diskErr, clip: name }, "AudioClipRegistry: failed to write clip to disk — in-memory only");
  }

  return buf;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Called once at server startup. Non-blocking — errors are logged, not thrown.
 * Server starts normally whether or not clips are successfully generated.
 */
export async function initialize(): Promise<void> {
  const apiKey  = process.env["ELEVENLABS_API_KEY"];
  const voiceId = process.env["ELEVENLABS_VOICE_ID"];

  if (!apiKey || !voiceId) {
    logger.warn(
      "AudioClipRegistry: ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID not set — " +
      "all clips unavailable; runtime will fall back to text TTS",
    );
    return;
  }

  const names = Object.keys(CLIP_TEXTS) as ClipName[];
  const results = await Promise.allSettled(names.map((n) => loadOrGenerateClip(n)));

  let loaded = 0;
  for (let i = 0; i < names.length; i++) {
    const result = results[i];
    const name   = names[i];
    if (result.status === "fulfilled" && result.value && result.value.byteLength > 0) {
      clips.set(name, result.value);
      loaded++;
    } else if (result.status === "rejected") {
      logger.warn({ clip: name, reason: result.reason }, "AudioClipRegistry: clip failed to load");
    }
  }

  logger.info({ loaded, total: names.length }, "AudioClipRegistry: initialised");
}

/**
 * Return the pre-generated audio Buffer for a clip.
 * Returns Buffer.alloc(0) if the clip is not available.
 */
export function getClipBuffer(name: ClipName): Buffer {
  return clips.get(name) ?? Buffer.alloc(0);
}

/**
 * Returns true only if a non-empty clip Buffer is registered.
 */
export function hasClip(name: ClipName): boolean {
  const buf = clips.get(name);
  return buf !== undefined && buf.byteLength > 0;
}
