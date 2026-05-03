import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  loadMemories,
  saveMemories,
  newId,
  type Memory,
  type MemoryTag,
} from "./storage";
import {
  createMemoryOnServer,
  deleteMemoryOnServer,
  fetchState,
  updateMemoryOnServer,
} from "./aiClient";

const MEMORIES_KEY = ["memories"] as const;

export function useMemories() {
  return useQuery({
    queryKey: MEMORIES_KEY,
    queryFn: async (): Promise<Memory[]> => {
      try {
        const state = await fetchState();
        await saveMemories(state.memories);
        return state.memories;
      } catch (err) {
        const cached = await loadMemories();
        if (cached.length > 0) return cached;
        throw err;
      }
    },
  });
}

export type CreateMemoryInput = {
  content: string;
  tag: MemoryTag;
  importance: number;
};

export function useCreateMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateMemoryInput): Promise<Memory> => {
      const id = newId();
      const created = await createMemoryOnServer({
        id,
        content: input.content,
        tag: input.tag,
        importance: input.importance,
      });
      if (!created) {
        throw new Error("Server did not return the new memory.");
      }
      const previous = qc.getQueryData<Memory[]>(MEMORIES_KEY) ?? [];
      const next = [created, ...previous.filter((m) => m.id !== created.id)];
      qc.setQueryData(MEMORIES_KEY, next);
      await saveMemories(next);
      return created;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: MEMORIES_KEY });
    },
  });
}

export type UpdateMemoryInput = {
  id: string;
  content: string;
  tag: MemoryTag;
  importance: number;
};

export function useUpdateMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateMemoryInput): Promise<Memory | null> => {
      const updated = await updateMemoryOnServer(input.id, {
        content: input.content,
        tag: input.tag,
        importance: input.importance,
      });
      const previous = qc.getQueryData<Memory[]>(MEMORIES_KEY) ?? [];
      const next = previous.map((m) => (m.id === updated.id ? updated : m));
      qc.setQueryData(MEMORIES_KEY, next);
      await saveMemories(next);
      return updated;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: MEMORIES_KEY });
    },
  });
}

export function useDeleteMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      await deleteMemoryOnServer(id);
      const previous = qc.getQueryData<Memory[]>(MEMORIES_KEY) ?? [];
      const next = previous.filter((m) => m.id !== id);
      qc.setQueryData(MEMORIES_KEY, next);
      await saveMemories(next);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: MEMORIES_KEY });
    },
  });
}

export const memoriesQueryKey = MEMORIES_KEY;
