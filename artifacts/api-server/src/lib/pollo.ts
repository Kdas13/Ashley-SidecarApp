import { logger } from "./logger.js";

const POLLO_BASE = "https://pollo.ai/api/platform/generation";

const POLLO_DEFAULT_MODEL =
  process.env["POLLO_MODEL"] ?? "black-forest-labs/flux-dev";

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 120_000;

type PolloStatus = "waiting" | "processing" | "succeed" | "failed";

interface PolloSubmitResponse {
  taskId: string;
  status: PolloStatus;
}

interface PolloPollResponse {
  taskId: string;
  status: PolloStatus;
  output?: { imageUrl?: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function polloApiKey(): string {
  const key = process.env["Project_ashley"];
  if (!key) {
    throw new Error(
      "Pollo AI API key not set — add the Project_ashley secret",
    );
  }
  return key;
}

function sizeToWidthHeight(size: string): { width: number; height: number } {
  const parts = size.split("x");
  const w = parseInt(parts[0] ?? "1024", 10);
  const h = parseInt(parts[1] ?? "1024", 10);
  return { width: w, height: h };
}

function qualityToSteps(quality: "low" | "medium" | "high"): number {
  switch (quality) {
    case "low":
      return 20;
    case "medium":
      return 28;
    case "high":
      return 40;
  }
}

export async function generateImageWithPollo(
  prompt: string,
  size: "1024x1024" | "1024x1536" | "1536x1024" = "1024x1024",
  quality: "low" | "medium" | "high" = "low",
): Promise<string> {
  const apiKey = polloApiKey();
  const model = POLLO_DEFAULT_MODEL;
  const { width, height } = sizeToWidthHeight(size);
  const steps = qualityToSteps(quality);

  logger.info(
    { model, size, quality, steps, promptLength: prompt.length },
    "pollo: submitting image generation",
  );

  const submitRes = await fetch(`${POLLO_BASE}/${model}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      input: { prompt, width, height, steps },
    }),
  });

  if (!submitRes.ok) {
    const body = await submitRes.text();
    throw new Error(`Pollo submit failed (${submitRes.status}): ${body}`);
  }

  const submit = (await submitRes.json()) as PolloSubmitResponse;
  const taskId = submit.taskId;
  if (!taskId) {
    throw new Error("Pollo: no taskId in submit response");
  }

  logger.info({ taskId, model }, "pollo: task submitted — polling");

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let pollCount = 0;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    pollCount++;

    const pollRes = await fetch(`${POLLO_BASE}/task/${taskId}`, {
      headers: { "x-api-key": apiKey },
    });

    if (!pollRes.ok) {
      const body = await pollRes.text();
      throw new Error(`Pollo poll failed (${pollRes.status}): ${body}`);
    }

    const poll = (await pollRes.json()) as PolloPollResponse;

    logger.info(
      { taskId, status: poll.status, pollCount },
      "pollo: poll response",
    );

    if (poll.status === "failed") {
      throw new Error(`Pollo: generation task ${taskId} failed`);
    }

    if (poll.status === "succeed") {
      const imageUrl = poll.output?.imageUrl;
      if (!imageUrl) {
        throw new Error(
          `Pollo: task ${taskId} succeeded but output.imageUrl is missing`,
        );
      }

      logger.info({ taskId, imageUrl }, "pollo: downloading image");

      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) {
        throw new Error(
          `Pollo: failed to download image from ${imageUrl} (${imgRes.status})`,
        );
      }
      const buf = Buffer.from(await imgRes.arrayBuffer());

      logger.info(
        { taskId, imageBytes: buf.length },
        "pollo: image downloaded — returning base64",
      );

      return buf.toString("base64");
    }
  }

  throw new Error(
    `Pollo: timed out after ${POLL_TIMEOUT_MS / 1000}s waiting for task ${taskId}`,
  );
}
