// ---------------------------------------------------------------------------
// Voice output — TTS playback via expo-audio.
//
// Full lifecycle contract:
//   • speak(text)   — cancel any in-flight request/playback, then fetch
//                     audio and play it. Cancel-token guards stale responses.
//   • stop()        — synchronous fire-and-forget stop (for send() / toggle).
//   • stopAsync()   — awaitable stop. MUST be used by handleMicPressIn so
//                     teardown completes before the recorder grabs audio focus.
//   • isPlaying     — true while the player is active.
//
// Key fixes vs previous version:
//   1. stopAsync() is awaitable — handleMicPressIn waits for teardown before
//      calling setAudioModeAsync({ allowsRecording: true }), eliminating the
//      audio-focus race that killed STT after TTS played.
//   2. setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true })
//      is called before createAudioPlayer so Android properly requests
//      playback audio focus.
//   3. After teardown, the same setAudioModeAsync call resets to a neutral
//      state so the recorder can later claim recording focus cleanly.
//   4. 45s timeout on synthesizeSpeechToFile so a hung network call never
//      locks the pipeline.
//   5. 120s watchdog on playback so a missing didJustFinish never leaves
//      the audio session permanently occupied.
//   6. Every error is logged with context — no silent swallowing.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
} from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";

import { synthesizeSpeechToFile } from "./aiClient";
import {
  audioError,
  audioLog,
  patchAudioState,
} from "./audioState";

export type TtsPlayback = {
  speak: (text: string) => void;
  /** Fire-and-forget stop — safe to call synchronously. */
  stop: () => void;
  /**
   * Awaitable stop — waits for the native player to be removed and the audio
   * mode to be reset before resolving. Use this in handleMicPressIn so the
   * recorder doesn't race with a lingering TTS audio session.
   */
  stopAsync: () => Promise<void>;
  isPlaying: boolean;
};

// Maximum wall-clock time for the synthesizeSpeechToFile network round-trip.
const TTS_NETWORK_TIMEOUT_MS = 45_000;

// If didJustFinish never fires (e.g. Android drops the event after audio
// focus loss), force teardown after this long. Covers even the longest
// realistic reply at slow TTS speed plus a generous buffer.
const TTS_PLAYBACK_WATCHDOG_MS = 120_000;

export function useTtsPlayback(): TtsPlayback {
  const playerRef = useRef<AudioPlayer | null>(null);
  const lastUriRef = useRef<string | null>(null);
  // Monotonic token — bumped on every speak/stop so stale async branches
  // can detect they've been superseded and bail out cleanly.
  const cancelTokenRef = useRef(0);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current !== null) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  // -------------------------------------------------------------------------
  // teardown — stop player, release audio session, clean up cache file.
  // All sync operations (pause/remove) happen before the first await so
  // callers that don't await still get immediate native cleanup.
  // -------------------------------------------------------------------------
  const teardown = useCallback(
    async (reason: string): Promise<void> => {
      clearWatchdog();
      audioLog("TTS.teardown", { reason });

      const p = playerRef.current;
      playerRef.current = null;
      setIsPlaying(false);
      patchAudioState({ ttsSpeaking: false, ttsReady: true });

      if (p) {
        try {
          p.pause();
        } catch {
          // already stopped / released — ignore
        }
        try {
          p.remove();
        } catch {
          // already removed — ignore
        }
      }

      const uri = lastUriRef.current;
      lastUriRef.current = null;
      if (uri) {
        try {
          await FileSystem.deleteAsync(uri, { idempotent: true });
        } catch {
          // best-effort cache cleanup — never fatal
        }
      }

      // Reset audio mode to a neutral state so the recorder can later
      // call setAudioModeAsync({ allowsRecording: true }) without fighting
      // a lingering playback audio-focus claim from this player.
      try {
        await setAudioModeAsync({
          allowsRecording: false,
          playsInSilentMode: true,
        });
        patchAudioState({ audioFocusState: "none" });
        audioLog("TTS.teardown.audioModeReset", { reason });
      } catch (err) {
        audioError("TTS.teardown.setAudioMode", err, { reason });
        // Non-fatal — audio mode reset failure is annoying but not blocking.
      }
    },
    [clearWatchdog],
  );

  // -------------------------------------------------------------------------
  // stopAsync / stop
  // -------------------------------------------------------------------------
  const stopAsync = useCallback((): Promise<void> => {
    cancelTokenRef.current += 1;
    audioLog("TTS.stopAsync", { token: cancelTokenRef.current });
    return teardown("explicit-stop");
  }, [teardown]);

  const stop = useCallback((): void => {
    void stopAsync();
  }, [stopAsync]);

  // -------------------------------------------------------------------------
  // speak
  // -------------------------------------------------------------------------
  const speak = useCallback(
    (text: string): void => {
      const trimmed = text.trim();
      if (!trimmed) return;

      cancelTokenRef.current += 1;
      const myToken = cancelTokenRef.current;
      audioLog("TTS.speak.queued", { token: myToken, chars: trimmed.length });

      void (async () => {
        // Tear down any in-progress playback synchronously (pause/remove)
        // before touching the audio session.
        await teardown("superseded");

        if (myToken !== cancelTokenRef.current) {
          audioLog("TTS.speak.cancelled", {
            token: myToken,
            reason: "superseded before audio-mode set",
          });
          return;
        }

        // Explicitly request playback audio focus on Android BEFORE the
        // network call so the session is ready when audio arrives. Without
        // this, createAudioPlayer after a recording session may not get
        // audio focus and plays silently.
        try {
          await setAudioModeAsync({
            allowsRecording: false,
            playsInSilentMode: true,
          });
          patchAudioState({ audioFocusState: "playback", ttsReady: false });
          audioLog("TTS.speak.audioModeSet", { token: myToken });
        } catch (err) {
          audioError("TTS.speak.setAudioMode", err, { token: myToken });
          // Non-fatal — attempt playback anyway; worst case it's silent.
        }

        if (myToken !== cancelTokenRef.current) {
          audioLog("TTS.speak.cancelled", {
            token: myToken,
            reason: "superseded after audio-mode set",
          });
          return;
        }

        // Network fetch with hard timeout.
        let result: { uri: string };
        try {
          audioLog("TTS.speak.fetchStart", {
            token: myToken,
            timeoutMs: TTS_NETWORK_TIMEOUT_MS,
          });
          patchAudioState({ lastTtsStartedAt: Date.now() });
          result = await Promise.race([
            synthesizeSpeechToFile(trimmed),
            new Promise<never>((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error(
                      `TTS network timeout after ${TTS_NETWORK_TIMEOUT_MS}ms`,
                    ),
                  ),
                TTS_NETWORK_TIMEOUT_MS,
              ),
            ),
          ]);
          audioLog("TTS.speak.fetchDone", { token: myToken });
        } catch (err) {
          audioError("TTS.speak.fetch", err, { token: myToken });
          patchAudioState({ ttsReady: true, audioFocusState: "none" });
          return;
        }

        if (myToken !== cancelTokenRef.current) {
          audioLog("TTS.speak.cancelled", {
            token: myToken,
            reason: "superseded after fetch",
          });
          try {
            await FileSystem.deleteAsync(result.uri, { idempotent: true });
          } catch {
            // ignore
          }
          return;
        }

        // Create player and start playback.
        try {
          audioLog("TTS.speak.createPlayer", { token: myToken });
          const player = createAudioPlayer({ uri: result.uri });
          playerRef.current = player;
          lastUriRef.current = result.uri;
          setIsPlaying(true);
          patchAudioState({
            ttsSpeaking: true,
            ttsReady: true,
            lastTtsStartedAt: Date.now(),
          });

          player.addListener("playbackStatusUpdate", (status) => {
            if (status.didJustFinish) {
              audioLog("TTS.speak.didJustFinish", { token: myToken });
              patchAudioState({
                ttsSpeaking: false,
                lastTtsFinishedAt: Date.now(),
              });
              if (playerRef.current === player) {
                void teardown("didJustFinish");
              }
            }
          });

          // Watchdog: if didJustFinish never fires (e.g. Android drops the
          // event after audio focus loss), force teardown so the pipeline
          // doesn't stay locked forever.
          watchdogRef.current = setTimeout(() => {
            audioLog("TTS.speak.watchdogFired", {
              token: myToken,
              watchdogMs: TTS_PLAYBACK_WATCHDOG_MS,
            });
            patchAudioState({
              lastAudioError: "TTS watchdog fired — didJustFinish never received",
            });
            if (playerRef.current === player) {
              void teardown("watchdog");
            }
          }, TTS_PLAYBACK_WATCHDOG_MS);

          player.play();
          audioLog("TTS.speak.playing", { token: myToken });
        } catch (err) {
          audioError("TTS.speak.createPlayer", err, { token: myToken });
          void teardown("createPlayer-error");
        }
      })();
    },
    [teardown],
  );

  // Cleanup on unmount — never leak a player or hold an audio session.
  useEffect(() => {
    return () => {
      cancelTokenRef.current += 1;
      clearWatchdog();
      void teardown("unmount");
    };
  }, [teardown, clearWatchdog]);

  return { speak, stop, stopAsync, isPlaying };
}
