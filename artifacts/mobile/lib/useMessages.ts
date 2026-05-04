import { useEffect, useReducer } from "react";
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
  markImageRemembered,
  sendChatImage,
  sendChatMessage,
  type RememberDecision,
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
