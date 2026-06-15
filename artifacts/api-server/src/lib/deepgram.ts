// ---------------------------------------------------------------------------
// Deepgram STT — transcribe audio to text for the tap-to-talk pipeline.
//
// Uses the pre-recorded REST endpoint (nova-3 model) which typically
// returns in < 500ms for short voice clips — materially faster than the
// OpenAI gpt-4o-mini-transcribe path through the Replit proxy.
//
// Required env var: DEEPGRAM_API_KEY (Replit secret).
// Falls back to OpenAI Whisper in the route if this key is absent.
// ---------------------------------------------------------------------------

const DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen";

interface DeepgramResponse {
  results?: {
    channels?: Array<{
      alternatives?: Array<{ transcript?: string }>;
    }>;
  };
}

export async function transcribeWithDeepgram(
  audioBase64: string,
  mimeType: string,
): Promise<string> {
  const apiKey = process.env["DEEPGRAM_API_KEY"];
  if (!apiKey) {
    throw new Error("DEEPGRAM_API_KEY not set");
  }

  const audioBuffer = Buffer.from(audioBase64, "base64");

  const url = new URL(DEEPGRAM_LISTEN_URL);
  url.searchParams.set("model", "nova-3");
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("punctuate", "true");

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": mimeType,
    },
    body: audioBuffer,
  });

  if (!response.ok) {
    const msg = await response.text().catch(() => response.statusText);
    throw new Error(`Deepgram error ${response.status}: ${msg}`);
  }

  const data = (await response.json()) as DeepgramResponse;
  const transcript =
    data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
  return transcript.trim();
}
