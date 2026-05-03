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
  clearChatOnServer,
  fetchSelfieForMessage,
  fetchState,
  sendChatMessage,
} from "./aiClient";

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

      // 4. If Ashley wanted to send a selfie, kick off the (slow) image
      //    generation in the background. The bubble is already on screen
      //    showing its "taking a selfie..." state.
      if (response.ashleyMessage.selfieVibe) {
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

      if (response.ashleyMessage.selfieVibe) {
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

export async function fetchAndAttachSelfie(
  qc: ReturnType<typeof useQueryClient>,
  messageId: string,
  vibe: string,
): Promise<void> {
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
}

const inFlightSelfies = new Set<string>();

export function useRetrySelfie(): {
  retry: (messageId: string, vibe: string) => Promise<void>;
} {
  const qc = useQueryClient();
  return {
    retry: async (messageId: string, vibe: string) => {
      if (inFlightSelfies.has(messageId)) return;
      inFlightSelfies.add(messageId);
      try {
        const imageUrl = await fetchSelfieForMessage(messageId, vibe);
        await patchInCache(qc, messageId, { imageUrl, selfieVibe: null });
      } finally {
        inFlightSelfies.delete(messageId);
      }
    },
  };
}

export const messagesQueryKey = MESSAGES_KEY;
