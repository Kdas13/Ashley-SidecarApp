import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  STORAGE_KEYS,
  loadSummaries,
  saveSummaries,
  withStorageLock,
  newId,
  type ConversationSummary,
} from "./storage";

const SUMMARIES_KEY = ["summaries"] as const;

export function useSummaries() {
  return useQuery({
    queryKey: SUMMARIES_KEY,
    queryFn: loadSummaries,
  });
}

export type CreateSummaryInput = {
  summary: string;
  messageCount: number;
  coveredThroughCreatedAt: string;
};

export function useCreateSummary() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: CreateSummaryInput,
    ): Promise<ConversationSummary> => {
      return withStorageLock(STORAGE_KEYS.summaries, async () => {
        const all = await loadSummaries();
        const now = new Date().toISOString();
        const summary: ConversationSummary = {
          id: newId(),
          summary: input.summary,
          messageCount: input.messageCount,
          coveredThroughCreatedAt: input.coveredThroughCreatedAt,
          createdAt: now,
          updatedAt: now,
        };
        await saveSummaries([...all, summary]);
        return summary;
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SUMMARIES_KEY });
    },
  });
}

export type UpdateSummaryInput = {
  id: string;
  summary: string;
};

export function useUpdateSummary() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: UpdateSummaryInput,
    ): Promise<ConversationSummary | null> => {
      return withStorageLock(STORAGE_KEYS.summaries, async () => {
        const all = await loadSummaries();
        const idx = all.findIndex((s) => s.id === input.id);
        if (idx === -1) return null;
        const updated: ConversationSummary = {
          ...all[idx]!,
          summary: input.summary,
          updatedAt: new Date().toISOString(),
        };
        const next = [...all];
        next[idx] = updated;
        await saveSummaries(next);
        return updated;
      });
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
      await withStorageLock(STORAGE_KEYS.summaries, async () => {
        const all = await loadSummaries();
        await saveSummaries(all.filter((s) => s.id !== id));
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SUMMARIES_KEY });
    },
  });
}

export const summariesQueryKey = SUMMARIES_KEY;
