import React, { useEffect } from "react";
import { LinearGradient } from "expo-linear-gradient";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

export function AmbientBackground({
  children,
  dim = 0.35,
}: {
  children?: React.ReactNode;
  dim?: number;
}): React.JSX.Element {
  const glow = useSharedValue(0);

  useEffect(() => {
    glow.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 12000, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 12000, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      false,
    );
  }, [glow]);

  const glowStyle = useAnimatedStyle(() => ({
    opacity: 0.06 + glow.value * 0.08,
  }));

  return (
    <View style={styles.root}>
      <LinearGradient
        colors={["#0B0F18", "#0D1420", "#0B0F18"]}
        locations={[0, 0.5, 1]}
        style={StyleSheet.absoluteFillObject}
      />
      <Animated.View
        style={[
          StyleSheet.absoluteFillObject,
          styles.glowLayer,
          glowStyle,
        ]}
      />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0B0F18",
  },
  glowLayer: {
    backgroundColor: "#00B9FF",
    borderRadius: 9999,
    top: "30%",
    left: "10%",
    right: "10%",
    bottom: "30%",
  },
});
