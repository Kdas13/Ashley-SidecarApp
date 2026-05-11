// =============================================================================
// Ashley Maintainer — Phase 1 diagnostic service
// =============================================================================
//
// WHAT THIS IS:
//   An internal-only LLM-backed service that inspects improvement tickets and
//   produces plain-English diagnoses for human engineers.
//
// WHAT THIS IS NOT:
//   It cannot patch code, edit prompts, change configuration, deploy anything,
//   or access protected system areas. It produces reports. Humans act on them.
//
// POLICY:
//   Any ticket that references a protected path is automatically reclassified
//   as DO_NOT_AUTOFIX before the LLM is even called. This is hard-coded and
//   cannot be overridden by ticket content.
//
// LLM CHOICE:
//   The maintainer always uses Claude (Anthropic) regardless of the
//   ASHLEY_TEXT_PROVIDER env var. Diagnostics need a consistent, auditable
//   model — not the cheaper chat lane.
// =============================================================================

import { anthropic } from "@workspace/integrations-anthropic-ai";
import type { ImprovementTicket } from "@workspace/db";
import type { Logger } from "pino";

// ---------------------------------------------------------------------------
// Protected areas — hard-coded, cannot be overridden by ticket content.
// ---------------------------------------------------------------------------

const PROTECTED_PATHS = [
  "/auth/",
  "/secrets/",
  "/approval/",
  "/policy/",
  "/deploy/",
  "/infra/",
  "/billing/",
  "/monitoring/",
] as const;

export function findProtectedPathReference(
  ...texts: (string | null | undefined)[]
): string | null {
  for (const t of texts) {
    if (!t) continue;
    const lower = t.toLowerCase();
    for (const p of PROTECTED_PATHS) {
      if (lower.includes(p)) return p;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Diagnosis output types
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

// ---------------------------------------------------------------------------
// Maintainer system prompt — scoped tightly so the model cannot drift.
// ---------------------------------------------------------------------------

const MAINTAINER_SYSTEM_PROMPT = `\
You are Ashley Maintainer, an internal diagnostic agent for the Ashley-Sidecar AI companion platform.

YOUR ONLY JOB: inspect improvement tickets and produce structured diagnoses for human engineers.

YOU MUST NOT:
- Generate code, patches, or diffs
- Suggest deployment, rollback, or release actions
- Produce configuration file changes
- Access or reference protected areas (/auth/, /secrets/, /approval/, /policy/, /deploy/, /infra/, /billing/, /monitoring/)
- Claim certainty you do not have — use confidence: "low" when unsure

YOU MUST:
- Read the ticket carefully and identify the most likely root cause
- Estimate your confidence honestly: "low" | "medium" | "high"
- Suggest a safe investigation direction for a human engineer (no patching — just where to look)
- Write a plain-English human_report in ~150 words, no jargon, no bullet points in prose fields
- Keep "why_it_matters" focused on the user experience impact
- Keep "possible_downside" honest — what could go wrong if the suggested direction is followed

OUTPUT: Respond with ONLY a valid JSON object in exactly this shape — no preamble, no code fences, no markdown:
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

// ---------------------------------------------------------------------------
// Main diagnostic function
// ---------------------------------------------------------------------------

export async function diagnoseTicket(
  ticket: ImprovementTicket,
  logger: Logger,
): Promise<DiagnoseResult> {
  const ticketPayload = JSON.stringify(
    {
      ticket_id: ticket.ticketId,
      source: ticket.source,
      category: ticket.category,
      severity: ticket.severity,
      summary: ticket.summary,
      affected_component: ticket.affectedComponent ?? null,
      frequency: ticket.frequency ?? 1,
      evidence: ticket.evidence ?? [],
      sample_conversation: ticket.sampleConversation ?? null,
    },
    null,
    2,
  );

  logger.info(
    { ticket_id: ticket.ticketId, category: ticket.category, severity: ticket.severity },
    "maintainer: starting diagnosis",
  );

  const raw = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: MAINTAINER_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Diagnose the following improvement ticket:\n\n${ticketPayload}`,
      },
    ],
  });

  const block = raw.content[0];
  const text = block && block.type === "text" ? block.text.trim() : "";

  if (!text) {
    logger.error({ ticket_id: ticket.ticketId }, "maintainer: LLM returned empty response");
    throw new Error("Maintainer received empty response from model");
  }

  // Strip any accidental code fences the model might wrap despite instructions
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  let parsed: DiagnoseResult;
  try {
    parsed = JSON.parse(cleaned) as DiagnoseResult;
  } catch {
    logger.error(
      { ticket_id: ticket.ticketId, raw_text: text.slice(0, 300) },
      "maintainer: failed to parse LLM JSON",
    );
    throw new Error("Maintainer model returned non-JSON — cannot produce diagnosis");
  }

  // Normalise ticket_id to match the actual ticket regardless of what the model echoes
  parsed.ticket_id = ticket.ticketId;

  // Validate confidence is one of the allowed values
  const validConfidence: Confidence[] = ["low", "medium", "high"];
  if (!validConfidence.includes(parsed.diagnosis?.confidence)) {
    parsed.diagnosis.confidence = "low";
  }

  logger.info(
    {
      ticket_id: ticket.ticketId,
      confidence: parsed.diagnosis.confidence,
    },
    "maintainer: diagnosis complete",
  );

  return parsed;
}
