import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  DEFAULT_PROFILE,
  loadProfile,
  saveProfile,
  type AshleyProfile,
} from "./storage";
import {
  confirmAdult,
  fetchState,
  submitReplikaCarryover,
  updateProfileOnServer,
  withdrawAdultConfirmation,
  type ProfileUpdate,
  type ReplikaCarryoverInput,
  type ReplikaCarryoverResult,
} from "./aiClient";
import type { ServerPolicy } from "./storage";

const PROFILE_KEY = ["profile"] as const;
const POLICY_KEY = ["policy"] as const;

export const policyQueryKey = POLICY_KEY;

export function useProfile() {
  const qc = useQueryClient();
  return useQuery({
    queryKey: PROFILE_KEY,
    queryFn: async (): Promise<AshleyProfile> => {
      try {
        const state = await fetchState();
        await saveProfile(state.profile);
        // /state is the canonical hydration call — write the policy snapshot
        // to its own cache slot at the same time so usePolicy() doesn't have
        // to fire a second round trip.
        qc.setQueryData<ServerPolicy>(POLICY_KEY, state.policy);
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

/**
 * Read the server-resolved content policy snapshot. Populated as a side
 * effect of useProfile()'s /state hydration; returns undefined until the
 * first hydration completes.
 */
export function usePolicy() {
  return useQuery({
    queryKey: POLICY_KEY,
    queryFn: async (): Promise<ServerPolicy> => {
      const state = await fetchState();
      return state.policy;
    },
  });
}

/** 18+ age gate — the only path to enabling Mature Mode. */
export function useConfirmAdult() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<AshleyProfile> => {
      const next = await confirmAdult();
      await saveProfile(next);
      return next;
    },
    onSuccess: (next) => {
      qc.setQueryData(PROFILE_KEY, next);
      // Operator switch could have changed but we don't refetch /state — the
      // policy snapshot's `adultConfirmed` flag is the only bit that flips
      // here, so patch it directly to avoid an extra round trip.
      qc.setQueryData<ServerPolicy | undefined>(POLICY_KEY, (prev) =>
        prev
          ? {
              ...prev,
              adultConfirmed: true,
              matureModeAvailable: prev.operatorMatureModeAvailable,
            }
          : prev,
      );
    },
  });
}

/** Withdraw the 18+ confirmation — server forces mode back to standard. */
export function useWithdrawAdultConfirmation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<AshleyProfile> => {
      const next = await withdrawAdultConfirmation();
      await saveProfile(next);
      return next;
    },
    onSuccess: (next) => {
      qc.setQueryData(PROFILE_KEY, next);
      qc.setQueryData<ServerPolicy | undefined>(POLICY_KEY, (prev) =>
        prev
          ? {
              ...prev,
              effectiveMode: "standard",
              intimacyCeiling: 3,
              intimacyLevel: Math.min(3, prev.intimacyLevel),
              adultConfirmed: false,
              matureModeAvailable: false,
            }
          : prev,
      );
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
      if (patch.voiceMode !== undefined) wirePatch.voiceMode = patch.voiceMode;
      if (patch.contentMode !== undefined)
        wirePatch.contentMode = patch.contentMode;
      if (patch.intimacyLevel !== undefined)
        wirePatch.intimacyLevel = patch.intimacyLevel;
      if (patch.markOnboarded) wirePatch.markOnboarded = true;

      const next = await updateProfileOnServer(wirePatch);
      await saveProfile(next);
      return next;
    },
    onSuccess: (next) => {
      qc.setQueryData(PROFILE_KEY, next);
      // contentMode/intimacyLevel may have changed — patch the policy
      // snapshot from the new profile + the cached operator switch so
      // the 18+ UI re-renders without a round trip.
      qc.setQueryData<ServerPolicy | undefined>(POLICY_KEY, (prev) => {
        if (!prev) return prev;
        const operatorOn = prev.operatorMatureModeAvailable;
        const adultOk = next.adultConfirmedAt != null;
        const wantsMature = next.contentMode === "mature";
        const effective: "standard" | "mature" =
          wantsMature && operatorOn && adultOk ? "mature" : "standard";
        const ceiling = effective === "mature" ? 5 : 3;
        return {
          ...prev,
          effectiveMode: effective,
          intimacyCeiling: ceiling,
          intimacyLevel: Math.max(0, Math.min(ceiling, next.intimacyLevel)),
          adultConfirmed: adultOk,
          matureModeAvailable: operatorOn && adultOk,
        };
      });
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
