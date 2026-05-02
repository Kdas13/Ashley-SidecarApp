import React, { useCallback, useRef } from "react";
import { StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  type SharedValue,
} from "react-native-reanimated";

import colors from "@/constants/colors";

// Drag distance at which release commits a reply. Picked to match iMessage
// feel — short enough that one-handed flicks land it, long enough that an
// accidental jiggle never triggers.
const TRIGGER_THRESHOLD_PX = 56;

// Minimum horizontal travel before the underlying pan gesture activates.
// CRITICAL: this is what lets the FlatList own short vertical scrolls. The
// gesture stays asleep until the finger moves >=14px sideways, so vertical
// flicks pass straight through to the list.
const DRAG_OFFSET_PX = 14;

export type SwipeToReplyDirection = "left" | "right";

type Props = {
  /** Which way the user must swipe to commit a reply on this bubble. */
  direction: SwipeToReplyDirection;
  /**
   * Fired exactly once per gesture when the drag passes the threshold.
   * The bubble snaps back automatically after firing.
   */
  onTrigger: () => void;
  children: React.ReactNode;
};

/**
 * Hint icon shown underneath the bubble while it's being dragged. Lives in
 * its own component so we can call `useAnimatedStyle` at the top level
 * (Swipeable's render-action prop is invoked imperatively, so calling
 * hooks inside the render function would violate the rules of hooks).
 */
function ReplyHint({
  translation,
  side,
}: {
  translation: SharedValue<number>;
  side: SwipeToReplyDirection;
}): React.JSX.Element {
  const style = useAnimatedStyle(() => {
    // Swipeable gives us signed translation: positive = bubble moved right,
    // negative = bubble moved left. We only care about magnitude here.
    const dist = Math.abs(translation.value);
    const opacity = interpolate(
      dist,
      [DRAG_OFFSET_PX, TRIGGER_THRESHOLD_PX],
      [0, 1],
      Extrapolation.CLAMP,
    );
    const scale = interpolate(
      dist,
      [DRAG_OFFSET_PX, TRIGGER_THRESHOLD_PX, TRIGGER_THRESHOLD_PX * 1.4],
      [0.5, 1, 1.15],
      Extrapolation.CLAMP,
    );
    return { opacity, transform: [{ scale }] };
  });
  return (
    <Animated.View
      style={[
        styles.action,
        side === "right" ? styles.actionLeft : styles.actionRight,
        style,
      ]}
      pointerEvents="none"
    >
      <Feather
        name="corner-up-left"
        size={18}
        color={colors.light.mutedForeground}
      />
    </Animated.View>
  );
}

/**
 * Wraps a chat bubble row with horizontal swipe-to-reply behaviour. Uses
 * `ReanimatedSwipeable` from gesture-handler under the hood — the canonical
 * primitive for this pattern. It plays nicely with the FlatList's vertical
 * scroll (because of `dragOffsetFromLeftEdge`/`dragOffsetFromRightEdge`),
 * and lets nested Pressables (like the selfie-retry button) receive taps
 * normally because the underlying pan gesture only activates on a real
 * horizontal drag.
 *
 * Implementation notes:
 *  - We listen to `onSwipeableWillOpen` to fire the trigger + a medium
 *    haptic the moment the user passes the threshold. We then immediately
 *    call `close()` on the swipeable so the bubble springs back rather
 *    than latching open — same UX as iMessage.
 *  - `firedRef` guards against multiple triggers per gesture if both
 *    `willOpen` and `open` end up firing.
 */
export function SwipeToReply({
  direction,
  onTrigger,
  children,
}: Props): React.JSX.Element {
  const swipeableRef = useRef<SwipeableMethods>(null);
  const firedRef = useRef(false);

  const handleWillOpen = useCallback(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {
      /* haptics may be unavailable in web preview; ignore */
    });
    onTrigger();
    // Snap back rather than latching open — we don't want the action panel
    // to stay revealed since the reply UI lives in the input bar.
    requestAnimationFrame(() => swipeableRef.current?.close());
  }, [onTrigger]);

  const handleClose = useCallback(() => {
    firedRef.current = false;
  }, []);

  // direction "right": bubble drags right → action panel revealed on left
  // direction "left":  bubble drags left  → action panel revealed on right
  const renderHint = useCallback(
    (
      _progress: SharedValue<number>,
      translation: SharedValue<number>,
    ) => <ReplyHint translation={translation} side={direction} />,
    [direction],
  );

  const swipeProps =
    direction === "right"
      ? {
          renderLeftActions: renderHint,
          leftThreshold: TRIGGER_THRESHOLD_PX,
          dragOffsetFromLeftEdge: DRAG_OFFSET_PX,
          overshootLeft: false,
        }
      : {
          renderRightActions: renderHint,
          rightThreshold: TRIGGER_THRESHOLD_PX,
          dragOffsetFromRightEdge: DRAG_OFFSET_PX,
          overshootRight: false,
        };

  return (
    <ReanimatedSwipeable
      ref={swipeableRef}
      friction={2}
      onSwipeableWillOpen={handleWillOpen}
      onSwipeableClose={handleClose}
      containerStyle={styles.container}
      {...swipeProps}
    >
      {children}
    </ReanimatedSwipeable>
  );
}

const styles = StyleSheet.create({
  container: {
    // Allow the bubble's normal layout to flow; no clipping so the hint
    // icon can sit just outside the bubble visually.
    overflow: "visible",
  },
  action: {
    width: 56,
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
  actionLeft: { paddingLeft: 8 },
  actionRight: { paddingRight: 8 },
});
