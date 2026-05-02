import React, { useEffect } from "react";
import { Image } from "expo-image";
import {
  StyleSheet,
  View,
  type ImageSourcePropType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

const ashleyAvatar: ImageSourcePropType = require("../assets/images/ashley_avatar.png");

export function AnimatedAvatar({
  size = 320,
  style,
}: {
  size?: number;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const breathe = useSharedValue(0);
  const sway = useSharedValue(0);

  useEffect(() => {
    breathe.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 3200, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 3200, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      false,
    );
    sway.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 5400, easing: Easing.inOut(Easing.sin) }),
        withTiming(-1, { duration: 5400, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      true,
    );
  }, [breathe, sway]);

  const animatedStyle = useAnimatedStyle(() => {
    const scale = 1 + breathe.value * 0.018;
    const translateY = -breathe.value * 4;
    const rotate = `${sway.value * 0.6}deg`;
    return {
      transform: [{ translateY }, { scale }, { rotate }],
    };
  });

  return (
    <View style={[styles.wrapper, { width: size, height: size }, style]}>
      <Animated.View style={[styles.inner, animatedStyle]}>
        <Image
          source={ashleyAvatar}
          style={styles.image}
          contentFit="contain"
          transition={300}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    alignItems: "center",
    justifyContent: "center",
  },
  inner: {
    width: "100%",
    height: "100%",
  },
  image: {
    width: "100%",
    height: "100%",
  },
});
