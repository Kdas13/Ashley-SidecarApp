import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  DEFAULT_PROFILE,
  loadProfile,
  saveProfile,
  type AshleyProfile,
} from "./storage";
import {
  fetchState,
  submitReplikaCarryover,
  updateProfileOnServer,
  type ProfileUpdate,
  type ReplikaCarryoverInput,
  type ReplikaCarryoverResult,
} from "./aiClient";

const PROFILE_KEY = ["profile"] as const;

export function useProfile() {
  return useQuery({
    queryKey: PROFILE_KEY,
    queryFn: async (): Promise<AshleyProfile> => {
      try {
        const state = await fetchState();
        await saveProfile(state.profile);
        return state.profile;
      } catch (err) {
        // Network / server hiccup — fall back to last cached copy so the
        // UI still renders with whatever we last knew. Re-throws if even
        // the cache is empty so React Query can surface the error.
        const cached = await loadProfile();
        if (cached.updatedAt !== DEFAULT_PROFILE.updatedAt) return cached;
        throw err;
      }
    },
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      patch: Partial<AshleyProfile> & { markOnboarded?: boolean },
    ): Promise<AshleyProfile> => {
      const wirePatch: ProfileUpdate = {};
      if (patch.name !== undefined) wirePatch.name = patch.name;
      if (patch.age !== undefined) wirePatch.age = patch.age;
      if (patch.identity !== undefined) wirePatch.identity = patch.identity;
      if (patch.personality !== undefined)
        wirePatch.personality = patch.personality;
      if (patch.speakingStyle !== undefined)
        wirePatch.speakingStyle = patch.speakingStyle;
      if (patch.appearance !== undefined)
        wirePatch.appearance = patch.appearance;
      if (patch.refersToUserAs !== undefined)
        wirePatch.refersToUserAs = patch.refersToUserAs;
      if (patch.sharedHistory !== undefined)
        wirePatch.sharedHistory = patch.sharedHistory;
      if (patch.replikaExcerpts !== undefined)
        wirePatch.replikaExcerpts = patch.replikaExcerpts;
      if (patch.replikaCarryover !== undefined)
        wirePatch.replikaCarryover = patch.replikaCarryover;
      if (patch.replikaCarryoverSummary !== undefined)
        wirePatch.replikaCarryoverSummary = patch.replikaCarryoverSummary;
      if (patch.relationshipMode !== undefined)
        wirePatch.relationshipMode = patch.relationshipMode;
      if (patch.builderAwareMode !== undefined)
        wirePatch.builderAwareMode = patch.builderAwareMode;
      if (patch.markOnboarded) wirePatch.markOnboarded = true;

      const next = await updateProfileOnServer(wirePatch);
      await saveProfile(next);
      return next;
    },
    onSuccess: (next) => {
      qc.setQueryData(PROFILE_KEY, next);
    },
  });
}

export const profileQueryKey = PROFILE_KEY;

/**
 * Submit the Replika Carryover intake. The server condenses it into a
 * Carryover Summary (injected into every chat prompt) and seeds initial
 * long-term memories. The cached profile + memories + state queries are
 * invalidated on success so the rest of the UI re-syncs.
 */
export function useReplikaCarryover() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: ReplikaCarryoverInput,
    ): Promise<ReplikaCarryoverResult> => {
      const result = await submitReplikaCarryover(input);
      await saveProfile(result.profile);
      return result;
    },
    onSuccess: (result) => {
      qc.setQueryData(PROFILE_KEY, result.profile);
      // Memories list lives behind a separate query; invalidate it so the
      // newly seeded long-term memories show up.
      void qc.invalidateQueries({ queryKey: ["memories"] });
      void qc.invalidateQueries({ queryKey: ["messages"] });
      void qc.invalidateQueries({ queryKey: ["summaries"] });
    },
  });
}
