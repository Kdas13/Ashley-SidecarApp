import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  loadMemories,
  saveMemories,
  newId,
  type Memory,
  type MemoryTag,
} from "./storage";

const MEMORIES_KEY = ["memories"] as const;

export function useMemories() {
  return useQuery({
    queryKey: MEMORIES_KEY,
    queryFn: loadMemories,
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
      const all = await loadMemories();
      const now = new Date().toISOString();
      const memory: Memory = {
        id: newId(),
        content: input.content,
        tag: input.tag,
        importance: input.importance,
        createdAt: now,
        updatedAt: now,
      };
      const next = [memory, ...all];
      await saveMemories(next);
      return memory;
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
      const all = await loadMemories();
      const idx = all.findIndex((m) => m.id === input.id);
      if (idx === -1) return null;
      const updated: Memory = {
        ...all[idx]!,
        content: input.content,
        tag: input.tag,
        importance: input.importance,
        updatedAt: new Date().toISOString(),
      };
      const next = [...all];
      next[idx] = updated;
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
      const all = await loadMemories();
      await saveMemories(all.filter((m) => m.id !== id));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: MEMORIES_KEY });
    },
  });
}
