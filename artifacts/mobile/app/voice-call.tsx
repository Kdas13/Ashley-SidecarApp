import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, Stack } from "expo-router";
import InCallManager from "react-native-incall-manager";
import { useVoiceCall, type VoiceCallPhase } from "@/lib/useVoiceCall";

// ── Helpers ───────────────────────────────────────────────────────────────────

function phaseLabel(phase: VoiceCallPhase): string {
  switch (phase) {
    case "idle":          return "Ready";
    case "connecting":    return "Connecting...";
    case "listening":     return "Listening — speak when ready";
    case "user_speaking": return "Got you — keep going";
    case "submitting":    return "Sending...";
    case "thinking":      return "Thinking...";
    case "speaking":      return "Ashley speaking";
    case "ended":         return "Call ended";
  }
}

function phaseColor(phase: VoiceCallPhase): string {
  switch (phase) {
    case "user_speaking": return "#4ade80";
    case "speaking":      return "#a78bfa";
    case "thinking":
    case "submitting":    return "#60a5fa";
    case "ended":         return "rgba(255,255,255,0.2)";
    default:              return "rgba(255,255,255,0.45)";
  }
}

// ── Animated pulse dot ────────────────────────────────────────────────────────

function PulseDot({ phase }: { phase: VoiceCallPhase }): React.JSX.Element {
  const anim = useRef(new Animated.Value(1)).current;
  const pulse = phase === "user_speaking" || phase === "speaking";

  useEffect(() => {
    if (pulse) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(anim, { toValue: 0.2, duration: 500, useNativeDriver: true }),
          Animated.timing(anim, { toValue: 1,   duration: 500, useNativeDriver: true }),
        ]),
      );
      loop.start();
      return () => loop.stop();
    }
    anim.stopAnimation();
    anim.setValue(1);
    return undefined;
  }, [pulse, anim]);

  return (
    <Animated.View
      style={[styles.dot, { backgroundColor: phaseColor(phase), opacity: anim }]}
    />
  );
}

// ── Mic level bar ─────────────────────────────────────────────────────────────
// Maps dBFS (-80…0) to a 0–1 fill. Null → empty bar (mic closed).

function MicLevelBar({ metering }: { metering: number | null }): React.JSX.Element {
  const fill = metering === null ? 0 : Math.max(0, Math.min(1, (metering + 80) / 80));
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: fill,
      duration: 80,
      useNativeDriver: false,
    }).start();
  }, [fill, anim]);

  return (
    <View style={styles.levelTrack}>
      <Animated.View
        style={[
          styles.levelFill,
          {
            width: anim.interpolate({
              inputRange: [0, 1],
              outputRange: ["0%", "100%"],
            }),
            backgroundColor: fill > 0.6 ? "#4ade80" : fill > 0.3 ? "#60a5fa" : "rgba(255,255,255,0.3)",
          },
        ]}
      />
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

// ── Debug log panel ───────────────────────────────────────────────────────────

function DebugLog({ entries }: { entries: string[] }): React.JSX.Element {
  return (
    <View style={styles.debugPanel}>
      <Text style={styles.debugTitle}>DBG</Text>
      <ScrollView style={styles.debugScroll} nestedScrollEnabled>
        {entries.map((e, i) => (
          <Text key={i} style={styles.debugEntry}>{e}</Text>
        ))}
      </ScrollView>
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function VoiceCallScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [audioMode, setAudioMode] = useState<"speaker" | "headset" | null>(null);
  const {
    phase,
    userTranscript,
    ashleyResponse,
    error,
    metering,
    auditLog,
    connect,
    disconnect,
    submitNow,
    interrupt,
  } = useVoiceCall({ headsetMode: audioMode === "headset" });

  const micOpen = phase === "listening" || phase === "user_speaking";
  const connected = phase !== "idle" && phase !== "connecting" && phase !== "ended";
  const isEnded = phase === "ended";

  useEffect(() => {
    if (audioMode) connect();
  }, [audioMode, connect]);

  useEffect(() => {
    if (phase === "ended") {
      const t = setTimeout(() => router.back(), 1800);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [phase]);

  const onHangUp = useCallback(() => {
    if (audioMode === "headset") InCallManager.stop();
    disconnect();
  }, [audioMode, disconnect]);

  useEffect(() => {
    return () => {
      if (audioMode === "headset") InCallManager.stop();
    };
  }, [audioMode]);

  if (audioMode === null) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <View
          style={[
            styles.root,
            { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 36, justifyContent: "center" },
          ]}
        >
          <Text style={styles.name}>Ashley</Text>
          <Text style={styles.chooserSubtitle}>How do you want to call?</Text>
          <View style={styles.chooserButtons}>
            <Pressable
              onPress={() => setAudioMode("speaker")}
              style={({ pressed }) => [styles.chooserBtn, pressed && { opacity: 0.7 }]}
            >
              <Text style={styles.chooserBtnText}>Speaker</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                InCallManager.start({ media: "audio" });
                setAudioMode("headset");
              }}
              style={({ pressed }) => [styles.chooserBtn, styles.chooserBtnHeadset, pressed && { opacity: 0.7 }]}
            >
              <Text style={styles.chooserBtnText}>Headset</Text>
            </Pressable>
          </View>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View
        style={[
          styles.root,
          { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 36 },
        ]}
      >
        {/* Header */}
        <Text style={styles.name}>Ashley</Text>

        {/* Status */}
        <View style={styles.statusRow}>
          <PulseDot phase={phase} />
          <Text style={[styles.statusText, { color: phaseColor(phase) }]}>
            {phaseLabel(phase)}
          </Text>
        </View>

        {/* Mic level bar — only shows when mic is open */}
        <View style={styles.levelRow}>
          {micOpen && <MicLevelBar metering={metering} />}
          {micOpen && metering !== null && (
            <Text style={styles.meteringLabel}>{Math.round(metering)} dB</Text>
          )}
        </View>

        {/* Transcript */}
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {!!userTranscript && (
            <View style={styles.bubble}>
              <Text style={styles.bubbleLabel}>You</Text>
              <Text style={styles.bubbleText}>{userTranscript}</Text>
            </View>
          )}
          {!!ashleyResponse && (
            <View style={[styles.bubble, styles.ashleyBubble]}>
              <Text style={styles.bubbleLabel}>Ashley</Text>
              <Text style={[styles.bubbleText, styles.ashleyText]}>{ashleyResponse}</Text>
            </View>
          )}
          {!!error && <Text style={styles.errorText}>{error}</Text>}
        </ScrollView>

        {/* Debug audit log */}
        <DebugLog entries={auditLog} />

        {/* Controls */}
        <View style={styles.controls}>
          {/* Manual send — tap if VAD doesn't fire */}
          {micOpen && (
            <Pressable
              onPress={submitNow}
              style={({ pressed }) => [
                styles.sendBtn,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text style={styles.sendBtnText}>Send ▶</Text>
            </Pressable>
          )}

          {/* Interrupt — tap to cut Ashley off mid-sentence */}
          {phase === "speaking" && (
            <Pressable
              onPress={interrupt}
              style={({ pressed }) => [
                styles.interruptBtn,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text style={styles.interruptBtnText}>Interrupt</Text>
            </Pressable>
          )}

          {/* Hang up */}
          <Pressable
            onPress={onHangUp}
            disabled={isEnded || phase === "connecting"}
            style={[
              styles.hangUpBtn,
              (isEnded || phase === "connecting") && styles.hangUpBtnDisabled,
            ]}
          >
            <Text style={styles.hangUpIcon}>✕</Text>
            <Text style={styles.hangUpLabel}>
              {phase === "connecting" ? "Connecting..." : connected ? "End call" : "Call Ashley"}
            </Text>
          </Pressable>
        </View>
      </View>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0a0a0a",
    alignItems: "center",
  },
  name: {
    color: "#ffffff",
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 16,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  levelRow: {
    width: "100%",
    paddingHorizontal: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 20,
    height: 20,
  },
  levelTrack: {
    flex: 1,
    height: 6,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderRadius: 3,
    overflow: "hidden",
  },
  levelFill: {
    height: "100%",
    borderRadius: 3,
  },
  meteringLabel: {
    color: "rgba(255,255,255,0.3)",
    fontSize: 10,
    fontFamily: "Inter_500Medium",
    width: 48,
    textAlign: "right",
  },
  scroll: {
    flex: 1,
    width: "100%",
    paddingHorizontal: 24,
  },
  scrollContent: {
    gap: 14,
    paddingBottom: 16,
  },
  bubble: {
    backgroundColor: "rgba(255,255,255,0.05)",
    borderRadius: 14,
    padding: 14,
    gap: 4,
  },
  ashleyBubble: {
    backgroundColor: "rgba(167,139,250,0.08)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(167,139,250,0.25)",
  },
  bubbleLabel: {
    color: "rgba(255,255,255,0.3)",
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  bubbleText: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    lineHeight: 22,
  },
  ashleyText: {
    color: "rgba(255,255,255,0.9)",
  },
  errorText: {
    color: "#f87171",
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    marginTop: 8,
  },
  controls: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: 24,
    gap: 14,
    marginTop: 8,
  },
  sendBtn: {
    paddingVertical: 12,
    paddingHorizontal: 36,
    backgroundColor: "rgba(96,165,250,0.12)",
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(96,165,250,0.4)",
  },
  sendBtnText: {
    color: "#60a5fa",
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  interruptBtn: {
    paddingVertical: 12,
    paddingHorizontal: 36,
    backgroundColor: "rgba(251,191,36,0.12)",
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(251,191,36,0.4)",
  },
  interruptBtnText: {
    color: "#fbbf24",
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  hangUpBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 32,
    backgroundColor: "rgba(239,68,68,0.12)",
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(239,68,68,0.4)",
  },
  hangUpBtnDisabled: {
    opacity: 0.3,
  },
  hangUpIcon: {
    color: "#ef4444",
    fontSize: 16,
  },
  hangUpLabel: {
    color: "#ef4444",
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  chooserSubtitle: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    marginBottom: 40,
  },
  chooserButtons: {
    width: "100%",
    paddingHorizontal: 24,
    gap: 14,
  },
  chooserBtn: {
    paddingVertical: 16,
    paddingHorizontal: 32,
    backgroundColor: "rgba(96,165,250,0.12)",
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(96,165,250,0.4)",
    alignItems: "center",
  },
  chooserBtnHeadset: {
    backgroundColor: "rgba(167,139,250,0.12)",
    borderColor: "rgba(167,139,250,0.4)",
  },
  chooserBtnText: {
    color: "#ffffff",
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  debugPanel: {
    width: "100%",
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  debugTitle: {
    color: "rgba(255,255,255,0.2)",
    fontSize: 9,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
    marginBottom: 3,
  },
  debugScroll: {
    maxHeight: 130,
    backgroundColor: "rgba(0,0,0,0.4)",
    borderRadius: 6,
    padding: 6,
  },
  debugEntry: {
    color: "rgba(255,255,255,0.45)",
    fontSize: 9,
    fontFamily: "Inter_400Regular",
    lineHeight: 14,
  },
});
