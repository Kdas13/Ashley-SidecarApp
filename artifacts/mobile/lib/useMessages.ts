import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  STORAGE_KEYS,
  loadMessages,
  loadMemories,
  loadProfile,
  saveMessages,
  withStorageLock,
  newId,
  type Message,
} from "./storage";
import { fetchAshleyReply } from "./aiClient";

const MESSAGES_KEY = ["messages"] as const;

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

      const [profile, memories] = await Promise.all([
        loadProfile(),
        loadMemories(),
      ]);

      let replyText: string;
      try {
        replyText = await fetchAshleyReply({
          content,
          profile,
          memories,
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
        content: replyText,
        createdAt: new Date().toISOString(),
      };
      // Abort if the conversation was cleared (or a newer turn was appended)
      // while we were waiting on Claude.
      const next = await appendIfStillCurrent(userMessage.id, ashleyMessage);
      if (!next) {
        return { user: userMessage, ashley: null };
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

export function useClearMessages() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      await withStorageLock(STORAGE_KEYS.messages, async () => {
        await saveMessages([]);
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: MESSAGES_KEY });
    },
  });
}
