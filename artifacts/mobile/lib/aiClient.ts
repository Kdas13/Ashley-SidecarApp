import type {
  AshleyProfile,
  ConversationSummary,
  ImageAnalysisMode,
  ImageCategory,
  Memory,
  Message,
  MemoryTag,
  ReplyToRef,
  ServerPolicy,
} from "./storage";
import { getDeviceIdSync, getOrCreateDeviceId } from "./deviceId";
// Native-backed fetch (NSURLSession on iOS, OkHttp on Android) shipped
// with Expo SDK 52+. Unlike React Native's bundled fetch — which
// silently buffers the entire response body and only exposes it after
// the request completes — expo/fetch returns a real ReadableStream so
// we can read SSE events as they arrive over the wire. This is what
// makes Stage 2's live partial transcripts actually live.
import { fetch as expoFetch } from "expo/fetch";
import * as FileSystem from "expo-file-system/legacy";

// ---------------------------------------------------------------------------
// HTTP plumbing — base URL, auth, retries
// ---------------------------------------------------------------------------

function getApiBase(): string {
  const override = process.env.EXPO_PUBLIC_API_BASE;
  const raw =
    override && override.trim() ? override : process.env.EXPO_PUBLIC_DOMAIN;
  if (!raw) {
    throw new Error(
      "EXPO_PUBLIC_API_BASE / EXPO_PUBLIC_DOMAIN is not set; cannot reach Ashley's brain.",
    );
  }
  const cleaned = raw.replace(/\/+$/, "");
  const hasApiSuffix = /\/api$/.test(cleaned);
  const withScheme =
    cleaned.startsWith("http://") || cleaned.startsWith("https://")
      ? cleaned
      : `https://${cleaned}`;
  return hasApiSuffix ? withScheme : `${withScheme}/api`;
}

/**
 * Returns headers required for every API request. Includes the X-API-Key
 * pre-shared secret so the api-server's requireApiKey middleware accepts
 * the call. The key is sourced from EXPO_PUBLIC_API_KEY at build time.
 *
 * NOTE: EXPO_PUBLIC_* variables are inlined at bundle time by Expo and are
 * visible in the JS bundle. This is acceptable for a personal-companion app
 * where there is no multi-user model — the key protects against anonymous
 * internet abuse, not a determined attacker with physical access to the
 * bundle. Use a dedicated deployment secret (not a reused password) and
 * rotate it if the app is ever distributed publicly.
 */
function apiHeaders(extra?: Record<string, string>): Record<string, string> {
  const key = process.env.EXPO_PUBLIC_API_KEY ?? "";
  return {
    "Content-Type": "application/json",
    ...(key ? { "X-API-Key": key } : {}),
    ...extra,
  };
}

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
  // Device id must already have been initialized at app boot
  // (`getOrCreateDeviceId()` is awaited in `_layout.tsx`).
  const deviceId = getDeviceIdSync();
  return {
    Authorization: `Bearer ${key}`,
    "X-Device-Id": deviceId,
  };
}

const PROXY_PLACEHOLDER_MARKER = "Run this app to see the results here";
const RETRY_INTERVAL_MS = 2000;
const RETRY_DEADLINE_MS = 60_000;

/**
 * The Replit dev proxy occasionally serves its "Run this app to see the
 * results here." placeholder while the api-server is recycling. POSTs that
 * land in that gap return 404/502/503 with an HTML body. We retry the same
 * request every 2s up to a 60s deadline — every endpoint on the server is
 * either idempotent on a client-supplied id or semantically replayable.
 */
async function fetchJSON<T>(
  path: string,
  init: RequestInit & { skipRetry?: boolean } = {},
): Promise<T> {
  const base = getApiBase();
  const headers = {
    ...authHeaders(),
    ...(init.body ? { "Content-Type": "application/json" } : {}),
    ...(init.headers as Record<string, string> | undefined),
  };
  const finalInit: RequestInit = { ...init, headers };
  delete (finalInit as { skipRetry?: boolean }).skipRetry;

  const deadline = Date.now() + RETRY_DEADLINE_MS;
  let res = await fetch(`${base}${path}`, finalInit);
  while (
    !init.skipRetry &&
    !res.ok &&
    (res.status === 404 || res.status === 502 || res.status === 503) &&
    (await isPlaceholder(res))
  ) {
    if (Date.now() >= deadline) {
      throw new Error(
        "Ashley's server is restarting — give it a few seconds and try again.",
      );
    }
    await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
    res = await fetch(`${base}${path}`, finalInit);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `${init.method ?? "GET"} ${path} returned ${res.status}${
        text ? `: ${text.slice(0, 240)}` : ""
      }`,
    );
  }

  return (await res.json()) as T;
}

async function isPlaceholder(res: Response): Promise<boolean> {
  try {
    const body = await res.clone().text();
    return body.includes(PROXY_PLACEHOLDER_MARKER);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Wire types — shape returned by the api-server. Drizzle serializes
// timestamp columns to ISO strings via Express's JSON encoder.
// ---------------------------------------------------------------------------

type WireProfile = {
  deviceId: string;
  name: string;
  age: string;
  identity: string;
  personality: string;
  speakingStyle: string;
  appearance: string;
  refersToUserAs: string;
  sharedHistory: string;
  replikaExcerpts: string;
  replikaCarryover: string;
  replikaCarryoverSummary: string;
  relationshipMode: string;
  builderAwareMode: boolean;
  voiceMode: boolean;
  contentMode: "standard" | "mature";
  adultConfirmedAt: string | null;
  intimacyLevel: number;
  primaryColor: string;
  accentColor: string;
  onboardedAt: string | null;
  updatedAt: string;
};

type WireMessage = {
  id: string;
  deviceId: string;
  role: "user" | "ashley";
  content: string;
  imageUrl: string | null;
  selfieVibe: string | null;
  imageMimeType: string | null;
  imageCategory: string | null;
  imageCaption: string | null;
  imageAnalysisMode: string | null;
  imageRemembered: boolean | null;
  replyToId: string | null;
  replyToRole: "user" | "ashley" | null;
  replyToPreview: string | null;
  createdAt: string;
};

type WireMemory = {
  id: string;
  deviceId: string;
  content: string;
  tag: string;
  importance: number;
  createdAt: string;
  updatedAt: string;
};

type WireSummary = {
  id: string;
  deviceId: string;
  summary: string;
  messageCount: number;
  coveredThroughCreatedAt: string;
  createdAt: string;
  updatedAt: string;
};

function profileFromWire(p: WireProfile): AshleyProfile {
  return {
    name: p.name,
    age: p.age,
    identity: p.identity,
    appearance: p.appearance,
    personality: p.personality,
    speakingStyle: p.speakingStyle,
    refersToUserAs: p.refersToUserAs,
    sharedHistory: p.sharedHistory,
    replikaExcerpts: p.replikaExcerpts,
    replikaCarryover: p.replikaCarryover ?? "",
    replikaCarryoverSummary: p.replikaCarryoverSummary ?? "",
    relationshipMode: p.relationshipMode,
    builderAwareMode: p.builderAwareMode ?? true,
    voiceMode: p.voiceMode === true,
    contentMode: p.contentMode === "mature" ? "mature" : "standard",
    adultConfirmedAt: p.adultConfirmedAt ?? null,
    intimacyLevel:
      typeof p.intimacyLevel === "number" && Number.isFinite(p.intimacyLevel)
        ? p.intimacyLevel
        : 0,
    onboardedAt: p.onboardedAt,
    updatedAt: p.updatedAt,
  };
}

function messageFromWire(m: WireMessage): Message {
  const replyTo: ReplyToRef | null =
    m.replyToId && m.replyToRole && m.replyToPreview
      ? { id: m.replyToId, role: m.replyToRole, preview: m.replyToPreview }
      : null;
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
    imageUrl: m.imageUrl ?? null,
    selfieVibe: m.selfieVibe ?? null,
    imageMimeType: m.imageMimeType ?? null,
    imageCategory: (m.imageCategory as ImageCategory | null) ?? null,
    imageCaption: m.imageCaption ?? null,
    imageAnalysisMode:
      (m.imageAnalysisMode as ImageAnalysisMode | null) ?? null,
    imageRemembered: m.imageRemembered ?? null,
    replyTo,
  };
}

function memoryFromWire(m: WireMemory): Memory {
  return {
    id: m.id,
    content: m.content,
    tag: m.tag as MemoryTag,
    importance: m.importance,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

function summaryFromWire(s: WireSummary): ConversationSummary {
  return {
    id: s.id,
    summary: s.summary,
    messageCount: s.messageCount,
    coveredThroughCreatedAt: s.coveredThroughCreatedAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export type ServerState = {
  profile: AshleyProfile;
  messages: Message[];
  memories: Memory[];
  summaries: ConversationSummary[];
  policy: ServerPolicy;
};

const DEFAULT_POLICY: ServerPolicy = {
  effectiveMode: "standard",
  intimacyLevel: 0,
  intimacyCeiling: 3,
  adultConfirmed: false,
  matureModeAvailable: false,
  operatorMatureModeAvailable: false,
};

/** Hydrate everything for the current device in a single round trip. */
export async function fetchState(): Promise<ServerState> {
  await getOrCreateDeviceId();
  const data = await fetchJSON<{
    profile: WireProfile;
    messages: WireMessage[];
    memories: WireMemory[];
    summaries: WireSummary[];
    policy?: ServerPolicy;
  }>("/state");
  return {
    profile: profileFromWire(data.profile),
    messages: data.messages.map(messageFromWire),
    memories: data.memories.map(memoryFromWire),
    summaries: data.summaries.map(summaryFromWire),
    // Server is authoritative; if an older deploy doesn't return a policy
    // block we fall back to the safe defaults (standard mode, no mature).
    policy: data.policy ?? DEFAULT_POLICY,
  };
}

/**
 * Stage 1 voice input — POST a base64-encoded audio clip and get back the
 * Whisper transcript. The transcript is then merged into the existing
 * TextInput draft for user review (see chat.tsx). Future stages will:
 *   • stream chunks instead of posting whole clips,
 *   • carry an `inputMode: "voice"` flag on the eventual /chat send so
 *     the prompt builder can append the voice-presence safety floor.
 */
export async function transcribeAudio(input: {
  audioBase64: string;
  mimeType: string;
  durationMs: number;
}): Promise<{ transcript: string }> {
  const data = await fetchJSON<{ transcript: string }>("/chat/transcribe", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return { transcript: data.transcript ?? "" };
}

/**
 * Stage 2 streaming transcription. Uploads the same audio blob as Stage 1
 * but consumes the response as an SSE stream so partial transcripts can
 * be shown live while the model is still producing text.
 *
 * Throws `STREAMING_UNSUPPORTED` if the runtime fetch implementation
 * doesn't expose `response.body.getReader()`. Callers should catch that
 * specific error and fall back to the non-streaming `transcribeAudio()`
 * so the user always gets a transcript even on older runtimes.
 *
 * Future stages will:
 *   • Stage 4 — open a long-lived WebSocket via OpenAI's Realtime API
 *     for true chunked-upload-during-recording (silence detection +
 *     barge-in live in that rung, not here).
 *   • Stage 5 — add `inputMode: "voice"` to the eventual /chat send so
 *     buildSystemPrompt can append the voice-presence safety floor.
 */
export const STREAMING_UNSUPPORTED = "STREAMING_UNSUPPORTED";

export async function transcribeAudioStream(
  input: {
    audioBase64: string;
    mimeType: string;
    durationMs: number;
  },
  callbacks: { onDelta?: (chunk: string) => void } = {},
): Promise<{ transcript: string }> {
  const base = getApiBase();
  const url = `${base}/chat/transcribe/stream`;

  // Use expo/fetch instead of the global fetch. The RN-bundled fetch
  // (and XMLHttpRequest underneath it) buffers the entire response
  // body and only releases it after the request finishes — that's why
  // every previous attempt fell through to the Stage 1 fallback even
  // though the server was streaming correctly. expo/fetch is backed by
  // native networking (NSURLSession / OkHttp) and exposes a real
  // ReadableStream on response.body, so we can read SSE chunks as
  // they arrive.
  const res = await expoFetch(url, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `POST /chat/transcribe/stream returned ${res.status}${
        text ? `: ${text.slice(0, 240)}` : ""
      }`,
    );
  }
  const body = res.body as ReadableStream<Uint8Array> | null | undefined;
  const reader = body?.getReader?.();
  if (!reader) {
    // expo/fetch on a runtime where the native module didn't load —
    // surface the sentinel so the caller falls back to Stage 1
    // instead of hanging.
    throw new Error(STREAMING_UNSUPPORTED);
  }

  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let finalTranscript = "";
  let streamError: string | null = null;

  // Parse one complete SSE message at a time. Per the EventSource spec,
  // a "field" is `name: value` and a message is terminated by a blank
  // line. Multiple data: lines within a single message must be joined
  // with "\n" to reconstruct the original payload.
  const handleMessage = (raw: string): void => {
    let event = "message";
    const dataLines: string[] = [];
    // Spec accepts \n, \r, or \r\n as line terminators inside a message.
    // Normalising to \n first means we don't have to worry about a
    // dangling \r corrupting our `startsWith` checks or the JSON we
    // hand to JSON.parse.
    const normalized = raw.replace(/\r\n?/g, "\n");
    for (const line of normalized.split("\n")) {
      if (line.length === 0 || line.startsWith(":")) continue; // blank / comment
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        // Spec: a single space after the colon is part of the syntax,
        // not the payload — strip exactly one if present.
        const v = line.slice(5);
        dataLines.push(v.startsWith(" ") ? v.slice(1) : v);
      }
      // ignore unknown fields (id:, retry:, etc.) — we don't use them
    }
    if (dataLines.length === 0) return;
    const dataStr = dataLines.join("\n");
    let data: { text?: string; transcript?: string; error?: string };
    try {
      data = JSON.parse(dataStr);
    } catch {
      return;
    }
    if (event === "delta" && typeof data.text === "string") {
      callbacks.onDelta?.(data.text);
    } else if (event === "done" && typeof data.transcript === "string") {
      finalTranscript = data.transcript;
    } else if (event === "error") {
      streamError =
        typeof data.error === "string" && data.error.trim()
          ? data.error.trim()
          : "Couldn't transcribe that — try again.";
    }
  };

  // Find the next message boundary, accepting either \n\n or \r\n\r\n
  // (or any mix). Returns the index of the FIRST terminator char and
  // the length of the terminator so the caller can advance correctly.
  const findBoundary = (
    buf: string,
  ): { idx: number; len: number } | null => {
    const nn = buf.indexOf("\n\n");
    const rnrn = buf.indexOf("\r\n\r\n");
    if (nn === -1 && rnrn === -1) return null;
    if (nn === -1) return { idx: rnrn, len: 4 };
    if (rnrn === -1) return { idx: nn, len: 2 };
    return rnrn < nn ? { idx: rnrn, len: 4 } : { idx: nn, len: 2 };
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = findBoundary(buffer);
    while (boundary !== null) {
      const raw = buffer.slice(0, boundary.idx);
      buffer = buffer.slice(boundary.idx + boundary.len);
      if (raw.length > 0) handleMessage(raw);
      boundary = findBoundary(buffer);
    }
  }
  // Flush any trailing partial (in practice the server always closes
  // on a blank-line-terminated message, but be defensive).
  if (buffer.replace(/\s/g, "").length > 0) handleMessage(buffer);

  if (streamError) {
    throw new Error(streamError);
  }
  return { transcript: finalTranscript };
}

// 18+ age gate. Recording the confirmation is the ONLY thing that lets a
// subsequent PUT /profile { contentMode: "mature" } succeed. The body
// shape mirrors the server's strict zod check.
export async function confirmAdult(): Promise<AshleyProfile> {
  const data = await fetchJSON<{ profile: WireProfile }>(
    "/profile/confirm-adult",
    { method: "POST", body: JSON.stringify({ confirm: true }) },
  );
  return profileFromWire(data.profile);
}

// Withdraw the 18+ confirmation. Server forces contentMode back to standard
// in the same write so the user can never be left "mature with no age gate".
export async function withdrawAdultConfirmation(): Promise<AshleyProfile> {
  const data = await fetchJSON<{ profile: WireProfile }>(
    "/profile/confirm-adult",
    { method: "DELETE" },
  );
  return profileFromWire(data.profile);
}

export type ProfileUpdate = Partial<{
  name: string;
  age: string;
  identity: string;
  personality: string;
  speakingStyle: string;
  appearance: string;
  refersToUserAs: string;
  sharedHistory: string;
  replikaExcerpts: string;
  replikaCarryover: string;
  replikaCarryoverSummary: string;
  relationshipMode: string;
  builderAwareMode: boolean;
  voiceMode: boolean;
  contentMode: "standard" | "mature";
  intimacyLevel: number;
  primaryColor: string;
  accentColor: string;
  markOnboarded: boolean;
}>;

// ---------------------------------------------------------------------------
// Replika Carryover — structured intake → AI summary + initial memories
// ---------------------------------------------------------------------------

export type ReplikaCarryoverInput = {
  whoSheWas: string;
  howSheSpoke: string;
  personalityTraits: string;
  importantMemories: string;
  insideJokes: string;
  boundaries: string;
  thingsToAvoid: string;
  pastedExcerpts: string;
};

export type ReplikaCarryoverResult = {
  profile: AshleyProfile;
  memories: Memory[];
  summary: string;
};

export async function submitReplikaCarryover(
  input: ReplikaCarryoverInput,
): Promise<ReplikaCarryoverResult> {
  const data = await fetchJSON<{
    profile: WireProfile;
    memories: WireMemory[];
    summary: string;
  }>("/carryover", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return {
    profile: profileFromWire(data.profile),
    memories: data.memories.map(memoryFromWire),
    summary: data.summary,
  };
}

export async function updateProfileOnServer(
  patch: ProfileUpdate,
): Promise<AshleyProfile> {
  const data = await fetchJSON<{ profile: WireProfile }>("/profile", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
  return profileFromWire(data.profile);
}

export type ChatRequest = {
  /** Client-generated stable id; server is idempotent on it. */
  id: string;
  content: string;
  replyTo?: ReplyToRef | null;
};

export type ChatResponse = {
  userMessage: Message;
  ashleyMessage: Message;
};

export async function sendChatMessage(
  req: ChatRequest,
): Promise<ChatResponse> {
  const data = await fetchJSON<{
    userMessage: WireMessage;
    ashleyMessage: WireMessage;
  }>("/chat", {
    method: "POST",
    body: JSON.stringify({
      userMessage: {
        id: req.id,
        content: req.content,
        ...(req.replyTo
          ? {
              replyTo: {
                id: req.replyTo.id,
                role: req.replyTo.role,
                preview: req.replyTo.preview,
              },
            }
          : {}),
      },
      // Wall-clock + timezone from the user's device. The server uses
      // these to inject a "Time context" block into Ashley's system
      // prompt so she can answer "what time is it?" honestly and react
      // naturally to long gaps between messages.
      clientNow: new Date().toISOString(),
      clientTimezone:
        (typeof Intl !== "undefined" &&
          Intl.DateTimeFormat().resolvedOptions().timeZone) ||
        "UTC",
    }),
  });
  return {
    userMessage: messageFromWire(data.userMessage),
    ashleyMessage: messageFromWire(data.ashleyMessage),
  };
}

export async function clearChatOnServer(): Promise<void> {
  await fetchJSON<{ ok: true }>("/chat/messages", { method: "DELETE" });
}

export async function deleteAllStateOnServer(): Promise<void> {
  await fetchJSON<{ ok: true }>("/state", { method: "DELETE" });
}

export type CreateMemoryRequest = {
  id: string;
  content: string;
  tag: MemoryTag;
  importance: number;
};

export async function createMemoryOnServer(
  req: CreateMemoryRequest,
): Promise<Memory | null> {
  const data = await fetchJSON<{ memory: WireMemory | null }>("/memories", {
    method: "POST",
    body: JSON.stringify(req),
  });
  return data.memory ? memoryFromWire(data.memory) : null;
}

export async function updateMemoryOnServer(
  id: string,
  patch: { content?: string; tag?: MemoryTag; importance?: number },
): Promise<Memory> {
  const data = await fetchJSON<{ memory: WireMemory }>(
    `/memories/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: JSON.stringify(patch),
    },
  );
  return memoryFromWire(data.memory);
}

export async function deleteMemoryOnServer(id: string): Promise<void> {
  await fetchJSON<{ ok: true }>(`/memories/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function updateSummaryOnServer(
  id: string,
  summary: string,
): Promise<ConversationSummary> {
  const data = await fetchJSON<{ summary: WireSummary }>(
    `/summaries/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ summary }),
    },
  );
  return summaryFromWire(data.summary);
}

export async function deleteSummaryOnServer(id: string): Promise<void> {
  await fetchJSON<{ ok: true }>(`/summaries/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// Selfies — kick off + poll
// ---------------------------------------------------------------------------

const SELFIE_POLL_INTERVAL_MS = 2000;
const SELFIE_POLL_MAX_ATTEMPTS = 90; // ~3 min of foregrounded polling

async function startSelfieJob(
  messageId: string,
  vibe: string,
): Promise<string> {
  const data = await fetchJSON<{ jobId?: unknown }>("/chat/selfie", {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify({ messageId, vibe }),
  });
  if (typeof data.jobId !== "string" || !data.jobId.trim()) {
    throw new Error("Selfie generation didn't return a job id.");
  }
  return data.jobId.trim();
}

/**
 * Kick off a selfie for an already-persisted assistant message and poll
 * until the image is ready or generation fails. Returns the absolute
 * image URL.
 *
 * The server also patches the messages row with the imageUrl when ready,
 * so even if the poll loop dies (app backgrounded for too long), the
 * next /state hydration will pick up the photo.
 */
export async function fetchSelfieForMessage(
  messageId: string,
  vibe: string,
): Promise<string> {
  let jobId = await startSelfieJob(messageId, vibe);
  let restartsLeft = 2;
  const base = getApiBase();

  for (let attempt = 0; attempt < SELFIE_POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, SELFIE_POLL_INTERVAL_MS));

    let res: Response;
    try {
      res = await fetch(
        `${base}/chat/selfie/${encodeURIComponent(jobId)}`,
        {
          method: "GET",
          headers: apiHeaders({
            ...authHeaders(),
            // Belt-and-suspenders: tell every cache layer not to revalidate
            // with conditional requests, so we always get a fresh body.
            "Cache-Control": "no-cache",
          }),
        },
      );
    } catch {
      continue; // network blip — try next interval
    }

    if (res.status === 404) {
      // Server may have recycled and forgotten the in-memory job. Re-issue
      // POST once (server-side patching of the message row is idempotent).
      if (restartsLeft > 0) {
        restartsLeft -= 1;
        try {
          jobId = await startSelfieJob(messageId, vibe);
          continue;
        } catch {
          continue;
        }
      }
      throw new Error("Selfie job expired before it finished.");
    }
    if (!res.ok) continue;

    let data: { status?: unknown; imageUrl?: unknown; error?: unknown };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      continue;
    }
    if (data.status === "ready") {
      if (typeof data.imageUrl !== "string" || !data.imageUrl.trim()) {
        throw new Error("Selfie was ready but no image URL was returned.");
      }
      return data.imageUrl.trim();
    }
    if (data.status === "failed") {
      const msg =
        typeof data.error === "string" && data.error.trim()
          ? data.error.trim()
          : "Selfie generation failed.";
      throw new Error(msg);
    }
    // status === "pending" → keep polling
  }
  throw new Error("Selfie took too long — try again.");
}

// ---------------------------------------------------------------------------
// User image upload (paperclip flow) + remember-decision card
// ---------------------------------------------------------------------------

export type SendChatImageRequest = {
  /** Stable client-generated id; the server is idempotent on it. */
  id: string;
  /** Base64-encoded image bytes (no data: prefix). */
  base64: string;
  mimeType: string;
  category: ImageCategory;
  mode: ImageAnalysisMode;
  caption: string;
  replyTo?: ReplyToRef | null;
};

export async function sendChatImage(
  req: SendChatImageRequest,
): Promise<ChatResponse> {
  const data = await fetchJSON<{
    userMessage: WireMessage;
    ashleyMessage: WireMessage;
  }>("/chat/image", {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify({
      userMessage: {
        id: req.id,
        content: req.caption ?? "",
        ...(req.replyTo
          ? {
              replyTo: {
                id: req.replyTo.id,
                role: req.replyTo.role,
                preview: req.replyTo.preview,
              },
            }
          : {}),
      },
      image: {
        base64: req.base64,
        mimeType: req.mimeType,
      },
      category: req.category,
      mode: req.mode,
      clientNow: new Date().toISOString(),
      clientTimezone:
        (typeof Intl !== "undefined" &&
          Intl.DateTimeFormat().resolvedOptions().timeZone) ||
        "UTC",
    }),
  });
  return {
    userMessage: messageFromWire(data.userMessage),
    ashleyMessage: messageFromWire(data.ashleyMessage),
  };
}

export type RememberDecision = "remember" | "visual" | "dismiss";

export async function markImageRemembered(
  messageId: string,
  decision: RememberDecision,
): Promise<Message> {
  const data = await fetchJSON<{ message: WireMessage }>(
    `/messages/${encodeURIComponent(messageId)}/remember`,
    {
      method: "POST",
      body: JSON.stringify({ decision }),
    },
  );
  return messageFromWire(data.message);
}

// ---------------------------------------------------------------------------
// Stage 3 — TTS replies. POST one of Ashley's reply texts to /chat/tts,
// receive a base64 mp3, write it to the cache directory, and return the
// local file:// URI ready for expo-audio playback.
//
// We use the JSON envelope (audioBase64 + mimeType) rather than streaming
// binary because RN's FileSystem.writeAsStringAsync with base64 encoding
// is the path-of-least-resistance for getting bytes onto disk; the ~33%
// size inflation is irrelevant for ≤1500 chars of TTS audio (10-30 KB).
//
// The caller (lib/voiceOutput.ts → useTtsPlayback) is responsible for
// cleaning up the file after playback completes.
// ---------------------------------------------------------------------------
export async function synthesizeSpeechToFile(
  text: string,
): Promise<{ uri: string }> {
  const data = await fetchJSON<{ audioBase64: string; mimeType: string }>(
    "/chat/tts",
    { method: "POST", body: JSON.stringify({ text }) },
  );
  const dir = FileSystem.cacheDirectory;
  if (!dir) {
    throw new Error("No cache directory available for TTS playback");
  }
  const uri = `${dir}ashley-tts-${Date.now()}.mp3`;
  await FileSystem.writeAsStringAsync(uri, data.audioBase64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return { uri };
}
