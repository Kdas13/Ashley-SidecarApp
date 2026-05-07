/**
 * Safeguard API client — small typed fetch wrapper.
 *
 * We intentionally do NOT use the shared `lib/api-spec` codegen here:
 * the existing spec is wired to Ashley's `/api` server. Hard separation
 * means a hand-written client against `/safeguard-api`. Endpoint shapes
 * are documented in artifacts/safeguard-api/README.md.
 */

import { useAuth } from "@clerk/clerk-react";
import { useCallback } from "react";

export type Lang = "en" | "uk" | "ar" | "ur" | "ps" | "so";

export interface SafeguardProfile {
  userId: string;
  preferredName: string;
  preferredLanguage: Lang;
  nativeLanguage: Lang;
  secondaryLanguage: Lang | "";
  literacyLevel: "low" | "medium" | "high";
  countryOfOrigin: string;
  dateOfBirth: string;
  gpName: string;
  gpSurgery: string;
  ongoingConcerns: string;
  currentMedications: string;
  accessibilityLargeText: boolean;
  accessibilityHighContrast: boolean;
  accessibilityAudio: boolean;
  accessibilitySimplified: boolean;
  accessibilitySlowerPacing: boolean;
  trustedContactName: string;
  trustedContactRelation: string;
  trustedContactPhone: string;
  consentStorage: boolean;
  consentAiProcessing: boolean;
  consentRecordedAt: string | null;
  updatedAt: string;
}

export interface SafeguardCheckin {
  id: string;
  userId: string;
  createdAt: string;
  lang: Lang;
  freeText: string;
  generalFeelingScore: number | null;
  painScore: number | null;
  foodWaterScore: number | null;
  medicationScore: number | null;
  sleepScore: number | null;
  safetyScore: number | null;
  // legacy
  moodScore: number | null;
  energyScore: number | null;
  appetiteScore: number | null;
}

export interface SafeguardObservation {
  id: string;
  userId: string;
  checkinId: string | null;
  createdAt: string;
  kind: string;
  summary: string;
  bullets: string[];
  flagged: boolean;
  outputLang: Lang;
}

export interface SafeguardTrend {
  kind: "trend_repeated_distress" | "trend_missed_checkin";
  summary: string;
  bullets: string[];
  flagged: boolean;
  windowStart: string;
  windowEnd: string;
}

const BASE = "/safeguard-api";

export function useApi() {
  const { getToken } = useAuth();

  const request = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const token = await getToken();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(init?.headers as Record<string, string> | undefined),
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`${BASE}${path}`, { ...init, headers });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`API ${res.status}: ${text || res.statusText}`);
      }
      return (await res.json()) as T;
    },
    [getToken],
  );

  return { request };
}
