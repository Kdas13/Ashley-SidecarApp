// =============================================================================
// Change Plans — Stage 2.5 endpoints
//
//   GET /improvements/plans              List plans (newest first)
//   GET /improvements/plans/:plan_id     Get a single plan
//
// Plans are created via POST /maintainer/plan/:ticket_id (see maintainer.ts).
// This router exposes the read side only — the write side is Maintainer-gated.
// =============================================================================

import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, changePlansTable } from "@workspace/db";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// GET /improvements/plans
// ---------------------------------------------------------------------------

router.get("/improvements/plans", async (req, res): Promise<void> => {
  try {
    const plans = await db
      .select()
      .from(changePlansTable)
      .orderBy(desc(changePlansTable.createdAt))
      .limit(100);

    res.json({ plans, count: plans.length });
  } catch (err) {
    req.log.error({ err }, "plans: failed to list plans");
    res.status(500).json({ error: "Failed to list plans" });
  }
});

// ---------------------------------------------------------------------------
// GET /improvements/plans/:plan_id
// ---------------------------------------------------------------------------

router.get("/improvements/plans/:plan_id", async (req, res): Promise<void> => {
  const { plan_id } = req.params;
  try {
    const [plan] = await db
      .select()
      .from(changePlansTable)
      .where(eq(changePlansTable.planId, plan_id))
      .limit(1);

    if (!plan) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    res.json({ plan });
  } catch (err) {
    req.log.error({ err, plan_id }, "plans: failed to fetch plan");
    res.status(500).json({ error: "Failed to fetch plan" });
  }
});

export default router;
