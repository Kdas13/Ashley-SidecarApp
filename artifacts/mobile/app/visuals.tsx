import React, { useMemo } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon as Feather } from "@/components/Icon";
import { router } from "expo-router";

import { useMessages } from "@/lib/useMessages";
import type { ImageCategory, Message } from "@/lib/storage";
import colors from "@/constants/colors";

const CATEGORY_LABEL: Record<ImageCategory, string> = {
  art_progress: "Art progress",
  ashley_identity: "Ashley identity",
  app_screenshot: "App screenshot",
  medical: "Medical",
  clothing_design: "Clothing design",
  other: "Other",
};

const CATEGORY_ORDER: ImageCategory[] = [
  "art_progress",
  "clothing_design",
  "ashley_identity",
  "app_screenshot",
  "medical",
  "other",
];

type Section = { category: ImageCategory; items: Message[] };

export default function VisualsScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const messagesQuery = useMessages();

  const sections = useMemo<Section[]>(() => {
    const all = messagesQuery.data ?? [];
    const byCat = new Map<ImageCategory, Message[]>();
    for (const m of all) {
      if (m.role !== "user") continue;
      if (!m.imageUrl) continue;
      const cat = (m.imageCategory ?? "other") as ImageCategory;
      const arr = byCat.get(cat) ?? [];
      arr.push(m);
      byCat.set(cat, arr);
    }
    return CATEGORY_ORDER.filter((c) => (byCat.get(c) ?? []).length > 0).map(
      (c) => ({
        category: c,
        items: (byCat.get(c) ?? []).slice().reverse(),
      }),
    );
  }, [messagesQuery.data]);

  const totalCount = sections.reduce((n, s) => n + s.items.length, 0);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={styles.iconBtn}
          accessibilityLabel="Back"
        >
          <Feather name="chevron-left" size={22} color={colors.light.text} />
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Visual memory</Text>
          <Text style={styles.headerSubtitle}>
            {totalCount} {totalCount === 1 ? "photo" : "photos"} you've shared
          </Text>
        </View>
        <View style={styles.iconBtn} />
      </View>

      {messagesQuery.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.light.primary} />
        </View>
      ) : sections.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Feather
            name="image"
            size={36}
            color={colors.light.mutedForeground}
          />
          <Text style={styles.emptyText}>nothing here yet</Text>
          <Text style={styles.emptyHint}>
            send Ashley a photo from chat — anything you share shows up here,
            grouped by category.
          </Text>
        </View>
      ) : (
        <FlatList
          data={sections}
          keyExtractor={(s) => s.category}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>
                {CATEGORY_LABEL[item.category]}
              </Text>
              <Text style={styles.sectionCount}>
                {item.items.length}{" "}
                {item.items.length === 1 ? "photo" : "photos"}
              </Text>
              <View style={styles.grid}>
                {item.items.map((m) => (
                  <View key={m.id} style={styles.gridCell}>
                    <Image
                      source={{ uri: m.imageUrl! }}
                      style={styles.thumb}
                      resizeMode="cover"
                      accessibilityLabel={
                        m.imageCaption ?? CATEGORY_LABEL[item.category]
                      }
                    />
                    {m.imageCaption ? (
                      <Text style={styles.thumbCaption} numberOfLines={2}>
                        {m.imageCaption}
                      </Text>
                    ) : null}
                    {m.imageRemembered === true ? (
                      <View style={styles.rememberedBadge}>
                        <Feather
                          name="bookmark"
                          size={10}
                          color={colors.light.primaryForeground}
                        />
                      </View>
                    ) : null}
                  </View>
                ))}
              </View>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.light.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.light.border,
  },
  headerCenter: { flex: 1, alignItems: "center" },
  headerTitle: {
    color: colors.light.text,
    fontFamily: "Inter_600SemiBold",
    fontSize: 17,
  },
  headerSubtitle: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    marginTop: 1,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 10,
  },
  emptyText: {
    color: colors.light.text,
    fontFamily: "Inter_500Medium",
    fontSize: 16,
  },
  emptyHint: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    textAlign: "center",
    maxWidth: 280,
  },
  list: { padding: 16, paddingBottom: 32 },
  section: { marginBottom: 24 },
  sectionTitle: {
    color: colors.light.text,
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
  },
  sectionCount: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    marginTop: 2,
    marginBottom: 10,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  gridCell: {
    width: "31%",
    aspectRatio: 0.78,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: colors.light.muted,
    position: "relative",
  },
  thumb: { width: "100%", flex: 1, backgroundColor: "rgba(0,0,0,0.15)" },
  thumbCaption: {
    color: colors.light.text,
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  rememberedBadge: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.light.primary,
    alignItems: "center",
    justifyContent: "center",
  },
});
