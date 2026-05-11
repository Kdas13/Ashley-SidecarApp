// =============================================================================
// Improvement Tickets — Phase 1 endpoints
//
//   POST /improvements/tickets        Create a ticket
//   GET  /improvements/tickets        List tickets (newest first)
//   GET  /improvements/tickets/:id    Get a single ticket
//
// Auth: same X-API-Key gate as every other /api/* route.
// These are internal engineering endpoints — not user-facing, not exposed in
// any mobile UI. Kane calls them directly or via the debug flow.
//
// POLICY: if ticket content references a protected path, the category is
// forced to DO_NOT_AUTOFIX and a warning is logged. No further action is
// blocked at this layer — Maintainer enforces the same check again before
// diagnosis.
// =============================================================================

import { Router, type IRouter } from "express";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { db, improvementTicketsTable } from "@workspace/db";
import { findProtectedPathReference } from "../lib/maintainerService";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Allowed enum values — validated by Zod, not by DB constraints.
// ---------------------------------------------------------------------------

const SOURCES = ["user_feedback", "self_detected", "eval", "error_log"] as const;
const CATEGORIES = [
  "PROMPT",
  "CONFIG",
  "MEMORY_POLICY",
  "TOOLING",
  "CODE_PATCH",
  "DATA",
  "DO_NOT_AUTOFIX",
] as const;
const SEVERITIES = ["low", "medium", "high"] as const;
const STATUSES = [
  "new",
  "triaged",
  "diagnosed",
  "awaiting_review",
  "resolved",
  "rejected",
] as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CreateTicketSchema = z.object({
  source: z.enum(SOURCES),
  category: z.enum(CATEGORIES),
  severity: z.enum(SEVERITIES),
  summary: z.string().min(1).max(500),
  evidence: z.array(z.unknown()).optional(),
  affected_component: z.string().max(200).optional(),
  sample_conversation: z.string().max(4000).optional(),
});

// ---------------------------------------------------------------------------
// Ticket ID generator — server-side, never client-supplied.
// Format: tkt_<unix-ms>_<6-char random>
// ---------------------------------------------------------------------------

function generateTicketId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `tkt_${Date.now()}_${rand}`;
}

// ---------------------------------------------------------------------------
// POST /improvements/tickets
// ---------------------------------------------------------------------------

router.post("/improvements/tickets", async (req, res): Promise<void> => {
  const parsed = CreateTicketSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid ticket payload" });
    return;
  }

  const data = parsed.data;

  // Policy check — force DO_NOT_AUTOFIX if protected path referenced
  const protectedHit = findProtectedPathReference(
    data.summary,
    data.affected_component,
    data.sample_conversation,
  );

  let category = data.category;
  if (protectedHit) {
    req.log.warn(
      {
        original_category: category,
        protected_path: protectedHit,
        summary: data.summary,
      },
      "improvements: protected path reference detected — forcing DO_NOT_AUTOFIX",
    );
    category = "DO_NOT_AUTOFIX";
  }

  const ticketId = generateTicketId();

  try {
    const [row] = await db
      .insert(improvementTicketsTable)
      .values({
        ticketId,
        source: data.source,
        category,
        severity: data.severity,
        summary: data.summary,
        evidence: data.evidence ?? [],
        frequency: 1,
        affectedComponent: data.affected_component ?? null,
        sampleConversation: data.sample_conversation ?? null,
        status: "new",
      })
      .returning();

    req.log.info(
      {
        ticket_id: ticketId,
        source: data.source,
        category,
        severity: data.severity,
        policy_override: protectedHit ? true : false,
      },
      "improvements: ticket created",
    );

    res.status(201).json({ ticket: row });
  } catch (err) {
    req.log.error({ err }, "improvements: failed to insert ticket");
    res.status(500).json({ error: "Failed to create ticket" });
  }
});

// ---------------------------------------------------------------------------
// GET /improvements/tickets
// ---------------------------------------------------------------------------

router.get("/improvements/tickets", async (req, res): Promise<void> => {
  try {
    const tickets = await db
      .select()
      .from(improvementTicketsTable)
      .orderBy(desc(improvementTicketsTable.createdAt))
      .limit(100);

    res.json({ tickets, count: tickets.length });
  } catch (err) {
    req.log.error({ err }, "improvements: failed to list tickets");
    res.status(500).json({ error: "Failed to list tickets" });
  }
});

// ---------------------------------------------------------------------------
// GET /improvements/tickets/:ticket_id
// ---------------------------------------------------------------------------

router.get("/improvements/tickets/:ticket_id", async (req, res): Promise<void> => {
  const { ticket_id } = req.params;

  try {
    const [ticket] = await db
      .select()
      .from(improvementTicketsTable)
      .where(eq(improvementTicketsTable.ticketId, ticket_id))
      .limit(1);

    if (!ticket) {
      res.status(404).json({ error: "Ticket not found" });
      return;
    }

    res.json({ ticket });
  } catch (err) {
    req.log.error({ err, ticket_id }, "improvements: failed to fetch ticket");
    res.status(500).json({ error: "Failed to fetch ticket" });
  }
});

export { SOURCES, CATEGORIES, SEVERITIES, STATUSES };
export default router;
