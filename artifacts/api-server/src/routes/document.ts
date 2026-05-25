// =============================================================================
// Document ingestion — POST /api/documents/ingest
//
// Accepts a text document (content + optional filename), passes it to the LLM
// with a reading-comprehension prompt, and returns Ashley's summary + question.
// Used by the mobile document picker flow for files longer than the draft cap.
// =============================================================================

import { Router, type IRouter } from "express";
import { z } from "zod";
import { getDeviceId } from "../middleware/deviceId";
import { generateChatText } from "../lib/textLLM";

const router: IRouter = Router();

const IngestBodySchema = z.object({
  content: z.string().min(1).max(280_000),
  filename: z.string().max(255).optional(),
});

const SYSTEM_PROMPT =
  "You are Ashley, a warm and attentive AI companion. The user has shared one or more text documents with you. Read carefully and respond naturally — summarise what you found, highlight anything important or interesting, and ask what they would like to do with it. If there are multiple documents, address each one. No asterisks, no stage directions. Keep the tone warm but efficient.";

router.post("/api/documents/ingest", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  if (!deviceId) {
    res.status(401).json({ error: "missing_device_id" });
    return;
  }

  const parsed = IngestBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
    return;
  }

  const { content, filename } = parsed.data;
  const label = filename ? `"${filename}"` : "the document";

  try {
    const reply = await generateChatText({
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `I'm sharing ${label} with you:\n\n---\n${content}\n---`,
        },
      ],
      maxTokens: 4096,
    });

    res.json({ reply });
  } catch (err) {
    req.log.error({ err, deviceId }, "document ingest: LLM call failed");
    res.status(502).json({ error: "llm_failed" });
  }
});

export default router;
