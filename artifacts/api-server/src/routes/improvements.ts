// =============================================================================
// Improvement Tickets + Evidence — Stage 2.5 endpoints
//
//   POST /improvements/tickets                  Create a ticket
//   GET  /improvements/tickets                  List tickets (newest first)
//   GET  /improvements/tickets/:id              Get a single ticket
//   POST /improvements/tickets/:id/evidence     Attach an evidence item
//   GET  /improvements/tickets/:id/evidence     List evidence for a ticket
//
// Auth: X-API-Key gate (same as every other /api/* route).
// =============================================================================

import { Router, type IRouter } from "express";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import {
  db,
  improvementTicketsTable,
  evidenceItemsTable,
} from "@workspace/db";
import { findProtectedPathReference } from "../lib/maintainerService";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Allowed values
// ---------------------------------------------------------------------------

export const TICKET_SOURCES = ["user_feedback", "self_detected", "eval", "error_log"] as const;
export const TICKET_CATEGORIES = [
  "PROMPT", "CONFIG", "MEMORY_POLICY", "TOOLING", "CODE_PATCH", "DATA", "DO_NOT_AUTOFIX",
] as const;
export const TICKET_SEVERITIES = ["low", "medium", "high"] as const;
export const TICKET_STATUSES = [
  "new", "triaged", "planned", "awaiting_approval", "approved", "rejected",
  "needs_more_explanation", "approved_waiting_for_execution", "queued_for_pc_execution",
] as const;
export const EVIDENCE_TYPES = [
  "conversation_snippet", "log_excerpt", "user_report", "eval_result",
] as const;
export const EVIDENCE_SENSITIVITY = ["normal", "sensitive"] as const;

// ---------------------------------------------------------------------------
// ID generators
// ---------------------------------------------------------------------------

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CreateTicketSchema = z.object({
  source: z.enum(TICKET_SOURCES),
  category: z.enum(TICKET_CATEGORIES),
  severity: z.enum(TICKET_SEVERITIES),
  summary: z.string().min(1).max(500),
  what_happened: z.string().max(2000).optional(),
  why_it_matters: z.string().max(1000).optional(),
  affected_component: z.string().max(200).optional(),
  sample_conversation: z.string().max(4000).optional(),
});

const CreateEvidenceSchema = z.object({
  type: z.enum(EVIDENCE_TYPES),
  summary: z.string().min(1).max(500),
  snippet: z.string().max(4000).optional(),
  source_ref: z.string().max(200).optional(),
  sensitivity: z.enum(EVIDENCE_SENSITIVITY).optional().default("normal"),
});

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

  const protectedHit = findProtectedPathReference(
    data.summary,
    data.what_happened,
    data.why_it_matters,
    data.affected_component,
    data.sample_conversation,
  );

  let category = data.category;
  if (protectedHit) {
    req.log.warn(
      { original_category: category, protected_hit: protectedHit, summary: data.summary },
      "improvements: protected reference detected — forcing DO_NOT_AUTOFIX",
    );
    category = "DO_NOT_AUTOFIX";
  }

  const ticketId = makeId("tkt");

  try {
    const [row] = await db
      .insert(improvementTicketsTable)
      .values({
        ticketId,
        source: data.source,
        category,
        severity: data.severity,
        summary: data.summary,
        whatHappened: data.what_happened ?? null,
        whyItMatters: data.why_it_matters ?? null,
        evidence: [],
        frequency: 1,
        affectedComponent: data.affected_component ?? null,
        sampleConversation: data.sample_conversation ?? null,
        status: "new",
      })
      .returning();

    req.log.info(
      { ticket_id: ticketId, source: data.source, category, severity: data.severity, policy_override: !!protectedHit },
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

// ---------------------------------------------------------------------------
// POST /improvements/tickets/:ticket_id/evidence
// ---------------------------------------------------------------------------

router.post("/improvements/tickets/:ticket_id/evidence", async (req, res): Promise<void> => {
  const { ticket_id } = req.params;

  // Confirm ticket exists
  const [ticket] = await db
    .select({ ticketId: improvementTicketsTable.ticketId })
    .from(improvementTicketsTable)
    .where(eq(improvementTicketsTable.ticketId, ticket_id))
    .limit(1)
    .catch(() => []);

  if (!ticket) {
    res.status(404).json({ error: "Ticket not found" });
    return;
  }

  const parsed = CreateEvidenceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid evidence payload" });
    return;
  }

  const data = parsed.data;
  const evidenceId = makeId("evidence");

  try {
    const [row] = await db
      .insert(evidenceItemsTable)
      .values({
        evidenceId,
        ticketId: ticket_id,
        type: data.type,
        summary: data.summary,
        snippet: data.snippet ?? null,
        sourceRef: data.source_ref ?? null,
        sensitivity: data.sensitivity,
      })
      .returning();

    req.log.info({ ticket_id, evidence_id: evidenceId, type: data.type }, "improvements: evidence attached");
    res.status(201).json({ evidence: row });
  } catch (err) {
    req.log.error({ err, ticket_id }, "improvements: failed to insert evidence");
    res.status(500).json({ error: "Failed to attach evidence" });
  }
});

// ---------------------------------------------------------------------------
// GET /improvements/tickets/:ticket_id/evidence
// ---------------------------------------------------------------------------

router.get("/improvements/tickets/:ticket_id/evidence", async (req, res): Promise<void> => {
  const { ticket_id } = req.params;
  try {
    const items = await db
      .select()
      .from(evidenceItemsTable)
      .where(eq(evidenceItemsTable.ticketId, ticket_id))
      .orderBy(desc(evidenceItemsTable.createdAt));

    res.json({ evidence: items, count: items.length });
  } catch (err) {
    req.log.error({ err, ticket_id }, "improvements: failed to fetch evidence");
    res.status(500).json({ error: "Failed to fetch evidence" });
  }
});

export default router;
