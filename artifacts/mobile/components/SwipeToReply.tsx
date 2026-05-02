import React, { useCallback } from "react";
import { StyleSheet, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";

import colors from "@/constants/colors";

// Distance the bubble must travel (in px) before releasing commits a reply.
// Below this threshold the bubble springs back without firing onTrigger.
const TRIGGER_THRESHOLD_PX = 56;

// Hard cap on how far the bubble can be dragged regardless of finger
// movement. Past the threshold we apply rubber-banding so the gesture
// still feels responsive but doesn't fly across the screen.
const MAX_DRAG_PX = 92;

export type SwipeToReplyDirection = "left" | "right";

type Props = {
  /** Which way the user must swipe to commit a reply on this bubble. */
  direction: SwipeToReplyDirection;
  /**
   * Fired exactly once per gesture when the drag passes the threshold and
   * the user releases. Triggers a haptic on the JS thread.
   */
  onTrigger: () => void;
  children: React.ReactNode;
};

/**
 * Wraps a chat bubble row with a horizontal pan gesture. Dragging the
 * bubble in the configured direction reveals a reply icon underneath; if
 * the user releases past the threshold we fire `onTrigger` and a soft
 * haptic. Otherwise the bubble springs back into place.
 *
 * Implementation notes:
 *  - We use Reanimated's `useSharedValue` so the bubble follows the finger
 *    on the UI thread (60fps) even while the JS thread is busy.
 *  - The `triggered` shared value latches across the gesture so we only
 *    fire the haptic + JS callback once per pass over the threshold.
 *  - Vertical scrolling needs to win over this gesture, so we use
 *    `activeOffsetX` to give the FlatList first claim on small movements.
 */
export function SwipeToReply({
  direction,
  onTrigger,
  children,
}: Props): React.JSX.Element {
  const translateX = useSharedValue(0);
  const triggered = useSharedValue(false);

  const fireTrigger = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {
      /* haptics may not be available on web/preview; ignore */
    });
    onTrigger();
  }, [onTrigger]);

  const sign = direction === "right" ? 1 : -1;

  const pan = Gesture.Pan()
    // Require ~10px of horizontal movement before the gesture activates,
    // so vertical scrolling on the FlatList still wins for small drags.
    .activeOffsetX(direction === "right" ? [10, 999] : [-999, -10])
    .failOffsetY([-12, 12])
    .onUpdate((e) => {
      // Only allow movement in the configured direction. Movement in the
      // wrong direction is clamped to 0 so the bubble can't jitter.
      const raw = e.translationX * sign;
      if (raw <= 0) {
        translateX.value = 0;
        return;
      }
      // Past the threshold we add resistance so the bubble drifts but
      // doesn't follow 1:1 — cushions the visual cap at MAX_DRAG_PX.
      let next: number;
      if (raw <= TRIGGER_THRESHOLD_PX) {
        next = raw;
      } else {
        const overshoot = raw - TRIGGER_THRESHOLD_PX;
        next = TRIGGER_THRESHOLD_PX + overshoot * 0.4;
      }
      next = Math.min(next, MAX_DRAG_PX);
      translateX.value = next * sign;

      // Latch a single haptic + commit when crossing the threshold so the
      // user feels exactly when the reply will fire.
      if (!triggered.value && raw >= TRIGGER_THRESHOLD_PX) {
        triggered.value = true;
        runOnJS(fireTrigger)();
      } else if (triggered.value && raw < TRIGGER_THRESHOLD_PX * 0.85) {
        // Allow undoing if the user pulls back before releasing.
        triggered.value = false;
      }
    })
    .onEnd(() => {
      translateX.value = withSpring(0, {
        damping: 18,
        stiffness: 220,
        mass: 0.6,
      });
      triggered.value = false;
    })
    .onFinalize(() => {
      translateX.value = withSpring(0, {
        damping: 18,
        stiffness: 220,
        mass: 0.6,
      });
      triggered.value = false;
    });

  const bubbleStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  // Reply hint icon fades in as the user drags past ~30% of the threshold,
  // and rotates slightly past the trigger as a subtle commit cue.
  const hintStyle = useAnimatedStyle(() => {
    const progress = Math.abs(translateX.value) / TRIGGER_THRESHOLD_PX;
    const opacity = interpolate(
      progress,
      [0.2, 1],
      [0, 1],
      Extrapolation.CLAMP,
    );
    const scale = interpolate(
      progress,
      [0, 1, 1.4],
      [0.6, 1, 1.15],
      Extrapolation.CLAMP,
    );
    return { opacity, transform: [{ scale }] };
  });

  return (
    <View style={styles.wrap}>
      <Animated.View
        style={[
          styles.hint,
          direction === "right" ? styles.hintLeft : styles.hintRight,
          hintStyle,
        ]}
        pointerEvents="none"
      >
        <Feather
          name="corner-up-left"
          size={18}
          color={colors.light.mutedForeground}
        />
      </Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View style={bubbleStyle}>{children}</Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "relative",
    width: "100%",
  },
  hint: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  hintLeft: { left: 4 },
  hintRight: { right: 4 },
});
