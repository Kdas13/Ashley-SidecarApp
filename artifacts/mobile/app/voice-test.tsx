/**
 * Voice Test Screen — completely isolated STT/TTS harness.
 *
 * NO imports from lib/aiClient, lib/voiceInput, lib/voiceOutput,
 * lib/audioState, or any Ashley-specific code. Every call is inlined.
 *
 * Purpose: prove whether raw STT and raw TTS actually work together
 * on Android in isolation, independent of Ashley's chat stack.
 *
 * State panel shows every field Kane requested:
 *   mic permission | STT active | STT error | transcript
 *   TTS speaking   | TTS error  | last lifecycle event
 *   last failure reason | recovery count
 */
import React, { useCallback, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, Stack } from "expo-router";
import {
  AudioModule,
  createAudioPlayer,
  setAudioModeAsync,
  useAudioRecorder,
  RecordingPresets,
  type AudioPlayer,
} from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";

// ---------------------------------------------------------------------------
// Inline API helpers — zero Ashley lib imports
// ---------------------------------------------------------------------------

const EXPO_API_KEY = process.env.EXPO_PUBLIC_API_KEY ?? "";
const EXPO_DOMAIN  = process.env.EXPO_PUBLIC_DOMAIN  ?? "";

function apiBase(): string {
  const raw = (EXPO_DOMAIN || "").replace(/\/+$/, "");
  const withScheme =
    raw.startsWith("http://") || raw.startsWith("https://")
      ? raw
      : `https://${raw}`;
  return /\/api$/.test(withScheme) ? withScheme : `${withScheme}/api`;
}

function apiHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(EXPO_API_KEY ? { "X-API-Key": EXPO_API_KEY } : {}),
  };
}

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

type MicPerm = "unknown" | "granted" | "denied";

type S = {
  micPermission:     MicPerm;
  sttActive:         boolean;   // recording in progress
  sttError:          string | null;
  sttResult:         string;    // transcript
  ttsSpeaking:       boolean;
  ttsError:          string | null;
  lastEvent:         string;
  lastEventAt:       string | null;
  lastFailureReason: string | null;  // most recent failure message from any step
  recoveryCount:     number;         // how many times Recover Audio has been tapped
};

const INIT: S = {
  micPermission:     "unknown",
  sttActive:         false,
  sttError:          null,
  sttResult:         "",
  ttsSpeaking:       false,
  ttsError:          null,
  lastEvent:         "idle",
  lastEventAt:       null,
  lastFailureReason: null,
  recoveryCount:     0,
};

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function VoiceTestScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [s, setS] = useState<S>(INIT);

  const recorder      = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const playerRef     = useRef<AudioPlayer | null>(null);
  const playerUriRef  = useRef<string | null>(null);

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  const log = useCallback((event: string): void => {
    const ts = new Date().toISOString();
    console.log(`[VoiceTest] ${ts}  ${event}`);
    setS((prev) => ({ ...prev, lastEvent: event, lastEventAt: ts }));
  }, []);

  const patch = useCallback((p: Partial<S>): void => {
    setS((prev) => ({ ...prev, ...p }));
  }, []);

  /** Record a failure: sets the specific error field AND lastFailureReason. */
  const fail = useCallback((field: "sttError" | "ttsError", msg: string): void => {
    const ts = new Date().toISOString();
    console.log(`[VoiceTest] ${ts}  FAIL(${field}): ${msg}`);
    setS((prev) => ({
      ...prev,
      [field]:          msg,
      lastFailureReason: msg,
      lastEvent:        `FAIL: ${msg}`,
      lastEventAt:      ts,
    }));
  }, []);

  // -----------------------------------------------------------------------
  // Recover Audio — hard audio-focus reset, no state wipe
  // -----------------------------------------------------------------------

  const handleRecover = useCallback(async (): Promise<void> => {
    log("RECOVER: stopping player and releasing audio focus...");

    // Kill any live player.
    const prevPlayer = playerRef.current;
    playerRef.current = null;
    if (prevPlayer) {
      try { prevPlayer.pause();  } catch { /* ignore */ }
      try { prevPlayer.remove(); } catch { /* ignore */ }
    }
    const prevUri = playerUriRef.current;
    playerUriRef.current = null;
    if (prevUri) {
      FileSystem.deleteAsync(prevUri, { idempotent: true }).catch(() => {/* ignore */});
    }

    // Force audio mode back to neutral.
    try {
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: false });
      log("RECOVER: setAudioModeAsync neutral OK");
    } catch (err) {
      log(`RECOVER: setAudioModeAsync FAILED (continuing): ${err instanceof Error ? err.message : String(err)}`);
    }

    setS((prev) => ({
      ...prev,
      sttActive:   false,
      ttsSpeaking: false,
      recoveryCount: prev.recoveryCount + 1,
      lastEvent:    `recovered (total: ${prev.recoveryCount + 1})`,
      lastEventAt:  new Date().toISOString(),
    }));
  }, [log]);

  // -----------------------------------------------------------------------
  // STT — Start Listening
  // -----------------------------------------------------------------------

  const handleStartListening = useCallback(async (): Promise<void> => {
    patch({ sttError: null, sttResult: "" });
    log("requestRecordingPermissionsAsync...");

    let granted = false;
    try {
      const status = await AudioModule.requestRecordingPermissionsAsync();
      granted = Boolean(status.granted);
      patch({ micPermission: granted ? "granted" : "denied" });
      log(`mic permission → ${granted ? "granted" : "DENIED"}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      patch({ micPermission: "denied" });
      fail("sttError", `permission: ${msg}`);
      return;
    }

    if (!granted) {
      fail("sttError", "Microphone permission denied");
      return;
    }

    try {
      log("setAudioModeAsync allowsRecording=true playsInSilentMode=true...");
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      log("setAudioModeAsync OK");
    } catch (err) {
      // Non-fatal on Android — log and continue.
      log(`setAudioModeAsync FAILED (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      log("prepareToRecordAsync...");
      await recorder.prepareToRecordAsync(RecordingPresets.HIGH_QUALITY);
      log("prepareToRecordAsync OK");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fail("sttError", `prepareToRecordAsync: ${msg}`);
      return;
    }

    try {
      recorder.record();
      patch({ sttActive: true });
      log("recorder.record() — listening");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fail("sttError", `recorder.record(): ${msg}`);
    }
  }, [recorder, log, patch, fail]);

  // -----------------------------------------------------------------------
  // STT — Stop and Transcribe
  // -----------------------------------------------------------------------

  const handleStopListening = useCallback(async (): Promise<void> => {
    patch({ sttActive: false });
    log("recorder.stop()...");

    try {
      await recorder.stop();
      log("recorder.stop() OK");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fail("sttError", `recorder.stop(): ${msg}`);
      return;
    }

    const uri = recorder.uri;
    log(`recorder.uri = ${uri ?? "null"}`);

    try {
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      log("setAudioModeAsync allowsRecording=false OK");
    } catch (err) {
      log(`setAudioModeAsync release FAILED (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!uri) {
      fail("sttError", "recorder.uri is null after stop — no audio captured");
      return;
    }

    let audioBase64: string;
    try {
      log("FileSystem.readAsStringAsync Base64...");
      audioBase64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      log(`audio file read: ${audioBase64.length} base64 chars`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fail("sttError", `file read: ${msg}`);
      return;
    }

    const base = apiBase();
    log(`POST ${base}/chat/transcribe...`);
    try {
      const resp = await fetch(`${base}/chat/transcribe`, {
        method:  "POST",
        headers: apiHeaders(),
        body:    JSON.stringify({ audioBase64, mimeType: "audio/m4a" }),
      });
      log(`transcribe HTTP ${resp.status}`);
      if (!resp.ok) {
        const body = await resp.text().catch(() => "(unreadable)");
        throw new Error(`HTTP ${resp.status}: ${body.slice(0, 300)}`);
      }
      const data = (await resp.json()) as { transcript?: string };
      const transcript = data.transcript ?? "";
      patch({ sttResult: transcript });
      log(`transcript: "${transcript}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fail("sttError", `transcribe: ${msg}`);
    }
  }, [recorder, log, patch, fail]);

  // -----------------------------------------------------------------------
  // TTS — Speak Test Reply
  // -----------------------------------------------------------------------

  const handleSpeak = useCallback(async (): Promise<void> => {
    patch({ ttsError: null });

    // Clean up any previous player.
    const prevPlayer = playerRef.current;
    playerRef.current = null;
    if (prevPlayer) {
      try { prevPlayer.pause();  } catch { /* ignore */ }
      try { prevPlayer.remove(); } catch { /* ignore */ }
    }
    const prevUri = playerUriRef.current;
    playerUriRef.current = null;
    if (prevUri) {
      FileSystem.deleteAsync(prevUri, { idempotent: true }).catch(() => {/* ignore */});
    }

    try {
      log("setAudioModeAsync for playback allowsRecording=false playsInSilentMode=true...");
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      log("setAudioModeAsync playback OK");
    } catch (err) {
      log(`setAudioModeAsync playback FAILED (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    const base = apiBase();
    log(`POST ${base}/chat/tts text="Voice test successful."...`);

    let fileUri: string;
    try {
      const resp = await fetch(`${base}/chat/tts`, {
        method:  "POST",
        headers: apiHeaders(),
        body:    JSON.stringify({ text: "Voice test successful." }),
      });
      log(`TTS HTTP ${resp.status}`);
      if (!resp.ok) {
        const body = await resp.text().catch(() => "(unreadable)");
        throw new Error(`HTTP ${resp.status}: ${body.slice(0, 300)}`);
      }
      const data = (await resp.json()) as { audioBase64?: string; mimeType?: string };
      const b64 = data.audioBase64 ?? "";
      log(`TTS audio received: ${b64.length} base64 chars`);
      if (!b64) throw new Error("response has empty audioBase64");

      const dir = FileSystem.cacheDirectory;
      if (!dir) throw new Error("FileSystem.cacheDirectory is null");
      fileUri = `${dir}vtest-tts-${Date.now()}.mp3`;
      await FileSystem.writeAsStringAsync(fileUri, b64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      playerUriRef.current = fileUri;
      log(`wrote audio file → ${fileUri}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fail("ttsError", `fetch/write: ${msg}`);
      return;
    }

    try {
      log("createAudioPlayer...");
      const player = createAudioPlayer({ uri: fileUri });
      playerRef.current = player;
      patch({ ttsSpeaking: true });

      player.addListener("playbackStatusUpdate", (status) => {
        if (status.didJustFinish) {
          log("didJustFinish — TTS playback complete");
          patch({ ttsSpeaking: false });
          playerRef.current = null;
          try { player.remove(); } catch { /* ignore */ }
          playerUriRef.current = null;
          FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => {/* ignore */});
        }
      });

      player.play();
      log("player.play() called");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fail("ttsError", `playback: ${msg}`);
      patch({ ttsSpeaking: false });
    }
  }, [log, patch, fail]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        style={styles.root}
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 40 },
        ]}
      >
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>← back</Text>
        </Pressable>

        <Text style={styles.title}>Voice Test</Text>
        <Text style={styles.subtitle}>
          Isolated harness — no Ashley, no chat, no background processes
        </Text>

        {/* ---- Step 1: STT ---- */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Step 1 — Speech to Text</Text>
          <View style={styles.btnRow}>
            <Pressable
              onPress={handleStartListening}
              disabled={s.sttActive}
              style={[styles.btn, s.sttActive && styles.btnRecording, s.sttActive && styles.btnDimmed]}
            >
              <Text style={styles.btnText}>
                {s.sttActive ? "Recording…" : "Start Listening"}
              </Text>
            </Pressable>
            <Pressable
              onPress={handleStopListening}
              disabled={!s.sttActive}
              style={[styles.btn, styles.btnStop, !s.sttActive && styles.btnDimmed]}
            >
              <Text style={styles.btnText}>Stop + Transcribe</Text>
            </Pressable>
          </View>
        </View>

        {/* ---- Step 2: TTS ---- */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Step 2 — Text to Speech</Text>
          <Pressable
            onPress={handleSpeak}
            disabled={s.ttsSpeaking}
            style={[styles.btn, styles.btnSpeak, s.ttsSpeaking && styles.btnSpeaking]}
          >
            <Text style={styles.btnText}>
              {s.ttsSpeaking
                ? 'Speaking "Voice test successful."…'
                : "Speak Test Reply"}
            </Text>
          </Pressable>
        </View>

        {/* ---- Recover ---- */}
        <Pressable onPress={handleRecover} style={[styles.btn, styles.btnRecover]}>
          <Text style={styles.btnText}>Recover Audio</Text>
        </Pressable>

        {/* ---- State panel ---- */}
        <View style={styles.stateCard}>
          <Text style={styles.stateTitle}>Audio State</Text>

          <StateRow label="mic permission"      value={s.micPermission} />
          <StateRow
            label="STT active"
            value={s.sttActive ? "true" : "false"}
            highlight={s.sttActive}
          />
          <StateRow
            label="STT error"
            value={s.sttError ?? "(none)"}
            isError={!!s.sttError}
          />
          <StateRow
            label="transcript"
            value={s.sttResult.length > 0 ? `"${s.sttResult}"` : "(none)"}
            highlight={s.sttResult.length > 0}
          />
          <StateRow
            label="TTS speaking"
            value={s.ttsSpeaking ? "true" : "false"}
            highlight={s.ttsSpeaking}
          />
          <StateRow
            label="TTS error"
            value={s.ttsError ?? "(none)"}
            isError={!!s.ttsError}
          />
          <StateRow label="last lifecycle event" value={s.lastEvent} />
          <StateRow label="last event at"        value={s.lastEventAt ?? "(never)"} />
          <StateRow
            label="last failure reason"
            value={s.lastFailureReason ?? "(none)"}
            isError={!!s.lastFailureReason}
          />
          <StateRow
            label="recovery count"
            value={String(s.recoveryCount)}
            highlight={s.recoveryCount > 0}
          />
        </View>

        {/* ---- Reset ---- */}
        <Pressable
          onPress={() => {
            setS(INIT);
            log("full state reset by user");
          }}
          style={styles.resetBtn}
        >
          <Text style={styles.resetBtnText}>Reset All State</Text>
        </Pressable>

        <Text style={styles.footer}>
          All events logged to console with [VoiceTest] prefix + timestamp.
        </Text>
      </ScrollView>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StateRow({
  label,
  value,
  highlight,
  isError,
}: {
  label:      string;
  value:      string;
  highlight?: boolean;
  isError?:   boolean;
}): React.JSX.Element {
  return (
    <View style={rowStyles.row}>
      <Text style={rowStyles.label}>{label}</Text>
      <Text
        style={[
          rowStyles.value,
          highlight && rowStyles.highlight,
          isError   && rowStyles.error,
        ]}
        numberOfLines={4}
      >
        {value}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const rowStyles = StyleSheet.create({
  row: {
    flexDirection:   "row",
    justifyContent:  "space-between",
    paddingVertical: 6,
    borderBottomWidth:  StyleSheet.hairlineWidth,
    borderBottomColor:  "rgba(255,255,255,0.07)",
  },
  label: {
    color:      "rgba(255,255,255,0.4)",
    fontSize:   12,
    fontFamily: "Inter_400Regular",
    flex:       1,
  },
  value: {
    color:      "rgba(255,255,255,0.8)",
    fontSize:   12,
    fontFamily: "Inter_500Medium",
    flex:       2,
    textAlign:  "right",
  },
  highlight: { color: "#4ade80" },
  error:     { color: "#f87171" },
});

const styles = StyleSheet.create({
  root:    { flex: 1, backgroundColor: "#0a0a0a" },
  content: { paddingHorizontal: 20, gap: 14 },

  backBtn:  { marginBottom: 2 },
  backText: {
    color:      "rgba(255,255,255,0.4)",
    fontSize:   14,
    fontFamily: "Inter_400Regular",
  },

  title: {
    color:      "#ffffff",
    fontSize:   24,
    fontFamily: "Inter_700Bold",
    marginBottom: 2,
  },
  subtitle: {
    color:      "rgba(255,255,255,0.35)",
    fontSize:   12,
    fontFamily: "Inter_400Regular",
    marginBottom: 4,
  },

  card: {
    backgroundColor: "rgba(255,255,255,0.05)",
    borderRadius:    14,
    padding:         16,
    gap:             12,
  },
  cardTitle: {
    color:      "rgba(255,255,255,0.6)",
    fontSize:   13,
    fontFamily: "Inter_600SemiBold",
  },

  btnRow: { flexDirection: "row", gap: 10 },

  btn: {
    flex:             1,
    backgroundColor:  "rgba(255,255,255,0.10)",
    borderRadius:     10,
    paddingVertical:  14,
    paddingHorizontal: 12,
    alignItems:       "center",
    justifyContent:   "center",
  },
  btnRecording: {
    backgroundColor: "rgba(74,222,128,0.15)",
    borderWidth:     1,
    borderColor:     "#4ade80",
  },
  btnStop: {
    backgroundColor: "rgba(239,68,68,0.15)",
    borderWidth:     1,
    borderColor:     "#ef4444",
  },
  btnDimmed: { opacity: 0.3 },
  btnSpeak: {
    flex:             0,
    alignSelf:        "stretch",
    backgroundColor:  "rgba(139,92,246,0.2)",
    borderWidth:      1,
    borderColor:      "#8b5cf6",
  },
  btnSpeaking: { backgroundColor: "rgba(139,92,246,0.35)" },
  btnRecover: {
    flex:             0,
    backgroundColor:  "rgba(251,146,60,0.15)",
    borderWidth:      1,
    borderColor:      "#fb923c",
  },
  btnText: {
    color:      "#ffffff",
    fontSize:   14,
    fontFamily: "Inter_500Medium",
    textAlign:  "center",
  },

  stateCard: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius:    14,
    padding:         16,
  },
  stateTitle: {
    color:          "rgba(255,255,255,0.35)",
    fontSize:       10,
    fontFamily:     "Inter_600SemiBold",
    textTransform:  "uppercase",
    letterSpacing:  1,
    marginBottom:   8,
  },

  resetBtn: {
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius:    10,
    paddingVertical: 12,
    alignItems:      "center",
  },
  resetBtnText: {
    color:      "rgba(255,255,255,0.4)",
    fontSize:   13,
    fontFamily: "Inter_500Medium",
  },

  footer: {
    color:      "rgba(255,255,255,0.18)",
    fontSize:   11,
    fontFamily: "Inter_400Regular",
    textAlign:  "center",
    marginTop:  4,
  },
});
