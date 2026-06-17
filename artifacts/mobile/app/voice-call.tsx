// ---------------------------------------------------------------------------
// Voice Call Screen — live Ashley call via WebSocket + push-to-talk.
//
// Phase flow:
//   idle → connecting → listening ⇄ recording → transcribing → thinking
//   → speaking → listening (repeat)
//   Any phase → ended (hang up or WS close)
//
// Push-to-talk: hold the mic button to record, release to send.
// Interruption: pressing mic while Ashley is speaking stops her immediately.
// ---------------------------------------------------------------------------

import React, { useCallback, useEffect, useRef } from "react";
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
import { useVoiceCall, type VoiceCallPhase } from "@/lib/useVoiceCall";

// ── Status label ─────────────────────────────────────────────────────────────

function phaseLabel(phase: VoiceCallPhase): string {
  switch (phase) {
    case "idle":          return "Tap call to connect";
    case "connecting":    return "Connecting...";
    case "listening":     return "Listening";
    case "recording":     return "Recording...";
    case "transcribing":  return "Sending...";
    case "thinking":      return "Thinking...";
    case "speaking":      return "Speaking";
    case "ended":         return "Call ended";
  }
}

function phaseColor(phase: VoiceCallPhase): string {
  switch (phase) {
    case "recording":     return "#4ade80";
    case "speaking":      return "#a78bfa";
    case "thinking":      return "#60a5fa";
    case "ended":         return "rgba(255,255,255,0.2)";
    default:              return "rgba(255,255,255,0.55)";
  }
}

// ── Animated pulsing dot ─────────────────────────────────────────────────────

function PulseDot({ phase }: { phase: VoiceCallPhase }): React.JSX.Element {
  const anim = useRef(new Animated.Value(1)).current;
  const pulse = phase === "recording" || phase === "speaking";

  useEffect(() => {
    if (pulse) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(anim, { toValue: 0.3, duration: 600, useNativeDriver: true }),
          Animated.timing(anim, { toValue: 1,   duration: 600, useNativeDriver: true }),
        ]),
      );
      loop.start();
      return () => loop.stop();
    } else {
      anim.stopAnimation();
      anim.setValue(1);
      return undefined;
    }
  }, [pulse, anim]);

  return (
    <Animated.View
      style={[
        styles.dot,
        { backgroundColor: phaseColor(phase), opacity: anim },
      ]}
    />
  );
}

// ── Screen ───────────────────────────────────────────────────────────────────

export default function VoiceCallScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const {
    phase,
    userTranscript,
    ashleyResponse,
    error,
    connect,
    disconnect,
    startRecording,
    stopRecording,
    cancelRecording,
  } = useVoiceCall();

  // Connect as soon as the screen mounts.
  useEffect(() => {
    connect();
  }, [connect]);

  // Navigate back when the call ends (with a short pause so "Call ended" is
  // visible for a moment rather than the screen immediately disappearing).
  useEffect(() => {
    if (phase === "ended") {
      const t = setTimeout(() => router.back(), 1800);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [phase]);

  const onHangUp = useCallback(() => {
    disconnect();
  }, [disconnect]);

  const canRecord =
    phase === "listening" || phase === "speaking" || phase === "thinking";
  const isRecording = phase === "recording";
  const isEnded = phase === "ended";

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View
        style={[
          styles.root,
          { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 32 },
        ]}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.name}>Ashley</Text>
        </View>

        {/* Status row */}
        <View style={styles.statusRow}>
          <PulseDot phase={phase} />
          <Text style={[styles.statusText, { color: phaseColor(phase) }]}>
            {phaseLabel(phase)}
          </Text>
        </View>

        {/* Transcript area */}
        <ScrollView
          style={styles.transcriptScroll}
          contentContainerStyle={styles.transcriptContent}
        >
          {!!userTranscript && (
            <View style={styles.bubble}>
              <Text style={styles.bubbleLabel}>You</Text>
              <Text style={styles.bubbleText}>{userTranscript}</Text>
            </View>
          )}
          {!!ashleyResponse && (
            <View style={[styles.bubble, styles.ashleyBubble]}>
              <Text style={styles.bubbleLabel}>Ashley</Text>
              <Text style={[styles.bubbleText, styles.ashleyText]}>
                {ashleyResponse}
              </Text>
            </View>
          )}
          {!!error && (
            <Text style={styles.errorText}>{error}</Text>
          )}
        </ScrollView>

        {/* Controls */}
        <View style={styles.controls}>
          {/* Mic button — hold to speak */}
          <Pressable
            onPressIn={() => { void startRecording(); }}
            onPressOut={() => { void stopRecording(); }}
            onLongPress={() => { /* already handled by onPressIn */ }}
            disabled={isEnded || (!canRecord && !isRecording)}
            style={[
              styles.micBtn,
              isRecording && styles.micBtnActive,
              (isEnded || (!canRecord && !isRecording)) && styles.micBtnDisabled,
            ]}
          >
            <Text style={styles.micIcon}>{isRecording ? "●" : "◉"}</Text>
            <Text style={styles.micLabel}>
              {isRecording ? "Release to send" : "Hold to speak"}
            </Text>
          </Pressable>

          {/* Cancel recording — visible only while recording */}
          {isRecording && (
            <Pressable
              onPress={() => { void cancelRecording(); }}
              style={styles.cancelBtn}
            >
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </Pressable>
          )}

          {/* Hang-up button */}
          <Pressable
            onPress={onHangUp}
            disabled={isEnded}
            style={[styles.hangUpBtn, isEnded && styles.hangUpBtnDisabled]}
          >
            <Text style={styles.hangUpIcon}>✕</Text>
            <Text style={styles.hangUpLabel}>End call</Text>
          </Pressable>
        </View>
      </View>
    </>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0a0a0a",
    alignItems: "center",
  },

  header: {
    marginBottom: 16,
    alignItems: "center",
  },
  name: {
    color: "#ffffff",
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.5,
  },

  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 32,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },

  transcriptScroll: {
    flex: 1,
    width: "100%",
    paddingHorizontal: 24,
  },
  transcriptContent: {
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
    borderColor: "rgba(167,139,250,0.2)",
  },
  bubbleLabel: {
    color: "rgba(255,255,255,0.35)",
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
    fontFamily: "Inter_400Regular",
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
    gap: 16,
    marginTop: 8,
  },

  micBtn: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  micBtnActive: {
    backgroundColor: "rgba(74,222,128,0.15)",
    borderColor: "#4ade80",
  },
  micBtnDisabled: {
    opacity: 0.3,
  },
  micIcon: {
    color: "#ffffff",
    fontSize: 32,
  },
  micLabel: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    textAlign: "center",
  },

  cancelBtn: {
    paddingVertical: 8,
    paddingHorizontal: 20,
    backgroundColor: "rgba(251,146,60,0.12)",
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(251,146,60,0.4)",
  },
  cancelBtnText: {
    color: "#fb923c",
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },

  hangUpBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 28,
    backgroundColor: "rgba(239,68,68,0.15)",
    borderRadius: 24,
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
});
