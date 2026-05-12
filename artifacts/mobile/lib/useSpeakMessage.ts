// ---------------------------------------------------------------------------
// useSpeakMessage — per-message Speak button logic.
//
// Fetches TTS audio for a specific message, writes it to a named cache file
// so subsequent taps on the same message skip the network round-trip, then
// plays via tts.speakUri() (which uses the existing audio-session / player
// lifecycle in useTtsPlayback without any extra overlapping-play machinery).
//
// Status states:
//   "idle"    — no request in flight, ready to tap.
//   "loading" — network request to /messages/:id/speech is in flight.
//   "error"   — most recent attempt failed; button still tappable to retry.
// ---------------------------------------------------------------------------

import { useCallback, useState } from "react";
import * as FileSystem from "expo-file-system/legacy";
import { fetchSpeechForMessage } from "./aiClient";
import type { TtsPlayback } from "./voiceOutput";

export type SpeakStatus = "idle" | "loading" | "error";

export function useSpeakMessage(tts: TtsPlayback): {
  speakMessage: (messageId: string, text: string) => void;
  getSpeakStatus: (messageId: string) => SpeakStatus;
} {
  const [statuses, setStatuses] = useState<Record<string, SpeakStatus>>({});

  const speakMessage = useCallback(
    (messageId: string, text: string): void => {
      void (async () => {
        // Check the cache first — same message id re-uses the same file.
        const dir = FileSystem.cacheDirectory;
        if (!dir) return;
        const cachedUri = `${dir}tts_${messageId}.mp3`;
        try {
          const info = await FileSystem.getInfoAsync(cachedUri);
          if (info.exists) {
            tts.speakUri(cachedUri);
            return;
          }
        } catch {
          // Cache miss — fall through to fetch.
        }

        // Fetch from API.
        setStatuses((prev) => ({ ...prev, [messageId]: "loading" }));
        try {
          const stripped = text
            .replace(/\*([^*]*)\*/g, "$1")
            .replace(/\*/g, "")
            .replace(/\s{2,}/g, " ")
            .trim();
          const data = await fetchSpeechForMessage(messageId, stripped);
          await FileSystem.writeAsStringAsync(cachedUri, data.audioBase64, {
            encoding: FileSystem.EncodingType.Base64,
          });
          setStatuses((prev) => ({ ...prev, [messageId]: "idle" }));
          tts.speakUri(cachedUri);
        } catch {
          setStatuses((prev) => ({ ...prev, [messageId]: "error" }));
        }
      })();
    },
    [tts],
  );

  const getSpeakStatus = useCallback(
    (messageId: string): SpeakStatus => statuses[messageId] ?? "idle",
    [statuses],
  );

  return { speakMessage, getSpeakStatus };
}
