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

  const res = await fetch(`${base}/chat/reply`, {
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
 * `selfieVibe`. The server runs gpt-image-1 (10–60s) and uploads the
 * resulting PNG, then returns the absolute URL. Slow-by-design; kept on
 * its own request so it doesn't share a fetch timeout with the chat reply.
 */
export async function fetchAshleySelfie(
  vibe: string,
  profile: AshleyProfile,
): Promise<string> {
  const base = getApiBase();
  const res = await fetch(`${base}/chat/selfie`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vibe, profile }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Selfie generation returned ${res.status}${text ? `: ${text}` : ""}`,
    );
  }
  const data = (await res.json()) as { imageUrl?: unknown };
  if (typeof data.imageUrl !== "string" || !data.imageUrl.trim()) {
    throw new Error("Selfie generation returned no image URL.");
  }
  return data.imageUrl.trim();
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
  const res = await fetch(`${base}/chat/summarize`, {
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
