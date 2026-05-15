import { useEffect, useReducer, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  loadMessages,
  saveMessages,
  withStorageLock,
  STORAGE_KEYS,
  newId,
  type Message,
  type ReplyToRef,
} from "./storage";
import {
  abortStream,
  clearChatOnServer,
  fetchSelfieForMessage,
  fetchState,
  markImageRemembered,
  sendChatImage,
  sendChatMessage,
  streamAshleyReply,
  type RememberDecision,
  type StreamReplyMeta,
  type StreamReplyOutcome,
} from "./aiClient";
import type { ImageAnalysisMode, ImageCategory } from "./storage";

const MESSAGES_KEY = ["messages"] as const;
const SUMMARIES_KEY = ["summaries"] as const;

// ---------------------------------------------------------------------------
// Query — server-backed, with AsyncStorage as a startup cache so the chat
// has SOMETHING to render before the network responds.
// ---------------------------------------------------------------------------

export function useMessages() {
  return useQuery({
    queryKey: MESSAGES_KEY,
    queryFn: async (): Promise<Message[]> => {
      try {
        const state = await fetchState();
        await withStorageLock(STORAGE_KEYS.messages, () =>
          saveMessages(state.messages),
        );
        return state.messages;
      } catch (err) {
        const cached = await loadMessages();
        if (cached.length > 0) return cached;
        throw err;
      }
    },
    // Bootstrap pre-seeds this query via `setQueryData(["messages"], …)`
    // before the chat screen mounts. Without a staleTime, the chat
    // screen's observer treats the seeded data as stale and immediately
    // refetches /api/state in parallel with whatever the bootstrap is
    // still doing (e.g. the on-app-open greeting). That parallel refetch
    // can land AFTER the greeting splice and overwrite it with a stale
    // server snapshot taken before the greeting was persisted. A short
    // staleTime suppresses the redundant mount refetch while still
    // letting deliberate invalidations (push receive, send completes,
    // greeting splice) refresh the list.
    staleTime: 30_000,
  });
}

async function patchInCache(
  qc: ReturnType<typeof useQueryClient>,
  id: string,
  patch: Partial<Omit<Message, "id">>,
): Promise<void> {
  const previous = qc.getQueryData<Message[]>(MESSAGES_KEY) ?? [];
  const next = previous.map((m) => (m.id === id ? { ...m, ...patch } : m));
  qc.setQueryData(MESSAGES_KEY, next);
  await withStorageLock(STORAGE_KEYS.messages, () => saveMessages(next));
}

// ---------------------------------------------------------------------------
// Send — POST /chat round-trips both the user message and Ashley's reply.
// ---------------------------------------------------------------------------

export type SendMessageResult = {
  user: Message;
  ashley: Message | null;
};

export function useSendMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      arg: string | { content: string; replyTo?: ReplyToRef | null },
    ): Promise<SendMessageResult> => {
      const content = typeof arg === "string" ? arg : arg.content;
      const replyTo = typeof arg === "string" ? null : arg.replyTo ?? null;
      const userId = newId();

      // 1. Optimistic insert so the user's bubble appears instantly.
      const optimisticUser: Message = {
        id: userId,
        role: "user",
        content,
        createdAt: new Date().toISOString(),
        replyTo,
      };
      const previous = qc.getQueryData<Message[]>(MESSAGES_KEY) ?? [];
      const optimisticList = [...previous, optimisticUser];
      qc.setQueryData(MESSAGES_KEY, optimisticList);
      await withStorageLock(STORAGE_KEYS.messages, () =>
        saveMessages(optimisticList),
      );

      // 2. Round-trip to the server. Server uses our id for the user
      //    message (idempotent) and assigns its own id to Ashley's reply.
      let response: { userMessage: Message; ashleyMessage: Message };
      try {
        response = await sendChatMessage({
          id: userId,
          content,
          ...(replyTo ? { replyTo } : {}),
        });
      } catch (err) {
        // Leave the optimistic user bubble in place so retry works.
        throw err instanceof Error ? err : new Error("Could not send message");
      }

      // 3. Reconcile: the server is authoritative on createdAt and on the
      //    user message metadata. Replace ours, append Ashley's.
      const next = [
        ...previous,
        response.userMessage,
        response.ashleyMessage,
      ];
      qc.setQueryData(MESSAGES_KEY, next);
      await withStorageLock(STORAGE_KEYS.messages, () => saveMessages(next));

      // The server may have rolled up older messages into a new summary
      // as a side effect — refresh that query so the memories screen
      // stays current.
      qc.invalidateQueries({ queryKey: SUMMARIES_KEY });

      // 4. If Ashley wanted to send selfie(s), kick off generation in the
      //    background. Multi-image path fires N jobs in parallel.
      if (response.ashleyMessage.selfieVibeList && response.ashleyMessage.selfieVibeList.length > 1) {
        void fetchAndAttachSelfieList(
          qc,
          response.ashleyMessage.id,
          response.ashleyMessage.selfieVibeList,
        );
      } else if (response.ashleyMessage.selfieVibe) {
        void fetchAndAttachSelfie(
          qc,
          response.ashleyMessage.id,
          response.ashleyMessage.selfieVibe,
        );
      }

      return { user: response.userMessage, ashley: response.ashleyMessage };
    },
    onError: () => {
      qc.invalidateQueries({ queryKey: MESSAGES_KEY });
    },
  });
}

// ---------------------------------------------------------------------------
// Presence Loop — Stage 1
//
// useStreamMessage / useContinueMessage open an SSE stream against
// /chat/stream (see lib/aiClient.ts → streamAshleyReply) and apply each
// `meta` / `delta` / `done` / `interrupted` event to the React Query cache
// so the chat bubble fills in live as Anthropic produces tokens.
//
// Cache write strategy:
//   - On `meta`: synchronously insert (or replace) the user + ashley rows.
//                Ashley row carries `status: "streaming"` and empty content.
//   - On `delta`: APPEND to a buffer ref; the actual cache update is
//                throttled to ~30ms intervals so 50 deltas/sec don't
//                trigger 50 React re-renders (a real concern at Sonnet's
//                streaming rate). The flush always commits the entire
//                buffered text, so no chunk is dropped.
//   - On `done` / `interrupted` / `error`: flush any pending delta
//                immediately, then write the terminal status + content.
//   - AsyncStorage write happens ONLY on the terminal event — the live
//                deltas don't touch disk.
//
// Stop / abort:
//   - useStopStream(streamId) calls abortStream() server-side AND fires
//                the local AbortController so the SSE fetch unwinds
//                immediately. Server-side abort is the source of truth
//                for the persisted partial.
//
// Active-stream registry: useActiveStream() lets the chat screen subscribe
// to "is something streaming right now?" so it can swap the send button to
// stop in-place. Module-level so it survives mutation re-renders.
// ---------------------------------------------------------------------------

const DELTA_FLUSH_MS = 30;

type ActiveStream = {
  streamId: string;
  mode: "new" | "continue";
} | null;

const inFlightStreamControllers = new Map<string, AbortController>();
let activeStream: ActiveStream = null;
const activeStreamListeners = new Set<() => void>();

function setActiveStream(next: ActiveStream): void {
  activeStream = next;
  for (const l of activeStreamListeners) l();
}

/**
 * Clear `activeStream` ONLY if it still references the streamId we own.
 *
 * The unconditional `setActiveStream(null)` pattern races during the
 * connection-dip auto-retry path: the original stream's `finally` can
 * fire AFTER the continuation's `onMeta` has already populated
 * `activeStream` with the new id, wiping the stop button mid-stream
 * and leaving the user with no way to interrupt the live continuation.
 * Gating on identity makes the clear safe to call from any unwind path.
 */
function clearActiveStreamIfOwned(streamId: string | undefined): void {
  if (!streamId) return;
  if (activeStream?.streamId === streamId) {
    setActiveStream(null);
  }
}

export function useActiveStream(): ActiveStream {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const listener = () => force();
    activeStreamListeners.add(listener);
    return () => {
      activeStreamListeners.delete(listener);
    };
  }, []);
  return activeStream;
}

/**
 * Persist the current cache snapshot to AsyncStorage. Call this on
 * terminal stream events only; the streaming-delta path skips disk
 * writes entirely.
 */
async function persistCacheSnapshot(
  qc: ReturnType<typeof useQueryClient>,
): Promise<void> {
  const snapshot = qc.getQueryData<Message[]>(MESSAGES_KEY) ?? [];
  await withStorageLock(STORAGE_KEYS.messages, () => saveMessages(snapshot));
}

/** Optional presence-loop hooks the chat screen wires into the stream. */
export type StreamHooks = {
  /** Fires once, on the first non-empty delta. Drives STREAM_FIRST_TOKEN. */
  onFirstDelta?: () => void;
  /** Fires on every delta arrival. Drives the watchdog timer reset. */
  onDeltaArrived?: () => void;
};

type RunStreamArgs = {
  qc: ReturnType<typeof useQueryClient>;
  optimisticUserId: string | null;
  optimisticAshleyId: string | null;
  // Either newTurn OR continueFromMessageId — exactly one.
  newTurn?: { id: string; content: string; replyTo?: ReplyToRef | null };
  continueFromMessageId?: string;
  controller: AbortController;
  hooks?: StreamHooks;
  /** Forwarded to the server for in-flight deduplication. */
  requestId?: string;
};

/**
 * Shared streaming engine used by both useStreamMessage and
 * useContinueMessage. Wires the SSE callbacks into the React Query cache.
 */
async function runStream(args: RunStreamArgs): Promise<StreamReplyOutcome> {
  const { qc, optimisticUserId, optimisticAshleyId, controller, hooks } = args;
  // Capture requestId once — used for ownership guards throughout this closure.
  const currentRequestId = args.requestId ?? null;
  let ashleyId: string | null = null;
  // Fresh per-invocation accumulator — never shared across runStream calls.
  let pendingDelta = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let firstDeltaSeen = false;

  console.log(
    "[runStream] open  requestId:", currentRequestId,
    "optimisticAshleyId:", optimisticAshleyId,
    "pendingDelta reset to ''",
  );

  const flushNow = (): void => {
    if (!ashleyId || pendingDelta.length === 0) return;
    const chunk = pendingDelta;
    pendingDelta = "";
    const previous = qc.getQueryData<Message[]>(MESSAGES_KEY) ?? [];
    const next = previous.map((m) => {
      if (m.id !== ashleyId) return m;
      // Hard guard 1: never append to a completed message — it is immutable.
      if (m.status === "complete") {
        console.warn(
          "[runStream] flushNow DROP (message complete) requestId:", currentRequestId,
          "ashleyId:", ashleyId,
        );
        return m;
      }
      // Hard guard 2: if the row carries a requestId that doesn't match this
      // stream, another runStream owns it — drop to prevent cross-stream bleed.
      if (currentRequestId && m.requestId && m.requestId !== currentRequestId) {
        console.warn(
          "[runStream] flushNow DROP (requestId mismatch) expected:", currentRequestId,
          "got:", m.requestId, "ashleyId:", ashleyId,
        );
        return m;
      }
      return { ...m, content: (m.content ?? "") + chunk };
    });
    qc.setQueryData(MESSAGES_KEY, next);
  };

  const cancelFlush = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  const scheduleFlush = (): void => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushNow();
    }, DELTA_FLUSH_MS);
  };

  const outcome = await streamAshleyReply(
    args.newTurn
      ? { newTurn: args.newTurn, requestId: args.requestId }
      : { continueFromMessageId: args.continueFromMessageId! },
    {
      onMeta: (meta: StreamReplyMeta) => {
        ashleyId = meta.ashleyMessage.id;
        console.log(
          "[runStream] meta  requestId:", currentRequestId,
          "ashleyId:", ashleyId,
        );
        setActiveStream({ streamId: meta.streamId, mode: meta.mode });
        // Register the local AbortController against the real streamId
        // *before* we start handling deltas so useStopStream() can find
        // and abort it the instant the user taps stop. (Registering only
        // on `done` would create a window where stop has no effect.)
        inFlightStreamControllers.set(meta.streamId, controller);

        // Reconcile the optimistic rows with the server-authoritative
        // rows. The user row keeps the same id (server is idempotent),
        // but the Ashley row is brand new. For continue mode there is
        // no user row to reconcile.
        const previous = qc.getQueryData<Message[]>(MESSAGES_KEY) ?? [];
        const filtered = previous.filter((m) => {
          if (optimisticAshleyId && m.id === optimisticAshleyId) return false;
          // For new-turn mode we also drop the optimistic user row so
          // we can reinsert it with the server's authoritative metadata
          // (createdAt etc.). Continue mode never inserts an optimistic
          // user row, so this is a no-op there.
          if (
            optimisticUserId &&
            m.id === optimisticUserId &&
            meta.userMessage &&
            meta.userMessage.id === optimisticUserId
          ) {
            return false;
          }
          return true;
        });
        const additions: Message[] = [];
        if (meta.userMessage) additions.push(meta.userMessage);
        // Stamp the server-authoritative Ashley row with this stream's
        // requestId so ownership guards in flushNow/onDone can verify it.
        const taggedAshley: Message = currentRequestId
          ? { ...meta.ashleyMessage, requestId: currentRequestId }
          : meta.ashleyMessage;
        additions.push(taggedAshley);
        qc.setQueryData(MESSAGES_KEY, [...filtered, ...additions]);
      },
      onDelta: (text: string) => {
        if (!firstDeltaSeen) {
          firstDeltaSeen = true;
          hooks?.onFirstDelta?.();
        }
        hooks?.onDeltaArrived?.();
        pendingDelta += text;
        scheduleFlush();
      },
      onDone: ({ content, selfieVibe, selfieVibeList, visualPacketId }) => {
        cancelFlush();
        pendingDelta = "";
        if (!ashleyId) return;
        console.log(
          "[runStream] done  requestId:", currentRequestId,
          "ashleyId:", ashleyId,
          "content length:", content.length,
        );
        const previous = qc.getQueryData<Message[]>(MESSAGES_KEY) ?? [];
        const next = previous.map((m) => {
          if (m.id !== ashleyId) return m;
          // Guard: once complete, the message is immutable.
          if (m.status === "complete") {
            console.warn(
              "[runStream] onDone DROP (already complete) requestId:", currentRequestId,
              "ashleyId:", ashleyId,
            );
            return m;
          }
          // Guard: ownership check — only write if this stream owns the row.
          if (currentRequestId && m.requestId && m.requestId !== currentRequestId) {
            console.warn(
              "[runStream] onDone DROP (requestId mismatch) expected:", currentRequestId,
              "got:", m.requestId,
            );
            return m;
          }
          return {
            ...m,
            content,
            status: "complete" as const,
            selfieVibe: selfieVibe ?? m.selfieVibe ?? null,
            selfieVibeList: selfieVibeList ?? m.selfieVibeList ?? null,
            visualPacketId: visualPacketId ?? m.visualPacketId ?? null,
          };
        });
        qc.setQueryData(MESSAGES_KEY, next);
      },
      onInterrupted: ({ partialContent }) => {
        cancelFlush();
        pendingDelta = "";
        if (!ashleyId) return;
        console.log(
          "[runStream] interrupted requestId:", currentRequestId,
          "ashleyId:", ashleyId,
        );
        const previous = qc.getQueryData<Message[]>(MESSAGES_KEY) ?? [];
        const next = previous.map((m) => {
          if (m.id !== ashleyId) return m;
          // Guard: don't downgrade a completed message.
          if (m.status === "complete") return m;
          // Guard: ownership check.
          if (currentRequestId && m.requestId && m.requestId !== currentRequestId) return m;
          // If the server told us a partial, prefer it (it's authoritative
          // — written from the same accumulated buffer the SSE wrote
          // out). Otherwise keep whatever deltas we'd already applied.
          const finalContent =
            partialContent.length > 0 ? partialContent : (m.content ?? "");
          return {
            ...m,
            content: finalContent,
            status: "interrupted" as const,
          };
        });
        qc.setQueryData(MESSAGES_KEY, next);
      },
      onError: () => {
        cancelFlush();
        pendingDelta = "";
        // Mirror onInterrupted's cache shape so the UI can offer
        // Continue/Retry on errored streams too.
        if (!ashleyId) return;
        console.log(
          "[runStream] error requestId:", currentRequestId,
          "ashleyId:", ashleyId,
        );
        const previous = qc.getQueryData<Message[]>(MESSAGES_KEY) ?? [];
        const next = previous.map((m) => {
          if (m.id !== ashleyId) return m;
          // Guard: don't downgrade a completed message.
          if (m.status === "complete") return m;
          // Guard: ownership check.
          if (currentRequestId && m.requestId && m.requestId !== currentRequestId) return m;
          return { ...m, status: "interrupted" as const };
        });
        qc.setQueryData(MESSAGES_KEY, next);
      },
    },
    { signal: controller.signal },
  );

  cancelFlush();
  // Final safety flush: in the rare case `done` arrived with no fresh
  // content (pure cancel) but we'd buffered some deltas, get them onto
  // the bubble before we hand control back.
  flushNow();
  console.log(
    "[runStream] close requestId:", currentRequestId,
    "ashleyId:", ashleyId,
    "outcome:", outcome.kind,
  );
  return outcome;
}

export type StreamMessageArg =
  | string
  | {
      content: string;
      replyTo?: ReplyToRef | null;
      hooks?: StreamHooks;
      /** Unique id for this logical send — reused on retries so the server
       *  can detect and reject in-flight duplicate requests. */
      requestId?: string;
    };

export function useStreamMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      arg: StreamMessageArg,
    ): Promise<{ user: Message; ashley: Message | null; outcome: StreamReplyOutcome }> => {
      const content = typeof arg === "string" ? arg : arg.content;
      const replyTo = typeof arg === "string" ? null : arg.replyTo ?? null;
      const hooks = typeof arg === "string" ? undefined : arg.hooks;
      const requestId = typeof arg === "string" ? undefined : arg.requestId;
      const userId = newId();
      const optimisticAshleyId = `optimistic-ashley-${userId}`;

      // 1. Optimistic insert: user bubble + an empty Ashley bubble in
      //    "streaming" state so the typing indicator is in-place from
      //    frame zero. The server-authoritative ids replace these on
      //    the meta event.
      const optimisticUser: Message = {
        id: userId,
        role: "user",
        content,
        createdAt: new Date().toISOString(),
        replyTo,
        status: "complete",
      };
      const optimisticAshley: Message = {
        id: optimisticAshleyId,
        role: "ashley",
        content: "",
        createdAt: new Date(Date.now() + 1).toISOString(),
        status: "streaming",
        // Stamp the requestId so flushNow/onDone can verify ownership even
        // before onMeta fires and replaces this row with the server version.
        ...(requestId ? { requestId } : {}),
      };
      const previous = qc.getQueryData<Message[]>(MESSAGES_KEY) ?? [];
      qc.setQueryData(MESSAGES_KEY, [
        ...previous,
        optimisticUser,
        optimisticAshley,
      ]);

      // 2. Open the SSE stream with a local AbortController so the
      //    stop button can cancel it. runStream registers this against
      //    the streamId on the meta event, so useStopStream can find
      //    it for the duration of the stream.
      const ac = new AbortController();
      let outcome: StreamReplyOutcome | undefined;
      try {
        outcome = await runStream({
          qc,
          optimisticUserId: userId,
          optimisticAshleyId,
          newTurn: { id: userId, content, replyTo },
          controller: ac,
          ...(requestId ? { requestId } : {}),
          ...(hooks ? { hooks } : {}),
        });
      } catch (err) {
        // Don't clear activeStream here — the finally below handles it
        // safely (and unconditional clears race the auto-retry path).
        throw err instanceof Error ? err : new Error("Stream failed");
      } finally {
        if (outcome?.meta) {
          inFlightStreamControllers.delete(outcome.meta.streamId);
          clearActiveStreamIfOwned(outcome.meta.streamId);
        } else {
          // Meta event never arrived (network failure on the POST,
          // server 4xx/5xx, runtime without ReadableStream, etc.).
          // The optimistic Ashley row therefore was never replaced
          // by the server-authoritative one — strip it from cache
          // so the user isn't left staring at a permanent empty
          // bubble with the streaming cursor and no recovery
          // affordance. The user's outgoing message is preserved
          // so they can simply re-send.
          qc.setQueryData<Message[]>(MESSAGES_KEY, (prev) =>
            (prev ?? []).filter((m) => m.id !== optimisticAshleyId),
          );
        }
      }

      // Persist final state to disk + invalidate side queries.
      await persistCacheSnapshot(qc);
      qc.invalidateQueries({ queryKey: SUMMARIES_KEY });

      const finalAshleyMeta = outcome.meta;
      const finalAshley = finalAshleyMeta
        ? (qc.getQueryData<Message[]>(MESSAGES_KEY) ?? []).find(
            (m) => m.id === finalAshleyMeta.ashleyMessage.id,
          ) ?? null
        : null;

      // Selfie kickoff — only on a clean done with a vibe.
      if (outcome.kind === "done" && finalAshley) {
        if (outcome.final.selfieVibeList && outcome.final.selfieVibeList.length > 1) {
          void fetchAndAttachSelfieList(qc, finalAshley.id, outcome.final.selfieVibeList);
        } else if (outcome.final.selfieVibe) {
          void fetchAndAttachSelfie(qc, finalAshley.id, outcome.final.selfieVibe);
        }
      }

      // Surface a real error to the mutation so the UI banner shows.
      if (outcome.kind === "error") {
        throw outcome.error;
      }

      const finalUser = outcome.meta?.userMessage ?? optimisticUser;
      return { user: finalUser, ashley: finalAshley, outcome };
    },
    // No onError handler — the mutationFn's finally already does the
    // safe (id-guarded) cleanup, and an unconditional clear here would
    // race the connection-dip auto-retry continuation.
  });
}

export type ContinueMessageArg =
  | string
  | { continueFromMessageId: string; hooks?: StreamHooks };

/**
 * Resume an interrupted Ashley reply. The interrupted bubble is left in
 * place; the server returns a fresh Ashley row containing the continuation.
 */
export function useContinueMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      arg: ContinueMessageArg,
    ): Promise<{ ashley: Message | null; outcome: StreamReplyOutcome }> => {
      const continueFromMessageId =
        typeof arg === "string" ? arg : arg.continueFromMessageId;
      const hooks = typeof arg === "string" ? undefined : arg.hooks;
      const ac = new AbortController();
      let outcome: StreamReplyOutcome | undefined;
      try {
        outcome = await runStream({
          qc,
          optimisticUserId: null,
          optimisticAshleyId: null,
          continueFromMessageId,
          controller: ac,
          ...(hooks ? { hooks } : {}),
        });
      } finally {
        if (outcome?.meta) {
          inFlightStreamControllers.delete(outcome.meta.streamId);
          clearActiveStreamIfOwned(outcome.meta.streamId);
        }
        // No-op when meta never arrived — we never set activeStream,
        // so there's nothing to clear. Continue mode never inserts an
        // optimistic Ashley row either (the partial-bubble lives on
        // its own pre-existing row), so no cache surgery is needed.
      }

      await persistCacheSnapshot(qc);
      qc.invalidateQueries({ queryKey: SUMMARIES_KEY });

      const finalAshleyMeta = outcome.meta;
      const finalAshley = finalAshleyMeta
        ? (qc.getQueryData<Message[]>(MESSAGES_KEY) ?? []).find(
            (m) => m.id === finalAshleyMeta.ashleyMessage.id,
          ) ?? null
        : null;

      if (outcome.kind === "done" && finalAshley) {
        if (outcome.final.selfieVibeList && outcome.final.selfieVibeList.length > 1) {
          void fetchAndAttachSelfieList(qc, finalAshley.id, outcome.final.selfieVibeList);
        } else if (outcome.final.selfieVibe) {
          void fetchAndAttachSelfie(qc, finalAshley.id, outcome.final.selfieVibe);
        }
      }

      if (outcome.kind === "error") {
        throw outcome.error;
      }

      return { ashley: finalAshley, outcome };
    },
    // No onError — the mutationFn's finally handles cleanup safely
    // without the activeStream-clobber race.
  });
}

/**
 * Stop a live SSE chat stream both client-side (abort the fetch) and
 * server-side (POST /chat/stream/:id/abort so Anthropic stops billing
 * for tokens we'll never use). Idempotent — safe to call multiple times
 * or against a streamId that already finished.
 */
export function useStopStream() {
  return useMutation({
    mutationFn: async (streamId: string): Promise<void> => {
      // Local abort kicks the SSE fetch out of its read loop immediately
      // so the UI can flip out of streaming state without waiting for
      // the server's TCP RST to arrive.
      const ctrl = inFlightStreamControllers.get(streamId);
      if (ctrl) {
        try {
          ctrl.abort();
        } catch {
          // Ignore — abort() is idempotent and only throws on really
          // exotic runtimes.
        }
      }
      // Server-side abort is the source of truth for "the partial has
      // been persisted with status=interrupted". Best-effort; if it
      // fails (e.g. the server already finished) the boot recovery /
      // /state hydration will fix the row.
      try {
        await abortStream(streamId);
      } catch {
        // Swallow — the local abort already fired.
      }
    },
  });
}

/**
 * Re-issue Ashley's reply for a trailing user message that never got one
 * (because the previous send mutation failed mid-way). The server is
 * idempotent on the user message id, so resending the same id+content
 * returns the existing user row plus a fresh Ashley reply.
 */
export function useRetryUnansweredReply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<Message | null> => {
      const all = qc.getQueryData<Message[]>(MESSAGES_KEY) ?? (await loadMessages());
      if (all.length === 0) return null;
      const tail = all[all.length - 1]!;
      if (tail.role !== "user") return null;

      const response = await sendChatMessage({
        id: tail.id,
        content: tail.content,
        ...(tail.replyTo ? { replyTo: tail.replyTo } : {}),
      });

      const next = [...all.slice(0, -1), response.userMessage, response.ashleyMessage];
      qc.setQueryData(MESSAGES_KEY, next);
      await withStorageLock(STORAGE_KEYS.messages, () => saveMessages(next));
      qc.invalidateQueries({ queryKey: SUMMARIES_KEY });

      if (response.ashleyMessage.selfieVibeList && response.ashleyMessage.selfieVibeList.length > 1) {
        void fetchAndAttachSelfieList(
          qc,
          response.ashleyMessage.id,
          response.ashleyMessage.selfieVibeList,
        );
      } else if (response.ashleyMessage.selfieVibe) {
        void fetchAndAttachSelfie(
          qc,
          response.ashleyMessage.id,
          response.ashleyMessage.selfieVibe,
        );
      }
      return response.ashleyMessage;
    },
  });
}

// ---------------------------------------------------------------------------
// Image upload (paperclip flow) — POST /chat/image
// ---------------------------------------------------------------------------

export type SendImageArgs = {
  uri: string;
  base64: string;
  mimeType: string;
  category: ImageCategory;
  mode: ImageAnalysisMode;
  caption: string;
  replyTo?: ReplyToRef | null;
};

export function useSendImage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: SendImageArgs): Promise<SendMessageResult> => {
      const userId = newId();
      // Optimistic insert: show the local file:// URI in the user's bubble
      // immediately so the chat doesn't appear frozen during upload.
      const optimisticUser: Message = {
        id: userId,
        role: "user",
        content: args.caption ?? "",
        createdAt: new Date().toISOString(),
        imageUrl: args.uri,
        imageMimeType: args.mimeType,
        imageCategory: args.category,
        imageCaption: args.caption,
        imageAnalysisMode: args.mode,
        imageRemembered: null,
        replyTo: args.replyTo ?? null,
      };
      const previous = qc.getQueryData<Message[]>(MESSAGES_KEY) ?? [];
      const optimisticList = [...previous, optimisticUser];
      // Optimistic update is in-memory only — we deliberately do NOT
      // write the file:// URI to AsyncStorage. If the upload succeeds
      // we persist the server's public URL below; if it fails or the
      // app is killed mid-upload, the cache resets cleanly on next boot.
      qc.setQueryData(MESSAGES_KEY, optimisticList);

      let response: { userMessage: Message; ashleyMessage: Message };
      try {
        response = await sendChatImage({
          id: userId,
          base64: args.base64,
          mimeType: args.mimeType,
          category: args.category,
          mode: args.mode,
          caption: args.caption,
          ...(args.replyTo ? { replyTo: args.replyTo } : {}),
        });
      } catch (err) {
        throw err instanceof Error ? err : new Error("Could not send image");
      }

      const next = [
        ...previous,
        response.userMessage,
        response.ashleyMessage,
      ];
      qc.setQueryData(MESSAGES_KEY, next);
      await withStorageLock(STORAGE_KEYS.messages, () => saveMessages(next));
      qc.invalidateQueries({ queryKey: SUMMARIES_KEY });

      return { user: response.userMessage, ashley: response.ashleyMessage };
    },
    onError: () => {
      qc.invalidateQueries({ queryKey: MESSAGES_KEY });
    },
  });
}

export function useMarkImageRemembered() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      messageId: string;
      decision: RememberDecision;
    }): Promise<Message> => {
      const updated = await markImageRemembered(args.messageId, args.decision);
      await patchInCache(qc, args.messageId, {
        imageRemembered: updated.imageRemembered ?? null,
      });
      // The "remember" / "visual" decisions create a new memory server-side,
      // so refresh that query to keep the memories screen current.
      if (args.decision !== "dismiss") {
        qc.invalidateQueries({ queryKey: ["memories"] });
      }
      return updated;
    },
  });
}

export function useClearMessages() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      await clearChatOnServer();
      qc.setQueryData(MESSAGES_KEY, []);
      qc.setQueryData(SUMMARIES_KEY, []);
      await withStorageLock(STORAGE_KEYS.messages, () => saveMessages([]));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: MESSAGES_KEY });
      qc.invalidateQueries({ queryKey: SUMMARIES_KEY });
    },
  });
}

// ---------------------------------------------------------------------------
// Selfies — kick off, poll, patch the message bubble in place
// ---------------------------------------------------------------------------

const SELFIE_AUTO_RETRY_ATTEMPTS = 3;
const SELFIE_AUTO_RETRY_DELAY_MS = 4000;

// Module-level registry of messageIds whose selfie is currently being
// generated/polled. Shared by BOTH the auto-attach (fired right after
// /chat returns a selfieVibe) and the manual retry button so they
// (a) dedup against each other and (b) drive a "taking a selfie…"
// indicator in the bubble while in flight. Components subscribe via
// useSelfieInFlight().
const inFlightSelfies = new Set<string>();
const inFlightListeners = new Set<() => void>();

function setInFlight(messageId: string, value: boolean): void {
  if (value) inFlightSelfies.add(messageId);
  else inFlightSelfies.delete(messageId);
  for (const l of inFlightListeners) l();
}

export function useSelfieInFlight(messageId: string): boolean {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const listener = () => force();
    inFlightListeners.add(listener);
    return () => {
      inFlightListeners.delete(listener);
    };
  }, []);
  return inFlightSelfies.has(messageId);
}

export async function fetchAndAttachSelfie(
  qc: ReturnType<typeof useQueryClient>,
  messageId: string,
  vibe: string,
): Promise<void> {
  if (inFlightSelfies.has(messageId)) return;
  setInFlight(messageId, true);
  try {
    for (let attempt = 0; attempt < SELFIE_AUTO_RETRY_ATTEMPTS; attempt++) {
      try {
        const imageUrl = await fetchSelfieForMessage(messageId, vibe);
        await patchInCache(qc, messageId, { imageUrl, selfieVibe: null });
        return;
      } catch {
        if (attempt < SELFIE_AUTO_RETRY_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, SELFIE_AUTO_RETRY_DELAY_MS));
        }
      }
    }
    // Leave selfieVibe in place so the bubble surfaces a manual retry button.
  } finally {
    setInFlight(messageId, false);
  }
}

/**
 * Fetch all selfies for a multi-image packet and patch them into the cache
 * as an `imageUrls` array. All jobs are fired in parallel; on partial failure
 * the resolved URLs are still stored so the gallery can render what arrived.
 */
export async function fetchAndAttachSelfieList(
  qc: ReturnType<typeof useQueryClient>,
  messageId: string,
  vibeList: string[],
): Promise<void> {
  if (vibeList.length === 0) return;
  if (inFlightSelfies.has(messageId)) return;
  setInFlight(messageId, true);
  try {
    const settled = await Promise.allSettled(
      vibeList.map((vibe, i) => fetchSelfieForMessage(messageId, vibe, i)),
    );
    const imageUrls = settled
      .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
      .map((r) => r.value);
    if (imageUrls.length > 0) {
      await patchInCache(qc, messageId, {
        imageUrls,
        imageUrl: imageUrls[0] ?? null,
        selfieVibe: null,
        selfieVibeList: null,
      });
    }
    // If ALL failed, leave selfieVibeList in place so the retry button shows.
  } finally {
    setInFlight(messageId, false);
  }
}

export function useRetrySelfie(): {
  retry: (messageId: string, vibe: string) => Promise<void>;
} {
  const qc = useQueryClient();
  return {
    retry: async (messageId: string, vibe: string) => {
      if (inFlightSelfies.has(messageId)) return;
      setInFlight(messageId, true);
      try {
        const imageUrl = await fetchSelfieForMessage(messageId, vibe);
        await patchInCache(qc, messageId, { imageUrl, selfieVibe: null });
      } finally {
        setInFlight(messageId, false);
      }
    },
  };
}

export const messagesQueryKey = MESSAGES_KEY;
