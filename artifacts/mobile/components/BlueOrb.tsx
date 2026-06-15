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

export function BlueOrb({
  size = 200,
}: {
  size?: number;
}): React.JSX.Element {
  const pulse = useSharedValue(0);
  const ring1 = useSharedValue(0);
  const ring2 = useSharedValue(0);

  useEffect(() => {
    pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 2800, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 2800, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      false,
    );
    ring1.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 3200, easing: Easing.out(Easing.exp) }),
        withTiming(0, { duration: 0 }),
      ),
      -1,
      false,
    );
    ring2.value = withRepeat(
      withSequence(
        withTiming(0, { duration: 1600 }),
        withTiming(1, { duration: 3200, easing: Easing.out(Easing.exp) }),
        withTiming(0, { duration: 0 }),
      ),
      -1,
      false,
    );
  }, [pulse, ring1, ring2]);

  const coreStyle = useAnimatedStyle(() => {
    const scale = 0.88 + pulse.value * 0.12;
    return {
      transform: [{ scale }],
      shadowOpacity: 0.3 + pulse.value * 0.4,
    };
  });

  const ring1Style = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + ring1.value * 0.9 }],
    opacity: (1 - ring1.value) * 0.35,
  }));

  const ring2Style = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + ring2.value * 0.9 }],
    opacity: (1 - ring2.value) * 0.25,
  }));

  return (
    <View
      style={[styles.container, { width: size * 2, height: size * 2 }]}
    >
      <Animated.View
        style={[
          styles.ring,
          { width: size, height: size, borderRadius: size / 2 },
          ring1Style,
        ]}
      />
      <Animated.View
        style={[
          styles.ring,
          { width: size, height: size, borderRadius: size / 2 },
          ring2Style,
        ]}
      />
      <Animated.View
        style={[
          styles.core,
          { width: size * 0.38, height: size * 0.38, borderRadius: (size * 0.38) / 2 },
          coreStyle,
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
  },
  ring: {
    position: "absolute",
    borderWidth: 1.5,
    borderColor: "#00B9FF",
  },
  core: {
    backgroundColor: "#00B9FF",
    shadowColor: "#00B9FF",
    shadowOffset: { width: 0, height: 0 },
    shadowRadius: 32,
    elevation: 20,
  },
});
