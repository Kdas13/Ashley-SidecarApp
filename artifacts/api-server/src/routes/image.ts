import { Router, type IRouter } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, messagesTable } from "@workspace/db";
import { GenerateSelfieBodySchema } from "@workspace/api-zod";
import { generateImageBase64 } from "../lib/openai";
import { getOrCreateProfile } from "../lib/profile";
import { selfieDir } from "../lib/storage";

const router: IRouter = Router();

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

  const [message] = await db
    .insert(messagesTable)
    .values({
      role: "assistant",
      content: `*sent a selfie* — ${userPrompt}`,
      imageUrl,
    })
    .returning();

  res.json(message);
});

export default router;
