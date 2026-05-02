import type {
  AshleyProfile,
  ConversationSummary,
  Memory,
  Message,
  ReplyToRef,
} from "./storage";

const HISTORY_WINDOW = 30;
const MAX_SUMMARIES_IN_PROMPT = 8;

function getApiBase(): string {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (!domain) {
    throw new Error(
      "EXPO_PUBLIC_DOMAIN is not set; cannot reach Ashley's brain.",
    );
  }
  const cleaned = domain.replace(/\/+$/, "");
  if (cleaned.startsWith("http://") || cleaned.startsWith("https://")) {
    return `${cleaned}/api`;
  }
  return `https://${cleaned}/api`;
}

/**
 * In Replit's dev environment the api-server is recycled by the workflow
 * runner roughly every 8-12 minutes. The actual dead-window between the
 * old instance dying and the new one accepting connections has been
 * observed to last 30s+ in practice — much longer than the build itself
 * (~1.5s) because the workflow runner spins up a fresh shell each time.
 *
 * During that window the public proxy returns its "Run this app to see
 * the results here." placeholder HTML — typically with a 404 or 503.
 *
 * Strategy: when we see the placeholder, poll /api/healthz every second
 * until the server reports 200 (or we hit the deadline), then retry the
 * original request ONCE. This is much cleaner than blind backoff because
 * we wait exactly as long as the outage lasts and no longer. The total
 * deadline is ~30s — comfortably covering the observed dead-window
 * without making the user feel like the app is hung. Real 4xx/5xx JSON
 * errors from the api-server are returned untouched.
 */
const PROXY_PLACEHOLDER_MARKER = "Run this app to see the results here";
const HEALTH_POLL_INTERVAL_MS = 1000;
const HEALTH_POLL_DEADLINE_MS = 30_000;

async function fetchWithProxyRetry(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const first = await fetch(url, init);
  if (!(await looksLikeProxyPlaceholder(first))) return first;

  // Server is in its restart dead-window. Wait for healthz to come back.
  const healthUrl = healthzUrlFor(url);
  const came_back = await waitForServerBack(healthUrl);
  if (!came_back) {
    throw new Error(
      "Ashley's server is restarting — give it a few seconds and try again.",
    );
  }

  // Server is back. Retry the original request once.
  const second = await fetch(url, init);
  if (await looksLikeProxyPlaceholder(second)) {
    throw new Error(
      "Ashley's server is restarting — give it a few seconds and try again.",
    );
  }
  return second;
}

function healthzUrlFor(reqUrl: string): string {
  // reqUrl is like https://<domain>/api/chat/reply — strip back to /api/healthz.
  const idx = reqUrl.indexOf("/api/");
  if (idx < 0) return reqUrl; // shouldn't happen; fall back, healthz will fail and we'll bail
  return `${reqUrl.slice(0, idx)}/api/healthz`;
}

async function waitForServerBack(healthUrl: string): Promise<boolean> {
  const deadline = Date.now() + HEALTH_POLL_DEADLINE_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
    try {
      const res = await fetch(healthUrl, { method: "GET" });
      if (res.ok && !(await looksLikeProxyPlaceholder(res))) return true;
    } catch {
      // network blip during the restart — keep polling
    }
  }
  return false;
}

async function looksLikeProxyPlaceholder(res: Response): Promise<boolean> {
  // Only consider it a transient gap if the status is suspicious AND the
  // body is the Replit landing HTML. We must clone() because the caller
  // still needs to read the body if we don't retry.
  if (res.ok) return false;
  const status = res.status;
  if (status !== 404 && status !== 502 && status !== 503) return false;
  try {
    const peek = await res.clone().text();
    return peek.includes(PROXY_PLACEHOLDER_MARKER);
  } catch {
    return false;
  }
}

export type ChatReplyRequest = {
  content: string;
  profile: AshleyProfile;
  memories: Memory[];
  summaries: ConversationSummary[];
  history: Message[];
  /** When the user swiped-to-reply on an earlier message, surfaces it. */
  replyTo?: ReplyToRef | null;
};

export type AshleyReply = {
  reply: string;
  /**
   * Always null on the new two-call flow — kept for backward compatibility
   * with any older code paths. The image is fetched separately via
   * `fetchAshleySelfie(vibe, profile)` when `selfieVibe` is set.
   */
  imageUrl: string | null;
  /** When set, Ashley wants to send a selfie with this visual prompt. */
  selfieVibe: string | null;
};

export async function fetchAshleyReply(
  req: ChatReplyRequest,
): Promise<AshleyReply> {
  const base = getApiBase();
  const trimmedHistory = req.history.slice(-HISTORY_WINDOW).map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const memories = req.memories.map((m) => ({
    content: m.content,
    tag: m.tag,
    importance: m.importance,
  }));
  // Send oldest-first, capped, so the prompt has chronological narrative.
  const summaries = req.summaries
    .slice()
    .sort(
      (a, b) =>
        Date.parse(a.coveredThroughCreatedAt) -
        Date.parse(b.coveredThroughCreatedAt),
    )
    .slice(-MAX_SUMMARIES_IN_PROMPT)
    .map((s) => ({
      summary: s.summary,
      coveredThroughCreatedAt: s.coveredThroughCreatedAt,
    }));

  const res = await fetchWithProxyRetry(`${base}/chat/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: req.content,
      profile: req.profile,
      memories,
      summaries,
      history: trimmedHistory,
      // Only send a quoted-reply ref when one is set; the server treats it
      // as optional and will inject the quote into Claude's prompt.
      ...(req.replyTo
        ? {
            replyTo: {
              role: req.replyTo.role,
              preview: req.replyTo.preview,
            },
          }
        : {}),
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Ashley's brain returned ${res.status}${text ? `: ${text}` : ""}`,
    );
  }

  const data = (await res.json()) as {
    reply?: unknown;
    imageUrl?: unknown;
    selfieVibe?: unknown;
  };
  if (typeof data.reply !== "string" || !data.reply.trim()) {
    throw new Error("Ashley's brain returned an empty reply.");
  }
  const imageUrl =
    typeof data.imageUrl === "string" && data.imageUrl.trim().length > 0
      ? data.imageUrl
      : null;
  const selfieVibe =
    typeof data.selfieVibe === "string" && data.selfieVibe.trim().length > 0
      ? data.selfieVibe.trim()
      : null;
  return { reply: data.reply.trim(), imageUrl, selfieVibe };
}

/**
 * Stage-2 selfie fetch. Called after `fetchAshleyReply` returns a
 * `selfieVibe`. Uses a poll-based protocol because gpt-image-1 takes
 * 30–60s — holding a single HTTP connection open that long blows past
 * the Replit proxy / RN-fetch ~60s cap and causes spurious "Failed to
 * fetch" errors.
 *
 * Protocol:
 *   1. POST /chat/selfie         → returns {jobId} in <100ms
 *   2. GET  /chat/selfie/:jobId  → returns {status: "pending"|"ready"|"failed"}
 *      Poll every 2s until terminal. Each request is sub-second so the
 *      proxy timeout never matters.
 */

const SELFIE_POLL_INTERVAL_MS = 2000;
const SELFIE_POLL_TIMEOUT_MS = 120_000; // 2 minutes — gpt-image-1 worst case

export async function fetchAshleySelfie(
  vibe: string,
  profile: AshleyProfile,
): Promise<string> {
  const base = getApiBase();

  // 1. Kick off the job.
  const startRes = await fetchWithProxyRetry(`${base}/chat/selfie`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vibe, profile }),
  });
  if (!startRes.ok) {
    const text = await startRes.text().catch(() => "");
    throw new Error(
      `Selfie generation returned ${startRes.status}${text ? `: ${text}` : ""}`,
    );
  }
  const startData = (await startRes.json()) as { jobId?: unknown };
  if (typeof startData.jobId !== "string" || !startData.jobId.trim()) {
    throw new Error("Selfie generation didn't return a job id.");
  }
  const jobId = startData.jobId.trim();

  // 2. Poll for completion.
  const deadline = Date.now() + SELFIE_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, SELFIE_POLL_INTERVAL_MS),
    );
    const pollRes = await fetch(
      `${base}/chat/selfie/${encodeURIComponent(jobId)}`,
      { method: "GET" },
    );
    if (!pollRes.ok) {
      // 404 means the job was pruned (TTL expired) — treat as a fail and
      // bail out. Other 5xx are likely transient; one bad poll shouldn't
      // kill the loop, so just continue to the next interval.
      if (pollRes.status === 404) {
        throw new Error("Selfie job expired before it finished.");
      }
      continue;
    }
    const pollData = (await pollRes.json()) as {
      status?: unknown;
      imageUrl?: unknown;
      error?: unknown;
    };
    if (pollData.status === "ready") {
      if (typeof pollData.imageUrl !== "string" || !pollData.imageUrl.trim()) {
        throw new Error("Selfie was ready but no image URL was returned.");
      }
      return pollData.imageUrl.trim();
    }
    if (pollData.status === "failed") {
      const msg =
        typeof pollData.error === "string" && pollData.error.trim()
          ? pollData.error.trim()
          : "Selfie generation failed.";
      throw new Error(msg);
    }
    // status === "pending" → keep polling
  }
  throw new Error("Selfie took too long — try again.");
}

export type SummarizeChunkRequest = {
  messages: Message[];
  priorSummary?: string;
};

/**
 * Ask the server to condense a chunk of older messages into one
 * narrative paragraph. Returns the summary text.
 */
export async function fetchSummaryForChunk(
  req: SummarizeChunkRequest,
): Promise<string> {
  const base = getApiBase();
  const messages = req.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const res = await fetchWithProxyRetry(`${base}/chat/summarize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      ...(req.priorSummary ? { priorSummary: req.priorSummary } : {}),
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Summarizer returned ${res.status}${text ? `: ${text}` : ""}`,
    );
  }

  const data = (await res.json()) as { summary?: unknown };
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    throw new Error("Summarizer returned empty text.");
  }
  return data.summary.trim();
}
