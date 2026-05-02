import type { AshleyProfile, Memory, Message } from "./storage";

const HISTORY_WINDOW = 30;

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
  history: Message[];
};

export type AshleyReply = {
  reply: string;
  imageUrl: string | null;
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

  const res = await fetch(`${base}/chat/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: req.content,
      profile: req.profile,
      memories,
      history: trimmedHistory,
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
  };
  if (typeof data.reply !== "string" || !data.reply.trim()) {
    throw new Error("Ashley's brain returned an empty reply.");
  }
  const imageUrl =
    typeof data.imageUrl === "string" && data.imageUrl.trim().length > 0
      ? data.imageUrl
      : null;
  return { reply: data.reply.trim(), imageUrl };
}
