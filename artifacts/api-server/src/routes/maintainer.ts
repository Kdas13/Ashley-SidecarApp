// =============================================================================
// Ashley Maintainer — Phase 1 diagnosis endpoint
//
//   POST /maintainer/diagnose/:ticket_id
//
// WHAT THIS DOES:
//   Loads the ticket, runs the policy check, calls the Maintainer LLM service,
//   updates the ticket status to "diagnosed", and returns the full diagnosis
//   JSON + plain-English human report.
//
// WHAT THIS DOES NOT DO:
//   It does not patch code. It does not edit prompts. It does not deploy
//   anything. It does not modify protected areas. It produces a report.
//   A human engineer reads the report and decides what to do.
//
// Auth: same X-API-Key gate as every other /api/* route.
// =============================================================================

import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, improvementTicketsTable } from "@workspace/db";
import { diagnoseTicket, findProtectedPathReference } from "../lib/maintainerService";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /maintainer/diagnose/:ticket_id
// ---------------------------------------------------------------------------

router.post("/maintainer/diagnose/:ticket_id", async (req, res): Promise<void> => {
  const { ticket_id } = req.params;

  // 1. Load the ticket
  let ticket: typeof improvementTicketsTable.$inferSelect | undefined;
  try {
    const [row] = await db
      .select()
      .from(improvementTicketsTable)
      .where(eq(improvementTicketsTable.ticketId, ticket_id))
      .limit(1);
    ticket = row;
  } catch (err) {
    req.log.error({ err, ticket_id }, "maintainer: db error loading ticket");
    res.status(500).json({ error: "Failed to load ticket" });
    return;
  }

  if (!ticket) {
    res.status(404).json({ error: "Ticket not found" });
    return;
  }

  // 2. Policy gate — refuse to diagnose tickets that reference protected paths
  const protectedHit = findProtectedPathReference(
    ticket.summary,
    ticket.affectedComponent,
    ticket.sampleConversation,
  );

  if (protectedHit) {
    req.log.warn(
      {
        ticket_id,
        protected_path: protectedHit,
        category: ticket.category,
      },
      "maintainer: BLOCKED — ticket references protected path, refusing diagnosis",
    );

    // Ensure category is DO_NOT_AUTOFIX in the DB
    if (ticket.category !== "DO_NOT_AUTOFIX") {
      await db
        .update(improvementTicketsTable)
        .set({ category: "DO_NOT_AUTOFIX", status: "triaged" })
        .where(eq(improvementTicketsTable.ticketId, ticket_id))
        .catch((err) =>
          req.log.error({ err, ticket_id }, "maintainer: failed to update category to DO_NOT_AUTOFIX"),
        );
    }

    res.status(403).json({
      error: "Diagnosis blocked",
      reason: "Ticket references a protected system path. Category set to DO_NOT_AUTOFIX. Human review required.",
      protected_path: protectedHit,
      ticket_id,
    });
    return;
  }

  // 3. Run diagnosis
  let result;
  try {
    result = await diagnoseTicket(ticket, req.log);
  } catch (err) {
    req.log.error({ err, ticket_id }, "maintainer: diagnosis failed");
    res.status(502).json({
      error: "Diagnosis failed",
      detail: err instanceof Error ? err.message : "Unknown error",
    });
    return;
  }

  // 4. Update ticket status to "diagnosed"
  await db
    .update(improvementTicketsTable)
    .set({ status: "diagnosed" })
    .where(eq(improvementTicketsTable.ticketId, ticket_id))
    .catch((err) =>
      req.log.error({ err, ticket_id }, "maintainer: failed to update ticket status after diagnosis"),
    );

  req.log.info(
    {
      ticket_id,
      confidence: result.diagnosis.confidence,
      status: "diagnosed",
    },
    "maintainer: diagnosis stored, returning report",
  );

  res.json(result);
});

export default router;
