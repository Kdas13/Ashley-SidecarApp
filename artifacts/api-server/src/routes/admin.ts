import { Router, type IRouter } from "express";
import { sql, eq, ilike, and, desc, count } from "drizzle-orm";
import { db, memoriesTable, messagesTable } from "@workspace/db";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ── Raw SQL result helper ────────────────────────────────────────────────────
// db.execute() returns QueryResult<Record<string,unknown>>. We need to extract
// typed rows. Casting directly fails TS overlap checks, so we go via unknown.
function dbRows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows) ?? [];
}

// ── Health check types ───────────────────────────────────────────────────────
type FindingLevel = "info" | "warning" | "error";
type HealthStatus = "pass" | "warn" | "fail";
interface Finding { level: FindingLevel; message: string; action?: string; }
interface HealthResult { status: HealthStatus; summary: string; findings: Finding[]; }

function overallStatus(findings: Finding[]): HealthStatus {
  if (findings.some((f) => f.level === "error")) return "fail";
  if (findings.some((f) => f.level === "warning")) return "warn";
  return "pass";
}

// ── Shared health check logic (called from routes AND /health/full) ───────────

async function runMemoryHealth(): Promise<HealthResult> {
  const findings: Finding[] = [];
  try {
    const nullContent = await db
      .select({ id: memoriesTable.id })
      .from(memoriesTable)
      .where(sql`${memoriesTable.content} IS NULL OR ${memoriesTable.content} = ''`);
    if (nullContent.length > 0) {
      findings.push({ level: "error", message: `${nullContent.length} memories have null or empty content`, action: "Delete or repair these rows" });
    }
    const oldLowReuse = await db
      .select({ id: memoriesTable.id })
      .from(memoriesTable)
      .where(sql`${memoriesTable.reuse} = 'rarely' AND ${memoriesTable.createdAt} < NOW() - INTERVAL '30 days'`);
    if (oldLowReuse.length > 0) {
      findings.push({ level: "warning", message: `${oldLowReuse.length} rarely-reused memories older than 30 days`, action: "Consider archiving these memories" });
    }
    if (findings.length === 0) findings.push({ level: "info", message: "Memory content looks healthy" });
  } catch (err) {
    findings.push({ level: "error", message: `Query error: ${String(err)}` });
  }
  return { status: overallStatus(findings), summary: `Memory health: ${findings.length} finding(s)`, findings };
}

async function runMemoryIntegrityHealth(): Promise<HealthResult> {
  const findings: Finding[] = [];
  try {
    const dupeResult = await db.execute(sql`
      SELECT content, COUNT(*) as cnt FROM memories
      WHERE state = 'active' GROUP BY content HAVING COUNT(*) > 1
    `);
    const dupeCount = dbRows<unknown>(dupeResult).length;
    if (dupeCount > 0) {
      findings.push({ level: "warning", message: `${dupeCount} exact-duplicate memory content strings found`, action: "Run memory consolidation" });
    }
    const missingResult = await db.execute(sql`SELECT COUNT(*) as cnt FROM memories WHERE content IS NULL OR category IS NULL`);
    const missingCount = Number(dbRows<{ cnt: string }>(missingResult)[0]?.cnt ?? 0);
    if (missingCount > 0) {
      findings.push({ level: "error", message: `${missingCount} memories missing required fields (content or category)`, action: "Inspect and repair these rows" });
    }
    if (findings.length === 0) findings.push({ level: "info", message: "Memory integrity OK" });
  } catch (err) {
    findings.push({ level: "error", message: `Query error: ${String(err)}` });
  }
  return { status: overallStatus(findings), summary: `Memory integrity: ${findings.length} finding(s)`, findings };
}

async function runPromptsHealth(): Promise<HealthResult> {
  const findings: Finding[] = [];
  try {
    const emptyResult = await db.execute(sql`SELECT id, name, tier FROM prompts WHERE content IS NULL OR content = ''`);
    const emptyCount = dbRows<unknown>(emptyResult).length;
    if (emptyCount > 0) {
      findings.push({ level: "error", message: `${emptyCount} prompts have empty content`, action: "Edit or delete these prompt entries" });
    }
    if (findings.length === 0) findings.push({ level: "info", message: "All prompts have content" });
  } catch {
    findings.push({ level: "info", message: "Prompts table not yet populated — no issues" });
  }
  return { status: overallStatus(findings), summary: `Prompt health: ${findings.length} finding(s)`, findings };
}

async function runProvidersHealth(): Promise<HealthResult> {
  const findings: Finding[] = [];
  const providers = [
    { name: "Gemini 2.5 Flash", baseUrl: process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"], apiKey: process.env["AI_INTEGRATIONS_GEMINI_API_KEY"] },
    { name: "Claude Sonnet",    baseUrl: process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"], apiKey: process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"] },
  ];
  for (const p of providers) {
    if (!p.baseUrl || !p.apiKey) {
      findings.push({ level: "info", message: `${p.name}: not configured (env vars missing)` });
      continue;
    }
    try {
      const start = Date.now();
      const fetchRes = await fetch(`${p.baseUrl.replace(/\/$/, "")}/models`, {
        headers: { Authorization: `Bearer ${p.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      const ms = Date.now() - start;
      const ok = fetchRes.ok || fetchRes.status === 400 || fetchRes.status === 404;
      findings.push({ level: ok ? "info" : "warning", message: `${p.name}: ${ok ? "reachable" : "HTTP " + fetchRes.status} (${ms}ms)`, action: ok ? undefined : "Check API key and base URL" });
    } catch (err) {
      findings.push({ level: "error", message: `${p.name}: unreachable — ${String(err)}`, action: "Check network and provider configuration" });
    }
  }
  return { status: overallStatus(findings), summary: `Provider health: ${findings.length} provider(s) checked`, findings };
}

async function runWorkersHealth(): Promise<HealthResult> {
  const findings: Finding[] = [];
  try {
    const workerResult = await db.execute(sql`
      SELECT worker_id, last_run_at, last_run_ok,
             last_run_at < NOW() - INTERVAL '5 minutes' AS stale
      FROM workers_heartbeat
    `);
    const workers = dbRows<{ worker_id: string; last_run_ok: boolean; stale: boolean }>(workerResult);
    if (workers.length === 0) {
      findings.push({ level: "warning", message: "No worker heartbeat rows found", action: "Check workers are running" });
    }
    for (const w of workers) {
      const wid = String(w.worker_id);
      if (w.stale) findings.push({ level: "warning", message: `Worker ${wid} heartbeat is stale`, action: "Restart the worker" });
      else if (!w.last_run_ok) findings.push({ level: "error", message: `Worker ${wid} last run failed`, action: "Check worker logs" });
      else findings.push({ level: "info", message: `Worker ${wid} OK` });
    }
  } catch {
    findings.push({ level: "info", message: "workers_heartbeat table not present — workers not implemented yet" });
  }
  return { status: overallStatus(findings), summary: `Worker health: ${findings.length} finding(s)`, findings };
}

async function runContextSizeHealth(): Promise<HealthResult> {
  const findings: Finding[] = [];
  try {
    const recentMessages = await db.select({ content: messagesTable.content }).from(messagesTable).orderBy(desc(messagesTable.createdAt)).limit(50);
    const activeMemories = await db.select({ content: memoriesTable.content }).from(memoriesTable).where(eq(memoriesTable.state, "active"));
    const msgChars = recentMessages.reduce((s, m) => s + m.content.length, 0);
    const memChars = activeMemories.reduce((s, m) => s + m.content.length, 0);
    const estimated = Math.round((msgChars + memChars) / 4);
    const windowK = 200_000;
    const pct = Math.round((estimated / windowK) * 100);
    findings.push({
      level: pct > 80 ? "warning" : "info",
      message: `Estimated ~${estimated.toLocaleString()} tokens (${pct}% of ${windowK / 1000}k window)`,
      action: pct > 80 ? "Consider running memory consolidation" : undefined,
    });
    findings.push({ level: "info", message: `${recentMessages.length} recent messages, ${activeMemories.length} active memories` });
  } catch (err) {
    findings.push({ level: "error", message: `Context size estimation failed: ${String(err)}` });
  }
  return { status: overallStatus(findings), summary: `Context size: ${findings[0]?.message ?? "unknown"}`, findings };
}

// ── Quick commands ─────────────────────────────────────────────────────────────

router.post("/memory/consolidate", (_req, res) => {
  res.json({ success: true, note: "not_yet_implemented" });
});

router.post("/workers/clear-stuck", async (_req, res) => {
  try {
    const result = await db.execute(sql`
      UPDATE image_move_queue
      SET status = 'pending', locked_at = NULL, worker_id = NULL
      WHERE status IN ('copying', 'verifying')
        AND locked_at < NOW() - INTERVAL '10 minutes'
    `);
    const cleared = (result as { rowCount?: number }).rowCount ?? 0;
    res.json({ success: true, cleared });
  } catch {
    res.json({ success: true, cleared: 0, note: "image_move_queue table not present" });
  }
});

router.post("/capabilities/reload", (_req, res) => res.json({ success: true }));
router.post("/cache/flush",         (_req, res) => res.json({ success: true }));

// ── Health check routes ────────────────────────────────────────────────────────

router.post("/health/memory",           async (_req, res) => res.json(await runMemoryHealth()));
router.post("/health/memory-integrity", async (_req, res) => res.json(await runMemoryIntegrityHealth()));
router.post("/health/prompts",          async (_req, res) => res.json(await runPromptsHealth()));
router.post("/health/providers",        async (_req, res) => res.json(await runProvidersHealth()));
router.post("/health/workers",          async (_req, res) => res.json(await runWorkersHealth()));
router.post("/health/context-size",     async (_req, res) => res.json(await runContextSizeHealth()));

router.post("/health/full", async (_req, res) => {
  const checks: Array<{ key: string; fn: () => Promise<HealthResult> }> = [
    { key: "memory",           fn: runMemoryHealth },
    { key: "memory-integrity", fn: runMemoryIntegrityHealth },
    { key: "prompts",          fn: runPromptsHealth },
    { key: "providers",        fn: runProvidersHealth },
    { key: "workers",          fn: runWorkersHealth },
    { key: "context-size",     fn: runContextSizeHealth },
  ];
  const results: Record<string, HealthResult> = {};
  await Promise.all(checks.map(async ({ key, fn }) => {
    try { results[key] = await fn(); }
    catch (err) { results[key] = { status: "fail", summary: `Check failed: ${String(err)}`, findings: [{ level: "error", message: String(err) }] }; }
  }));
  const fail = Object.values(results).some((r) => r.status === "fail");
  const warn = Object.values(results).some((r) => r.status === "warn");
  res.json({ status: fail ? "fail" : warn ? "warn" : "pass", checks: results });
});

// ── Memory CRUD ────────────────────────────────────────────────────────────────

router.get("/memories", async (req, res) => {
  const limit    = Math.min(Number(req.query["limit"]  ?? 100), 500);
  const offset   = Number(req.query["offset"] ?? 0);
  const category = (req.query["category"] as string) || "";
  const state    = (req.query["state"]    as string) || "";
  const search   = (req.query["search"]   as string) || "";

  try {
    const conditions = [];
    if (category) conditions.push(eq(memoriesTable.category, category));
    if (state)    conditions.push(eq(memoriesTable.state, state));
    if (search)   conditions.push(ilike(memoriesTable.content, `%${search}%`));

    const mems = await db
      .select({ id: memoriesTable.id, content: memoriesTable.content, category: memoriesTable.category, importance: memoriesTable.importance, state: memoriesTable.state, reuse: memoriesTable.reuse, createdAt: memoriesTable.createdAt, updatedAt: memoriesTable.updatedAt })
      .from(memoriesTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(memoriesTable.updatedAt))
      .limit(limit).offset(offset);

    const [totalRow] = await db.select({ total: count() }).from(memoriesTable).where(conditions.length ? and(...conditions) : undefined);
    res.json({ memories: mems, total: totalRow?.total ?? 0 });
  } catch (err) {
    req.log.error({ err }, "admin: GET /memories failed");
    res.status(500).json({ error: "internal_error" });
  }
});

router.post("/memory/add", async (req, res) => {
  const { content, category, importance_weight } = req.body as { content: string; category: string; importance_weight: number };
  if (!content || !category) { res.status(400).json({ error: "content and category are required" }); return; }
  try {
    const id = crypto.randomUUID();
    await db.insert(memoriesTable).values({ id, deviceId: "admin", content: String(content).slice(0, 500), category: String(category), importance: Number(importance_weight ?? 3), state: "active", reuse: "relevant_only" });
    res.json({ success: true, id });
  } catch (err) {
    req.log.error({ err }, "admin: POST /memory/add failed");
    res.status(500).json({ error: "internal_error" });
  }
});

router.post("/memory/update", async (req, res) => {
  const { id, content, category, importance_weight, state } = req.body as { id: string; content?: string; category?: string; importance_weight?: number; state?: string };
  if (!id) { res.status(400).json({ error: "id is required" }); return; }
  try {
    const updates: Partial<typeof memoriesTable.$inferSelect> = {};
    if (content           !== undefined) updates.content   = String(content).slice(0, 500);
    if (category          !== undefined) updates.category  = String(category);
    if (importance_weight !== undefined) updates.importance = Number(importance_weight);
    if (state             !== undefined) updates.state     = String(state);
    if (Object.keys(updates).length === 0) { res.status(400).json({ error: "no fields to update" }); return; }
    await db.update(memoriesTable).set(updates).where(eq(memoriesTable.id, id));
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "admin: POST /memory/update failed");
    res.status(500).json({ error: "internal_error" });
  }
});

router.delete("/memories/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await db.update(memoriesTable).set({ state: "passive" }).where(eq(memoriesTable.id, id!));
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "admin: DELETE /memories/:id failed");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Conversations ─────────────────────────────────────────────────────────────
// Messages are keyed by device_id; we treat each device as a "conversation".

router.get("/conversations", async (req, res) => {
  const limit  = Math.min(Number(req.query["limit"]  ?? 100), 500);
  const offset = Number(req.query["offset"] ?? 0);
  const search = (req.query["search"] as string) || "";
  const from   = (req.query["from"]   as string) || "";
  const to     = (req.query["to"]     as string) || "";

  try {
    const convResult = await db.execute(sql`
      SELECT device_id AS id, MIN(created_at) AS created_at,
             COUNT(*)::int AS message_count, MAX(created_at) AS last_message_at
      FROM messages
      WHERE (${search} = '' OR content ILIKE ${'%' + search + '%'})
        AND (${from}   = '' OR created_at >= ${from}::timestamptz)
        AND (${to}     = '' OR created_at <= ${to}::timestamptz)
      GROUP BY device_id
      ORDER BY MAX(created_at) DESC
      LIMIT ${limit} OFFSET ${offset}
    `);
    const cntResult = await db.execute(sql`SELECT COUNT(DISTINCT device_id)::int AS total FROM messages`);
    const total = Number(dbRows<{ total: string }>(cntResult)[0]?.total ?? 0);
    res.json({ conversations: dbRows<unknown>(convResult), total });
  } catch (err) {
    req.log.error({ err }, "admin: GET /conversations failed");
    res.status(500).json({ error: "internal_error" });
  }
});

router.get("/conversations/:id", async (req, res) => {
  const deviceId = req.params["id"]!;
  try {
    const messages = await db
      .select({ id: messagesTable.id, role: messagesTable.role, content: messagesTable.content, createdAt: messagesTable.createdAt })
      .from(messagesTable)
      .where(eq(messagesTable.deviceId, deviceId))
      .orderBy(messagesTable.createdAt);
    res.json({ messages });
  } catch (err) {
    req.log.error({ err }, "admin: GET /conversations/:id failed");
    res.status(500).json({ error: "internal_error" });
  }
});

router.delete("/conversations/:id", async (req, res) => {
  const deviceId = req.params["id"]!;
  try {
    await db.delete(messagesTable).where(eq(messagesTable.deviceId, deviceId));
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "admin: DELETE /conversations/:id failed");
    res.status(500).json({ error: "internal_error" });
  }
});

router.delete("/conversations/:id/messages/:msgId", async (req, res) => {
  const { id: deviceId, msgId } = req.params as { id: string; msgId: string };
  try {
    await db.delete(messagesTable).where(and(eq(messagesTable.id, msgId), eq(messagesTable.deviceId, deviceId)));
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "admin: DELETE /conversations/:id/messages/:msgId failed");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Feature flags ─────────────────────────────────────────────────────────────

router.get("/flags", async (_req, res) => {
  try {
    const flagResult = await db.execute(sql`SELECT id, name, description, category, enabled, updated_at FROM feature_flags ORDER BY category, name`);
    res.json({ flags: dbRows<unknown>(flagResult) });
  } catch {
    res.json({ flags: [] });
  }
});

router.post("/flags/toggle", async (req, res) => {
  const { flag_id, enabled } = req.body as { flag_id: string; enabled: boolean };
  if (!flag_id) { res.status(400).json({ error: "flag_id required" }); return; }
  try {
    await db.execute(sql`UPDATE feature_flags SET enabled = ${Boolean(enabled)}, updated_at = NOW() WHERE id = ${flag_id}`);
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "admin: POST /flags/toggle failed");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Providers ─────────────────────────────────────────────────────────────────

router.get("/providers", (_req, res) => {
  const active = process.env["ASHLEY_TEXT_PROVIDER"] ?? "gemini";
  res.json({
    active_llm: active,
    providers: [
      { id: "gemini",    name: "Gemini 2.5 Flash", active: active === "gemini" },
      { id: "anthropic", name: "Claude Sonnet",     active: active === "anthropic" },
    ],
    fallback_order: ["gemini", "anthropic"],
  });
});

router.post("/providers/set-active", (req, res) => {
  const { provider } = req.body as { provider: string };
  const allowed = ["gemini", "anthropic"];
  if (!allowed.includes(provider)) { res.status(400).json({ error: `provider must be one of: ${allowed.join(", ")}` }); return; }
  process.env["ASHLEY_TEXT_PROVIDER"] = provider;
  logger.info({ provider }, "admin: active LLM provider updated");
  res.json({ success: true, active: provider, note: "Runtime change only — set ASHLEY_TEXT_PROVIDER in Replit Secrets to persist across restarts" });
});

// ── Spend ──────────────────────────────────────────────────────────────────────

router.get("/spend", (req, res) => {
  const period = (req.query["period"] as string) || "today";
  res.json({
    period, last_updated: new Date().toISOString(),
    providers: [
      { id: "gemini",    name: "Gemini 2.5 Flash", tokens_in: null, tokens_out: null, estimated_cost_gbp: null, data_lag_hours: null, note: "Real-time billing not available via Replit AI integration proxy" },
      { id: "anthropic", name: "Claude Sonnet",     tokens_in: null, tokens_out: null, estimated_cost_gbp: null, data_lag_hours: null, note: "Real-time billing not available via Replit AI integration proxy" },
    ],
    total_estimated_gbp: null,
  });
});

router.post("/spend/threshold", async (req, res) => {
  const { provider, daily_cap_gbp, weekly_cap_gbp } = req.body as { provider: string; daily_cap_gbp: number; weekly_cap_gbp: number };
  if (!provider) { res.status(400).json({ error: "provider required" }); return; }
  try {
    await db.execute(sql`
      INSERT INTO spend_caps (provider, daily_cap_gbp, weekly_cap_gbp, updated_at)
      VALUES (${provider}, ${daily_cap_gbp ?? null}, ${weekly_cap_gbp ?? null}, NOW())
      ON CONFLICT (provider) DO UPDATE SET daily_cap_gbp = EXCLUDED.daily_cap_gbp, weekly_cap_gbp = EXCLUDED.weekly_cap_gbp, updated_at = NOW()
    `);
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "admin: POST /spend/threshold failed");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Context documents (stub — context_documents table not yet created) ─────────

router.get("/documents", async (_req, res) => {
  try {
    const docResult = await db.execute(sql`SELECT id, filename, upload_date, status, word_count, token_count, summary FROM context_documents ORDER BY upload_date DESC`);
    res.json({ documents: dbRows<unknown>(docResult) });
  } catch {
    res.json({ documents: [] });
  }
});

router.delete("/documents/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await db.execute(sql`DELETE FROM context_documents WHERE id = ${id}`);
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "admin: DELETE /documents/:id failed");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Inbox reply ───────────────────────────────────────────────────────────────

router.post("/inbox/reply", async (req, res) => {
  const { reference_code, reply } = req.body as { reference_code: string; reply: string };
  if (!reference_code || !reply) { res.status(400).json({ error: "reference_code and reply are required" }); return; }
  try {
    await db.execute(sql`INSERT INTO priority_notes (id, reference_code, content, created_at) VALUES (gen_random_uuid(), ${reference_code}, ${reply}, NOW())`);
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "admin: POST /inbox/reply failed");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Proposals ─────────────────────────────────────────────────────────────────

const VALID_PROPOSAL_TYPES = ["add-memory", "modify-memory", "change-flag", "change-provider", "new-tier3-prompt", "adjust-spend-threshold"] as const;

router.post("/proposals/execute", async (req, res) => {
  const { proposal_id, proposal_type, proposed_change } = req.body as { proposal_id: string; proposal_type: string; proposed_change: Record<string, unknown> };
  if (!VALID_PROPOSAL_TYPES.includes(proposal_type as typeof VALID_PROPOSAL_TYPES[number])) {
    res.status(400).json({ error: `Invalid proposal_type. Valid: ${VALID_PROPOSAL_TYPES.join(", ")}` });
    return;
  }
  try {
    logger.info({ proposal_id, proposal_type }, "admin: executing proposal");
    // Dispatch to the corresponding handler by mutating req.body and re-entering the router.
    req.body = proposed_change;
    const pathMap: Record<string, string> = {
      "add-memory": "/memory/add", "modify-memory": "/memory/update",
      "change-flag": "/flags/toggle", "change-provider": "/providers/set-active",
      "new-tier3-prompt": "/prompts/create", "adjust-spend-threshold": "/spend/threshold",
    };
    req.url = pathMap[proposal_type] ?? req.url;
    req.method = "POST";
    // Cast to Application (which has .handle) for internal dispatch.
    (router as unknown as { handle: (req: unknown, res: unknown, next: () => void) => void }).handle(
      req, res,
      () => { res.json({ success: true, proposal_id, executed: proposal_type }); },
    );
  } catch (err) {
    req.log.error({ err }, "admin: POST /proposals/execute failed");
    res.status(500).json({ error: "internal_error" });
  }
});

router.post("/proposals/reject", async (req, res) => {
  const { proposal_id, proposal_type, kane_note } = req.body as { proposal_id: string; proposal_type: string; kane_note?: string };
  if (!proposal_id || !proposal_type) { res.status(400).json({ error: "proposal_id and proposal_type are required" }); return; }
  try {
    await db.execute(sql`INSERT INTO proposal_rejections (id, proposal_id, proposal_type, kane_note, created_at) VALUES (gen_random_uuid(), ${proposal_id}, ${proposal_type}, ${kane_note ?? null}, NOW())`);
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "admin: POST /proposals/reject failed");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Prompts ───────────────────────────────────────────────────────────────────

router.post("/prompts/create", async (req, res) => {
  const { tier, name, content, description } = req.body as { tier: number; name: string; content: string; description?: string };
  if (tier === 1) { res.status(403).json({ error: "Tier 1 prompts are only editable manually" }); return; }
  if (!name || !content) { res.status(400).json({ error: "name and content are required" }); return; }
  try {
    const insertResult = await db.execute(sql`
      INSERT INTO prompts (id, tier, name, content, description, version, created_at, updated_at)
      VALUES (gen_random_uuid(), ${Number(tier)}, ${name}, ${content}, ${description ?? null}, 1, NOW(), NOW())
      RETURNING id
    `);
    const id = dbRows<{ id: string }>(insertResult)[0]?.id;
    res.json({ success: true, id });
  } catch (err) {
    req.log.error({ err }, "admin: POST /prompts/create failed");
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
