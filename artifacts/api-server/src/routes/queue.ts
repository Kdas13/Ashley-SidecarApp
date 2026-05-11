// =============================================================================
// Queue, Journal, Red Flags, Protected Rules — Stage 2.5 read endpoints
//
//   GET /improvements/queue              Items approved, waiting for PC execution
//   GET /improvements/journal            Full audit trail (append-only)
//   GET /improvements/red-flags          Policy-blocked reports
//   GET /improvements/protected-rules    Reference list of what is protected and why
// =============================================================================

import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
import {
  db,
  approvalQueueTable,
  changeJournalTable,
  redFlagReportsTable,
  protectedRulesTable,
} from "@workspace/db";
import { PROTECTED_PATHS, PROTECTED_CATEGORIES } from "../lib/maintainerService";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// GET /improvements/queue
// ---------------------------------------------------------------------------

router.get("/improvements/queue", async (req, res): Promise<void> => {
  try {
    const items = await db
      .select()
      .from(approvalQueueTable)
      .orderBy(desc(approvalQueueTable.approvedAt))
      .limit(100);

    res.json({ queue: items, count: items.length });
  } catch (err) {
    req.log.error({ err }, "queue: failed to list");
    res.status(500).json({ error: "Failed to list queue" });
  }
});

// ---------------------------------------------------------------------------
// GET /improvements/journal
// ---------------------------------------------------------------------------

router.get("/improvements/journal", async (req, res): Promise<void> => {
  try {
    const entries = await db
      .select()
      .from(changeJournalTable)
      .orderBy(desc(changeJournalTable.createdAt))
      .limit(200);

    res.json({ journal: entries, count: entries.length });
  } catch (err) {
    req.log.error({ err }, "queue: failed to list journal");
    res.status(500).json({ error: "Failed to list journal" });
  }
});

// ---------------------------------------------------------------------------
// GET /improvements/red-flags
// ---------------------------------------------------------------------------

router.get("/improvements/red-flags", async (req, res): Promise<void> => {
  try {
    const flags = await db
      .select()
      .from(redFlagReportsTable)
      .orderBy(desc(redFlagReportsTable.createdAt))
      .limit(100);

    res.json({ red_flags: flags, count: flags.length });
  } catch (err) {
    req.log.error({ err }, "queue: failed to list red flags");
    res.status(500).json({ error: "Failed to list red flags" });
  }
});

// ---------------------------------------------------------------------------
// GET /improvements/protected-rules
// ---------------------------------------------------------------------------
// Returns the canonical list of what Ashley cannot touch. On first call,
// seeds the protected_rules table from the hard-coded lists in maintainerService.ts
// if not already seeded. This keeps the single source of truth in code while
// making the list auditable via the API.

router.get("/improvements/protected-rules", async (req, res): Promise<void> => {
  try {
    const existing = await db
      .select()
      .from(protectedRulesTable)
      .limit(1);

    if (existing.length === 0) {
      // Seed from hard-coded constants
      const pathRules = PROTECTED_PATHS.map((p) => ({
        ruleId: `rule_path_${p.replace(/\//g, "")}`,
        ruleType: "path" as const,
        value: p,
        description: `Any ticket or plan referencing "${p}" is automatically blocked and reclassified as DO_NOT_AUTOFIX.`,
      }));

      const categoryRules = PROTECTED_CATEGORIES.map((c) => ({
        ruleId: `rule_cat_${c.replace(/\s+/g, "_")}`,
        ruleType: "category" as const,
        value: c,
        description: `Any ticket or plan mentioning "${c}" as a change target triggers a red-flag report and is blocked from the normal approval flow.`,
      }));

      await db.insert(protectedRulesTable).values([...pathRules, ...categoryRules]).onConflictDoNothing();

      req.log.info({ path_count: pathRules.length, category_count: categoryRules.length }, "queue: seeded protected_rules");
    }

    const rules = await db
      .select()
      .from(protectedRulesTable)
      .orderBy(protectedRulesTable.ruleType);

    res.json({
      protected_rules: rules,
      count: rules.length,
      note: "These rules are hard-coded in maintainerService.ts. The table is a read-only audit copy.",
    });
  } catch (err) {
    req.log.error({ err }, "queue: failed to fetch protected rules");
    res.status(500).json({ error: "Failed to fetch protected rules" });
  }
});

export default router;
