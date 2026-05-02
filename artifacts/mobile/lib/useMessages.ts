import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  loadMessages,
  saveMessages,
  newId,
  type Message,
} from "./storage";

const MESSAGES_KEY = ["messages"] as const;

export function useMessages() {
  return useQuery({
    queryKey: MESSAGES_KEY,
    queryFn: loadMessages,
  });
}

export function useSendMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (content: string): Promise<Message> => {
      const all = await loadMessages();
      const message: Message = {
        id: newId(),
        role: "user",
        content,
        createdAt: new Date().toISOString(),
      };
      const next = [...all, message];
      await saveMessages(next);
      return message;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: MESSAGES_KEY });
    },
  });
}

export function useClearMessages() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      await saveMessages([]);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: MESSAGES_KEY });
    },
  });
}
