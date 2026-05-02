import React, { useEffect } from "react";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { StyleSheet, View, type ImageSourcePropType } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

const ambient: ImageSourcePropType = require("../assets/images/ambient_bg.png");

export function AmbientBackground({
  children,
  dim = 0.35,
}: {
  children?: React.ReactNode;
  dim?: number;
}): React.JSX.Element {
  const drift = useSharedValue(0);

  useEffect(() => {
    drift.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 18000, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 18000, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      false,
    );
  }, [drift]);

  const animatedStyle = useAnimatedStyle(() => {
    const translateY = drift.value * -24;
    const scale = 1.06 + drift.value * 0.02;
    return {
      transform: [{ translateY }, { scale }],
    };
  });

  return (
    <View style={styles.root}>
      <Animated.View style={[StyleSheet.absoluteFillObject, animatedStyle]}>
        <Image
          source={ambient}
          style={StyleSheet.absoluteFillObject}
          contentFit="cover"
          transition={400}
        />
      </Animated.View>
      <LinearGradient
        colors={[
          `rgba(26, 19, 37, ${dim * 0.4})`,
          `rgba(26, 19, 37, ${dim})`,
          `rgba(26, 19, 37, ${Math.min(1, dim + 0.45)})`,
        ]}
        style={StyleSheet.absoluteFillObject}
      />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#1a1325",
  },
});
