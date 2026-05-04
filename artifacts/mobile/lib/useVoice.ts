import { useMutation } from "@tanstack/react-query";

import { transcribeAudio } from "./aiClient";
import type { RecordedAudio } from "./voiceInput";

/**
 * Mutation hook for Stage 1 push-to-talk. Caller passes the audio blob
 * obtained from useVoiceRecorder().stop() and gets back the transcript.
 *
 * No cache invalidation — transcription is a pure read; the resulting
 * text is dropped into the chat draft state and only persists once the
 * user sends the message via the existing send flow.
 */
export function useTranscribeAudio() {
  return useMutation({
    mutationFn: async (audio: RecordedAudio) => transcribeAudio(audio),
  });
}
