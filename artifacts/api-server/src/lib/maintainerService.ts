// =============================================================================
// Ashley Maintainer — Stage 2.5 diagnostic + planning service
// =============================================================================
//
// WHAT THIS IS:
//   Internal-only LLM-backed service. Inspects tickets, produces diagnoses,
//   drafts change plans, and generates human-readable approval packets.
//
// WHAT THIS IS NOT:
//   It cannot patch code, edit prompts, change configuration, deploy, access
//   secrets, or modify protected system areas. It produces structured reports
//   and proposals. Kane reads them and decides. Humans act on approvals.
//
// LLM CHOICE:
//   Always Claude (Anthropic), hardcoded. Never follows ASHLEY_TEXT_PROVIDER.
//   Diagnostics and plans need a consistent, auditable model.
//
// SAFETY LINE:
//   findProtectedReference() is the policy gate. It runs before every LLM
//   call and cannot be bypassed by ticket content.
// =============================================================================

import { anthropic } from "@workspace/integrations-anthropic-ai";
import type {
  ImprovementTicket,
  ChangePlan,
  EvidenceItem,
} from "@workspace/db";
import type { Logger } from "pino";

// ---------------------------------------------------------------------------
// Protected areas — hard-coded, cannot be overridden by ticket content.
// Paths and keyword categories both trigger a block.
// ---------------------------------------------------------------------------

export const PROTECTED_PATHS = [
  "/auth/",
  "/secrets/",
  "/infra/",
  "/deploy/",
  "/approval/",
  "/policy/",
  "/billing/",
  "/monitoring/",
] as const;

export const PROTECTED_CATEGORIES = [
  "auth",
  "secrets",
  "billing",
  "deployment",
  "approval logic",
  "safety rules",
  "permissions",
  "memory deletion policy",
] as const;

export type ProtectedPathValue = (typeof PROTECTED_PATHS)[number];
export type ProtectedCategoryValue = (typeof PROTECTED_CATEGORIES)[number];

export interface ProtectedHit {
  type: "path" | "category";
  value: string;
}

export function findProtectedReference(
  ...texts: (string | null | undefined)[]
): ProtectedHit | null {
  for (const t of texts) {
    if (!t) continue;
    const lower = t.toLowerCase();
    for (const p of PROTECTED_PATHS) {
      if (lower.includes(p)) return { type: "path", value: p };
    }
    for (const c of PROTECTED_CATEGORIES) {
      if (lower.includes(c)) return { type: "category", value: c };
    }
  }
  return null;
}

// Keep the Phase 1 name as an alias so existing callers don't break.
export function findProtectedPathReference(
  ...texts: (string | null | undefined)[]
): string | null {
  const hit = findProtectedReference(...texts);
  return hit ? hit.value : null;
}

// ---------------------------------------------------------------------------
// Shared LLM helpers
// ---------------------------------------------------------------------------

function stripFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

async function callClaude(system: string, user: string, maxTokens = 1024): Promise<string> {
  const raw = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  const block = raw.content[0];
  return block && block.type === "text" ? stripFences(block.text.trim()) : "";
}

// ---------------------------------------------------------------------------
// Phase 1: diagnoseTicket
// ---------------------------------------------------------------------------

export type Confidence = "low" | "medium" | "high";

export interface Diagnosis {
  what_failed: string;
  likely_root_cause: string;
  confidence: Confidence;
  possible_fix_direction: string;
  recommended_action: string;
}

export interface HumanReport {
  title: string;
  risk: string;
  what_went_wrong: string;
  why_it_matters: string;
  suggested_next_step: string;
  possible_downside: string;
}

export interface DiagnoseResult {
  ticket_id: string;
  diagnosis: Diagnosis;
  human_report: HumanReport;
}

const DIAGNOSE_SYSTEM = `\
You are Ashley Maintainer, an internal diagnostic agent for the Ashley-Sidecar AI companion platform.

YOUR ONLY JOB: inspect improvement tickets and produce structured diagnoses for human engineers.

YOU MUST NOT:
- Generate code, patches, or diffs
- Suggest deployment, rollback, or release actions
- Produce configuration file changes
- Reference protected areas (/auth/, /secrets/, /approval/, /policy/, /deploy/, /infra/, /billing/, /monitoring/)
- Claim certainty you do not have

YOU MUST:
- Identify the most likely root cause
- Estimate confidence honestly: "low" | "medium" | "high"
- Suggest a safe investigation direction (where to look, not what to patch)
- Write plain-English prose fields — no bullet points, no jargon, ~150 words total

OUTPUT: ONLY valid JSON, no preamble, no code fences:
{
  "ticket_id": "<string>",
  "diagnosis": {
    "what_failed": "<string>",
    "likely_root_cause": "<string>",
    "confidence": "low|medium|high",
    "possible_fix_direction": "<string>",
    "recommended_action": "<string>"
  },
  "human_report": {
    "title": "<string>",
    "risk": "<string>",
    "what_went_wrong": "<string>",
    "why_it_matters": "<string>",
    "suggested_next_step": "<string>",
    "possible_downside": "<string>"
  }
}`;

export async function diagnoseTicket(
  ticket: ImprovementTicket,
  logger: Logger,
): Promise<DiagnoseResult> {
  logger.info(
    { ticket_id: ticket.ticketId, category: ticket.category, severity: ticket.severity },
    "maintainer: starting diagnosis",
  );

  const payload = JSON.stringify({
    ticket_id: ticket.ticketId,
    source: ticket.source,
    category: ticket.category,
    severity: ticket.severity,
    summary: ticket.summary,
    what_happened: ticket.whatHappened ?? null,
    why_it_matters: ticket.whyItMatters ?? null,
    affected_component: ticket.affectedComponent ?? null,
    frequency: ticket.frequency ?? 1,
    evidence: ticket.evidence ?? [],
    sample_conversation: ticket.sampleConversation ?? null,
  }, null, 2);

  const text = await callClaude(DIAGNOSE_SYSTEM, `Diagnose this ticket:\n\n${payload}`);

  if (!text) {
    logger.error({ ticket_id: ticket.ticketId }, "maintainer: empty response from model");
    throw new Error("Maintainer received empty response from model");
  }

  let parsed: DiagnoseResult;
  try {
    parsed = JSON.parse(text) as DiagnoseResult;
  } catch {
    logger.error({ ticket_id: ticket.ticketId, raw: text.slice(0, 300) }, "maintainer: non-JSON response");
    throw new Error("Maintainer model returned non-JSON — cannot produce diagnosis");
  }

  parsed.ticket_id = ticket.ticketId;

  const validConf: Confidence[] = ["low", "medium", "high"];
  if (!validConf.includes(parsed.diagnosis?.confidence)) parsed.diagnosis.confidence = "low";

  logger.info({ ticket_id: ticket.ticketId, confidence: parsed.diagnosis.confidence }, "maintainer: diagnosis complete");
  return parsed;
}

// ---------------------------------------------------------------------------
// Stage 2.5: planTicket — draft a change plan from a ticket
// ---------------------------------------------------------------------------

export interface PlanDraft {
  change_type: string;
  risk: "low" | "medium" | "high";
  root_cause: string;
  proposed_change: string;
  expected_upside: string;
  possible_downside: string;
  requires_migration: boolean;
  rollback_method: string;
}

const PLAN_SYSTEM = `\
You are Ashley Maintainer, an internal planning agent for the Ashley-Sidecar AI companion platform.

YOUR ONLY JOB: read an improvement ticket and draft a structured change plan describing what should be different and why. You propose direction — a human engineer decides whether and how to implement it on a PC.

YOU MUST NOT:
- Write code, diffs, or patches
- Reference protected areas (/auth/, /secrets/, /infra/, /deploy/, /approval/, /policy/, /billing/)
- Suggest deployment or rollback execution steps
- Claim certainty you do not have
- Produce anything that could be executed automatically

YOU MUST:
- Identify the root cause clearly
- Describe what should change in plain English (e.g. "the memory write threshold should be stricter")
- Rate the risk honestly: "low" | "medium" | "high"
- Describe the expected benefit and possible downside
- Indicate whether a DB migration would likely be needed (true/false)
- Describe how a human could undo the change if it goes wrong
- change_type must match one of: PROMPT | CONFIG | MEMORY_POLICY | TOOLING | CODE_PATCH | DATA

OUTPUT: ONLY valid JSON, no preamble, no code fences:
{
  "change_type": "<PROMPT|CONFIG|MEMORY_POLICY|TOOLING|CODE_PATCH|DATA>",
  "risk": "low|medium|high",
  "root_cause": "<one paragraph>",
  "proposed_change": "<one paragraph — what should be different>",
  "expected_upside": "<one sentence>",
  "possible_downside": "<one sentence>",
  "requires_migration": false,
  "rollback_method": "<one sentence — how to undo>"
}`;

export async function planTicket(
  ticket: ImprovementTicket,
  evidence: EvidenceItem[],
  logger: Logger,
): Promise<PlanDraft> {
  logger.info({ ticket_id: ticket.ticketId }, "maintainer: starting plan draft");

  const payload = JSON.stringify({
    ticket_id: ticket.ticketId,
    category: ticket.category,
    severity: ticket.severity,
    summary: ticket.summary,
    what_happened: ticket.whatHappened ?? null,
    why_it_matters: ticket.whyItMatters ?? null,
    affected_component: ticket.affectedComponent ?? null,
    frequency: ticket.frequency ?? 1,
    evidence: evidence.map((e) => ({
      type: e.type,
      summary: e.summary,
      snippet: e.snippet ?? null,
    })),
    sample_conversation: ticket.sampleConversation ?? null,
  }, null, 2);

  const text = await callClaude(PLAN_SYSTEM, `Draft a change plan for this ticket:\n\n${payload}`, 1024);

  if (!text) {
    logger.error({ ticket_id: ticket.ticketId }, "maintainer: empty plan response");
    throw new Error("Maintainer received empty plan response");
  }

  let parsed: PlanDraft;
  try {
    parsed = JSON.parse(text) as PlanDraft;
  } catch {
    logger.error({ ticket_id: ticket.ticketId, raw: text.slice(0, 300) }, "maintainer: non-JSON plan response");
    throw new Error("Maintainer returned non-JSON plan");
  }

  const validRisk = ["low", "medium", "high"] as const;
  if (!validRisk.includes(parsed.risk)) parsed.risk = "medium";

  const validTypes = ["PROMPT", "CONFIG", "MEMORY_POLICY", "TOOLING", "CODE_PATCH", "DATA"] as const;
  if (!validTypes.includes(parsed.change_type as typeof validTypes[number])) {
    parsed.change_type = ticket.category;
  }

  logger.info({ ticket_id: ticket.ticketId, risk: parsed.risk, change_type: parsed.change_type }, "maintainer: plan draft complete");
  return parsed;
}

// ---------------------------------------------------------------------------
// Stage 2.5: generateApprovalPacket — human-readable mobile card
// ---------------------------------------------------------------------------

export interface HumanSummary {
  what_went_wrong: string;
  what_ashley_wants_to_change: string;
  why_this_should_help: string;
  what_could_go_wrong: string;
  what_happens_if_approved: string;
  what_happens_if_rejected: string;
}

export interface PacketDraft {
  risk: "low" | "medium" | "high";
  human_summary: HumanSummary;
}

const PACKET_SYSTEM = `\
You are Ashley Maintainer, generating a plain-English approval card for Kane — the human who must approve or reject this change before anything happens.

YOUR ONLY JOB: translate a change plan into a short, honest, jargon-free explanation that Kane can read on his phone in 30 seconds and make a confident decision.

RULES:
- All prose fields must be plain English, one or two sentences maximum each
- No technical jargon unless unavoidable, and if used, explain it
- Never claim certainty — if it might not work, say so
- "what_happens_if_approved" must always end with: "The change is queued for later PC execution — nothing happens automatically."
- "what_happens_if_rejected" must always be: "Nothing changes. The ticket is closed."
- Total word count across all six fields should stay under 180 words

OUTPUT: ONLY valid JSON, no preamble, no code fences:
{
  "risk": "low|medium|high",
  "human_summary": {
    "what_went_wrong": "<string>",
    "what_ashley_wants_to_change": "<string>",
    "why_this_should_help": "<string>",
    "what_could_go_wrong": "<string>",
    "what_happens_if_approved": "<string ending with queue note>",
    "what_happens_if_rejected": "Nothing changes. The ticket is closed."
  }
}`;

export async function generateApprovalPacket(
  ticket: ImprovementTicket,
  plan: ChangePlan,
  logger: Logger,
): Promise<PacketDraft> {
  logger.info({ ticket_id: ticket.ticketId, plan_id: plan.planId }, "maintainer: generating approval packet");

  const payload = JSON.stringify({
    ticket: {
      summary: ticket.summary,
      what_happened: ticket.whatHappened ?? null,
      why_it_matters: ticket.whyItMatters ?? null,
      severity: ticket.severity,
    },
    plan: {
      change_type: plan.changeType,
      risk: plan.risk,
      root_cause: plan.rootCause,
      proposed_change: plan.proposedChange,
      expected_upside: plan.expectedUpside,
      possible_downside: plan.possibleDownside,
      requires_migration: plan.requiresMigration,
      rollback_method: plan.rollbackMethod ?? null,
    },
  }, null, 2);

  const text = await callClaude(PACKET_SYSTEM, `Generate an approval card for this plan:\n\n${payload}`, 768);

  if (!text) {
    logger.error({ plan_id: plan.planId }, "maintainer: empty packet response");
    throw new Error("Maintainer received empty packet response");
  }

  let parsed: PacketDraft;
  try {
    parsed = JSON.parse(text) as PacketDraft;
  } catch {
    logger.error({ plan_id: plan.planId, raw: text.slice(0, 300) }, "maintainer: non-JSON packet response");
    throw new Error("Maintainer returned non-JSON approval packet");
  }

  const validRisk = ["low", "medium", "high"] as const;
  if (!validRisk.includes(parsed.risk)) parsed.risk = plan.risk as "low" | "medium" | "high";

  logger.info({ ticket_id: ticket.ticketId, plan_id: plan.planId }, "maintainer: approval packet ready");
  return parsed;
}
