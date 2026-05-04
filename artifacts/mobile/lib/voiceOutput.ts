// ---------------------------------------------------------------------------
// Voice output — Stage 3 of the staged voice plan.
//
// Plays Ashley's reply text aloud via expo-audio. Push-to-talk in (Stage
// 1/2) plus auto-spoken reply out (here) closes the voice loop. Toggle-
// gated and OFF by default — see chat.tsx for the AsyncStorage prefer-
// ence (`ashley.voiceReplyEnabled`).
//
// Lifecycle contract for `useTtsPlayback`:
//   • `speak(text)` cancels any in-flight TTS request and stops any
//     currently playing audio before starting the new one. The cancel-
//     token guards against a stale earlier request landing AFTER a
//     newer one and stomping on it (race when two replies fire close
//     together — rare in practice, but cheap to defend against).
//   • `stop()` halts playback and discards the current cache file.
//   • Unmount triggers `stop()` so we never leak an AudioPlayer or
//     hold a Bluetooth/audio session after the chat screen closes.
//   • All TTS errors are swallowed silently — TTS failure must NEVER
//     break the chat UX. Worst case: Kane just doesn't hear that one
//     reply (the text is already on screen).
//
// Future-stage placeholder hooks (DO NOT BUILD YET — see voiceInput.ts
// for the canonical list. Mirrored here so the output side stays
// discoverable):
//   • [voice selection]       profile.ttsVoice forwarded into
//                             synthesizeSpeech as the voice param.
//   • [live voice mode]       Hands-free walkie-talkie session built on
//                             top of useTtsPlayback + a VAD-driven
//                             recorder cycle. Turn-based (Realtime API
//                             blocked by the Replit OpenAI proxy).
//   • [interruption handling] Already partly wired: chat.tsx calls
//                             tts.stop() on mic press-in. Live mode
//                             would extend this to fire on VAD-detected
//                             voice-start, not just press-in.
//   • [emotional tone]        Pass an `instructions` field through to
//                             /chat/tts so the server can hand it to
//                             gpt-audio for tone-aware delivery
//                             ("speak softly and slowly", etc.).
//   • [sentence chunking]     Optional latency win: split the reply on
//                             sentence boundaries, fire TTS per-chunk,
//                             queue + play sequentially. Drops first-
//                             audio latency from "wait for full reply"
//                             to "wait for first sentence".
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";

import { synthesizeSpeechToFile } from "./aiClient";

export type TtsPlayback = {
  speak: (text: string) => void;
  stop: () => void;
  isPlaying: boolean;
};

export function useTtsPlayback(): TtsPlayback {
  const playerRef = useRef<AudioPlayer | null>(null);
  const lastUriRef = useRef<string | null>(null);
  // Monotonic token: every speak/stop bumps it; in-flight async work
  // checks the token before acting on the player so a late-arriving
  // synth response can't override a newer request.
  const cancelTokenRef = useRef(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const teardown = useCallback(async (): Promise<void> => {
    const p = playerRef.current;
    playerRef.current = null;
    setIsPlaying(false);
    if (p) {
      try {
        p.pause();
      } catch {
        // ignore — player may already be released
      }
      try {
        p.remove();
      } catch {
        // ignore
      }
    }
    const uri = lastUriRef.current;
    lastUriRef.current = null;
    if (uri) {
      try {
        await FileSystem.deleteAsync(uri, { idempotent: true });
      } catch {
        // ignore — best-effort cache cleanup
      }
    }
  }, []);

  const stop = useCallback((): void => {
    cancelTokenRef.current += 1;
    void teardown();
  }, [teardown]);

  const speak = useCallback(
    (text: string): void => {
      const trimmed = text.trim();
      if (!trimmed) return;
      cancelTokenRef.current += 1;
      const myToken = cancelTokenRef.current;
      void (async () => {
        await teardown();
        if (myToken !== cancelTokenRef.current) return;
        let result: { uri: string };
        try {
          result = await synthesizeSpeechToFile(trimmed);
        } catch {
          // Silent failure — TTS must never break chat UX.
          return;
        }
        if (myToken !== cancelTokenRef.current) {
          // A newer request superseded this one; discard the file.
          try {
            await FileSystem.deleteAsync(result.uri, { idempotent: true });
          } catch {
            // ignore
          }
          return;
        }
        try {
          const player = createAudioPlayer({ uri: result.uri });
          playerRef.current = player;
          lastUriRef.current = result.uri;
          setIsPlaying(true);
          player.addListener("playbackStatusUpdate", (status) => {
            if (status.didJustFinish) {
              if (playerRef.current === player) {
                void teardown();
              }
            }
          });
          player.play();
        } catch {
          void teardown();
        }
      })();
    },
    [teardown],
  );

  // Cleanup on unmount — never leak a player or audio session.
  useEffect(() => {
    return () => {
      cancelTokenRef.current += 1;
      void teardown();
    };
  }, [teardown]);

  return { speak, stop, isPlaying };
}
