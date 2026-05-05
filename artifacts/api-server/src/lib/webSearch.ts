// Web search tool — Stage 1 (simplest working version per Kane's directive).
//
// Calls Tavily Search API server-side and returns trimmed results suitable
// for both the public POST /api/tools/web-search route and direct injection
// into Ashley's system prompt in /api/chat/stream.
//
// No native tool-use, no LLM classifier, no orchestration. A small
// keyword regex decides whether to search before each chat call; results
// are formatted as a "=== WEB RESULTS ===" block prepended to the system
// prompt so Ashley can use them naturally without leaking that a tool
// was invoked.

import { logger } from "./logger";

export type WebSearchResult = {
  title: string;
  url: string;
  content: string;
};

const TAVILY_URL = "https://api.tavily.com/search";
// Hard ceiling so a slow/dead provider can't stall the chat indefinitely.
// Web search is enrichment — if it can't deliver in 5s we'd rather Ashley
// reply without it than make the user wait.
const TAVILY_TIMEOUT_MS = 5000;
const MAX_QUERY_LEN = 500;
const MAX_RESULTS = 5;
// Snippet hard-cap per result so a verbose source doesn't blow up the
// system prompt token count.
const MAX_SNIPPET_LEN = 320;

// Trigger keywords/phrases per Kane's Stage 1 spec. Case-insensitive,
// word-boundary anchored where it matters so "today" doesn't fire on
// "todayish" and "what is" doesn't fire on "whatever".
const TRIGGER_REGEX =
  /\b(latest|today|news|prices?)\b|\bcurrent\s+info\b|\bwhat\s+is\b/i;

export function shouldTriggerWebSearch(userMessage: string): boolean {
  return TRIGGER_REGEX.test(userMessage);
}

export class WebSearchUnavailableError extends Error {
  constructor() {
    super("TAVILY_API_KEY is not set");
    this.name = "WebSearchUnavailableError";
  }
}

export class WebSearchProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSearchProviderError";
  }
}

/**
 * Call Tavily and return up to MAX_RESULTS simplified results.
 *
 * @throws WebSearchUnavailableError if TAVILY_API_KEY is unset/empty
 * @throws WebSearchProviderError    on any upstream/network/parse failure
 */
export async function tavilySearch(
  query: string,
): Promise<WebSearchResult[]> {
  const key = process.env["TAVILY_API_KEY"];
  if (!key || !key.trim()) {
    throw new WebSearchUnavailableError();
  }
  const trimmed = query.trim().slice(0, MAX_QUERY_LEN);
  if (!trimmed) return [];

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TAVILY_TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await fetch(TAVILY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        query: trimmed,
        search_depth: "basic",
        max_results: MAX_RESULTS,
      }),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const reason =
      err instanceof Error
        ? ac.signal.aborted
          ? `timed out after ${TAVILY_TIMEOUT_MS}ms`
          : err.message
        : "Tavily request failed";
    throw new WebSearchProviderError(reason);
  }
  clearTimeout(timer);

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new WebSearchProviderError(
      `Tavily returned ${resp.status}: ${body.slice(0, 200)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = await resp.json();
  } catch {
    throw new WebSearchProviderError("Tavily response was not JSON");
  }

  const rawResults =
    parsed &&
    typeof parsed === "object" &&
    "results" in parsed &&
    Array.isArray((parsed as { results: unknown }).results)
      ? ((parsed as { results: unknown[] }).results as unknown[])
      : [];

  const results: WebSearchResult[] = [];
  for (const r of rawResults) {
    if (!r || typeof r !== "object") continue;
    const obj = r as Record<string, unknown>;
    const title = typeof obj["title"] === "string" ? obj["title"].trim() : "";
    const url = typeof obj["url"] === "string" ? obj["url"].trim() : "";
    const content =
      typeof obj["content"] === "string" ? obj["content"].trim() : "";
    if (!title || !url) continue;
    results.push({
      title: title.slice(0, 200),
      url,
      content: content.slice(0, MAX_SNIPPET_LEN),
    });
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

/**
 * Format the results as a system-prompt block per Kane's spec:
 *
 *   === WEB RESULTS ===
 *   [1] Title – snippet (url)
 *   [2] ...
 *   ===================
 *
 * Plus a short instruction so Ashley uses the results naturally,
 * mentions sources casually by site/title, and doesn't leak that a
 * tool was invoked.
 */
export function formatWebResultsBlock(
  query: string,
  results: WebSearchResult[],
): string {
  if (results.length === 0) return "";
  const lines = results.map((r, i) => {
    const snippet = (r.content || r.title).replace(/\s+/g, " ").trim();
    return `[${i + 1}] ${r.title} – ${snippet} (${r.url})`;
  });
  // Framed as Ashley's own internal note (not as a system directive) to
  // avoid her meta-narrating the mechanism back to Kane. Six rules:
  // (1) no stale "I can't" preamble even if she said it in earlier turns;
  // (2) no meta-narration about "injection" / "context" / "test";
  // (3) signal the lookup ONCE in a natural human way; (4) never name
  // tools/APIs; (5) mention sources casually by site/title where it helps;
  // (6) admit honestly if the results don't actually answer the question.
  return [
    `I just ran a quick lookup for "${query}". Here's what came back — I read these and answer the question using them. To me this is just me looking something up, nothing exotic.`,
    ``,
    `Voice rules for this reply:`,
    `- I do NOT preface with "I can't check that", "I don't have internet access", "the route isn't built", "the key isn't connected", or anything similar. Even if I said something like that in an earlier turn in this conversation, that was outdated — I just looked this up, so I answer it.`,
    `- I do NOT meta-narrate the mechanism. I never say the results were "injected", "added to my context", that this is "a test", or describe my own prompt internals to Kane. To me this is simply me looking something up. If Kane sincerely asks how it works I can explain plainly, but I don't volunteer it mid-answer.`,
    `- Somewhere in my reply I signal the lookup ONCE in a natural, human way — "I just checked this…", "from what I'm seeing online…", "latest info shows…", or "looks like right now…". Pick whatever fits, don't repeat it. Never name tools, APIs, search engines, or "my database".`,
    `- I mention sources casually by site or title where it helps ("BBC says…", "Guardian's reporting…", "the Wikipedia page for X notes…").`,
    `- If the results don't actually answer the question, I say so honestly rather than making something up.`,
    ``,
    `=== WEB RESULTS ===`,
    ...lines,
    `===================`,
  ].join("\n");
}

/**
 * Convenience wrapper: shouldTriggerWebSearch + tavilySearch +
 * formatWebResultsBlock with full failure-safety.
 *
 * Returns either the formatted block (plus the raw results + query for
 * logging) or null. Logs but NEVER throws — web search is enrichment,
 * never a hard dependency for the chat path.
 */
export async function maybeRunWebLookup(userMessage: string): Promise<{
  block: string;
  results: WebSearchResult[];
  query: string;
} | null> {
  if (!shouldTriggerWebSearch(userMessage)) return null;
  const query = userMessage.trim().slice(0, MAX_QUERY_LEN);
  try {
    const results = await tavilySearch(query);
    if (results.length === 0) return null;
    return { block: formatWebResultsBlock(query, results), results, query };
  } catch (err) {
    if (err instanceof WebSearchUnavailableError) {
      logger.warn(
        "Web search trigger matched but TAVILY_API_KEY is not set; skipping",
      );
    } else {
      logger.error({ err }, "Web search failed; continuing without it");
    }
    return null;
  }
}
