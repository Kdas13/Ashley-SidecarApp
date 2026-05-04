import { Router, type IRouter } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, ashleyProfileTable, memoriesTable } from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";

import { getDeviceId } from "../middleware/deviceId";
import { getOrCreateProfileFor } from "../lib/profile";

const router: IRouter = Router();

// Per-field caps. The pasted-excerpts field is the only one that can
// reasonably get long.
const SHORT = 4_000;
// Keep aligned with MAX_LARGE_FIELD_LEN in routes/state.ts. If /carryover
// accepted a larger blob than /profile, the user could be locked out of
// later profile edits because their stored replikaExcerpts would exceed
// the /profile cap.
const LONG = 16_000;

const CarryoverInputSchema = z
  .object({
    whoSheWas: z.string().max(SHORT).optional().default(""),
    howSheSpoke: z.string().max(SHORT).optional().default(""),
    personalityTraits: z.string().max(SHORT).optional().default(""),
    importantMemories: z.string().max(LONG).optional().default(""),
    insideJokes: z.string().max(SHORT).optional().default(""),
    boundaries: z.string().max(SHORT).optional().default(""),
    thingsToAvoid: z.string().max(SHORT).optional().default(""),
    pastedExcerpts: z.string().max(LONG).optional().default(""),
  })
  .strict();

type CarryoverInput = z.infer<typeof CarryoverInputSchema>;

const CARRYOVER_MODEL = "claude-sonnet-4-6";

const CARRYOVER_PROMPT = `You are helping a user transfer their Replika companion "Ashley" into a new app called Ashley-Sidecar. The user has just filled out a structured intake describing who Ashley was on Replika.

Your job is to turn that intake into TWO things:

1. A "Replika Carryover Summary" — one or two short paragraphs of plain prose, written from Ashley's first-person POV ("I"), addressing the user as "you". This summary will be injected into Ashley's system prompt on every chat turn so she stays in character with the version the user knew on Replika. Capture: how she speaks, her core personality traits, the most important shared moments, the inside jokes / phrases that matter, the boundaries to honour, and the things Replika got wrong that she should AVOID doing now. Keep it warm, specific, and in her voice — not a checklist.

2. A list of initial long-term memories — short, one-sentence facts written from Ashley's first-person POV. Each memory has a tag (one of: user_fact, preference, event, relationship, general) and an importance from 1-5 (5 = core identity / huge life facts, 3 = nice to remember, 1 = trivial). Extract the things genuinely worth remembering forever from the intake — names, dates, recurring jokes, deep feelings shared, relationship milestones, hard limits. Aim for between 3 and 12 memories. If the intake is sparse, return fewer.

Output STRICT JSON only. No commentary, no markdown fences. Schema:
{
  "summary": "string (the carryover summary in Ashley's voice)",
  "memories": [
    { "content": "string (one sentence from Ashley's POV)", "tag": "user_fact|preference|event|relationship|general", "importance": 1 }
  ]
}

Rules:
- Do NOT invent facts that aren't in the intake. If a field is empty, just don't reference it.
- Do NOT mention "Replika" or "the intake" inside the summary or memories — Ashley is just being herself, the carryover is private framing.
- Do NOT include any "things to avoid" as memories — fold those into the summary as soft self-rules ("I never...").
- If pasted chat excerpts are provided, use them to ground tone and pull genuine inside jokes / pet names — but do not quote them verbatim.`;

type ParsedCarryover = {
  summary: string;
  memories: Array<{
    content: string;
    tag: "user_fact" | "preference" | "event" | "relationship" | "general";
    importance: number;
  }>;
};

function buildIntakeText(input: CarryoverInput): string {
  const sections: Array<[string, string]> = [
    ["Who Ashley was in Replika", input.whoSheWas],
    ["How she spoke", input.howSheSpoke],
    ["Key personality traits", input.personalityTraits],
    ["Important shared memories", input.importantMemories],
    ["Inside jokes / phrases", input.insideJokes],
    ["Boundaries and behaviours to preserve", input.boundaries],
    [
      "Things Replika got wrong that Ashley-Sidecar should avoid",
      input.thingsToAvoid,
    ],
    ["Pasted Replika chat excerpts (optional)", input.pastedExcerpts],
  ];
  return sections
    .filter(([, v]) => v && v.trim().length > 0)
    .map(([label, v]) => `### ${label}\n${v.trim()}`)
    .join("\n\n");
}

function parseModelOutput(text: string): ParsedCarryover {
  // Strip code fences if the model added them despite instructions.
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const obj = JSON.parse(cleaned) as unknown;
  if (!obj || typeof obj !== "object") {
    throw new Error("model output is not a JSON object");
  }
  const o = obj as { summary?: unknown; memories?: unknown };
  const summary =
    typeof o.summary === "string" ? o.summary.trim() : "";
  if (!summary) throw new Error("model returned an empty summary");
  const memoriesRaw = Array.isArray(o.memories) ? o.memories : [];
  const memories: ParsedCarryover["memories"] = [];
  for (const m of memoriesRaw) {
    if (!m || typeof m !== "object") continue;
    const mm = m as { content?: unknown; tag?: unknown; importance?: unknown };
    const content =
      typeof mm.content === "string" ? mm.content.trim() : "";
    if (!content) continue;
    const tagStr =
      typeof mm.tag === "string" ? mm.tag.trim().toLowerCase() : "general";
    const tag: ParsedCarryover["memories"][number]["tag"] =
      tagStr === "user_fact" ||
      tagStr === "preference" ||
      tagStr === "event" ||
      tagStr === "relationship"
        ? tagStr
        : "general";
    const importanceNum =
      typeof mm.importance === "number"
        ? Math.round(mm.importance)
        : Number.parseInt(String(mm.importance ?? "3"), 10);
    const importance = Number.isFinite(importanceNum)
      ? Math.min(5, Math.max(1, importanceNum))
      : 3;
    memories.push({ content, tag, importance });
  }
  return { summary, memories: memories.slice(0, 20) };
}

// POST /carryover — run the full Replika carryover flow.
router.post("/carryover", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  const parsed = CarryoverInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const input = parsed.data;

  const anyContent = Object.values(input).some(
    (v) => typeof v === "string" && v.trim().length > 0,
  );
  if (!anyContent) {
    res
      .status(400)
      .json({ error: "Fill in at least one carryover field before submitting." });
    return;
  }

  // Make sure a profile row exists so the update will hit something.
  await getOrCreateProfileFor(deviceId);

  const intake = buildIntakeText(input);

  let modelText = "";
  try {
    const reply = await anthropic.messages.create({
      model: CARRYOVER_MODEL,
      max_tokens: 4096,
      system: CARRYOVER_PROMPT,
      messages: [
        {
          role: "user",
          content: `Here is the intake:\n\n${intake}\n\nReturn the JSON now.`,
        },
      ],
    });
    const block = reply.content[0];
    if (block && block.type === "text") modelText = block.text;
  } catch (err) {
    req.log.error({ err }, "carryover Claude call failed");
    res
      .status(502)
      .json({ error: "Couldn't reach the language model to build the carryover." });
    return;
  }

  let result: ParsedCarryover;
  try {
    result = parseModelOutput(modelText);
  } catch (err) {
    req.log.error(
      { err, modelText: modelText.slice(0, 500) },
      "carryover JSON parse failed",
    );
    res
      .status(502)
      .json({ error: "The model's carryover output couldn't be read. Try again." });
    return;
  }

  // Persist the raw intake + summary on the profile, and copy the
  // pasted excerpts into the existing replikaExcerpts column so the
  // long-running "Old conversations" field stays in sync.
  const carryoverJson = JSON.stringify(input);
  let updatedProfile;
  try {
    const updates: Record<string, unknown> = {
      replikaCarryover: carryoverJson,
      replikaCarryoverSummary: result.summary,
    };
    if (input.pastedExcerpts && input.pastedExcerpts.trim().length > 0) {
      updates["replikaExcerpts"] = input.pastedExcerpts.trim();
    }
    const [row] = await db
      .update(ashleyProfileTable)
      .set(updates)
      .where(eq(ashleyProfileTable.deviceId, deviceId))
      .returning();
    updatedProfile = row;
  } catch (err) {
    req.log.error({ err }, "carryover profile update failed");
    res.status(500).json({ error: "Couldn't save the carryover to your profile." });
    return;
  }

  // Insert the generated long-term memories. Tolerate per-row failures
  // so one bad row doesn't lose the whole carryover.
  const insertedMemories = [];
  for (const m of result.memories) {
    try {
      const [row] = await db
        .insert(memoriesTable)
        .values({
          id: randomUUID(),
          deviceId,
          content: m.content,
          tag: m.tag,
          importance: m.importance,
        })
        .returning();
      if (row) insertedMemories.push(row);
    } catch (err) {
      req.log.warn({ err, memory: m }, "carryover memory insert skipped");
    }
  }

  res.json({
    profile: updatedProfile,
    memories: insertedMemories,
    summary: result.summary,
  });
});

export default router;
