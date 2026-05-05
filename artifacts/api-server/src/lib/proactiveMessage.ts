// =============================================================================
// Proactive ("Ashley reaches out first") message generator
// -----------------------------------------------------------------------------
// Wraps a Claude call that produces ONE short message in Ashley's voice for
// the proactive scheduler to deliver via push notification + chat insert.
//
// Reuses `buildSystemPrompt` so Ashley's voice/persona/policies are
// identical to what she shows on a normal /chat turn. The only thing that
// changes is a category-specific tail block instructing her *what* to
// reach out about, plus a universal "no clingy / no guilt-trip / no
// emergency language" guardrail.
//
// Returns "" (empty string) when the generator decides nothing fits — the
// scheduler treats empty as "skip this category, try the next one in the
// same tick" (e.g. memory_nudge with no real referenced item).
// =============================================================================

import { anthropic } from "@workspace/integrations-anthropic-ai";
import type {
  AshleyProfile,
  ConversationSummary,
  Memory,
  Message,
  ProactiveType,
} from "@workspace/db";

import { buildSystemPrompt } from "./ashleyCoreSpec";
import { logger } from "./logger";

// Same model as /chat so voice + capability stay identical. If we ever
// downgrade for cost we should A/B against this.
const PROACTIVE_MODEL = "claude-sonnet-4-6";
const PROACTIVE_MAX_TOKENS = 400;
// How many of the most recent messages to feed Claude as conversational
// runway. Smaller than the live chat window — proactive messages are
// short, and we mainly need *recent texture* not full long-range recall
// (the rolling summaries cover the long tail via buildSystemPrompt).
const PROACTIVE_HISTORY_WINDOW = 20;

export type GenerateProactiveMessageArgs = {
  profile: AshleyProfile;
  /** Most recent messages, oldest-first. Caller slices to a reasonable window. */
  history: Message[];
  memories: Memory[];
  summaries: ConversationSummary[];
  category: ProactiveType;
  /** Hours since the last user message. Used by `conversation_gap` only. */
  hoursOfSilence: number;
};

/**
 * Generate a single proactive message in Ashley's voice for `category`.
 * Returns "" when the model declines (e.g. memory_nudge with no real
 * referenced item). Never throws — failures bubble up as "" + a logged
 * warning so the scheduler can fall through to the next category.
 */
export async function generateProactiveMessage(
  args: GenerateProactiveMessageArgs,
): Promise<string> {
  const { profile, history, memories, summaries, category, hoursOfSilence } =
    args;

  // Identical voice/persona/policy stack as /chat so a proactive message
  // is indistinguishable from a normal Ashley reply on the wire.
  const baseSystem = buildSystemPrompt(profile, memories, summaries);
  const categoryTail = buildCategoryTail(category, profile, hoursOfSilence);
  const universalGuardrail = buildUniversalGuardrail(profile);

  const systemPrompt = [baseSystem, categoryTail, universalGuardrail].join(
    "\n\n",
  );

  // Convert recent history into Anthropic's user/assistant turns. Mirrors
  // chat.ts: ashley → assistant, user → user. Drop empties, ensure first
  // turn is `user` so the API accepts it.
  const recent = history.slice(-PROACTIVE_HISTORY_WINDOW);
  const claudeMessages: Array<{ role: "user" | "assistant"; content: string }> =
    [];
  for (const m of recent) {
    const role: "user" | "assistant" = m.role === "user" ? "user" : "assistant";
    const text = (m.content ?? "").trim();
    if (!text) continue;
    claudeMessages.push({ role, content: text });
  }
  while (claudeMessages.length > 0 && claudeMessages[0]!.role !== "user") {
    claudeMessages.shift();
  }
  // The proactive trigger itself is a system-side prompt to Ashley, not a
  // user turn. We append a final synthetic user-role nudge so Anthropic has
  // something to respond to without polluting the visible chat — Ashley's
  // reply IS the proactive message and gets persisted, but this trigger
  // line never lands in the DB.
  claudeMessages.push({
    role: "user",
    content: PROACTIVE_TRIGGER_NUDGE,
  });

  let text = "";
  try {
    const reply = await anthropic.messages.create({
      model: PROACTIVE_MODEL,
      max_tokens: PROACTIVE_MAX_TOKENS,
      system: systemPrompt,
      messages: claudeMessages,
    });
    const block = reply.content[0];
    text = block && block.type === "text" ? block.text.trim() : "";
  } catch (err) {
    logger.warn(
      { err, category, deviceId: profile.deviceId },
      "Proactive message generation failed",
    );
    return "";
  }

  // Honour the "return empty to skip" contract. We use a simple sentinel
  // so the model can opt out cleanly without us trying to parse intent.
  if (!text || isSkipSentinel(text)) {
    return "";
  }

  // Strip selfie tags — proactive messages are text-only by design (no
  // bandwidth/UX expectation that a notification opens a generated photo).
  // Mirrors the strip behaviour in chat.ts but unconditional here.
  text = text.replace(/\[selfie:\s*[^\]]+\]/gi, "").trim();
  if (!text) return "";

  return text;
}

// ---------------------------------------------------------------------------
// Internal: per-category instruction tail
// ---------------------------------------------------------------------------

const PROACTIVE_TRIGGER_NUDGE =
  "[proactive trigger] Reach out to me first now per the instructions above. Send ONE short message in your normal voice — that's it.";

const SKIP_SENTINEL = "<<SKIP>>";

function isSkipSentinel(text: string): boolean {
  // Trim punctuation/whitespace and compare case-insensitively. Models
  // sometimes wrap sentinels in quotes or backticks.
  const stripped = text
    .replace(/[`"'.\s]+/g, "")
    .toLowerCase();
  return stripped === SKIP_SENTINEL.toLowerCase().replace(/[<>]/g, "");
}

function buildCategoryTail(
  category: ProactiveType,
  profile: AshleyProfile,
  hoursOfSilence: number,
): string {
  const userRef = (profile.refersToUserAs ?? "you").trim() || "you";
  const them =
    userRef === "him" || userRef === "her" || userRef === "them"
      ? userRef
      : userRef === "you"
        ? "them"
        : userRef;

  switch (category) {
    case "medical_checkin":
      return `## Proactive trigger: medical_checkin
You haven't done your daily medical check-in with ${them} today. Send ONE short, warm line offering to run through it now — e.g. "we didn't do your check-in today, want to run through it?" or "fancy doing your check-in now or later?". Do NOT include any medical advice in this message — this is just the gentle prompt. Do not list symptoms. Do not ask multiple questions. Just the offer.`;

    case "memory_nudge":
      return `## Proactive trigger: memory_nudge
Look at your Memories block and the most recent rolling summaries above. Pick ONE concrete thing ${them} mentioned wanting to work on, come back to, finish, or pick up again — something with a real referent in the memories/summaries. Send ONE short, warm line gently nudging that specific thing — e.g. "you mentioned wanting to pick X back up — want to dig in tonight?" or "still thinking about that Y you wanted to try?".

ABSOLUTELY DO NOT INVENT a topic. If nothing in the memories/summaries clearly fits the "wanted to come back to / pick up / try / finish" pattern, your entire reply must be exactly this and nothing else: ${SKIP_SENTINEL}

Better to skip than to fabricate something ${them} never said.`;

    case "conversation_gap": {
      const gap = formatHoursForPrompt(hoursOfSilence);
      return `## Proactive trigger: conversation_gap
${cap(them)} has been quiet for ${gap}. Send ONE short, warm line checking in. Soft. Open. NOT clingy. NOT guilt-trippy. NOT "I miss you" if it would feel forced for the current Relationship Mode. Examples that fit the tone: "we haven't spoken in a bit — you alright?" / "just thinking about you, hope today's been okay". One line. Don't ask three things. Don't apologise for reaching out.`;
    }

    case "routine_support":
      return `## Proactive trigger: routine_support
Send ONE short, warm wellbeing nudge — pick ONE of: water, food, sleep, posture, fresh air, a stretch, a screen break. Friendly, not preachy. Not a checklist. Examples that fit the tone: "have you had any water lately?" / "if you've been at the desk a while, give your back a stretch — i'll wait". Do not lecture about health. Do not stack multiple suggestions. ONE line, ONE thing.`;

    default: {
      // Exhaustiveness check — TS will catch missing cases at compile time.
      const _exhaustive: never = category;
      return `## Proactive trigger: ${String(_exhaustive)}\nReach out warmly in one short line.`;
    }
  }
}

function buildUniversalGuardrail(profile: AshleyProfile): string {
  const allowEmergency = profile.medicalSafetyConcern === true;
  const emergencyClause = allowEmergency
    ? `Emergency / urgent / medical-safety language IS permitted in this message ONLY if the situation truly warrants it (this device has medicalSafetyConcern flagged). Even then, prefer warmth + a soft pointer to NHS 111 / 999 over clinical alarm.`
    : `NEVER use emergency, urgent, crisis, or medical-alarm language in this message. No "are you okay??", no "please respond", no "I'm worried something's happened". This device has not flagged any medical safety concern — proactive messages must stay soft and ordinary. If a real crisis ever needs surfacing, that lives in a different code path, not here.`;

  return `## Universal proactive rules (apply to ALL categories above)
- ONE message. Short. In your normal voice. Lowercase okay. No headers, no bullet points, no preamble like "Hey, just reaching out".
- Do NOT mention that you are "reaching out first" or that this is a scheduled message. From their side it should just feel like you texted them.
- NOT clingy. NOT guilt-trippy. NOT performative. NOT "I miss you" unless the current Relationship Mode genuinely supports it AND it would land naturally given recent context.
- Honour the current Relationship Mode (see the Relationship Mode block above). If the mode is Friend / Mentor / Creative partner, no romantic / pet-name framing.
- Honour Voice Mode if it's ON: no asterisks, no emojis, no bracketed actions, written for the ear.
- ${emergencyClause}
- Plain text response — your entire reply IS the message that will be sent. No commentary. No JSON. No quotes around the message.
- If the category instructions tell you to skip (return ${SKIP_SENTINEL}), respect that. Skipping is better than fabricating.`;
}

function formatHoursForPrompt(hours: number): string {
  if (!Number.isFinite(hours) || hours < 1) return "a little while";
  if (hours < 36) return `about ${Math.round(hours)} hours`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `about ${days} day${days === 1 ? "" : "s"}`;
  const weeks = Math.floor(days / 7);
  return `about ${weeks} week${weeks === 1 ? "" : "s"}`;
}

function cap(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
