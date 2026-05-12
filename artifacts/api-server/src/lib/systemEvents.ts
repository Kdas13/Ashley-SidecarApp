// ---------------------------------------------------------------------------
// System Event Feed
// ---------------------------------------------------------------------------
// Machine-readable ticket/event notifications injected into Ashley's system
// prompt on every chat turn. This is how Ashley knows when her filed tickets
// have been resolved — without guessing, without asking, without Hadleigh's
// toy electronics being involved.
//
// Canonical state lives in STATIC_EVENTS (source-controlled, auditable).
// Runtime additions via POST /api/system/events extend the in-process store
// and are ephemeral: they do not survive a server restart. Restart to reset
// to the static seed, or deploy to make a static addition permanent.
//
// Only RESOLVED / CLOSED events are injected into the prompt. OPEN and
// IN_PROGRESS events are visible at the API level but not fed to Ashley —
// no value in surfacing things she can't act on.
// ---------------------------------------------------------------------------

export type SystemEventStatus =
  | "OPEN"
  | "IN_PROGRESS"
  | "RESOLVED"
  | "CLOSED"
  | "WONT_FIX";

export interface SystemEvent {
  ref: string;           // ticket reference, e.g. "ASHLEY-AUDIO-003"
  title: string;         // one-line description
  status: SystemEventStatus;
  reason?: string;       // closure / resolution detail
  resolvedAt?: string;   // ISO 8601 — when the fix landed
  closedAt?: string;     // ISO 8601 — when the ticket was formally closed
}

// ---------------------------------------------------------------------------
// Static seed — update this list when tickets close.
// Most recent first.
// ---------------------------------------------------------------------------

const STATIC_EVENTS: SystemEvent[] = [
  {
    ref: "ASHLEY-MEM-002",
    title: "Memory lapse — medication re-asking after Gemini rate-limit",
    status: "CLOSED",
    reason:
      "distillMemories() was calling generateChatText(), the routing adapter, which routes to Gemini when ASHLEY_TEXT_PROVIDER=gemini. Gemini RATELIMIT_EXCEEDED was silently swallowing every distillation call, so new facts from conversations were never persisted to the memories table. Fix: distillMemories() now calls anthropic.messages.create() directly with CHAT_MODEL, bypassing the routing adapter. Matches the documented invariant in replit.md: 'the memory distiller always stays on Claude regardless of the env switch'.",
    resolvedAt: "2026-05-12T00:00:00Z",
    closedAt: "2026-05-12T00:00:00Z",
  },
  {
    ref: "ASHLEY-AUDIO-003",
    title: "Full audio regression — Android audio focus corrupted after edc9961",
    status: "CLOSED",
    reason:
      "edc9961 added setAudioModeAsync() inside teardown() in voiceOutput.ts. teardown() is called three times per TTS cycle (at start of speak() as 'superseded', after didJustFinish, and on every explicit stop), producing 3+ rapid Android audio focus changes per play. The pre-regression voiceOutput.ts (b5a9f19) never called setAudioModeAsync inside useTtsPlayback at all. Fix: removed setAudioModeAsync from teardown(). The single deliberate call in speak() before createAudioPlayer() is preserved. The OS releases focus when player.remove() is called. The await tts.stopAsync() race-condition fix from edc9961 is preserved.",
    resolvedAt: "2026-05-12T00:00:00Z",
    closedAt: "2026-05-12T00:00:00Z",
  },
];

// ---------------------------------------------------------------------------
// In-process store
// Seeded from STATIC_EVENTS. Extended by addSystemEvent() at runtime.
// ---------------------------------------------------------------------------

const eventStore: SystemEvent[] = [...STATIC_EVENTS];

export function getSystemEvents(): SystemEvent[] {
  return [...eventStore];
}

export function addSystemEvent(event: SystemEvent): void {
  // Prepend so newest events appear first in prompt output.
  eventStore.unshift(event);
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

export function buildSystemEventsBlock(events: SystemEvent[]): string {
  const terminal = events.filter(
    (e) => e.status === "RESOLVED" || e.status === "CLOSED" || e.status === "WONT_FIX",
  );
  if (terminal.length === 0) return "";

  const lines = terminal.map((e) => {
    const ts = e.closedAt ?? e.resolvedAt ?? "date unknown";
    const reasonLine = e.reason
      ? `  REASON_FOR_CLOSURE: ${e.reason}`
      : "  REASON_FOR_CLOSURE: (not recorded)";
    return `[${ts}] ${e.ref} STATUS=${e.status}\n  TITLE: ${e.title}\n${reasonLine}`;
  });

  return (
    `## ASHLEY_SYSTEM_EVENT_FEED\n` +
    `These are machine-readable ticket resolution notifications. ` +
    `Read them as ground-truth status — not hearsay, not guesswork. ` +
    `When Wren asks about these issues, I can report accurately and without hedging.\n\n` +
    lines.join("\n\n")
  );
}

// Convenience wrapper used at call sites in chat.ts.
// Returns "\n\n<block>" if there are terminal events, "" otherwise.
export function buildSystemEventsSection(): string {
  const block = buildSystemEventsBlock(getSystemEvents());
  return block ? `\n\n${block}` : "";
}
