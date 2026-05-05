import { useCallback, useEffect, useReducer, useRef } from "react";

/**
 * Presence Loop — Stage 1
 *
 * A small finite-state machine that drives the *adaptive presence signals*
 * shown around Ashley's chat bubble: the gentle "I'm here…" while she's
 * formulating a reply, the unforced "take your time" after a long
 * monologue, and the "connection dipped…" notice when the stream stalls.
 *
 * The reducer is pure: every signal is *earned* by entering a state and
 * sitting there long enough for a timer to fire. Side effects live in the
 * `useEffect` block at the bottom of the hook (timers + dispatch); the
 * caller never has to manage those.
 *
 * Kane's locked-in behaviour rules (from docs/presence-loop.md):
 *   - One-shot per state entry: re-entering `thinking` resets the
 *     "I'm here…" eligibility, but a single thinking period emits at
 *     most one of those signals. Same goes for "take your time" in
 *     `waiting` and "connection dipped…" in `speaking`.
 *   - Continue is the *primary* recovery action on interrupted bubbles;
 *     Retry is the secondary. The reducer doesn't render those — the
 *     chat screen does — but it tracks `interrupted` as a first-class
 *     state so the stop button can flip back to send.
 *   - Watchdog fires CONNECTION_DIP at ~7s of silence on the SSE
 *     stream. The chat screen acts on it (auto-retries once); the
 *     reducer's job is just to emit the signal so the user sees a
 *     reason for the pause.
 */

export type PresenceState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "waiting"
  | "interrupted";

export type PresenceSignal = {
  /** Unique per emission; use as React key + dedupe handle. */
  key: string;
  type: "im_here" | "take_your_time" | "connection_dip";
  message: string;
  /** Date.now() when the reducer emitted this; used by the UI for fade. */
  emittedAt: number;
};

export type PresenceEvent =
  | { type: "OPEN_CHAT" }
  | { type: "USER_TYPING" }
  | { type: "USER_CLEAR_DRAFT" }
  | { type: "USER_SEND" }
  | { type: "USER_INTERRUPT" }
  | { type: "STREAM_FIRST_TOKEN" }
  | { type: "STREAM_END"; replyLength: number }
  | { type: "STREAM_INTERRUPTED_RECEIVED" }
  | { type: "WAITING_TIMEOUT" }
  | { type: "THINKING_TIMEOUT" }
  | { type: "CONNECTION_DIP" }
  | { type: "CONNECTION_RESTORED" }
  | { type: "DISMISS_SIGNAL"; key: string }
  | { type: "RESET" };

type PresenceInternal = {
  state: PresenceState;
  /** Date.now() when we entered the current state. */
  enteredAt: number;
  /** Length of the most recent finished Ashley reply, used to gate take-your-time. */
  lastReplyLength: number;
  /** Has the current state-entry already emitted its one-shot signal? */
  oneShotFired: boolean;
  signals: PresenceSignal[];
  signalSeq: number;
};

const TAKE_YOUR_TIME_MIN_REPLY_CHARS = 40;

const initialState: PresenceInternal = {
  state: "idle",
  enteredAt: 0,
  lastReplyLength: 0,
  oneShotFired: false,
  signals: [],
  signalSeq: 0,
};

function pushSignal(
  s: PresenceInternal,
  type: PresenceSignal["type"],
  message: string,
): PresenceInternal {
  const next: PresenceSignal = {
    key: `sig-${type}-${s.signalSeq + 1}`,
    type,
    message,
    emittedAt: Date.now(),
  };
  return {
    ...s,
    signalSeq: s.signalSeq + 1,
    signals: [...s.signals, next],
    oneShotFired: true,
  };
}

function transition(
  s: PresenceInternal,
  state: PresenceState,
): PresenceInternal {
  return {
    ...s,
    state,
    enteredAt: Date.now(),
    oneShotFired: false,
  };
}

export function presenceReducer(
  s: PresenceInternal,
  e: PresenceEvent,
): PresenceInternal {
  switch (e.type) {
    case "OPEN_CHAT":
      return transition(s, "idle");

    case "USER_TYPING":
      // "listening" is just a label for "user has a draft going". We never
      // emit a signal here — Ashley should never narrate that she's
      // watching the typing indicator.
      if (s.state === "listening") return s;
      // Don't yank a streaming reply out from under the user just because
      // they started typing the next message — that's a real UX pattern
      // for chats that overlap.
      if (s.state === "thinking" || s.state === "speaking") return s;
      return transition(s, "listening");

    case "USER_CLEAR_DRAFT":
      // Falling out of "listening" goes back to idle (or whatever recovery
      // state — "interrupted" should stick so the Continue button stays).
      if (s.state === "listening") return transition(s, "idle");
      return s;

    case "USER_SEND":
      return transition(s, "thinking");

    case "USER_INTERRUPT":
      // The actual stop action is dispatched by the chat screen; the
      // reducer's job is to flip the surface state so the stop button
      // turns back into a send button immediately. The server's
      // `interrupted` event will arrive next and we'll receive
      // STREAM_INTERRUPTED_RECEIVED to canonicalize the state.
      if (s.state === "thinking" || s.state === "speaking") {
        return transition(s, "interrupted");
      }
      return s;

    case "STREAM_FIRST_TOKEN":
      if (s.state !== "thinking") return s;
      return transition(s, "speaking");

    case "STREAM_END":
      return {
        ...transition(s, "waiting"),
        lastReplyLength: e.replyLength,
      };

    case "STREAM_INTERRUPTED_RECEIVED":
      return transition(s, "interrupted");

    case "THINKING_TIMEOUT":
      // 3s without a first token while in `thinking` → emit "I'm here…".
      // One-shot: re-entering thinking resets `oneShotFired`.
      if (s.state !== "thinking" || s.oneShotFired) return s;
      return pushSignal(s, "im_here", "I'm here…");

    case "WAITING_TIMEOUT":
      // 12s of silence after a long-ish Ashley reply while in `waiting` →
      // emit "take your time". Short replies don't earn this signal —
      // it would feel pushy.
      if (
        s.state !== "waiting" ||
        s.oneShotFired ||
        s.lastReplyLength < TAKE_YOUR_TIME_MIN_REPLY_CHARS
      ) {
        return s;
      }
      return pushSignal(s, "take_your_time", "take your time");

    case "CONNECTION_DIP":
      // ~7s of zero deltas while in `speaking` → connection has plausibly
      // dipped. Emit one signal per dip so we don't carpet the screen
      // if the network is genuinely down. The chat screen does the
      // auto-retry side effect.
      if (s.state !== "speaking" || s.oneShotFired) return s;
      return pushSignal(s, "connection_dip", "connection dipped…");

    case "CONNECTION_RESTORED":
      // Just re-arm the one-shot so a subsequent dip can fire again.
      return { ...s, oneShotFired: false };

    case "DISMISS_SIGNAL":
      return {
        ...s,
        signals: s.signals.filter((sig) => sig.key !== e.key),
      };

    case "RESET":
      return initialState;
  }
}

export type UsePresenceLoop = {
  state: PresenceState;
  signals: PresenceSignal[];
  dispatch: (e: PresenceEvent) => void;
  /**
   * Mark a delta as just arrived from the SSE stream. Resets the
   * watchdog timer so a long *quiet* gap fires CONNECTION_DIP, but a
   * steady trickle of tokens does not.
   */
  noteDelta: () => void;
};

const THINKING_DELAY_MS = 3000;
const WAITING_DELAY_MS = 12_000;
const WATCHDOG_DELAY_MS = 7000;

export function usePresenceLoop(): UsePresenceLoop {
  const [internal, dispatch] = useReducer(presenceReducer, initialState);

  // Last time a delta arrived — drives the watchdog. We keep it in a ref
  // so resetting it (on every delta) doesn't trigger a re-render.
  const lastDeltaAtRef = useRef<number>(0);
  const noteDelta = useCallback(() => {
    lastDeltaAtRef.current = Date.now();
    // Re-arm the dip signal: if a new dip comes later, we want to be
    // able to surface it.
    dispatch({ type: "CONNECTION_RESTORED" });
  }, []);

  // ----- Adaptive timers -------------------------------------------------
  // Each timer is keyed off (state, enteredAt) so it resets cleanly on
  // every transition. We deliberately don't put any logic inside these
  // timers — they just dispatch; the reducer decides whether the
  // moment still qualifies.
  useEffect(() => {
    if (internal.state === "thinking") {
      const t = setTimeout(
        () => dispatch({ type: "THINKING_TIMEOUT" }),
        THINKING_DELAY_MS,
      );
      return () => clearTimeout(t);
    }
    if (internal.state === "waiting") {
      const t = setTimeout(
        () => dispatch({ type: "WAITING_TIMEOUT" }),
        WAITING_DELAY_MS,
      );
      return () => clearTimeout(t);
    }
    return undefined;
  }, [internal.state, internal.enteredAt]);

  // ----- Stream watchdog -------------------------------------------------
  // While speaking, poll every 1s and dispatch CONNECTION_DIP if the
  // last delta is older than the threshold. The reducer no-ops the
  // event if a dip signal is already on screen.
  useEffect(() => {
    if (internal.state !== "speaking") return undefined;
    lastDeltaAtRef.current = Date.now();
    const interval = setInterval(() => {
      const since = Date.now() - lastDeltaAtRef.current;
      if (since >= WATCHDOG_DELAY_MS) {
        dispatch({ type: "CONNECTION_DIP" });
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [internal.state, internal.enteredAt]);

  return {
    state: internal.state,
    signals: internal.signals,
    dispatch,
    noteDelta,
  };
}
