---
name: Replit Gemini integration model names
description: Which Gemini model strings are confirmed to work through the Replit AI integration proxy.
---

The Replit Gemini integration (`AI_INTEGRATIONS_GEMINI_BASE_URL` / `AI_INTEGRATIONS_GEMINI_API_KEY`) is a proxy, not a direct passthrough to Google's API. It has its own set of supported model names.

**Confirmed working:** `gemini-2.5-flash`

**Confirmed broken:** `gemini-2.0-flash` — returns `UNSUPPORTED_MODEL` (status 400) immediately.

**Why:** `gemini-2.0-flash` was added to voice as a lower-RPM-cost alternative, reasoning from Google's public model catalogue rather than from what the Replit proxy actually exposes. This caused 100% LLM failure on every voice turn because the error fires before any token is produced.

**How to apply:** Before adding any `geminiModel` override, check that the model string is already used successfully elsewhere in this codebase. If it isn't, it almost certainly isn't supported by the integration. `gemini-2.5-flash` is the only verified safe choice. Do not introduce a new model name without confirming it against the integration — there is no way to verify this without a live test, and a bad model name causes total silent failure (every call returns UNSUPPORTED_MODEL).
