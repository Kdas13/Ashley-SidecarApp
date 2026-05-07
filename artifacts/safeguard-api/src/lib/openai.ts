import OpenAI from "openai";

const baseURL = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
const apiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];

if (!baseURL || !apiKey) {
  // eslint-disable-next-line no-console
  console.warn(
    "[safeguard-api] OpenAI integration env vars not set — translation/summary will fail.",
  );
}

export const openai = new OpenAI({
  apiKey: apiKey ?? "missing",
  baseURL: baseURL ?? undefined,
});

// Default model. Cheap + fast for translation + short summaries.
export const DEFAULT_MODEL = process.env["SAFEGUARD_OPENAI_MODEL"] ?? "gpt-4o-mini";
