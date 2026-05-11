// =============================================================================
// Ashley Maintainer — Stage 2.5 endpoints
//
//   POST /maintainer/diagnose/:ticket_id   Phase 1: diagnosis report
//   POST /maintainer/plan/:ticket_id       Stage 2.5: draft a change plan
//   POST /maintainer/packet/:plan_id       Stage 2.5: generate approval packet
//
// WHAT THE MAINTAINER CAN DO:
//   Inspect tickets, produce diagnoses, draft change plans, generate
//   human-readable approval packets for Kane to review.
//
// WHAT THE MAINTAINER CANNOT DO:
//   Patch code, deploy, edit prompts, change configuration, bypass policy,
//   access secrets, or modify protected areas. It produces structured text.
//   Humans act on it.
// =============================================================================

import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  improvementTicketsTable,
  changePlansTable,
  approvalPacketsTable,
  evidenceItemsTable,
  redFlagReportsTable,
} from "@workspace/db";
import {
  diagnoseTicket,
  planTicket,
  generateApprovalPacket,
  findProtectedReference,
} from "../lib/maintainerService";

const router: IRouter = Router();

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// POST /maintainer/diagnose/:ticket_id  (Phase 1 — unchanged)
// ---------------------------------------------------------------------------

router.post("/maintainer/diagnose/:ticket_id", async (req, res): Promise<void> => {
  const { ticket_id } = req.params;

  const [ticket] = await db
    .select()
    .from(improvementTicketsTable)
    .where(eq(improvementTicketsTable.ticketId, ticket_id))
    .limit(1)
    .catch(() => []);

  if (!ticket) {
    res.status(404).json({ error: "Ticket not found" });
    return;
  }

  // Policy gate
  const hit = findProtectedReference(ticket.summary, ticket.affectedComponent, ticket.sampleConversation, ticket.whatHappened, ticket.whyItMatters);
  if (hit) {
    req.log.warn({ ticket_id, protected_hit: hit }, "maintainer: BLOCKED — protected reference in ticket");
    if (ticket.category !== "DO_NOT_AUTOFIX") {
      await db
        .update(improvementTicketsTable)
        .set({ category: "DO_NOT_AUTOFIX", status: "triaged" })
        .where(eq(improvementTicketsTable.ticketId, ticket_id))
        .catch(() => null);
    }
    res.status(403).json({
      error: "Diagnosis blocked",
      reason: "Ticket references a protected area. Category set to DO_NOT_AUTOFIX.",
      protected_hit: hit,
      ticket_id,
    });
    return;
  }

  let result;
  try {
    result = await diagnoseTicket(ticket, req.log);
  } catch (err) {
    req.log.error({ err, ticket_id }, "maintainer: diagnosis failed");
    res.status(502).json({ error: "Diagnosis failed", detail: err instanceof Error ? err.message : "Unknown" });
    return;
  }

  await db
    .update(improvementTicketsTable)
    .set({ status: "triaged" })
    .where(eq(improvementTicketsTable.ticketId, ticket_id))
    .catch(() => null);

  req.log.info({ ticket_id, confidence: result.diagnosis.confidence }, "maintainer: diagnosis complete");
  res.json(result);
});

// ---------------------------------------------------------------------------
// POST /maintainer/plan/:ticket_id — draft a change plan
// ---------------------------------------------------------------------------

router.post("/maintainer/plan/:ticket_id", async (req, res): Promise<void> => {
  const { ticket_id } = req.params;

  const [ticket] = await db
    .select()
    .from(improvementTicketsTable)
    .where(eq(improvementTicketsTable.ticketId, ticket_id))
    .limit(1)
    .catch(() => []);

  if (!ticket) {
    res.status(404).json({ error: "Ticket not found" });
    return;
  }

  // Load evidence for this ticket
  const evidence = await db
    .select()
    .from(evidenceItemsTable)
    .where(eq(evidenceItemsTable.ticketId, ticket_id))
    .catch(() => []);

  // Policy gate — check ticket + all evidence snippets
  const textsToCheck = [
    ticket.summary,
    ticket.affectedComponent,
    ticket.whatHappened,
    ticket.whyItMatters,
    ...evidence.map((e) => e.snippet ?? ""),
  ];
  const hit = findProtectedReference(...textsToCheck);

  if (hit) {
    // Create a red-flag report
    const redFlagId = makeId("rf");
    const humanSummary = `This ticket references ${hit.type === "path" ? `the protected path "${hit.value}"` : `the protected category "${hit.value}"`}. Ashley is not allowed to draft change plans that touch this area. The ticket must be reviewed and handled manually.`;

    await db
      .insert(redFlagReportsTable)
      .values({
        redFlagId,
        sourceTicketId: ticket_id,
        blockedCategory: hit.type === "category" ? hit.value : null,
        blockedPath: hit.type === "path" ? hit.value : null,
        reason: `Protected ${hit.type} referenced: "${hit.value}"`,
        humanSummary,
        status: "blocked_needs_human_review",
      })
      .catch(() => null);

    await db
      .update(improvementTicketsTable)
      .set({ category: "DO_NOT_AUTOFIX", status: "triaged" })
      .where(eq(improvementTicketsTable.ticketId, ticket_id))
      .catch(() => null);

    req.log.warn({ ticket_id, hit, red_flag_id: redFlagId }, "maintainer: plan BLOCKED — red flag created");

    res.status(403).json({
      error: "Plan blocked",
      reason: humanSummary,
      protected_hit: hit,
      red_flag_id: redFlagId,
      ticket_id,
    });
    return;
  }

  let draft;
  try {
    draft = await planTicket(ticket, evidence, req.log);
  } catch (err) {
    req.log.error({ err, ticket_id }, "maintainer: plan drafting failed");
    res.status(502).json({ error: "Plan drafting failed", detail: err instanceof Error ? err.message : "Unknown" });
    return;
  }

  const planId = makeId("plan");

  const [plan] = await db
    .insert(changePlansTable)
    .values({
      planId,
      ticketId: ticket_id,
      changeType: draft.change_type,
      risk: draft.risk,
      rootCause: draft.root_cause,
      proposedChange: draft.proposed_change,
      expectedUpside: draft.expected_upside,
      possibleDownside: draft.possible_downside,
      requiresMigration: draft.requires_migration,
      blockedByPolicy: false,
      rollbackMethod: draft.rollback_method ?? null,
      status: "ready_for_approval",
    })
    .returning()
    .catch((err) => {
      req.log.error({ err }, "maintainer: failed to save plan");
      return [];
    });

  if (!plan) {
    res.status(500).json({ error: "Failed to save plan" });
    return;
  }

  // Advance ticket status
  await db
    .update(improvementTicketsTable)
    .set({ status: "planned" })
    .where(eq(improvementTicketsTable.ticketId, ticket_id))
    .catch(() => null);

  req.log.info({ ticket_id, plan_id: planId, risk: draft.risk }, "maintainer: plan saved");
  res.status(201).json({ plan });
});

// ---------------------------------------------------------------------------
// POST /maintainer/packet/:plan_id — generate approval packet
// ---------------------------------------------------------------------------

router.post("/maintainer/packet/:plan_id", async (req, res): Promise<void> => {
  const { plan_id } = req.params;

  const [plan] = await db
    .select()
    .from(changePlansTable)
    .where(eq(changePlansTable.planId, plan_id))
    .limit(1)
    .catch(() => []);

  if (!plan) {
    res.status(404).json({ error: "Plan not found" });
    return;
  }

  if (plan.blockedByPolicy) {
    res.status(403).json({ error: "Plan is blocked by policy — cannot generate approval packet" });
    return;
  }

  const [ticket] = await db
    .select()
    .from(improvementTicketsTable)
    .where(eq(improvementTicketsTable.ticketId, plan.ticketId))
    .limit(1)
    .catch(() => []);

  if (!ticket) {
    res.status(404).json({ error: "Parent ticket not found" });
    return;
  }

  let draft;
  try {
    draft = await generateApprovalPacket(ticket, plan, req.log);
  } catch (err) {
    req.log.error({ err, plan_id }, "maintainer: packet generation failed");
    res.status(502).json({ error: "Packet generation failed", detail: err instanceof Error ? err.message : "Unknown" });
    return;
  }

  const packetId = makeId("ap");

  const [packet] = await db
    .insert(approvalPacketsTable)
    .values({
      packetId,
      ticketId: plan.ticketId,
      planId: plan_id,
      risk: draft.risk,
      humanSummary: draft.human_summary,
      status: "awaiting_approval",
    })
    .returning()
    .catch((err) => {
      req.log.error({ err }, "maintainer: failed to save packet");
      return [];
    });

  if (!packet) {
    res.status(500).json({ error: "Failed to save approval packet" });
    return;
  }

  // Advance ticket status
  await db
    .update(improvementTicketsTable)
    .set({ status: "awaiting_approval" })
    .where(eq(improvementTicketsTable.ticketId, plan.ticketId))
    .catch(() => null);

  req.log.info({ plan_id, packet_id: packetId, ticket_id: plan.ticketId }, "maintainer: approval packet created");

  // Return packet in mobile-card-friendly shape
  res.status(201).json({
    packet,
    mobile_card: {
      title: `Ashley wants to improve: ${ticket.summary.slice(0, 60)}`,
      risk: draft.risk,
      problem: draft.human_summary.what_went_wrong,
      proposed_fix: draft.human_summary.what_ashley_wants_to_change,
      expected_benefit: draft.human_summary.why_this_should_help,
      possible_downside: draft.human_summary.what_could_go_wrong,
      if_approved: draft.human_summary.what_happens_if_approved,
      if_rejected: draft.human_summary.what_happens_if_rejected,
      decision_options: ["approve", "reject", "explain_more", "show_evidence"],
      decide_url: `/api/improvements/packets/${packetId}/decide`,
    },
  });
});

export default router;
