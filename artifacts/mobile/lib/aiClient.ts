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
  // Prefer an explicit override so we can point the Expo Go app at the
  // deployed (production) api-server instead of the ephemeral dev workflow,
  // without changing any other code. Accepts either a full URL with scheme
  // or a bare hostname.
  const override = process.env.EXPO_PUBLIC_API_BASE;
  const raw = override && override.trim() ? override : process.env.EXPO_PUBLIC_DOMAIN;
  if (!raw) {
    throw new Error(
      "EXPO_PUBLIC_API_BASE / EXPO_PUBLIC_DOMAIN is not set; cannot reach Ashley's brain.",
    );
  }
  const cleaned = raw.replace(/\/+$/, "");
  // If the override already ends with /api, don't double-suffix.
  const hasApiSuffix = /\/api$/.test(cleaned);
  const withScheme =
    cleaned.startsWith("http://") || cleaned.startsWith("https://")
      ? cleaned
      : `https://${cleaned}`;
  return hasApiSuffix ? withScheme : `${withScheme}/api`;
}

/**
 * In Replit's dev environment the api-server is recycled by the workflow
 * runner roughly every 8-12 minutes. During the dead-window between the
 * old instance dying and the new one accepting connections, the public
 * proxy returns its "Run this app to see the results here." placeholder
 * HTML — typically with a 404 or 503 status.
 *
 * IMPORTANT: We empirically observed that during the dead-window
 * /api/healthz GETs can return 200 while concurrent POSTs to the same
 * server still get placeholder HTML — the Replit proxy seems to retry
 * GETs internally and/or refresh its upstream connection pool faster
 * for GETs than POSTs. So polling healthz as a "is the server back?"
 * signal is unreliable for POSTs and was producing false-positives
 * that triggered our friendly error even when the server was healthy.
 *
 * Strategy: retry the actual request itself every 2s up to a 30s
 * deadline. The api-server endpoints we wrap with this helper are all
 * idempotent (stateless Claude calls; no DB writes), so re-issuing a
 * POST that returned placeholder is safe — placeholder means the
 * request never reached api-server. Real 4xx/5xx JSON errors are
 * returned untouched so callers can surface the real error.
 */
const PROXY_PLACEHOLDER_MARKER = "Run this app to see the results here";
const RETRY_INTERVAL_MS = 2000;
const RETRY_DEADLINE_MS = 60_000;

/**
 * Build the headers our api-server requires on every authenticated route.
 * The key is shipped in the Expo bundle (EXPO_PUBLIC_API_KEY) — it's a basic
 * gate against random scrapers/abuse, not a true secret. Without a valid
 * Bearer the server returns 401.
 */
function authHeaders(): Record<string, string> {
  const key = process.env.EXPO_PUBLIC_API_KEY;
  if (!key) {
    throw new Error(
      "EXPO_PUBLIC_API_KEY is not set; the app can't talk to Ashley's server.",
    );
  }
  return { Authorization: `Bearer ${key}` };
}

function withAuth(init: RequestInit): RequestInit {
  return {
    ...init,
    headers: {
      ...authHeaders(),
      ...(init.headers as Record<string, string> | undefined),
    },
  };
}

async function fetchWithProxyRetry(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const finalInit = withAuth(init);
  const deadline = Date.now() + RETRY_DEADLINE_MS;
  let res = await fetch(url, finalInit);
  while (await looksLikeProxyPlaceholder(res)) {
    if (Date.now() >= deadline) {
      throw new Error(
        "Ashley's server is restarting — give it a few seconds and try again.",
      );
    }
    await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
    res = await fetch(url, finalInit);
  }
  return res;
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
// We count actual poll attempts instead of using a wall-clock deadline.
// On Android, when the user locks the phone or backgrounds the app while
// waiting for a selfie, JS setTimeouts stop firing but `Date.now()` keeps
// advancing. A wall-clock deadline therefore expires silently with zero
// polls executed, and the user comes back to a "couldn't send the photo"
// error even though the server has the image ready. Counting attempts
// makes the loop survive arbitrary background pauses — when the JS thread
// resumes, we still have all our polling budget left.
const SELFIE_POLL_MAX_ATTEMPTS = 90; // ~3 min of foregrounded polling

async function startSelfieJob(
  base: string,
  vibe: string,
  profile: AshleyProfile,
): Promise<string> {
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
  return startData.jobId.trim();
}

export async function fetchAshleySelfie(
  vibe: string,
  profile: AshleyProfile,
): Promise<string> {
  const base = getApiBase();

  // 1. Kick off the job.
  let jobId = await startSelfieJob(base, vibe, profile);
  // The original POST might have landed on a server that died milliseconds
  // later (Replit dev cycles), in which case our jobId is unknown to the
  // restarted server and the first poll comes back 404. Re-POST up to twice
  // before surfacing an "expired" error to the user — covers the case
  // where the server cycles twice in quick succession during a single
  // generation. Capped to avoid loops if the server is genuinely broken.
  let restartsLeft = 2;

  // 2. Poll for completion.
  //
  // We're defensive here: gpt-image-1 takes 30-60s, the proxy/mobile network
  // can be flaky, and individual polls failing (network errors, transient
  // 5xx, even unexpectedly empty 304 bodies if any layer adds caching back)
  // must NOT abort the whole flow. Only an explicit terminal status from the
  // server (or a second 404 after a re-POST) ends the loop early.
  for (let attempt = 0; attempt < SELFIE_POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) =>
      setTimeout(resolve, SELFIE_POLL_INTERVAL_MS),
    );

    let pollRes: Response;
    try {
      pollRes = await fetch(
        `${base}/chat/selfie/${encodeURIComponent(jobId)}`,
        {
          method: "GET",
          headers: {
            ...authHeaders(),
            // Belt-and-suspenders: tell every cache layer not to revalidate
            // with conditional requests, so we always get a fresh body.
            "Cache-Control": "no-cache",
          },
        },
      );
    } catch {
      // Network blip — try again next interval.
      continue;
    }

    // 404 = job lost (server restart between POST and GET, or TTL prune).
    // Re-issue the POST once with a fresh jobId; only fail terminally if it
    // happens twice in a row.
    if (pollRes.status === 404) {
      if (restartsLeft > 0) {
        restartsLeft -= 1;
        try {
          jobId = await startSelfieJob(base, vibe, profile);
          continue;
        } catch {
          // POST itself failed — treat as transient and let the deadline
          // ultimately bail.
          continue;
        }
      }
      throw new Error("Selfie job expired before it finished.");
    }
    // Any other non-2xx (502/503/504/304-with-empty-body/etc.) — keep polling.
    if (!pollRes.ok) continue;

    let pollData: { status?: unknown; imageUrl?: unknown; error?: unknown };
    try {
      pollData = (await pollRes.json()) as typeof pollData;
    } catch {
      // Empty or malformed body. Don't bail — try again.
      continue;
    }

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
