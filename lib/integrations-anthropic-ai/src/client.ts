import Anthropic from "@anthropic-ai/sdk";

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error(
    "ANTHROPIC_API_KEY must be set. Add it to Replit Secrets.",
  );
}

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  // baseURL deliberately omitted — SDK uses https://api.anthropic.com by default.
  // Do not point this at AI_INTEGRATIONS_ANTHROPIC_BASE_URL: that variable
  // resolves to localhost:1106, a proxy that only exists inside the Replit
  // editor session and is unreachable in production.
});
