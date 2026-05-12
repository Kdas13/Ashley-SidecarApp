// =============================================================================
// Ashley Phase 2.5 — Conversational Ticket System
//
//   POST   /api/tickets                       Create a ticket
//   GET    /api/tickets?status=OPEN,APPROVED  Filter by status (comma-separated)
//   PATCH  /api/tickets/:ticket_id            Update allowed fields
//   POST   /api/tickets/:ticket_id/approve    Approve ticket (OPEN → APPROVED)
//
// Status lifecycle enforced in PATCH: OPEN → APPROVED → IN_PROGRESS → RESOLVED
// No other transitions are valid.
//
// Auth: X-API-Key gate (same as every other /api/* route).
// =============================================================================

import { Router, type IRouter } from "express";
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { db, ashleyTicketsTable } from "@workspace/db";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Allowed values
// ---------------------------------------------------------------------------

const ASHLEY_TICKET_STATUSES = ["OPEN", "APPROVED", "IN_PROGRESS", "RESOLVED"] as const;
const ASHLEY_TICKET_SEVERITIES = ["low", "medium", "high"] as const;
const ASHLEY_TICKET_CATEGORIES = [
  "PROMPT", "CONFIG", "MEMORY_POLICY", "TOOLING", "CODE_PATCH", "DATA",
] as const;
const ASHLEY_TICKET_SOURCES = ["user_feedback", "self_detected", "eval", "error_log"] as const;

// Status transition map — only these forward moves are allowed.
const VALID_NEXT_STATUS: Record<string, string> = {
  OPEN: "APPROVED",
  APPROVED: "IN_PROGRESS",
  IN_PROGRESS: "RESOLVED",
};

// ---------------------------------------------------------------------------
// ID generator
// ---------------------------------------------------------------------------

function makeTicketId(): string {
  return `atkt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CreateTicketSchema = z.object({
  severity: z.enum(ASHLEY_TICKET_SEVERITIES),
  category: z.enum(ASHLEY_TICKET_CATEGORIES),
  summary: z.string().min(1).max(500),
  description: z.string().max(2000).optional(),
  impact: z.string().max(1000).optional(),
  proposed_fix: z.string().max(2000).optional(),
  source: z.enum(ASHLEY_TICKET_SOURCES),
  created_by: z.string().min(1).max(100).optional().default("Ashley"),
});

const PatchTicketSchema = z.object({
  status: z.enum(ASHLEY_TICKET_STATUSES).optional(),
  severity: z.enum(ASHLEY_TICKET_SEVERITIES).optional(),
  summary: z.string().min(1).max(500).optional(),
  description: z.string().max(2000).optional(),
  impact: z.string().max(1000).optional(),
  proposed_fix: z.string().max(2000).optional(),
  resolution_notes: z.string().max(2000).optional(),
});

const ApproveSchema = z.object({
  approved_by: z.string().min(1).max(100).optional().default("Kane"),
});

// ---------------------------------------------------------------------------
// POST /tickets
// ---------------------------------------------------------------------------

router.post("/tickets", async (req, res): Promise<void> => {
  const parsed = CreateTicketSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid ticket payload" });
    return;
  }

  const data = parsed.data;
  const ticketId = makeTicketId();

  try {
    const [row] = await db
      .insert(ashleyTicketsTable)
      .values({
        ticketId,
        status: "OPEN",
        severity: data.severity,
        category: data.category,
        summary: data.summary,
        description: data.description ?? null,
        impact: data.impact ?? null,
        proposedFix: data.proposed_fix ?? null,
        source: data.source,
        createdBy: data.created_by,
        approved: false,
      })
      .returning();

    req.log.info(
      { ticket_id: ticketId, severity: data.severity, category: data.category, source: data.source },
      "ashley_ticket: created",
    );

    res.status(201).json({ ticket: row });
  } catch (err) {
    req.log.error({ err }, "ashley_ticket: failed to insert");
    res.status(500).json({ error: "Failed to create ticket" });
  }
});

// ---------------------------------------------------------------------------
// GET /tickets?status=OPEN,IN_PROGRESS
// ---------------------------------------------------------------------------

router.get("/tickets", async (req, res): Promise<void> => {
  try {
    const statusParam = typeof req.query["status"] === "string" ? req.query["status"] : null;
    let rows;

    if (statusParam) {
      const requested = statusParam
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s): s is typeof ASHLEY_TICKET_STATUSES[number] =>
          (ASHLEY_TICKET_STATUSES as readonly string[]).includes(s),
        );

      if (requested.length === 0) {
        res.status(400).json({ error: "No valid status values in filter" });
        return;
      }

      rows = await db
        .select()
        .from(ashleyTicketsTable)
        .where(inArray(ashleyTicketsTable.status, requested));
    } else {
      rows = await db.select().from(ashleyTicketsTable);
    }

    res.json({ tickets: rows, count: rows.length });
  } catch (err) {
    req.log.error({ err }, "ashley_ticket: failed to list");
    res.status(500).json({ error: "Failed to list tickets" });
  }
});

// ---------------------------------------------------------------------------
// PATCH /tickets/:ticket_id
// ---------------------------------------------------------------------------

router.patch("/tickets/:ticket_id", async (req, res): Promise<void> => {
  const { ticket_id } = req.params;

  const parsed = PatchTicketSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid patch payload" });
    return;
  }

  const data = parsed.data;

  const [existing] = await db
    .select()
    .from(ashleyTicketsTable)
    .where(eq(ashleyTicketsTable.ticketId, ticket_id))
    .limit(1)
    .catch(() => []);

  if (!existing) {
    res.status(404).json({ error: "Ticket not found" });
    return;
  }

  // APPROVED status can only be set by POST /tickets/:ticket_id/approve (or the
  // APPROVE: chat gate) because that path also sets approved=true, approved_by,
  // and approved_at. PATCH is not allowed to set APPROVED directly.
  if (data.status === "APPROVED") {
    res.status(422).json({
      error: "Use POST /tickets/:ticket_id/approve to approve a ticket. PATCH cannot set status to APPROVED.",
    });
    return;
  }

  // Enforce status transition for non-APPROVED targets:
  //   APPROVED → IN_PROGRESS → RESOLVED only via PATCH.
  //   OPEN tickets cannot be advanced via PATCH (use approve endpoint first).
  if (data.status && data.status !== existing.status) {
    const patchNextStatus: Record<string, string> = {
      APPROVED: "IN_PROGRESS",
      IN_PROGRESS: "RESOLVED",
    };
    const allowed = patchNextStatus[existing.status];
    if (!allowed || data.status !== allowed) {
      res.status(422).json({
        error: `Invalid status transition via PATCH: ${existing.status} → ${data.status}. ${allowed ? `Expected: ${allowed}` : "OPEN tickets must go through the approve endpoint."}`,
      });
      return;
    }
  }

  try {
    const update: Record<string, unknown> = {};
    if (data.status !== undefined) update["status"] = data.status;
    if (data.severity !== undefined) update["severity"] = data.severity;
    if (data.summary !== undefined) update["summary"] = data.summary;
    if (data.description !== undefined) update["description"] = data.description;
    if (data.impact !== undefined) update["impact"] = data.impact;
    if (data.proposed_fix !== undefined) update["proposedFix"] = data.proposed_fix;
    if (data.resolution_notes !== undefined) {
      update["resolutionNotes"] = data.resolution_notes;
    }
    if (data.status === "RESOLVED") {
      update["resolvedAt"] = new Date();
    }

    const [row] = await db
      .update(ashleyTicketsTable)
      .set(update)
      .where(eq(ashleyTicketsTable.ticketId, ticket_id))
      .returning();

    req.log.info({ ticket_id, update }, "ashley_ticket: patched");
    res.json({ ticket: row });
  } catch (err) {
    req.log.error({ err, ticket_id }, "ashley_ticket: failed to patch");
    res.status(500).json({ error: "Failed to update ticket" });
  }
});

// ---------------------------------------------------------------------------
// POST /tickets/:ticket_id/approve
// ---------------------------------------------------------------------------

router.post("/tickets/:ticket_id/approve", async (req, res): Promise<void> => {
  const { ticket_id } = req.params;

  const parsed = ApproveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid approve payload" });
    return;
  }

  const { approved_by } = parsed.data;

  const [existing] = await db
    .select()
    .from(ashleyTicketsTable)
    .where(eq(ashleyTicketsTable.ticketId, ticket_id))
    .limit(1)
    .catch(() => []);

  if (!existing) {
    res.status(404).json({ error: "Ticket not found" });
    return;
  }

  if (existing.status !== "OPEN") {
    res.status(422).json({
      error: `Ticket is already in status ${existing.status}; only OPEN tickets can be approved via this endpoint`,
    });
    return;
  }

  try {
    const [row] = await db
      .update(ashleyTicketsTable)
      .set({
        approved: true,
        approvedBy: approved_by,
        approvedAt: new Date(),
        status: "APPROVED",
      })
      .where(eq(ashleyTicketsTable.ticketId, ticket_id))
      .returning();

    req.log.info({ ticket_id, approved_by }, "ashley_ticket: approved");
    res.json({ ticket: row, approved: true });
  } catch (err) {
    req.log.error({ err, ticket_id }, "ashley_ticket: failed to approve");
    res.status(500).json({ error: "Failed to approve ticket" });
  }
});

export default router;

// ---------------------------------------------------------------------------
// Shared approve logic — called by the APPROVE: gate in chat.ts
// without going through the HTTP layer.
// ---------------------------------------------------------------------------

export async function approveTicketById(
  ticketId: string,
  approvedBy = "Kane",
): Promise<{ ticket: typeof ashleyTicketsTable.$inferSelect } | { error: string }> {
  const [existing] = await db
    .select()
    .from(ashleyTicketsTable)
    .where(eq(ashleyTicketsTable.ticketId, ticketId))
    .limit(1)
    .catch(() => []);

  if (!existing) {
    return { error: "Ticket not found" };
  }

  if (existing.status !== "OPEN") {
    return {
      error: `Ticket is already in status ${existing.status}; only OPEN tickets can be approved`,
    };
  }

  const [row] = await db
    .update(ashleyTicketsTable)
    .set({
      approved: true,
      approvedBy,
      approvedAt: new Date(),
      status: "APPROVED",
    })
    .where(eq(ashleyTicketsTable.ticketId, ticketId))
    .returning();

  return { ticket: row! };
}
