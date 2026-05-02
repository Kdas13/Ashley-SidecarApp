import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  STORAGE_KEYS,
  loadMessages,
  loadMemories,
  loadProfile,
  loadSummaries,
  saveMessages,
  saveSummaries,
  withStorageLock,
  newId,
  type ConversationSummary,
  type Message,
} from "./storage";
import { fetchAshleyReply, fetchSummaryForChunk } from "./aiClient";

const MESSAGES_KEY = ["messages"] as const;
const SUMMARIES_KEY = ["summaries"] as const;

// Mirrors the server constants. Once the live conversation grows past
// HISTORY_WINDOW + SUMMARY_CHUNK_SIZE unsummarized messages, the oldest
// SUMMARY_CHUNK_SIZE get distilled into one rolling summary record so the
// long tail of the relationship doesn't disappear from Ashley's prompt.
const HISTORY_WINDOW = 30;
const SUMMARY_CHUNK_SIZE = 20;
const SUMMARY_TRIGGER = HISTORY_WINDOW + SUMMARY_CHUNK_SIZE;

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
    mutationFn: async (content: string): Promise<SendMessageResult> => {
      const userMessage: Message = {
        id: newId(),
        role: "user",
        content,
        createdAt: new Date().toISOString(),
      };
      const afterUser = await appendMessage(userMessage);
      qc.setQueryData(MESSAGES_KEY, afterUser);

      const [profile, memories, summaries] = await Promise.all([
        loadProfile(),
        loadMemories(),
        loadSummaries(),
      ]);

      let reply: { reply: string; imageUrl: string | null };
      try {
        reply = await fetchAshleyReply({
          content,
          profile,
          memories,
          summaries,
          history: afterUser.slice(0, -1),
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
