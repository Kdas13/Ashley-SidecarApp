// ---------------------------------------------------------------------------
// elevenlabsStream.ts — Streaming ElevenLabs TTS adapter for voice calls.
//
// EXISTING elevenlabs.ts IS FROZEN. Do NOT modify it.
// This file is the NEW streaming-only adapter used by the voice-call route.
//
// Streams MP3 audio chunks from the ElevenLabs /stream endpoint using the
// same model and voice as the existing batch function.
//
// The binary frame ownership protocol (speech_start / tts_done / speechId
// per-chunk check) lives in routes/voice-call.ts, not here — this file is
// a pure HTTP-streaming adapter.
//
// Required env vars: ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID
// ---------------------------------------------------------------------------

import { logger } from "./logger.js";

const ELEVENLABS_API = "https://api.elevenlabs.io/v1";

/**
 * Stream MP3 audio chunks for the given text using ElevenLabs turbo model.
 *
 * Yields Buffer chunks as they arrive from the HTTP response body.
 * Throws if the API returns a non-2xx status or the response body is null.
 * Respects the optional AbortSignal — the for-await caller will see an
 * AbortError if the signal fires mid-stream.
 */
export async function* streamSpeechElevenLabs(
  text: string,
  signal?: AbortSignal,
): AsyncGenerator<Buffer, void, void> {
  const apiKey = process.env["ELEVENLABS_API_KEY"];
  const voiceId = process.env["ELEVENLABS_VOICE_ID"];
  if (!apiKey || !voiceId) {
    throw new Error(
      "ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID must both be set as secrets",
    );
  }

  const url = `${ELEVENLABS_API}/text-to-speech/${voiceId}/stream`;

  logger.debug(
    { textLen: text.length, voiceId },
    "elevenlabsStream: starting request",
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_turbo_v2_5",
      output_format: "mp3_44100_128",
    }),
    signal,
  });

  if (!response.ok) {
    const msg = await response.text().catch(() => response.statusText);
    throw new Error(`ElevenLabs stream error ${response.status}: ${msg}`);
  }

  if (!response.body) {
    throw new Error("ElevenLabs stream: response body is null");
  }

  const reader = response.body.getReader();
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        totalBytes += value.length;
        yield Buffer.from(value);
      }
    }
    logger.debug(
      { totalBytes },
      "elevenlabsStream: stream complete",
    );
  } finally {
    reader.releaseLock();
  }
}
