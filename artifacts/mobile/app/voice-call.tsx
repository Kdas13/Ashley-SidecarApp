// ---------------------------------------------------------------------------
// Voice Call Screen
//
// UX: tap "Call" → connects, mic opens automatically.
// Talk freely. Silence auto-submits. Ashley replies. Mic reopens when she
// finishes. Tap "End call" at any point to hang up.
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
    case "idle":          return "Ready";
    case "connecting":    return "Connecting...";
    case "listening":     return "Listening";
    case "user_speaking": return "You're speaking";
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
    default:              return "rgba(255,255,255,0.55)";
  }
}

// ── Animated pulse ────────────────────────────────────────────────────────────

function PulseDot({ phase }: { phase: VoiceCallPhase }): React.JSX.Element {
  const anim = useRef(new Animated.Value(1)).current;
  const pulse = phase === "user_speaking" || phase === "speaking";

  useEffect(() => {
    if (pulse) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(anim, { toValue: 0.25, duration: 500, useNativeDriver: true }),
          Animated.timing(anim, { toValue: 1,    duration: 500, useNativeDriver: true }),
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

// ── Screen ────────────────────────────────────────────────────────────────────

export default function VoiceCallScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const {
    phase,
    userTranscript,
    ashleyResponse,
    error,
    connect,
    disconnect,
  } = useVoiceCall();

  const connected =
    phase !== "idle" && phase !== "connecting" && phase !== "ended";

  // Navigate back shortly after call ends.
  useEffect(() => {
    if (phase === "ended") {
      const t = setTimeout(() => router.back(), 1800);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [phase]);

  const onMainButton = useCallback(() => {
    if (phase === "idle") { connect(); return; }
    disconnect();
  }, [phase, connect, disconnect]);

  const isEnded = phase === "ended";

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View
        style={[
          styles.root,
          { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 40 },
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

        {/* Transcript */}
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
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
          {/* Large call / end call button */}
          <Pressable
            onPress={onMainButton}
            disabled={isEnded || phase === "connecting"}
            style={[
              styles.callBtn,
              connected ? styles.callBtnActive : styles.callBtnIdle,
              (isEnded || phase === "connecting") && styles.callBtnDisabled,
            ]}
          >
            <Text style={styles.callBtnIcon}>
              {connected ? "✕" : "◎"}
            </Text>
            <Text style={styles.callBtnLabel}>
              {phase === "connecting"
                ? "Connecting..."
                : connected
                  ? "End call"
                  : "Call Ashley"}
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
    marginBottom: 12,
  },

  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 28,
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
    marginTop: 8,
  },

  callBtn: {
    width: 160,
    height: 160,
    borderRadius: 80,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 2,
  },
  callBtnIdle: {
    backgroundColor: "rgba(74,222,128,0.12)",
    borderColor: "#4ade80",
  },
  callBtnActive: {
    backgroundColor: "rgba(239,68,68,0.12)",
    borderColor: "#ef4444",
  },
  callBtnDisabled: {
    opacity: 0.35,
  },
  callBtnIcon: {
    color: "#ffffff",
    fontSize: 36,
  },
  callBtnLabel: {
    color: "rgba(255,255,255,0.75)",
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
});
