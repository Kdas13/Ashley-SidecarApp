/**
 * Base44 SDK wrapper — Phase 1 stub.
 *
 * Ashley writes InboxMessage and Proposal entities directly to the Base44
 * dashboard database. When BASE44_SERVICE_ROLE_KEY is not set this module
 * emits a warning and no-ops every write (so startup is not blocked).
 *
 * Replace with the real @base44/sdk import once Kane adds the service role
 * key from the Base44 project settings panel.
 */
import { logger } from "./logger.js";

const BASE44_KEY = process.env["BASE44_SERVICE_ROLE_KEY"]?.trim();

if (!BASE44_KEY) {
  logger.warn(
    "BASE44_SERVICE_ROLE_KEY not set — Base44 inbox and proposal writes are disabled. " +
      "Add the key from your Base44 project settings to enable them.",
  );
}

export type Priority = "info" | "warning" | "urgent";

export async function postInboxMessage(
  content: string,
  priority: Priority,
  referenceCode: string,
): Promise<void> {
  if (!BASE44_KEY) {
    logger.warn({ referenceCode, priority }, "base44: skipped postInboxMessage — no key");
    return;
  }
  // TODO: replace with @base44/sdk once Kane provides BASE44_SERVICE_ROLE_KEY
  //   import { createClient } from "@base44/sdk";
  //   const base44 = createClient({ serviceRoleKey: BASE44_KEY });
  //   await base44.entities.InboxMessage.create({ ... });
  logger.info({ referenceCode, priority, contentLength: content.length }, "base44: postInboxMessage (stub)");
}

export async function postProposal(
  proposalType: string,
  proposedChange: Record<string, unknown>,
  reasoning: string,
): Promise<void> {
  const VALID_TYPES = [
    "add-memory",
    "modify-memory",
    "change-flag",
    "change-provider",
    "new-tier3-prompt",
    "adjust-spend-threshold",
  ];
  if (!VALID_TYPES.includes(proposalType)) {
    throw new Error(`Invalid proposal type: ${proposalType}`);
  }
  if (!BASE44_KEY) {
    logger.warn({ proposalType }, "base44: skipped postProposal — no key");
    return;
  }
  // TODO: replace with @base44/sdk
  logger.info({ proposalType, reasoning }, "base44: postProposal (stub)");
}
