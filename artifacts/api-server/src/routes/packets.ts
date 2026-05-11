// =============================================================================
// Approval Packets + Decisions — Stage 2.5 endpoints
//
//   GET  /improvements/packets                       List packets
//   GET  /improvements/packets/:packet_id            Get a single packet
//   POST /improvements/packets/:packet_id/decide     Kane approves/rejects/asks more
//
// Packets are created via POST /maintainer/packet/:plan_id (see maintainer.ts).
// This router handles the read side and Kane's decision.
//
// Decision flow:
//   approve          → creates approval_queue row + journal row, ticket → approved_waiting_for_execution
//   reject           → journal row, ticket → rejected, packet → rejected
//   explain_more     → packet → needs_more_explanation, ticket → needs_more_explanation
//   show_evidence    → returns evidence items for the ticket (no state change)
// =============================================================================

import { Router, type IRouter } from "express";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import type { Logger } from "pino";
import {
  db,
  approvalPacketsTable,
  approvalQueueTable,
  changeJournalTable,
  improvementTicketsTable,
  evidenceItemsTable,
} from "@workspace/db";

const router: IRouter = Router();

const DECISION_OPTIONS = ["approve", "reject", "explain_more", "show_evidence"] as const;

const DecideSchema = z.object({
  decision: z.enum(DECISION_OPTIONS),
  notes: z.string().max(1000).optional(),
  decided_by: z.string().max(100).optional().default("Kane"),
});

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// GET /improvements/packets
// ---------------------------------------------------------------------------

router.get("/improvements/packets", async (req, res): Promise<void> => {
  try {
    const packets = await db
      .select()
      .from(approvalPacketsTable)
      .orderBy(desc(approvalPacketsTable.createdAt))
      .limit(100);

    res.json({ packets, count: packets.length });
  } catch (err) {
    req.log.error({ err }, "packets: failed to list");
    res.status(500).json({ error: "Failed to list packets" });
  }
});

// ---------------------------------------------------------------------------
// GET /improvements/packets/:packet_id
// ---------------------------------------------------------------------------

router.get("/improvements/packets/:packet_id", async (req, res): Promise<void> => {
  const { packet_id } = req.params;
  try {
    const [packet] = await db
      .select()
      .from(approvalPacketsTable)
      .where(eq(approvalPacketsTable.packetId, packet_id))
      .limit(1);

    if (!packet) {
      res.status(404).json({ error: "Packet not found" });
      return;
    }
    res.json({ packet });
  } catch (err) {
    req.log.error({ err, packet_id }, "packets: failed to fetch");
    res.status(500).json({ error: "Failed to fetch packet" });
  }
});

// ---------------------------------------------------------------------------
// POST /improvements/packets/:packet_id/decide
// ---------------------------------------------------------------------------

router.post("/improvements/packets/:packet_id/decide", async (req, res): Promise<void> => {
  const { packet_id } = req.params;

  const parsed = DecideSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid decision payload" });
    return;
  }

  const { decision, notes, decided_by } = parsed.data;

  // Load the packet
  const [packet] = await db
    .select()
    .from(approvalPacketsTable)
    .where(eq(approvalPacketsTable.packetId, packet_id))
    .limit(1)
    .catch(() => []);

  if (!packet) {
    res.status(404).json({ error: "Packet not found" });
    return;
  }

  // Guard: cannot re-decide an already-decided packet
  if (packet.status === "approved" || packet.status === "rejected") {
    res.status(409).json({
      error: `Packet already has a final decision: ${packet.status}. Create a new ticket if needed.`,
    });
    return;
  }

  // show_evidence — no state change, just return evidence
  if (decision === "show_evidence") {
    const evidence = await db
      .select()
      .from(evidenceItemsTable)
      .where(eq(evidenceItemsTable.ticketId, packet.ticketId))
      .orderBy(desc(evidenceItemsTable.createdAt))
      .catch(() => []);

    req.log.info({ packet_id, ticket_id: packet.ticketId }, "packets: show_evidence requested");
    res.json({ decision: "show_evidence", evidence, count: evidence.length });
    return;
  }

  try {
    if (decision === "approve") {
      await handleApprove(packet, decided_by, notes ?? null, req.log);
      res.json({
        decision: "approved",
        packet_id,
        ticket_id: packet.ticketId,
        plan_id: packet.planId,
        message: "Queued for PC execution. Nothing changes automatically.",
      });
    } else if (decision === "reject") {
      await handleReject(packet, decided_by, notes ?? null, req.log);
      res.json({
        decision: "rejected",
        packet_id,
        ticket_id: packet.ticketId,
        message: "Ticket closed. Nothing changes.",
      });
    } else {
      // explain_more
      await handleExplainMore(packet, decided_by, notes ?? null, req.log);
      res.json({
        decision: "explain_more",
        packet_id,
        ticket_id: packet.ticketId,
        message: "Ticket status updated to needs_more_explanation. Re-run /maintainer/packet/:plan_id to generate a revised packet.",
      });
    }
  } catch (err) {
    req.log.error({ err, packet_id, decision }, "packets: decision handling failed");
    res.status(500).json({ error: "Failed to record decision" });
  }
});

// ---------------------------------------------------------------------------
// Decision handlers
// ---------------------------------------------------------------------------

async function handleApprove(
  packet: typeof approvalPacketsTable.$inferSelect,
  decidedBy: string,
  notes: string | null,
  logger: Logger,
): Promise<void> {
  const queueId = makeId("queue");
  const journalId = makeId("journal");
  const finalStatus = "approved_waiting_for_execution";

  await db.transaction(async (tx) => {
    // Mark packet approved
    await tx
      .update(approvalPacketsTable)
      .set({ status: "approved" })
      .where(eq(approvalPacketsTable.packetId, packet.packetId));

    // Create queue entry
    await tx.insert(approvalQueueTable).values({
      queueId,
      packetId: packet.packetId,
      planId: packet.planId,
      ticketId: packet.ticketId,
      approvedBy: decidedBy,
      executionStatus: "approved_waiting_for_execution",
      pcRequired: true,
      notes: notes ?? undefined,
    });

    // Update ticket status
    await tx
      .update(improvementTicketsTable)
      .set({ status: finalStatus })
      .where(eq(improvementTicketsTable.ticketId, packet.ticketId));

    // Journal entry
    await tx.insert(changeJournalTable).values({
      journalId,
      ticketId: packet.ticketId,
      planId: packet.planId,
      packetId: packet.packetId,
      decision: "approve",
      decidedBy,
      decisionNotes: notes ?? null,
      finalStatus,
    });
  });

  logger.info(
    { packet_id: packet.packetId, ticket_id: packet.ticketId, queue_id: queueId, decided_by: decidedBy },
    "packets: approved — queued for PC execution",
  );
}

async function handleReject(
  packet: typeof approvalPacketsTable.$inferSelect,
  decidedBy: string,
  notes: string | null,
  logger: Logger,
): Promise<void> {
  const journalId = makeId("journal");
  const finalStatus = "rejected";

  await db.transaction(async (tx) => {
    await tx
      .update(approvalPacketsTable)
      .set({ status: "rejected" })
      .where(eq(approvalPacketsTable.packetId, packet.packetId));

    await tx
      .update(improvementTicketsTable)
      .set({ status: finalStatus })
      .where(eq(improvementTicketsTable.ticketId, packet.ticketId));

    await tx.insert(changeJournalTable).values({
      journalId,
      ticketId: packet.ticketId,
      planId: packet.planId,
      packetId: packet.packetId,
      decision: "reject",
      decidedBy,
      decisionNotes: notes ?? null,
      finalStatus,
    });
  });

  logger.info(
    { packet_id: packet.packetId, ticket_id: packet.ticketId, decided_by: decidedBy },
    "packets: rejected",
  );
}

async function handleExplainMore(
  packet: typeof approvalPacketsTable.$inferSelect,
  decidedBy: string,
  notes: string | null,
  logger: Logger,
): Promise<void> {
  const journalId = makeId("journal");
  const finalStatus = "needs_more_explanation";

  await db.transaction(async (tx) => {
    await tx
      .update(approvalPacketsTable)
      .set({ status: "needs_more_explanation" })
      .where(eq(approvalPacketsTable.packetId, packet.packetId));

    await tx
      .update(improvementTicketsTable)
      .set({ status: finalStatus })
      .where(eq(improvementTicketsTable.ticketId, packet.ticketId));

    await tx.insert(changeJournalTable).values({
      journalId,
      ticketId: packet.ticketId,
      planId: packet.planId,
      packetId: packet.packetId,
      decision: "explain_more",
      decidedBy,
      decisionNotes: notes ?? null,
      finalStatus,
    });
  });

  logger.info(
    { packet_id: packet.packetId, ticket_id: packet.ticketId },
    "packets: needs_more_explanation",
  );
}

export default router;
