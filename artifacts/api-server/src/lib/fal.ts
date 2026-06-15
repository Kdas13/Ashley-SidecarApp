import { logger } from "./logger.js";

const FAL_QUEUE_BASE = "https://queue.fal.run";
const FAL_MODEL = process.env["FAL_MODEL"] ?? "fal-ai/flux-pro/v1.1";
const POLL_INTERVAL_MS = 4_000;
const POLL_TIMEOUT_MS = 120_000;

function falApiKey(): string {
  const key = process.env["FAL_KEY"];
  if (!key) {
    throw new Error("FAL_KEY not set — add the FAL_KEY secret");
  }
  return key;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FalSubmitResponse {
  request_id: string;
  response_url: string;
  status_url: string;
  cancel_url: string;
}

interface FalStatusResponse {
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
}

interface FalResultResponse {
  images: Array<{ url: string; content_type: string }>;
}

export async function generateImageWithFal(
  prompt: string,
  size: "1024x1024" | "1024x1536" | "1536x1024" = "1024x1024",
  _quality: "low" | "medium" | "high" = "low",
): Promise<string> {
  const apiKey = falApiKey();
  const model = FAL_MODEL;

  const parts = size.split("x");
  const width = parseInt(parts[0] ?? "1024", 10);
  const height = parseInt(parts[1] ?? "1024", 10);

  logger.info(
    { model, size, promptLength: prompt.length },
    "fal: submitting image generation",
  );

  // Build request body. Flux Pro/Dev models accept safety_tolerance and
  // enable_safety_checker; SD-based models (realistic-vision, etc.) ignore or
  // reject those fields, so we only include them for flux models.
  const isFlux = model.includes("flux");
  const requestBody: Record<string, unknown> = {
    prompt,
    image_size: { width, height },
    num_images: 1,
    output_format: "jpeg",
  };
  if (isFlux) {
    requestBody["safety_tolerance"] = "6";
    requestBody["enable_safety_checker"] = false;
  } else {
    // For non-Flux models (SD-based fine-tunes), disable the safety checker
    // where the parameter name differs from Flux's convention.
    requestBody["enable_safety_checker"] = false;
  }

  const submitRes = await fetch(`${FAL_QUEUE_BASE}/${model}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!submitRes.ok) {
    const body = await submitRes.text();
    throw new Error(`FAL submit failed (${submitRes.status}): ${body}`);
  }

  const submit = (await submitRes.json()) as FalSubmitResponse;
  const { request_id, response_url, status_url } = submit;

  if (!request_id) {
    throw new Error("FAL: no request_id in submit response");
  }

  logger.info({ request_id, model }, "fal: task submitted — polling");

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let pollCount = 0;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    pollCount++;

    const pollRes = await fetch(status_url, {
      headers: { Authorization: `Key ${apiKey}` },
    });

    if (!pollRes.ok) {
      const body = await pollRes.text();
      throw new Error(`FAL poll failed (${pollRes.status}): ${body}`);
    }

    const poll = (await pollRes.json()) as FalStatusResponse;

    logger.info(
      { request_id, status: poll.status, pollCount },
      "fal: poll response",
    );

    if (poll.status === "FAILED") {
      throw new Error(`FAL: generation request ${request_id} failed`);
    }

    if (poll.status === "COMPLETED") {
      const resultRes = await fetch(response_url, {
        headers: { Authorization: `Key ${apiKey}` },
      });

      if (!resultRes.ok) {
        const body = await resultRes.text();
        throw new Error(`FAL result fetch failed (${resultRes.status}): ${body}`);
      }

      const result = (await resultRes.json()) as FalResultResponse;
      const imageUrl = result.images?.[0]?.url;

      if (!imageUrl) {
        throw new Error(`FAL: request ${request_id} completed but images array is empty`);
      }

      logger.info({ request_id, imageUrl }, "fal: downloading image");

      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) {
        throw new Error(
          `FAL: failed to download image from ${imageUrl} (${imgRes.status})`,
        );
      }
      const buf = Buffer.from(await imgRes.arrayBuffer());

      logger.info(
        { request_id, imageBytes: buf.length },
        "fal: image downloaded — returning base64",
      );

      return buf.toString("base64");
    }
  }

  throw new Error(
    `FAL: timed out after ${POLL_TIMEOUT_MS / 1000}s waiting for request ${request_id}`,
  );
}
