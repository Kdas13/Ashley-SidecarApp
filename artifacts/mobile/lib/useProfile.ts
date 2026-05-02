import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  STORAGE_KEYS,
  loadProfile,
  saveProfile,
  withStorageLock,
  type AshleyProfile,
} from "./storage";

const PROFILE_KEY = ["profile"] as const;

export function useProfile() {
  return useQuery({
    queryKey: PROFILE_KEY,
    queryFn: loadProfile,
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      patch: Partial<AshleyProfile> & { markOnboarded?: boolean },
    ): Promise<AshleyProfile> => {
      return withStorageLock(STORAGE_KEYS.profile, async () => {
        const { markOnboarded, ...fields } = patch;
        const current = await loadProfile();
        const next: AshleyProfile = {
          ...current,
          ...fields,
          onboardedAt:
            markOnboarded && !current.onboardedAt
              ? new Date().toISOString()
              : current.onboardedAt,
          updatedAt: new Date().toISOString(),
        };
        await saveProfile(next);
        return next;
      });
    },
    onSuccess: (next) => {
      qc.setQueryData(PROFILE_KEY, next);
    },
  });
}
