import { GoogleGenAI } from "@google/genai";

let cached: GoogleGenAI | null = null;

export function getGemini(): GoogleGenAI {
  if (cached) return cached;
  if (!process.env.GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY must be set to use the Gemini chat lane (ASHLEY_TEXT_PROVIDER=gemini). Add it to Replit Secrets.",
    );
  }
  cached = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    // httpOptions.baseUrl deliberately omitted — SDK uses Google's real endpoint
    // by default. Do not point this at AI_INTEGRATIONS_GEMINI_BASE_URL: that
    // variable resolves to localhost:1106, a proxy that only exists inside the
    // Replit editor session and is unreachable in production.
  });
  return cached;
}
