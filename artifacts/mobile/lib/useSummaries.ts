import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  loadSummaries,
  saveSummaries,
  type ConversationSummary,
} from "./storage";
import {
  deleteSummaryOnServer,
  fetchState,
  updateSummaryOnServer,
} from "./aiClient";

const SUMMARIES_KEY = ["summaries"] as const;

export function useSummaries() {
  return useQuery({
    queryKey: SUMMARIES_KEY,
    queryFn: async (): Promise<ConversationSummary[]> => {
      try {
        const state = await fetchState();
        await saveSummaries(state.summaries);
        return state.summaries;
      } catch (err) {
        const cached = await loadSummaries();
        if (cached.length > 0) return cached;
        throw err;
      }
    },
  });
}

// Summaries are AUTHORED by the server (rolled up automatically after every
// chat turn once the live history exceeds the prompt window). The client
// can edit the prose or delete a chapter, but cannot create new ones — the
// CreateSummary hook below is intentionally a no-op so legacy screens that
// import it don't crash.

export type CreateSummaryInput = {
  summary: string;
  messageCount: number;
  coveredThroughCreatedAt: string;
};

export function useCreateSummary() {
  return useMutation({
    mutationFn: async (
      _input: CreateSummaryInput,
    ): Promise<ConversationSummary | null> => {
      // No-op: summaries are server-authored. Returning null keeps any
      // existing UI from blowing up if it triggers this code path.
      return null;
    },
  });
}

export type UpdateSummaryInput = { id: string; summary: string };

export function useUpdateSummary() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: UpdateSummaryInput,
    ): Promise<ConversationSummary | null> => {
      const updated = await updateSummaryOnServer(input.id, input.summary);
      const previous =
        qc.getQueryData<ConversationSummary[]>(SUMMARIES_KEY) ?? [];
      const next = previous.map((s) => (s.id === updated.id ? updated : s));
      qc.setQueryData(SUMMARIES_KEY, next);
      await saveSummaries(next);
      return updated;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SUMMARIES_KEY });
    },
  });
}

export function useDeleteSummary() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      await deleteSummaryOnServer(id);
      const previous =
        qc.getQueryData<ConversationSummary[]>(SUMMARIES_KEY) ?? [];
      const next = previous.filter((s) => s.id !== id);
      qc.setQueryData(SUMMARIES_KEY, next);
      await saveSummaries(next);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SUMMARIES_KEY });
    },
  });
}

export const summariesQueryKey = SUMMARIES_KEY;
