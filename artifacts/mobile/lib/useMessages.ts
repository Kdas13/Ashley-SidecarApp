import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  STORAGE_KEYS,
  loadMessages,
  loadMemories,
  loadProfile,
  loadSummaries,
  patchMessage,
  saveMessages,
  saveSummaries,
  withStorageLock,
  newId,
  type AshleyProfile,
  type ConversationSummary,
  type Message,
  type ReplyToRef,
} from "./storage";
import {
  fetchAshleyReply,
  fetchAshleySelfie,
  fetchSummaryForChunk,
} from "./aiClient";

const MESSAGES_KEY = ["messages"] as const;
const SUMMARIES_KEY = ["summaries"] as const;

// Mirrors the server constants. Once the live conversation grows past
// HISTORY_WINDOW unsummarized messages, the oldest SUMMARY_CHUNK_SIZE get
// distilled into one rolling summary record so the long tail of the
// relationship doesn't disappear from Ashley's prompt. We trigger AT the
// window boundary (not past it) so no message ever falls into a dead zone
// where it's neither in the verbatim history slice nor covered by a
// summary.
const HISTORY_WINDOW = 80;
const SUMMARY_CHUNK_SIZE = 20;
const SUMMARY_TRIGGER = HISTORY_WINDOW;

export function useMessages() {
  return useQuery({
    queryKey: MESSAGES_KEY,
    queryFn: loadMessages,
  });
}

async function appendMessage(message: Message): Promise<Message[]> {
  return withStorageLock(STORAGE_KEYS.messages, async () => {
    const all = await loadMessages();
    const next = [...all, message];
    await saveMessages(next);
    return next;
  });
}

/**
 * Append `message` only if `parentId` is still the most recent message in
 * storage. Used to abort writing Ashley's reply when the user cleared the
 * conversation (or sent another message) while the request was in flight.
 * Returns the new full list, or null if the parent is no longer there.
 */
async function appendIfStillCurrent(
  parentId: string,
  message: Message,
): Promise<Message[] | null> {
  return withStorageLock(STORAGE_KEYS.messages, async () => {
    const all = await loadMessages();
    if (all.length === 0 || all[all.length - 1]!.id !== parentId) {
      return null;
    }
    const next = [...all, message];
    await saveMessages(next);
    return next;
  });
}

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
      // Accept either a bare string (no quote) or an object with replyTo.
      const content = typeof arg === "string" ? arg : arg.content;
      const replyTo = typeof arg === "string" ? null : arg.replyTo ?? null;

      const userMessage: Message = {
        id: newId(),
        role: "user",
        content,
        createdAt: new Date().toISOString(),
        replyTo,
      };
      const afterUser = await appendMessage(userMessage);
      qc.setQueryData(MESSAGES_KEY, afterUser);

      const [profile, memories, summaries] = await Promise.all([
        loadProfile(),
        loadMemories(),
        loadSummaries(),
      ]);

      let reply: {
        reply: string;
        imageUrl: string | null;
        selfieVibe: string | null;
      };
      try {
        reply = await fetchAshleyReply({
          content,
          profile,
          memories,
          summaries,
          history: afterUser.slice(0, -1),
          replyTo,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown error";
        throw new Error(message);
      }

      const ashleyMessage: Message = {
        id: newId(),
        role: "ashley",
        content: reply.reply,
        createdAt: new Date().toISOString(),
        imageUrl: reply.imageUrl,
        selfieVibe: reply.selfieVibe,
      };
      // Abort if the conversation was cleared (or a newer turn was appended)
      // while we were waiting on Claude.
      const next = await appendIfStillCurrent(userMessage.id, ashleyMessage);
      if (!next) {
        return { user: userMessage, ashley: null };
      }

      // Fire-and-forget: keep the rolling summary index up to date in the
      // background without blocking the chat UI.
      void maybeRollUpOlderMessages(qc);

      // Fire-and-forget: if Ashley wanted to send a selfie, kick off the
      // (slow) image-generation request in the background. The chat bubble
      // is already on screen with a pending "taking a selfie…" indicator.
      if (reply.selfieVibe) {
        void fetchAndAttachSelfie(qc, ashleyMessage.id, reply.selfieVibe, profile);
      }

      return { user: userMessage, ashley: ashleyMessage };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: MESSAGES_KEY });
    },
    onError: () => {
      // Make sure the user message we optimistically saved is still visible.
      qc.invalidateQueries({ queryKey: MESSAGES_KEY });
    },
  });
}

/**
 * Re-fetch Ashley's reply for the most recent user message that never got
 * one. Used by the chat screen's auto-retry loop: when a send mutation
 * fails (server cycling, transient network) the optimistic user bubble
 * stays in storage with no Ashley reply after it. As soon as the server
 * is reachable again, this picks up exactly where things stalled — no
 * duplicate user message, just the missing assistant turn.
 *
 * Returns null when there is nothing to retry (latest message is already
 * Ashley's, or the chat is empty).
 */
export function useRetryUnansweredReply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<Message | null> => {
      const all = await loadMessages();
      if (all.length === 0) return null;
      const tail = all[all.length - 1]!;
      // Only the trailing user message (with no Ashley reply after it) is
      // a candidate. Anything older is already settled.
      if (tail.role !== "user") return null;
      const userMessage = tail;

      const [profile, memories, summaries] = await Promise.all([
        loadProfile(),
        loadMemories(),
        loadSummaries(),
      ]);

      const reply = await fetchAshleyReply({
        content: userMessage.content,
        profile,
        memories,
        summaries,
        history: all.slice(0, -1),
        replyTo: userMessage.replyTo ?? null,
      });

      const ashleyMessage: Message = {
        id: newId(),
        role: "ashley",
        content: reply.reply,
        createdAt: new Date().toISOString(),
        imageUrl: reply.imageUrl,
        selfieVibe: reply.selfieVibe,
      };
      // Only commit if the user hasn't typed something new in the
      // meantime — otherwise the normal send mutation owns the next turn
      // and our reply would land out of order.
      const next = await appendIfStillCurrent(userMessage.id, ashleyMessage);
      if (!next) return null;
      qc.setQueryData(MESSAGES_KEY, next);

      void maybeRollUpOlderMessages(qc);

      if (reply.selfieVibe) {
        void fetchAndAttachSelfie(
          qc,
          ashleyMessage.id,
          reply.selfieVibe,
          profile,
        );
      }
      return ashleyMessage;
    },
  });
}

export function useClearMessages() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      await withStorageLock(STORAGE_KEYS.messages, async () => {
        await saveMessages([]);
      });
      // Summaries are meaningless without their messages — wipe them too.
      await withStorageLock(STORAGE_KEYS.summaries, async () => {
        await saveSummaries([]);
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: MESSAGES_KEY });
      qc.invalidateQueries({ queryKey: SUMMARIES_KEY });
    },
  });
}

/**
 * Background helper that fetches a selfie image for an already-rendered
 * Ashley message, then patches the imageUrl into local storage and the
 * messages query cache. Called fire-and-forget from `useSendMessage`.
 *
 * We auto-retry the whole POST + poll flow up to SELFIE_AUTO_RETRY_ATTEMPTS
 * times before giving up, because the most common dev-environment failure
 * mode is the api-server being recycled by the Replit workflow runner
 * (~every 8-12 min) WHILE a selfie is generating — that wipes the
 * in-memory job store, makes subsequent polls 404 ("job expired"), and a
 * fresh POST against the new instance just works. After all attempts fail
 * we leave selfieVibe set so the chat bubble's manual retry button is
 * available as the user-facing recovery path.
 */
const SELFIE_AUTO_RETRY_ATTEMPTS = 3;
const SELFIE_AUTO_RETRY_DELAY_MS = 4000;

export async function fetchAndAttachSelfie(
  qc: ReturnType<typeof useQueryClient>,
  messageId: string,
  vibe: string,
  profile: AshleyProfile,
): Promise<void> {
  for (let attempt = 0; attempt < SELFIE_AUTO_RETRY_ATTEMPTS; attempt++) {
    try {
      const imageUrl = await fetchAshleySelfie(vibe, profile);
      // Clear selfieVibe so the bubble stops showing "taking a selfie…" —
      // the imageUrl now drives the rendering.
      const next = await patchMessage(messageId, {
        imageUrl,
        selfieVibe: null,
      });
      if (next) qc.setQueryData(MESSAGES_KEY, next);
      return;
    } catch {
      // Wait briefly and try the whole flow again. We don't bother
      // distinguishing failure modes here — any failure on the wrapped
      // network/poll loop is worth one more shot, since the most common
      // cause is the api-server recycling mid-generation.
      if (attempt < SELFIE_AUTO_RETRY_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, SELFIE_AUTO_RETRY_DELAY_MS));
      }
    }
  }
  // All attempts failed. Leave selfieVibe + null imageUrl in place so the
  // chat bubble surfaces its manual retry affordance — the user can tap to
  // try once more whenever they like.
}

/**
 * Track in-flight selfie fetches per messageId so the chat bubble can
 * disable its retry button and show a spinner while a previous attempt is
 * still running. Keyed by messageId; the value is true while a fetch is
 * pending. We use a module-level set rather than React state because the
 * fetch is fire-and-forget across renders.
 */
const inFlightSelfies = new Set<string>();

/**
 * React hook returning a `retry(messageId, vibe)` callback the chat bubble
 * can call to re-attempt a failed selfie generation. Loads the current
 * profile internally so the bubble doesn't have to.
 *
 * IMPORTANT: unlike the fire-and-forget `fetchAndAttachSelfie`, this
 * promise REJECTS on failure so the calling bubble can show inline
 * feedback. The bubble manages its own "retrying" state with React state
 * (instead of the module-level `inFlightSelfies` Set, which isn't
 * reactive) — that way the spinner actually appears when the user taps.
 * We keep `inFlightSelfies` only as a cross-bubble dedup guard.
 */
export function useRetrySelfie(): {
  retry: (messageId: string, vibe: string) => Promise<void>;
} {
  const qc = useQueryClient();
  return {
    retry: async (messageId: string, vibe: string) => {
      if (inFlightSelfies.has(messageId)) return;
      inFlightSelfies.add(messageId);
      try {
        const profile = await loadProfile();
        // Inline the fetch so errors surface to the caller. (The
        // fire-and-forget variant `fetchAndAttachSelfie` swallows them on
        // purpose, since it has no UI to show feedback in.)
        const imageUrl = await fetchAshleySelfie(vibe, profile);
        const next = await patchMessage(messageId, {
          imageUrl,
          selfieVibe: null,
        });
        if (next) qc.setQueryData(MESSAGES_KEY, next);
      } finally {
        inFlightSelfies.delete(messageId);
      }
    },
  };
}

// One-at-a-time guard so multiple sends in quick succession can't fire
// overlapping summarization requests against the server.
let summarizationInFlight = false;

async function maybeRollUpOlderMessages(
  qc: ReturnType<typeof useQueryClient>,
): Promise<void> {
  if (summarizationInFlight) return;
  summarizationInFlight = true;
  try {
    const [allMessages, summaries] = await Promise.all([
      loadMessages(),
      loadSummaries(),
    ]);

    // Walk forward from the last summary cursor (oldest first).
    const sortedSummaries = summaries
      .slice()
      .sort(
        (a, b) =>
          Date.parse(a.coveredThroughCreatedAt) -
          Date.parse(b.coveredThroughCreatedAt),
      );
    const latest = sortedSummaries[sortedSummaries.length - 1] ?? null;
    const cursorMs = latest
      ? Date.parse(latest.coveredThroughCreatedAt)
      : -Infinity;

    const ordered = allMessages
      .slice()
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const unsummarized = ordered.filter(
      (m) => Date.parse(m.createdAt) > cursorMs,
    );
    if (unsummarized.length < SUMMARY_TRIGGER) return;

    const chunk = unsummarized.slice(0, SUMMARY_CHUNK_SIZE);
    const last = chunk[chunk.length - 1];
    if (!last) return;

    const summaryText = await fetchSummaryForChunk({
      messages: chunk,
      ...(latest?.summary ? { priorSummary: latest.summary } : {}),
    });

    const now = new Date().toISOString();
    const newSummary: ConversationSummary = {
      id: newId(),
      summary: summaryText,
      messageCount: chunk.length,
      coveredThroughCreatedAt: last.createdAt,
      createdAt: now,
      updatedAt: now,
    };

    await withStorageLock(STORAGE_KEYS.summaries, async () => {
      const current = await loadSummaries();
      // Re-check the cursor under the lock to avoid double-summarizing the
      // same range if two background runs raced.
      const sortedCurrent = current
        .slice()
        .sort(
          (a, b) =>
            Date.parse(a.coveredThroughCreatedAt) -
            Date.parse(b.coveredThroughCreatedAt),
        );
      const tip = sortedCurrent[sortedCurrent.length - 1] ?? null;
      const tipMs = tip ? Date.parse(tip.coveredThroughCreatedAt) : -Infinity;
      if (Date.parse(newSummary.coveredThroughCreatedAt) <= tipMs) return;
      await saveSummaries([...current, newSummary]);
    });

    qc.invalidateQueries({ queryKey: SUMMARIES_KEY });
  } catch {
    // Background; surface nothing to the chat UI on failure.
  } finally {
    summarizationInFlight = false;
  }
}
