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
//
// Coverage notes:
//   - Single-word triggers fire on common "fresh info" topics: news,
//     latest, today, weather, forecast, prices, stocks, scores,
//     currently, happening.
//   - Multi-word phrases catch the natural-question shapes: "what is",
//     "what's" / "whats" (contractions), "current info", "right now".
//   - We accept some false positives (e.g. "what's for dinner" fires a
//     useless lookup) — they're cheap and Ashley is instructed to
//     answer honestly if the results don't fit.
const TRIGGER_REGEX =
  /\b(latest|today|news|prices?|weather|forecast|currently|happening|stocks?|scores?)\b|\bcurrent\s+info\b|\bwhat\s+is\b|\bwhat'?s\b|\bright\s+now\b/i;

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

// Shared self-awareness rule used by every WEB LOOKUP status block, so
// Ashley's tone of any meta-comment is consistent across success / empty /
// failed / unavailable. ON = brief technical phrasing OK, OFF = human-facing
// only ("I just checked", "I tried to check") with no tooling vocabulary.
function selfAwareRuleFor(builderAware: boolean): string {
  return builderAware
    ? `- Self-aware notes are welcome since Builder-Aware Mode is ON, but keep them BRIEF and AFTER the answer, not before. One short line is plenty. Skip the note entirely if it would be redundant. No long debrief tails unless Kane is clearly testing or building right now.`
    : `- Builder-Aware Mode is OFF, so I keep any acknowledgement human-facing — phrases like "I just checked this", "I tried to check that", "I can't check the web right now" are fine. I do NOT name internal tooling, search providers, "context", "injection", "Tavily", or "the lookup mechanism" in this mode.`;
}

/**
 * Format a WEB LOOKUP: results block per Kane's spec:
 *
 *   === WEB LOOKUP: results ===
 *   [1] Title – snippet (url)
 *   [2] ...
 *   === END LOOKUP ===
 *
 * Plus instructions so Ashley uses the results naturally, mentions
 * sources casually by site/title, and doesn't leak that a tool was
 * invoked.
 */
export function formatWebResultsBlock(
  query: string,
  results: WebSearchResult[],
  builderAware: boolean,
): string {
  if (results.length === 0) return "";
  const lines = results.map((r, i) => {
    const snippet = (r.content || r.title).replace(/\s+/g, " ").trim();
    return `[${i + 1}] ${r.title} – ${snippet} (${r.url})`;
  });

  return [
    `I just ran a quick lookup for "${query}". Here's what came back — I read these and answer Kane's question using them.`,
    ``,
    `Voice rules for this reply:`,
    `- ANSWER FIRST. The user's question is the priority — I open with the answer, not with commentary about how I got it.`,
    `- I do NOT preface with "I can't check that", "I don't have internet access", "the route isn't built", "the key isn't connected", or anything similar. Even if I said something like that in an earlier turn, that was outdated — I just looked this up, so I answer it.`,
    `- Somewhere in my reply I signal the lookup ONCE in a natural way — pick something that fits the tone (see below), don't repeat it, don't force a specific phrase.`,
    `- I mention sources casually by site or title where it helps ("BBC says…", "Guardian's reporting…", "the Wikipedia page for X notes…").`,
    `- If the results don't actually answer the question, I say so honestly rather than making something up.`,
    selfAwareRuleFor(builderAware),
    `- Core principle: self-aware, not self-distracting. I never over-explain the mechanism unless Kane sincerely asks how something works.`,
    ``,
    `=== WEB LOOKUP: results ===`,
    ...lines,
    `=== END LOOKUP ===`,
  ].join("\n");
}

/**
 * Format a WEB LOOKUP status block for the non-success cases. This is the
 * fix for the "I can't tell when the lookup didn't deliver" problem — every
 * trigger-fired turn now carries an explicit status block so Ashley never
 * has to guess (and never silently fabricates fresh facts).
 *
 *   === WEB LOOKUP: <kind> ===
 *   <kind-specific note>
 *   === END LOOKUP ===
 */
export type WebLookupStatusKind = "empty" | "failed" | "unavailable";

export function formatWebStatusBlock(
  query: string,
  kind: WebLookupStatusKind,
  builderAware: boolean,
): string {
  // Note: the underlying error `reason` (provider name, HTTP code, etc.) is
  // intentionally NOT injected into the prompt. It would leak technical /
  // provider vocabulary into Ashley's reply, contradicting the block's own
  // "do NOT name the provider" rule (and the Builder-Aware OFF voice rule).
  // Reasons live in the server logs only. The prompt stays generic.
  let header: string;
  let summary: string;
  let phrasing: string;
  let footer: string;

  switch (kind) {
    case "empty":
      header = "=== WEB LOOKUP: empty ===";
      summary = `I just ran a quick lookup for "${query}". The search ran but came back with nothing useful for this question.`;
      phrasing = `- Acknowledge once, briefly, that I looked and nothing useful came back. Examples: "I just checked and nothing useful came back", "I had a look and the search came up empty on that one". Pick one, don't repeat it.`;
      footer = "(no results)";
      break;
    case "failed":
      header = "=== WEB LOOKUP: failed ===";
      summary = `I just attempted a lookup for "${query}". The lookup itself did not come back this turn.`;
      phrasing = `- Acknowledge once, briefly, that the lookup didn't come back. Examples: "I tried to check that and the lookup didn't come back", "had a go at looking it up but the search didn't reach me". Pick one, don't repeat it. Do NOT name the provider or the error.`;
      footer = "(lookup did not return)";
      break;
    case "unavailable":
      header = "=== WEB LOOKUP: unavailable ===";
      summary = `I would have looked up "${query}" for this turn, but web search isn't configured on this server right now.`;
      phrasing = `- Acknowledge once, briefly, that I can't check the web on this turn. Examples: "I can't check the web here right now", "web lookup isn't available on this turn for me". Pick one, don't repeat it.`;
      footer = "(web search not configured on this server)";
      break;
  }

  return [
    summary,
    ``,
    `Voice rules for this reply:`,
    `- ANSWER from what I already know. I do NOT fabricate fresh facts (today's news, current prices, live events). If the question genuinely needs fresh info I don't have, I say so honestly and offer to retry if Kane rephrases.`,
    `- I FLAG STALENESS when relevant. If I'm answering from training and the answer might have changed, I mark that briefly ("this might be out of date", "as of when I last knew").`,
    phrasing,
    selfAwareRuleFor(builderAware),
    `- Core principle: honesty before completeness. Better to say "I don't know right now" than to invent a fact.`,
    ``,
    header,
    footer,
    `=== END LOOKUP ===`,
  ].join("\n");
}

/**
 * Discriminated outcome of an attempted web lookup. All four shapes carry
 * a `block` ready to inject into the system prompt. The chat path treats
 * them uniformly: if `maybeRunWebLookup` returns non-null, append `block`.
 *
 * `null` is reserved for the "trigger did not fire" case — section 9 of
 * the Core Spec tells Ashley what to do then (don't fabricate fresh facts).
 */
export type WebLookupOutcome =
  | { kind: "success"; block: string; results: WebSearchResult[]; query: string }
  | { kind: "empty"; block: string; query: string }
  | { kind: "failed"; block: string; query: string; reason: string }
  | { kind: "unavailable"; block: string; query: string };

/**
 * Convenience wrapper: shouldTriggerWebSearch + tavilySearch +
 * formatWebResultsBlock / formatWebStatusBlock with full failure-safety.
 *
 * Returns a discriminated outcome (success/empty/failed/unavailable) when
 * the trigger heuristic fires, or null when it doesn't. Logs but NEVER
 * throws — web search is enrichment, never a hard dependency for the chat
 * path. The non-success outcomes still produce a block so Ashley always
 * knows what happened (the fix for the "silent failure" problem).
 */
export async function maybeRunWebLookup(
  userMessage: string,
  builderAware: boolean,
): Promise<WebLookupOutcome | null> {
  if (!shouldTriggerWebSearch(userMessage)) return null;
  const query = userMessage.trim().slice(0, MAX_QUERY_LEN);
  if (!query) return null;
  try {
    const results = await tavilySearch(query);
    if (results.length === 0) {
      return {
        kind: "empty",
        block: formatWebStatusBlock(query, "empty", builderAware),
        query,
      };
    }
    return {
      kind: "success",
      block: formatWebResultsBlock(query, results, builderAware),
      results,
      query,
    };
  } catch (err) {
    if (err instanceof WebSearchUnavailableError) {
      logger.warn(
        "Web search trigger matched but TAVILY_API_KEY is not set; injecting unavailable block",
      );
      return {
        kind: "unavailable",
        block: formatWebStatusBlock(query, "unavailable", builderAware),
        query,
      };
    }
    const reason =
      err instanceof WebSearchProviderError
        ? err.message
        : err instanceof Error
          ? err.message
          : "unknown error";
    logger.error(
      { err },
      "Web search failed; injecting failed block so Ashley can acknowledge",
    );
    return {
      kind: "failed",
      block: formatWebStatusBlock(query, "failed", builderAware),
      query,
      reason,
    };
  }
}
