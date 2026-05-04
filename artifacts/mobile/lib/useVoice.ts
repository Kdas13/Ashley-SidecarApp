import { useMutation } from "@tanstack/react-query";

import {
  STREAMING_UNSUPPORTED,
  transcribeAudio,
  transcribeAudioStream,
} from "./aiClient";
import type { RecordedAudio } from "./voiceInput";

/**
 * Stage 1 mutation hook. Pure round-trip: caller passes the audio blob
 * obtained from useVoiceRecorder().stop() and gets back the transcript.
 * No cache invalidation — transcription is a pure read; the resulting
 * text is dropped into the chat draft state and only persists once the
 * user sends the message via the existing send flow.
 */
export function useTranscribeAudio() {
  return useMutation({
    mutationFn: async (audio: RecordedAudio) => transcribeAudio(audio),
  });
}

/**
 * Stage 2 streaming mutation hook. Same input shape as useTranscribeAudio
 * but invokes the SSE endpoint and forwards each delta chunk to the
 * caller-supplied onDelta callback so the UI can render partial text in
 * real time. On stream failure (network, runtime missing ReadableStream,
 * SDK error), silently falls back to the Stage 1 endpoint so the user
 * always gets a transcript — text remains the canonical fallback.
 *
 * Variables shape:
 *   { audio: RecordedAudio, onDelta?: (chunk: string) => void }
 *
 * Returns: { transcript: string } — the final full transcript.
 */
export function useTranscribeAudioStream() {
  return useMutation({
    mutationFn: async (vars: {
      audio: RecordedAudio;
      onDelta?: (chunk: string) => void;
    }) => {
      try {
        return await transcribeAudioStream(vars.audio, {
          onDelta: vars.onDelta,
        });
      } catch (err) {
        // Either the runtime can't stream or the upstream blew up
        // mid-flight. Fall back to the non-streaming endpoint so the
        // user still ends up with a transcript. The non-streaming path
        // is the existing Stage 1 chokepoint; identical safety posture.
        const msg = err instanceof Error ? err.message : "";
        const isStreamingUnsupported = msg.includes(STREAMING_UNSUPPORTED);
        if (!isStreamingUnsupported) {
          // Network / SSE parse / upstream Whisper error — the
          // partial banner may have shown nothing or a stale chunk;
          // the fallback's full transcript will overwrite cleanly.
        }
        return await transcribeAudio(vars.audio);
      }
    },
  });
}
