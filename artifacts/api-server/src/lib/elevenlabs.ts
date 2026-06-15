// ---------------------------------------------------------------------------
// ElevenLabs TTS — synthesise spoken audio for Ashley's replies.
//
// Uses the streaming-friendly /text-to-speech/{voice_id} endpoint with
// eleven_turbo_v2_5 (fastest model, ~300ms to first byte, full-length
// support up to 5 000 chars). Returns raw MP3 bytes as a Buffer.
//
// Required env vars (must be set as Replit secrets):
//   ELEVENLABS_API_KEY   — ElevenLabs API key
//   ELEVENLABS_VOICE_ID  — voice clone / preset ID (e.g. Ashley's voice)
//
// Callers: routes/chat.ts synthesizeTts()
// ---------------------------------------------------------------------------

const ELEVENLABS_API = "https://api.elevenlabs.io/v1";

export async function synthesizeSpeechElevenLabs(
  text: string,
): Promise<Buffer> {
  const apiKey = process.env["ELEVENLABS_API_KEY"];
  const voiceId = process.env["ELEVENLABS_VOICE_ID"];
  if (!apiKey || !voiceId) {
    throw new Error(
      "ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID must both be set as secrets",
    );
  }

  const response = await fetch(
    `${ELEVENLABS_API}/text-to-speech/${voiceId}`,
    {
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
    },
  );

  if (!response.ok) {
    const msg = await response.text().catch(() => response.statusText);
    throw new Error(
      `ElevenLabs TTS error ${response.status}: ${msg}`,
    );
  }

  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length === 0) {
    throw new Error("ElevenLabs returned an empty audio buffer");
  }
  return buf;
}
