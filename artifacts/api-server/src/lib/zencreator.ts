import { logger } from "./logger.js";

const ZENCREATOR_BASE = "https://api.zencreator.pro/api/public/v1";
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS  = 180_000;

function zenApiKey(): string {
  const key = process.env["Ashley_v3_Adult"];
  if (!key) {
    throw new Error(
      "Ashley_v3_Adult secret not set — add the ZenCreator API key to Replit Secrets",
    );
  }
  return key;
}

function zenTool(): string {
  const tool = process.env["ZENCREATOR_TOOL"];
  if (!tool) {
    throw new Error(
      "ZENCREATOR_TOOL env var not set — set it to the tool name from " +
        "GET /api/public/v1/tools on api.zencreator.pro",
    );
  }
  return tool;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ZenGenerationCreated {
  id: string;
  status: string;
}

interface ZenGenerationStatus {
  id: string;
  status: "queued" | "processing" | "succeeded" | "partial" | "failed";
  progress: number;
  error?: string | null;
}

interface ZenGenerationOutput {
  asset_id: string;
  url: string;
  download_url?: string | null;
}

interface ZenGenerationResult {
  id: string;
  status: string;
  outputs: ZenGenerationOutput[];
  error?: string | null;
}

function sizeToWidthHeight(size: string): { width: number; height: number } {
  const parts = size.split("x");
  return {
    width: parseInt(parts[0] ?? "1024", 10),
    height: parseInt(parts[1] ?? "1024", 10),
  };
}

/**
 * Generate an image via ZenCreator's async generation API.
 *
 * Flow:
 *   1. POST /api/public/v1/generations { tool, input }
 *   2. Poll GET /api/public/v1/generations/{id} until status=succeeded/failed
 *   3. GET /api/public/v1/generations/{id}/result → download outputs[0]
 *
 * Required env vars:
 *   Ashley_v3_Adult  — ZenCreator API key (Bearer token)
 *   ZENCREATOR_TOOL  — tool name from GET /tools, e.g. "flux-lora" or similar
 *
 * Optional env vars:
 *   ZENCREATOR_EXTRA_INPUT — JSON string of additional input fields merged
 *                            on top of { prompt, width, height } — use this
 *                            to pass model IDs, LoRA weights, negative
 *                            prompts, or any other tool-specific params.
 */
export async function generateImageWithZenCreator(
  prompt: string,
  size: "1024x1024" | "1024x1536" | "1536x1024" = "1024x1024",
  _quality: "low" | "medium" | "high" = "low",
): Promise<string> {
  const apiKey = zenApiKey();
  const tool   = zenTool();
  const { width, height } = sizeToWidthHeight(size);

  // Build base input and merge any operator overrides.
  let extraInput: Record<string, unknown> = {};
  const extraRaw = process.env["ZENCREATOR_EXTRA_INPUT"];
  if (extraRaw) {
    try {
      extraInput = JSON.parse(extraRaw) as Record<string, unknown>;
    } catch {
      logger.warn(
        { extraRaw },
        "zencreator: ZENCREATOR_EXTRA_INPUT is not valid JSON — ignoring",
      );
    }
  }

  const input: Record<string, unknown> = {
    positive_prompt: prompt,
    width,
    height,
    ...extraInput,
  };

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  logger.info(
    { tool, size, promptLength: prompt.length },
    "zencreator: submitting generation",
  );

  const submitRes = await fetch(`${ZENCREATOR_BASE}/generations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ tool, input }),
  });

  if (!submitRes.ok) {
    const body = await submitRes.text();
    throw new Error(
      `ZenCreator submit failed (${submitRes.status}): ${body}`,
    );
  }

  const created = (await submitRes.json()) as ZenGenerationCreated;
  const { id } = created;
  if (!id) {
    throw new Error("ZenCreator: no id in submit response");
  }

  logger.info({ id, tool }, "zencreator: task submitted — polling");

  const deadline  = Date.now() + POLL_TIMEOUT_MS;
  let pollCount   = 0;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    pollCount++;

    const pollRes = await fetch(`${ZENCREATOR_BASE}/generations/${id}`, {
      headers,
    });

    if (!pollRes.ok) {
      const body = await pollRes.text();
      throw new Error(
        `ZenCreator poll failed (${pollRes.status}): ${body}`,
      );
    }

    const poll = (await pollRes.json()) as ZenGenerationStatus;

    logger.info(
      { id, status: poll.status, progress: poll.progress, pollCount },
      "zencreator: poll",
    );

    if (poll.status === "failed") {
      throw new Error(
        `ZenCreator: generation ${id} failed — ${poll.error ?? "unknown error"}`,
      );
    }

    if (poll.status === "succeeded" || poll.status === "partial") {
      const resultRes = await fetch(
        `${ZENCREATOR_BASE}/generations/${id}/result`,
        { headers },
      );

      if (!resultRes.ok) {
        const body = await resultRes.text();
        throw new Error(
          `ZenCreator result fetch failed (${resultRes.status}): ${body}`,
        );
      }

      const result = (await resultRes.json()) as ZenGenerationResult;

      if (poll.status === "partial" && result.outputs.length === 0) {
        throw new Error(
          `ZenCreator: generation ${id} partial with no outputs — ${result.error ?? ""}`,
        );
      }

      const output = result.outputs[0];
      if (!output) {
        throw new Error(
          `ZenCreator: generation ${id} succeeded but outputs array is empty`,
        );
      }

      // Prefer direct download_url; fall back to the public preview url.
      const imageUrl = output.download_url ?? output.url;

      logger.info(
        { id, imageUrl, outputCount: result.outputs.length },
        "zencreator: generation complete — downloading",
      );

      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) {
        throw new Error(
          `ZenCreator: failed to download image from ${imageUrl} (${imgRes.status})`,
        );
      }

      const buf = Buffer.from(await imgRes.arrayBuffer());

      logger.info(
        { id, imageBytes: buf.length },
        "zencreator: image downloaded — returning base64",
      );

      return buf.toString("base64");
    }
  }

  throw new Error(
    `ZenCreator: timed out after ${POLL_TIMEOUT_MS / 1000}s waiting for generation ${id}`,
  );
}
