import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  DEFAULT_PROFILE,
  loadProfile,
  saveProfile,
  type AshleyProfile,
} from "./storage";
import {
  fetchState,
  updateProfileOnServer,
  type ProfileUpdate,
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
      if (patch.relationshipMode !== undefined)
        wirePatch.relationshipMode = patch.relationshipMode;
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
