import { GoogleGenAI } from "@google/genai";

let cached: GoogleGenAI | null = null;

export function getGemini(): GoogleGenAI {
  if (cached) return cached;
  if (!process.env.AI_INTEGRATIONS_GEMINI_BASE_URL) {
    throw new Error(
      "AI_INTEGRATIONS_GEMINI_BASE_URL must be set to use the Gemini chat lane (ASHLEY_TEXT_PROVIDER=gemini). Provision the Gemini AI integration.",
    );
  }
  if (!process.env.AI_INTEGRATIONS_GEMINI_API_KEY) {
    throw new Error(
      "AI_INTEGRATIONS_GEMINI_API_KEY must be set to use the Gemini chat lane (ASHLEY_TEXT_PROVIDER=gemini). Provision the Gemini AI integration.",
    );
  }
  cached = new GoogleGenAI({
    apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY,
    httpOptions: {
      apiVersion: "",
      baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL,
    },
  });
  return cached;
}
