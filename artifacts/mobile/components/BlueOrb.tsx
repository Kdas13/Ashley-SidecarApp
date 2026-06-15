import React, { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

/**
 * Animated blue orb for the welcome screen.
 *
 * Layout model (fixes the "dot sits high" bug):
 *   - Container is exactly `size × size`.
 *   - The two ring layers use StyleSheet.absoluteFillObject so they are
 *     always co-centred with the container regardless of size.
 *   - Rings start at the container boundary and scale outward, fading as
 *     they expand — they never touch the dot visually.
 *   - The core dot sits in a flex-centered absoluteFill wrapper so it is
 *     always at the true geometric centre of the container.
 */
export function BlueOrb({ size = 200 }: { size?: number }): React.JSX.Element {
  const pulse = useSharedValue(0);
  const ring1Scale = useSharedValue(1);
  const ring1Opacity = useSharedValue(0.4);
  const ring2Scale = useSharedValue(1);
  const ring2Opacity = useSharedValue(0.3);

  useEffect(() => {
    // Core breathe
    pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 2800, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 2800, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      false,
    );

    // Ring 1 — immediate start
    ring1Scale.value = withRepeat(
      withSequence(
        withTiming(1.9, { duration: 3000, easing: Easing.out(Easing.exp) }),
        withTiming(1, { duration: 0 }),
      ),
      -1,
      false,
    );
    ring1Opacity.value = withRepeat(
      withSequence(
        withTiming(0, { duration: 3000, easing: Easing.in(Easing.quad) }),
        withTiming(0.4, { duration: 0 }),
      ),
      -1,
      false,
    );

    // Ring 2 — staggered 1.5 s
    ring2Scale.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1500 }),
        withTiming(1.9, { duration: 3000, easing: Easing.out(Easing.exp) }),
        withTiming(1, { duration: 0 }),
      ),
      -1,
      false,
    );
    ring2Opacity.value = withRepeat(
      withSequence(
        withTiming(0.3, { duration: 1500 }),
        withTiming(0, { duration: 3000, easing: Easing.in(Easing.quad) }),
        withTiming(0.3, { duration: 0 }),
      ),
      -1,
      false,
    );
  }, [pulse, ring1Scale, ring1Opacity, ring2Scale, ring2Opacity]);

  const coreStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 0.88 + pulse.value * 0.12 }],
  }));

  const ring1Style = useAnimatedStyle(() => ({
    transform: [{ scale: ring1Scale.value }],
    opacity: ring1Opacity.value,
  }));

  const ring2Style = useAnimatedStyle(() => ({
    transform: [{ scale: ring2Scale.value }],
    opacity: ring2Opacity.value,
  }));

  const dotSize = size * 0.36;

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      {/* Rings are absoluteFill so they are always co-centred with the container */}
      <Animated.View
        style={[StyleSheet.absoluteFillObject, styles.ring, ring1Style]}
        pointerEvents="none"
      />
      <Animated.View
        style={[StyleSheet.absoluteFillObject, styles.ring, ring2Style]}
        pointerEvents="none"
      />
      {/* Core dot: flex-centred inside an absoluteFill wrapper = true geometric centre */}
      <View style={[StyleSheet.absoluteFillObject, styles.centreWrapper]} pointerEvents="none">
        <Animated.View
          style={[
            styles.core,
            {
              width: dotSize,
              height: dotSize,
              borderRadius: dotSize / 2,
            },
            coreStyle,
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "relative",
  },
  ring: {
    borderRadius: 9999,
    borderWidth: 1.5,
    borderColor: "#00B9FF",
  },
  centreWrapper: {
    alignItems: "center",
    justifyContent: "center",
  },
  core: {
    backgroundColor: "#00B9FF",
    shadowColor: "#00B9FF",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.7,
    shadowRadius: 24,
    elevation: 18,
  },
});
