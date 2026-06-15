// ---------------------------------------------------------------------------
// Replicate image generation — runs the LoRA fine-tune stored under
// REPLICATE_LORA_MODEL so selfies look like the specific trained character
// rather than a generic image.
//
// REPLICATE_LORA_MODEL accepts:
//   "model-name"          → prepends REPLICATE_USERNAME to form owner/model
//   "owner/model"         → used as-is for the latest deployed version
//   "owner/model:vhash"   → routes to the version-pinned predictions endpoint
//
// Required env vars: REPLICATE_API_TOKEN, REPLICATE_LORA_MODEL
// Optional: REPLICATE_USERNAME (needed if REPLICATE_LORA_MODEL has no owner)
// ---------------------------------------------------------------------------

import { logger } from "./logger.js";

const REPLICATE_API = "https://api.replicate.com/v1";
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getConfig(): { token: string; modelPath: string } {
  const token = process.env["REPLICATE_API_TOKEN"];
  if (!token) throw new Error("REPLICATE_API_TOKEN not set");

  const model = (process.env["REPLICATE_LORA_MODEL"] ?? "").trim();
  if (!model) throw new Error("REPLICATE_LORA_MODEL not set");

  let modelPath: string;
  if (model.includes("/")) {
    modelPath = model;
  } else {
    const username = (process.env["REPLICATE_USERNAME"] ?? "").trim();
    if (!username) {
      throw new Error(
        "REPLICATE_LORA_MODEL has no owner prefix and REPLICATE_USERNAME is not set",
      );
    }
    modelPath = `${username}/${model}`;
  }

  return { token, modelPath };
}

interface Prediction {
  id: string;
  status: string;
  output?: string | string[];
  error?: string;
  urls?: { get?: string };
}

export async function generateImageWithReplicate(
  prompt: string,
  size: "1024x1024" | "1024x1536" | "1536x1024" = "1024x1024",
  _quality: "low" | "medium" | "high" = "low",
): Promise<string> {
  const { token, modelPath } = getConfig();

  const parts = size.split("x");
  const width = parseInt(parts[0] ?? "1024", 10);
  const height = parseInt(parts[1] ?? "1024", 10);

  const hasVersion = modelPath.includes(":");
  const [ownerModel, version] = modelPath.split(":");

  const input = {
    prompt,
    width,
    height,
    output_format: "jpg",
    disable_safety_checker: true,
    num_inference_steps: 28,
    guidance_scale: 3.5,
  };

  const submitUrl = hasVersion
    ? `${REPLICATE_API}/predictions`
    : `${REPLICATE_API}/models/${ownerModel}/predictions`;

  const body = hasVersion
    ? { version, input }
    : { input };

  logger.info(
    { modelPath, size, hasVersion, promptLength: prompt.length },
    "replicate: submitting prediction",
  );

  const submitRes = await fetch(submitUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      // Ask Replicate to hold the connection for up to 5s before returning
      // a polling URL — avoids an extra round-trip for fast models.
      Prefer: "wait=5",
    },
    body: JSON.stringify(body),
  });

  if (!submitRes.ok) {
    const msg = await submitRes.text().catch(() => submitRes.statusText);
    throw new Error(`Replicate submit failed (${submitRes.status}): ${msg}`);
  }

  let prediction = (await submitRes.json()) as Prediction;
  logger.info(
    { id: prediction.id, status: prediction.status },
    "replicate: prediction submitted",
  );

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const pollUrl =
    prediction.urls?.get ?? `${REPLICATE_API}/predictions/${prediction.id}`;

  while (
    prediction.status !== "succeeded" &&
    prediction.status !== "failed" &&
    prediction.status !== "canceled"
  ) {
    if (Date.now() > deadline) {
      throw new Error(
        `Replicate: timed out after ${POLL_TIMEOUT_MS / 1000}s (prediction ${prediction.id})`,
      );
    }
    await sleep(POLL_INTERVAL_MS);

    const pollRes = await fetch(pollUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!pollRes.ok) {
      const msg = await pollRes.text().catch(() => pollRes.statusText);
      throw new Error(`Replicate poll failed (${pollRes.status}): ${msg}`);
    }
    prediction = (await pollRes.json()) as Prediction;
    logger.info(
      { id: prediction.id, status: prediction.status },
      "replicate: poll",
    );
  }

  if (prediction.status !== "succeeded") {
    throw new Error(
      `Replicate prediction ${prediction.id} ${prediction.status}: ${prediction.error ?? "unknown"}`,
    );
  }

  const outputUrl = Array.isArray(prediction.output)
    ? prediction.output[0]
    : prediction.output;

  if (!outputUrl) {
    throw new Error(
      `Replicate: prediction ${prediction.id} succeeded but output is empty`,
    );
  }

  logger.info({ id: prediction.id, outputUrl }, "replicate: downloading image");

  const imgRes = await fetch(outputUrl);
  if (!imgRes.ok) {
    throw new Error(
      `Replicate: image download failed (${imgRes.status}) from ${outputUrl}`,
    );
  }

  const buf = Buffer.from(await imgRes.arrayBuffer());
  if (buf.length === 0) {
    throw new Error("Replicate: downloaded image is empty");
  }

  logger.info(
    { id: prediction.id, bytes: buf.length },
    "replicate: image ready",
  );

  return buf.toString("base64");
}
