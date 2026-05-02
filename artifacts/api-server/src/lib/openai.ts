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
