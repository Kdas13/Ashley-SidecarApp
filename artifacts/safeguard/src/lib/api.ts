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

export type Lang = "en" | "uk" | "ar" | "pl" | "ur" | "ps" | "so";

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

// ---------------------------------------------------------------------------
// Appointments / translation workspace / follow-up types
// ---------------------------------------------------------------------------

export type AppointmentStatus =
  | "draft"
  | "ready"
  | "in_session"
  | "completed";

export interface SafeguardAppointment {
  id: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  status: AppointmentStatus;
  patientLang: Lang;
  clinicianLang: Lang;
  title: string;
}

export type Audience = "patient" | "clinician";
export type Confidence = "high" | "medium" | "low";

export interface SafeguardAppointmentSummary {
  id: string;
  appointmentId: string;
  audience: Audience;
  lang: Lang;
  summary: string;
  edited: boolean;
  confidence: Confidence;
  notes: string;
  provider: string;
  model: string;
  createdAt: string;
}

export interface SafeguardAppointmentIntake {
  appointmentId: string;
  lang: Lang;
  answers: Record<string, string>;
  updatedAt: string;
}

export interface SafeguardTranslation {
  id: string;
  sourceLang: Lang;
  targetLang: Lang;
  sourceText: string;
  translatedText: string;
  confidence: Confidence;
  notes: string;
  provider: string;
  model: string;
  createdAt: string;
}

export interface SafeguardUtterance {
  utterance: {
    id: string;
    appointmentId: string;
    speaker: "patient" | "clinician";
    translationId: string | null;
    createdAt: string;
  };
  translation: SafeguardTranslation | null;
}

export type FollowupCadence =
  | { kind: "none" }
  | { kind: "once"; at: string }
  | {
      kind: "recurring";
      startAt: string;
      timesPerDay: number;
      durationDays: number;
    };

export interface SafeguardFollowup {
  id: string;
  appointmentId: string;
  userId: string;
  kind: "medication" | "followup" | "escalation";
  sourceLang: Lang;
  targetLang: Lang;
  titleOriginal: string;
  titleTranslated: string;
  detailOriginal: string;
  detailTranslated: string;
  plainExplanation: string;
  confidence: Confidence;
  dueAt: string | null;
  nextReminderAt: string | null;
  cadence: FollowupCadence | null;
  reminderCount: number;
  remindersEnabled: boolean;
  completedAt: string | null;
  createdAt: string;
}

export interface SafeguardExportRef {
  id: string;
  generatedAt: string;
  byteSize: number;
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
