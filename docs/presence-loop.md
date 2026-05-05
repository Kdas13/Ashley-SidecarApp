# Presence Loop — staged architecture

Plan for moving Ashley off a strict turn-based request/response model and toward
something that *feels* present: she starts replying as soon as she has the first
word, the user can stop her mid-sentence, and small "I'm here" signals keep the
conversation alive between turns. Live voice (mic, VAD, barge-in, TTS) is
explicitly **not** Stage 1 work, but Stage 1 is designed so it can land cleanly
later without a rewrite.

## Goal

Today the chat is strictly request → wait → reply. We want a chat that:

1. Streams Ashley's text to the screen as it's generated (no more "stare at a
   spinner for 3 seconds" gap).
2. Lets the user tap a stop button to interrupt her mid-response, with
   server-side cancellation of the underlying LLM call.
3. Shows lightweight presence signals ("I'm here", "I'm following", "Take your
   time") at the right moments so silence doesn't feel like absence.
4. Has a single, coherent state model — the **Presence Loop** — that future
   voice/proactive features plug into instead of growing parallel state.

## Today's chat flow (ground truth, post-investigation)

| Concern | Current behavior |
|---|---|
| Endpoint mobile calls | `POST /api/chat` (stateful, writes to `messagesTable`). The legacy stateless `/api/chat/reply` from V1.1 is no longer the primary path despite what `replit.md` says. |
| LLM call | Single-shot `await anthropic.messages.create(...)` in `routes/chat.ts:375`. Whole reply text accumulated then inserted as one DB row at line 417. |
| Streaming | None for chat. Voice transcription DOES already use SSE via `expo/fetch` (`aiClient.ts:389`), so the stack is proven — we just haven't applied it to chat. |
| Cancel/abort | None on chat path. No `AbortController` is wired into the Anthropic call. Client disconnect doesn't stop generation. Transcription has a manual `aborted` flag but it doesn't propagate to the SDK either. |
| Pending UI | Optimistic user bubble appears instantly. There's no "Ashley is typing…" indicator anymore (it was removed when text replies got fast). Only selfies show a "taking a selfie…" placeholder bubble. |
| Selfie precedent | Selfies use the async-job + polling pattern that future-state Ashley features can borrow from: insert message row early with `selfieVibe` set + `imageUrl` null, kick off background work, patch the row when done. |

The "insert row early, patch later" pattern from selfies is the seed for how
streaming will work — except the patches are continuous.

## The Presence Loop state machine

A single client-side state machine drives the chat UI. Server events feed in
as inputs; the machine never blocks on the network synchronously. States:

```
              user starts typing
   ┌────────────────────────────────────────┐
   │                                        ▼
[idle] ──open chat──> [listening] ──send──> [thinking]
   ▲                       ▲                    │
   │                       │                    │ first token arrives
   │                       │                    ▼
   │                       └─── done ─── [speaking]
   │                                          │
   │             ┌────── timeout ───────[waiting]
   │             ▼                            ▲
   └─── timeout ─                              │ user types again
                                              │
   any of {thinking, speaking} ─stop tap─> [interrupted] ─cooldown─> [idle]
```

State definitions (kept identical for Stages 1 → 3 so future features just add
new event sources, not new states):

| State | Stage 1 meaning | Stage 2+ meaning |
|---|---|---|
| `idle` | App at rest, no draft, no in-flight reply. | Same. Mic closed. |
| `listening` | User is typing (draft has content) OR composing audio. | Mic open, VAD running, capturing user speech. |
| `thinking` | Server has the request, no first token yet. | Same. |
| `speaking` | Tokens are streaming into the latest Ashley bubble. | Tokens streaming AND/OR TTS playing audio. |
| `waiting` | Reply finished, conversation is "warm" — Ashley is available but inactive. Triggers presence signals. | Same. Triggers proactive check-ins. |
| `interrupted` | User just tapped stop. Brief "Ashley paused." UI, then return to idle. | Same — also entered on barge-in (user starts speaking while Ashley is). |

Two design rules that protect future stages:

- **Events in, not procedure calls.** Anything that wants to drive a transition
  dispatches an event (`USER_SEND`, `STREAM_FIRST_TOKEN`, `STREAM_END`,
  `USER_INTERRUPT`, `WAITING_TIMEOUT_5S`, ...). The machine never directly
  awaits a fetch. This means Stage 2 can plug a mic-VAD module and a TTS module
  in as additional event sources without restructuring.
- **One machine per chat session, not one per concern.** Don't build a separate
  "TTS state" or "mic state" later — they all dispatch into the same loop.
  Otherwise Stage 2 ends up with three machines fighting each other for the
  microphone.

## Stage 1 — what gets built now

### 1.1 Streaming chat endpoint (server)

- Add `POST /api/chat/stream` next to the existing `/api/chat`. Same request
  shape (`userMessage`, `clientNow`, `clientTimezone`). Returns `text/event-stream`.
- Inside the handler:
  1. Insert user row + Ashley row up front (Ashley row with `content=""`,
     `status="streaming"`). Get the Ashley row's `id` — this is the
     **streamId** the abort endpoint targets.
  2. Send an SSE `meta` event immediately: `{userMessage, ashleyMessageId,
     streamId}` so the client can render both bubbles before the first token.
  3. Call `anthropic.messages.stream({ ..., signal: ac.signal })` and forward
     each `text_delta` as an SSE `delta` event: `{text: "..."}`.
  4. On stream end: send `done` event with the final accumulated text, then
     `UPDATE messagesTable SET content=$final, status='complete' WHERE
     id=$ashleyId`. **Note: do the existing `[selfie:]` marker detection here
     too**, on the final text — selfie kickoff still happens as it does today.
  5. On abort (see below): send `interrupted` event with whatever partial text
     was accumulated, then `UPDATE messagesTable SET content=$partial,
     status='interrupted'`.
  6. Hook `req.on("close", () => ac.abort())` so a real client disconnect also
     kills the upstream Anthropic call.
- Add `messagesTable.status` column: `"complete" | "streaming" | "interrupted"`
  with default `"complete"` so existing rows are valid. Drizzle migration.
- Keep the old `POST /api/chat` route mounted unchanged — the streaming route
  is opt-in. Once the mobile client is fully on streaming we can deprecate it.

### 1.2 Abort endpoint (server)

- `POST /api/chat/stream/:streamId/abort`. Body: empty. Resolves an
  `AbortController` registered in an in-memory `Map<streamId, AbortController>`
  when the stream started, deletes the entry on stream end. Returns 200 even
  if the streamId is unknown (idempotent — the stream may have already
  finished naturally).
- Why a separate endpoint instead of relying on `req.on("close")`: in practice
  Replit's proxy + RN-fetch keep-alive can leave the upstream socket open for
  several seconds after the client thinks it's gone. Explicit abort makes
  cancellation feel instant.

### 1.3 Streaming client (mobile)

- New `streamAshleyReply(req, { onMeta, onDelta, onDone, onInterrupted, signal })`
  in `lib/aiClient.ts`. Mirrors the existing `transcribeAudioStream` SSE
  pattern (`expo/fetch`, manual line buffer, JSON-parse `data:` payloads).
- New `useStreamMessage` hook in `lib/useMessages.ts` that replaces the
  current `useSendMessage` for the streaming path:
  - Optimistic user bubble (same as today).
  - On `meta`: insert the Ashley bubble with `content=""` + `status="streaming"`.
  - On `delta`: append text to the Ashley bubble; React Query cache update is
    O(1) (no re-fetch).
  - On `done` / `interrupted`: finalize the bubble's content + status.
  - Holds an `AbortController` exposed to the UI so the stop button can both
    `controller.abort()` the local fetch AND POST the abort endpoint.

### 1.4 Presence Loop hook (mobile)

- `lib/usePresenceLoop.ts` — small reducer keyed by chat session.
  - `state: PresenceState`, `dispatch(event)`.
  - Owns three timers: `IDLE_TIMEOUT` (waiting → idle, ~30s), `WAITING_NUDGE`
    (waiting → "Take your time" signal, ~12s after a long Ashley message),
    `THINKING_NUDGE` (thinking → "I'm following" signal, ~3s with no first
    token). Timers are cleared on every transition.
  - Exposes `signals: PresenceSignal[]` — ephemeral UI-only nudges, NOT
    persisted to the messages log. The chat screen renders them as small
    italicized one-line bubbles that auto-fade after 4s.
- Drives the existing `tts.stop()` call on `USER_INTERRUPT` so when voice lands
  in Stage 2 the same event already does the right thing.

### 1.5 Chat screen wiring (mobile)

- `app/chat.tsx`:
  - Wire input bar to dispatch `USER_TYPING` / `USER_CLEAR_DRAFT`.
  - Send button becomes a **stop button** (square icon, same position) when
    `state ∈ {thinking, speaking}`. Tap → `dispatch({type: "USER_INTERRUPT"})`
    → triggers abort + UI banner "Ashley paused." for 2s.
  - Render `presenceSignals` as ephemeral bubbles below the latest message.
  - Streaming bubbles get a subtle pulsing cursor at the end of the text while
    `status="streaming"`. The existing inverted-FlatList layout doesn't change.

### 1.6 Stage 1 done definition

- User sends a message. Within ~400ms a "thinking" indicator appears. Within
  ~1s tokens start streaming into a bubble. User can tap stop at any point
  during streaming and the bubble freezes mid-sentence with "Ashley paused."
  shown briefly.
- If the user lingers without typing after a long Ashley reply, a faint "Take
  your time." nudge appears once and fades.
- If a thinking phase exceeds 3s without any tokens, "I'm following." appears
  once and fades when streaming starts.
- Server logs confirm the Anthropic stream actually aborts (no continued
  upstream usage after stop). DB row reflects either `complete` or
  `interrupted` with the right partial content.
- Old `POST /api/chat` still works (selfie auto-retry path doesn't break).

## Stage 2 — live voice (later, no code yet)

Architecture only, to make sure Stage 1 doesn't paint us into a corner.

- **Mic + VAD**: `useMicListener` module dispatches `USER_VOICE_START` /
  `USER_VOICE_END` / `USER_BARGE_IN` events into the same Presence Loop.
  `listening` state's "user is typing" check broadens to "user is typing OR
  mic is hot with voice." No new states needed.
- **STT**: existing `transcribeAudioStream` SSE pipeline already produces
  partial transcripts. Those become input to the same `useStreamMessage`
  flow — when the final transcript arrives, it dispatches `USER_SEND` with
  the transcribed content.
- **Barge-in**: `USER_VOICE_START` fired while `state === "speaking"` is
  identical to the Stage 1 stop button — both dispatch `USER_INTERRUPT`.
  The state machine handles them the same way.
- **TTS**: a `useTtsPlayback` module subscribes to `delta` events from the
  stream and pipes text to whatever TTS engine we choose. It dispatches
  `TTS_START` / `TTS_END` / `TTS_ABORTED`. The `speaking` state means
  "either tokens streaming or TTS playing or both"; transition out happens
  when both have ended.
- **Audio adapters behind interfaces**: `MicAdapter`, `TtsAdapter`,
  `SttAdapter` — so we can swap providers (OpenAI Realtime, Deepgram,
  ElevenLabs, etc.) without touching the loop.

## Stage 3 — proactive check-ins (later, no code yet)

- A server-side "presence worker" that, on a schedule, can decide Ashley
  should reach out first ("Hey — how did the meeting go?"). This requires:
  - **Server → client push**: a long-lived channel. Most likely a single SSE
    connection per device opened on app foreground that the server can write
    `presence` events into. Simpler than WebSockets and our SSE plumbing
    already exists.
  - The push event reuses the SAME state machine: it dispatches a new
    `SERVER_INITIATED_REPLY` event that transitions `idle → speaking` and
    inserts a streaming Ashley bubble exactly the way a user-initiated
    reply does. No new render path.
  - Memory + profile gates: don't ping during quiet hours, respect a
    per-device "max proactive messages per day" cap.

## Invariants to protect Stage 1 from breaking Stages 2 and 3

1. **The state machine is the only owner of UI mode.** Don't read `isLoading`
   from React Query directly in chat UI components — read `presenceState`.
   Otherwise Stage 2's mic and Stage 3's server push will need parallel UI
   wiring.
2. **All transitions are events, never raw promises.** Even Stage 1's
   `onDelta` callback dispatches `STREAM_DELTA`, it doesn't directly mutate
   UI mode.
3. **The streaming endpoint is the canonical chat endpoint going forward.**
   Stage 2 voice + Stage 3 push both produce text that flows through the
   same SSE-style `delta` events, not parallel pipelines.
4. **`messagesTable.status`** values stay backward-compatible additive only
   (`complete | streaming | interrupted`, never breaking the existing rows).
5. **Presence signals are ephemeral, not messages.** They live in component
   state and never hit `messagesTable`. Stage 3's proactive check-ins WILL
   be real messages — different concept.

## Decisions (locked in for Stage 1)

1. **Stop button**: in-place swap of send icon → stop icon (ChatGPT-style).
2. **Interrupted replies**: keep partial content, mark `status="interrupted"`,
   show a primary **Continue** action and a small secondary **Retry**. Default
   is Continue, not Regenerate.
   - **Continue protocol**: when the user taps Continue, the server takes the
     interrupted Ashley message's partial text, prepends it as a final
     `assistant` turn in the messages array, and adds a system-style nudge:
     *"Continue naturally from where you were, without repeating yourself or
     restarting the sentence."* The continuation streams as a new Ashley
     message; the original interrupted bubble stays in place above it. This
     preserves conversational flow and avoids restart artifacts.
3. **Presence signals**: adaptive, not periodic.
   - `thinking` for ~3s with no first token → "I'm here…" (one-shot).
   - `waiting` for ~10–12s after a long Ashley reply → "take your time"
     (one-shot).
   - No repeats unless the state actually transitions away and back.
4. **Stream watchdog**: per-stream, ~6–8s without a delta.
   - Mark stream as `unstable` (NOT a hard error).
   - Render a subtle inline "connection dipped…" status under the bubble.
   - Auto-retry once silently — re-open the SSE with the same `streamId`
     (server resumes by sending what's already accumulated, then continues).
   - If the retry also stalls, fall back to surfacing Continue / Retry
     actions on the (now interrupted) bubble — same affordance as decision 2.

## Risks

- **Anthropic SDK abort semantics**: need to confirm that passing `signal` to
  `messages.stream()` actually halts upstream billing, not just stops yielding
  to us. Spike before committing to the abort UX.
- **Replit proxy buffering**: SSE through some proxies can buffer chunks until
  the connection closes. Need to set `X-Accel-Buffering: no` and flush after
  each delta. The transcription stream already works through the proxy, which
  is encouraging.
- **Stale chat row on crash**: if the server crashes mid-stream, the Ashley
  row stays `status="streaming"` forever. On startup, run a one-time UPDATE
  that flips any orphan `streaming` rows to `interrupted`. Cheap.
