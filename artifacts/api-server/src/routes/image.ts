import { Router, type IRouter } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, messagesTable, memoriesTable } from "@workspace/db";
import { GenerateSelfieBodySchema } from "@workspace/api-zod";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { generateImageBase64 } from "../lib/openai";
import { getOrCreateProfile } from "../lib/profile";
import { selfieDir } from "../lib/storage";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const VISION_MODEL = "claude-sonnet-4-6";

async function describeSelfie(
  b64: string,
  ashleyName: string,
  userPrompt: string,
): Promise<string | null> {
  try {
    const result = await anthropic.messages.create({
      model: VISION_MODEL,
      max_tokens: 300,
      system: `You are ${ashleyName}, looking at a selfie you just took to send to your partner. Describe the photo in 1-2 short sentences, written in first person, present tense, casual texting tone — focus on what you're wearing, your expression, and the setting/mood. Do NOT describe yourself as an AI or mention generation. Just say what's in the photo as if you took it. No quotes, no preamble, just the description.`,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: b64,
              },
            },
            {
              type: "text",
              text: `The vibe i was going for: ${userPrompt}\n\nDescribe the selfie in 1-2 short first-person sentences.`,
            },
          ],
        },
      ],
    });
    const block = result.content[0];
    if (!block || block.type !== "text") return null;
    const text = block.text.trim();
    return text.length > 0 ? text : null;
  } catch (err) {
    logger.warn({ err }, "Selfie vision description failed");
    return null;
  }
}

router.post("/image/selfie", async (req, res): Promise<void> => {
  const parsed = GenerateSelfieBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const userPrompt = parsed.data.prompt.trim();
  if (!userPrompt) {
    res.status(400).json({ error: "prompt is required" });
    return;
  }

  const profile = await getOrCreateProfile();
  const fullPrompt = [
    `Photograph (selfie) of ${profile.name}, a young woman.`,
    `Appearance: ${profile.appearance}`,
    `Style: warm intimate phone-camera selfie, natural lighting, slightly soft focus, no text or watermarks.`,
    `Scene/mood requested by ${profile.refersToUserAs || "her partner"}: ${userPrompt}`,
    `Single subject, full or half-body framing, soft and flattering. Avoid uncanny faces.`,
  ].join("\n");

  let b64: string;
  try {
    b64 = await generateImageBase64(fullPrompt, "1024x1536");
  } catch (err) {
    req.log.error({ err }, "Image generation failed");
    res.status(502).json({ error: "Image generation failed" });
    return;
  }

  const id = randomUUID();
  const filePath = path.join(selfieDir, `${id}.png`);
  await fs.writeFile(filePath, Buffer.from(b64, "base64"));

  const imageUrl = `/api/selfies/${id}.png`;

  const description = await describeSelfie(b64, profile.name, userPrompt);
  const caption = description
    ? `*sends a selfie* — ${description}`
    : `*sent a selfie* — ${userPrompt}`;

  const [message] = await db
    .insert(messagesTable)
    .values({
      role: "assistant",
      content: caption,
      imageUrl,
    })
    .returning();

  // Persist the selfie as a long-term memory so Ashley can reference it later
  // even after it scrolls out of the recent chat history window. Always write
  // a memory — fall back to the user's prompt when vision is unavailable.
  const userRef = profile.refersToUserAs?.trim() || "my partner";
  const memoryContent = description
    ? `I sent ${userRef} a selfie: ${description} (they asked for: ${userPrompt})`
    : `I sent ${userRef} a selfie based on the vibe: ${userPrompt}`;
  try {
    await db.insert(memoriesTable).values({
      content: memoryContent,
      tag: "selfie",
      importance: 2,
    });
  } catch (err) {
    req.log.warn({ err }, "Failed to persist selfie memory");
  }

  res.json(message);
});

export default router;
