// =============================================================================
// GET /api/debug/ashley-state  — Ashley 2.0 Phase 1 diagnostics
// =============================================================================
// Returns a snapshot of the current Ashley system state for a device without
// touching the chat pipeline. Useful for verifying that memory filtering,
// state injection, and continuity protection are wired correctly.
//
// Auth: same X-API-Key + Bearer device-id auth as every other route.
// Access: always available (the API key is the gate). Works in prod too —
// Kane needs visibility into the live system.
//
// Response shape:
//   {
//     deviceId,
//     ashleyState:    { mode, energy, tone, focus, emotionalState },
//     memorySummary:  { total, byCategory, reuseSplit },
//     profile:        { name, relationshipMode, builderAwareMode, voiceMode },
//   }
// =============================================================================

import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, ashleyProfileTable, memoriesTable } from "@workspace/db";
import { getDeviceId } from "../middleware/deviceId";
import { getOrCreateProfileFor } from "../lib/profile";

const router: IRouter = Router();

router.get("/debug/ashley-state", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);

  // ---- Load profile (create default if first-ever request) ----
  let profile: Awaited<ReturnType<typeof getOrCreateProfileFor>>;
  try {
    profile = await getOrCreateProfileFor(deviceId);
  } catch (err) {
    req.log.error({ err }, "debug/ashley-state: failed to load profile");
    res.status(500).json({ error: "Could not load profile" });
    return;
  }

  // ---- Load all memories for the device ----
  let memories: { category: string | null; confidence: number | null; importance: number; reuse: string | null; content: string }[];
  try {
    memories = await db
      .select({
        category: memoriesTable.category,
        confidence: memoriesTable.confidence,
        importance: memoriesTable.importance,
        reuse: memoriesTable.reuse,
        content: memoriesTable.content,
      })
      .from(memoriesTable)
      .where(eq(memoriesTable.deviceId, deviceId));
  } catch (err) {
    req.log.error({ err }, "debug/ashley-state: failed to load memories");
    res.status(500).json({ error: "Could not load memories" });
    return;
  }

  // ---- Ashley state vars ----
  const ashleyState = {
    mode: profile.ashleyMode?.trim() || "daily",
    energy: profile.ashleyEnergy?.trim() || "balanced",
    tone: profile.ashleyTone?.trim() || "playful",
    focus: profile.ashleyFocus?.trim() || "general",
    emotionalState: profile.ashleyEmotionalState?.trim() || "grounded",
  };

  // ---- Memory summary ----
  const CATEGORIES = [
    "identity",
    "relational",
    "project",
    "daily",
    "landmark",
  ] as const;
  type Cat = (typeof CATEGORIES)[number] | "other";

  const byCategory: Record<Cat, { count: number; avgConfidence: number; avgImportance: number }> = {
    identity:   { count: 0, avgConfidence: 0, avgImportance: 0 },
    relational: { count: 0, avgConfidence: 0, avgImportance: 0 },
    project:    { count: 0, avgConfidence: 0, avgImportance: 0 },
    daily:      { count: 0, avgConfidence: 0, avgImportance: 0 },
    landmark:   { count: 0, avgConfidence: 0, avgImportance: 0 },
    other:      { count: 0, avgConfidence: 0, avgImportance: 0 },
  };

  const reuseSplit = { often: 0, relevant_only: 0, rarely: 0, unknown: 0 };

  for (const m of memories) {
    const rawCat = (m.category ?? "relational").trim() as Cat;
    const cat: Cat = CATEGORIES.includes(rawCat as (typeof CATEGORIES)[number]) ? rawCat : "other";
    byCategory[cat].count += 1;
    byCategory[cat].avgConfidence += m.confidence ?? 4;
    byCategory[cat].avgImportance += m.importance;

    const r = (m.reuse ?? "relevant_only").trim();
    if (r === "often" || r === "relevant_only" || r === "rarely") {
      reuseSplit[r] += 1;
    } else {
      reuseSplit.unknown += 1;
    }
  }

  // Finalise averages
  for (const cat of Object.keys(byCategory) as Cat[]) {
    const entry = byCategory[cat];
    if (entry.count > 0) {
      entry.avgConfidence = Math.round((entry.avgConfidence / entry.count) * 10) / 10;
      entry.avgImportance = Math.round((entry.avgImportance / entry.count) * 10) / 10;
    }
  }

  // Which categories are searched (non-zero) vs empty
  const categoriesSearched = CATEGORIES.filter(
    (c) => byCategory[c].count > 0,
  );
  const categoriesEmpty = CATEGORIES.filter((c) => byCategory[c].count === 0);

  // ---- How many memories would survive the reuse filter? ----
  const memoriesInPrompt = memories.filter((m) => {
    const r = (m.reuse ?? "relevant_only").trim();
    if (r === "often" || r === "relevant_only") return true;
    if (r === "rarely") return m.importance >= 4;
    return true;
  }).length;

  res.json({
    deviceId,
    ashleyState,
    memorySummary: {
      total: memories.length,
      inPromptAfterFilter: memoriesInPrompt,
      filteredOut: memories.length - memoriesInPrompt,
      categoriesSearched,
      categoriesEmpty,
      byCategory,
      reuseSplit,
    },
    profile: {
      name: profile.name || "(not set)",
      relationshipMode: profile.relationshipMode || "(not set)",
      builderAwareMode: profile.builderAwareMode !== false,
      voiceMode: profile.voiceMode === true,
    },
    continuityProtection: {
      configured: true,
      note: "Runs on every /chat and /chat/stream turn. Use ?debug=1 on POST /chat to see per-reply diagnostics.",
    },
  });
});

export default router;
