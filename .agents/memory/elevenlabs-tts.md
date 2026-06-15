---
name: ElevenLabs TTS provider
description: How TTS is routed, the auto-speak pattern, and why the 600-char cap was removed.
---

## Architecture

`synthesizeTts()` in `artifacts/api-server/src/routes/chat.ts` routes:
- **ElevenLabs** (`eleven_turbo_v2_5`) when `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` env vars are set — ~300ms to first byte, fast and full-length
- **OpenAI tts-1** fallback otherwise — can hit 30s+ if Replit proxy forces the gpt-audio chat-completions path

Implementation: `artifacts/api-server/src/lib/elevenlabs.ts`

Secrets needed: `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` (both from Ashley V2 project)

## Key decisions

**600-char cap removed**: Was truncating to ~600 chars (≈1 min of speech) in both `/chat/tts` and `/messages/:messageId/speech`. Removed entirely. Schema max raised to 5000 chars (ElevenLabs per-request limit). OpenAI fallback caps at 4096 naturally via its own API.

**Auto-speak**: `handleStreamOutcome` in `chat.tsx` calls `speakMessageRef.current(id, content)` on `outcome.kind === "done"`. Uses a ref so the callback dep array stays stable (no re-creation on every render). No profile toggle — always on, same as Ashley V2 behaviour.

**`stripForTts`**: Both routes now call `stripForTts()` from `openai.ts` (exported) instead of inline regex. The function handles bold, italic, stage directions, and backticks — don't duplicate this logic inline.

**Why:** OpenAI gpt-audio fallback was causing ~30s startup lag. ElevenLabs turbo is the only realistic real-time path for long replies. The 600-char cap was a latency guard for the slow OpenAI path — no longer needed.
