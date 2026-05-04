import OpenAI from "openai";

if (!process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"]) {
  throw new Error(
    "AI_INTEGRATIONS_OPENAI_BASE_URL must be set. Did you forget to provision the OpenAI AI integration?",
  );
}

if (!process.env["AI_INTEGRATIONS_OPENAI_API_KEY"]) {
  throw new Error(
    "AI_INTEGRATIONS_OPENAI_API_KEY must be set. Did you forget to provision the OpenAI AI integration?",
  );
}

export const openai = new OpenAI({
  apiKey: process.env["AI_INTEGRATIONS_OPENAI_API_KEY"],
  baseURL: process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"],
});

/**
 * Transcribe a base64-encoded audio blob via OpenAI Whisper.
 * Stage 1 of the staged voice plan — see contentPolicy.ts for the
 * future voice-presence safety floor that will gate Stages 4-5.
 *
 * The OpenAI SDK's audio.transcriptions.create accepts a File-like
 * object; we wrap the decoded buffer with the official `toFile` helper
 * so multipart upload is handled by the SDK.
 *
 * @param audioBase64 raw base64 (no data: URL prefix)
 * @param filename    used by Whisper to detect format (e.g. "speech.m4a")
 * @param mimeType    e.g. "audio/m4a", "audio/mp4", "audio/wav"
 */
export async function transcribeAudioBase64(
  audioBase64: string,
  filename: string,
  mimeType: string,
): Promise<string> {
  const buf = Buffer.from(audioBase64, "base64");
  const { toFile } = await import("openai");
  const file = await toFile(buf, filename, { type: mimeType });
  // Note: the Replit OpenAI integration proxy doesn't support the legacy
  // "whisper-1" model — use the gpt-4o transcription family instead.
  // gpt-4o-mini-transcribe is fast, cheap, and accurate for short clips.
  const response = await openai.audio.transcriptions.create({
    file,
    model: "gpt-4o-mini-transcribe",
    // Stage 5 hook: when tone-awareness ships, switch to gpt-4o-transcribe
    // (or a verbose_json-capable model) so the prompt builder can carry
    // pause/hesitation/segment cues into the voice-presence safety floor.
  });
  return (response.text ?? "").trim();
}

/**
 * Stage 2 streaming variant. Returns an async iterable of events so the
 * route can pipe partial transcripts down to the client over SSE while
 * the model is still producing text. Push-to-talk semantics unchanged —
 * the audio still arrives as a single base64 blob; only the *response*
 * is streamed so the user doesn't sit in silence after releasing the mic.
 *
 * Events:
 *   { kind: "delta", text }  — an incremental chunk to append client-side
 *   { kind: "done",  text }  — final full transcript (authoritative)
 *
 * Note: gpt-4o-mini-transcribe and gpt-4o-transcribe both support
 * streaming. The legacy whisper-1 model does not.
 */
export async function* transcribeAudioBase64Stream(
  audioBase64: string,
  filename: string,
  mimeType: string,
): AsyncGenerator<
  { kind: "delta"; text: string } | { kind: "done"; text: string },
  void,
  void
> {
  const buf = Buffer.from(audioBase64, "base64");
  const { toFile } = await import("openai");
  const file = await toFile(buf, filename, { type: mimeType });
  const stream = await openai.audio.transcriptions.create({
    file,
    model: "gpt-4o-mini-transcribe",
    stream: true,
  });
  let finalText = "";
  for await (const event of stream as AsyncIterable<unknown>) {
    // The SDK's typed events differ slightly across versions, so we
    // pluck the fields defensively rather than narrowing on a brand.
    const e = event as { type?: string; delta?: string; text?: string };
    if (e.type === "transcript.text.delta") {
      const delta = typeof e.delta === "string" ? e.delta : "";
      if (delta.length > 0) {
        finalText += delta;
        yield { kind: "delta", text: delta };
      }
    } else if (e.type === "transcript.text.done") {
      const text = typeof e.text === "string" ? e.text : finalText;
      yield { kind: "done", text: text.trim() };
      return;
    }
  }
  // If the upstream closed without a done event, emit our accumulated
  // text so the client still gets a final transcript.
  yield { kind: "done", text: finalText.trim() };
}

export async function generateImageBase64(
  prompt: string,
  size: "1024x1024" | "1024x1536" | "1536x1024" = "1024x1536",
): Promise<string> {
  const response = await openai.images.generate({
    model: "gpt-image-1",
    prompt,
    size,
    n: 1,
  });
  const b64 = response.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("OpenAI image generation returned no data");
  }
  return b64;
}
