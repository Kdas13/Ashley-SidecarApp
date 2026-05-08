/**
 * Integration tests for the reminder HTTP surface:
 *
 *   - `POST   /safeguard-api/me/push/subscribe`
 *   - `DELETE /safeguard-api/me/push/subscribe`
 *   - `GET    /safeguard-api/me/push/subscriptions`
 *   - `POST   /safeguard-api/reminders/tick` (cron secret check)
 *   - `POST   /safeguard-api/me/followups/:id/complete`
 *   - `PATCH  /safeguard-api/me/followups/:id` (mute toggle)
 *
 * The worker tick is exercised end-to-end against an in-memory db mock so
 * the "subsequent tick skips the row" assertions actually reflect what
 * `runReminderTick()` does.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AddressInfo } from "node:net";

vi.stubEnv("VAPID_PUBLIC_KEY", "test-public");
vi.stubEnv("VAPID_PRIVATE_KEY", "test-private");
vi.stubEnv("VAPID_SUBJECT", "mailto:test@example.org");

// ---------------------------------------------------------------------------
// In-memory store + drizzle stub.
// Mirrors the approach in reminderWorker.test.ts but extended to cover the
// route handlers (returning(), orderBy/limit, etc).
// ---------------------------------------------------------------------------

interface FollowupRow {
  id: string;
  userId: string;
  appointmentId: string;
  kind: string;
  remindersEnabled: boolean;
  completedAt: Date | null;
  nextReminderAt: Date | null;
  reminderCount: number;
  cadence: Record<string, unknown> | null;
  titleOriginal: string;
  titleTranslated: string;
  detailOriginal: string;
  detailTranslated: string;
  plainExplanation: string;
  targetLang: string;
  sourceLang: string;
  confidence: string;
  dueAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
interface ProfileRow {
  userId: string;
  preferredLanguage: string;
}
interface SubRow {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  lang: string;
  userAgent: string;
  createdAt: Date;
  lastSeenAt: Date;
}
interface SendRow {
  id: string;
  followupId: string;
  userId: string;
  scheduledFor: Date;
  success: boolean;
  deliveredCount: number;
  errorMessage: string;
}

const store = {
  followups: [] as FollowupRow[],
  profiles: [] as ProfileRow[],
  subs: [] as SubRow[],
  sends: [] as SendRow[],
  nextId: 1,
};

function nextId(prefix: string): string {
  return `${prefix}-${store.nextId++}`;
}

type ColRef = { __col: string; __table: string };
type Pred =
  | { __op: "eq"; col: ColRef; val: unknown }
  | { __op: "lte"; col: ColRef; val: unknown }
  | { __op: "isNull"; col: ColRef }
  | { __op: "and"; args: Pred[] }
  | undefined;

function makeTable(name: string): Record<string, ColRef> & { __t: string } {
  return new Proxy({ __t: name } as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop === "__t") return target["__t"];
      return { __col: prop, __table: name } satisfies ColRef;
    },
  }) as Record<string, ColRef> & { __t: string };
}

const tFollowups = makeTable("followups");
const tProfiles = makeTable("profiles");
const tSubs = makeTable("subs");
const tSends = makeTable("sends");
// Tables imported by the route module but never touched in these tests.
// They need to exist so destructured imports don't blow up.
const tUsers = makeTable("users");
const tAppointments = makeTable("appointments");
const tAppointmentIntake = makeTable("appointment_intake");
const tAppointmentSummaries = makeTable("appointment_summaries");
const tAppointmentUtterances = makeTable("appointment_utterances");
const tAppointmentExports = makeTable("appointment_exports");
const tAppointmentExportDeliveries = makeTable("appointment_export_deliveries");
const tCheckins = makeTable("checkins");
const tTranslations = makeTable("translations");
const tObservations = makeTable("observations");

function rowsFor(table: { __t: string }): Record<string, unknown>[] {
  switch (table.__t) {
    case "followups":
      return store.followups as unknown as Record<string, unknown>[];
    case "profiles":
      return store.profiles as unknown as Record<string, unknown>[];
    case "subs":
      return store.subs as unknown as Record<string, unknown>[];
    case "sends":
      return store.sends as unknown as Record<string, unknown>[];
    default:
      return [];
  }
}

function evalPred(pred: Pred, row: Record<string, unknown>): boolean {
  if (!pred) return true;
  if (pred.__op === "and") return pred.args.every((a) => evalPred(a, row));
  if (pred.__op === "isNull") {
    const v = row[pred.col.__col];
    return v === null || v === undefined;
  }
  if (pred.__op === "eq") {
    const v = row[pred.col.__col];
    return v === pred.val;
  }
  if (pred.__op === "lte") {
    const v = row[pred.col.__col];
    if (v == null) return false;
    const a = v instanceof Date ? v.getTime() : new Date(String(v)).getTime();
    const b =
      pred.val instanceof Date
        ? pred.val.getTime()
        : new Date(String(pred.val)).getTime();
    return a <= b;
  }
  return true;
}

function project(
  row: Record<string, unknown>,
  projection?: Record<string, ColRef>,
): Record<string, unknown> {
  if (!projection) return { ...row };
  const out: Record<string, unknown> = {};
  for (const [alias, ref] of Object.entries(projection)) {
    out[alias] = row[ref.__col];
  }
  return out;
}

vi.mock("drizzle-orm", () => ({
  eq: (col: ColRef, val: unknown) => ({ __op: "eq", col, val }),
  lte: (col: ColRef, val: unknown) => ({ __op: "lte", col, val }),
  gte: (col: ColRef, val: unknown) => ({ __op: "lte", col, val }),
  isNull: (col: ColRef) => ({ __op: "isNull", col }),
  and: (...args: Pred[]) => ({ __op: "and", args }),
  asc: (col: ColRef) => col,
  desc: (col: ColRef) => col,
}));

function insertRow(table: { __t: string }, v: Record<string, unknown>): Record<string, unknown> | null {
  const now = new Date();
  if (table.__t === "subs") {
    const row: SubRow = {
      id: nextId("sub"),
      userId: v["userId"] as string,
      endpoint: v["endpoint"] as string,
      p256dh: v["p256dh"] as string,
      auth: v["auth"] as string,
      lang: (v["lang"] as string) ?? "en",
      userAgent: (v["userAgent"] as string) ?? "",
      createdAt: now,
      lastSeenAt: (v["lastSeenAt"] as Date) ?? now,
    };
    store.subs.push(row);
    return row as unknown as Record<string, unknown>;
  }
  if (table.__t === "followups") {
    const row: FollowupRow = {
      id: nextId("fu"),
      userId: v["userId"] as string,
      appointmentId: v["appointmentId"] as string,
      kind: (v["kind"] as string) ?? "followup",
      remindersEnabled: (v["remindersEnabled"] as boolean) ?? true,
      completedAt: (v["completedAt"] as Date | null) ?? null,
      nextReminderAt: (v["nextReminderAt"] as Date | null) ?? null,
      reminderCount: (v["reminderCount"] as number) ?? 0,
      cadence: (v["cadence"] as Record<string, unknown>) ?? null,
      titleOriginal: (v["titleOriginal"] as string) ?? "",
      titleTranslated: (v["titleTranslated"] as string) ?? "",
      detailOriginal: (v["detailOriginal"] as string) ?? "",
      detailTranslated: (v["detailTranslated"] as string) ?? "",
      plainExplanation: (v["plainExplanation"] as string) ?? "",
      targetLang: (v["targetLang"] as string) ?? "en",
      sourceLang: (v["sourceLang"] as string) ?? "en",
      confidence: (v["confidence"] as string) ?? "high",
      dueAt: (v["dueAt"] as Date | null) ?? null,
      createdAt: now,
      updatedAt: now,
    };
    store.followups.push(row);
    return row as unknown as Record<string, unknown>;
  }
  if (table.__t === "sends") {
    const row: SendRow = {
      id: nextId("send"),
      followupId: v["followupId"] as string,
      userId: v["userId"] as string,
      scheduledFor: v["scheduledFor"] as Date,
      success: (v["success"] as boolean) ?? false,
      deliveredCount: (v["deliveredCount"] as number) ?? 0,
      errorMessage: (v["errorMessage"] as string) ?? "",
    };
    store.sends.push(row);
    return row as unknown as Record<string, unknown>;
  }
  if (table.__t === "profiles") {
    const row: ProfileRow = {
      userId: v["userId"] as string,
      preferredLanguage: (v["preferredLanguage"] as string) ?? "en",
    };
    store.profiles.push(row);
    return row as unknown as Record<string, unknown>;
  }
  // users / appointments / etc — accept silently.
  return null;
}

vi.mock("@workspace/db", () => {
  const db = {
    select(projection?: Record<string, ColRef>) {
      let table: { __t: string } | null = null;
      let pred: Pred = undefined;
      const builder: Record<string, unknown> = {
        from(t: { __t: string }) {
          table = t;
          return builder;
        },
        where(p: Pred) {
          pred = p;
          return builder;
        },
        orderBy(_x: unknown) {
          return builder;
        },
        limit(_n: number) {
          return Promise.resolve(execute());
        },
        leftJoin(_t: unknown, _on: unknown) {
          return builder;
        },
        then(
          resolve: (v: Record<string, unknown>[]) => unknown,
          reject?: (e: unknown) => unknown,
        ) {
          return Promise.resolve(execute()).then(resolve, reject);
        },
      };
      function execute(): Record<string, unknown>[] {
        if (!table) return [];
        const rows = rowsFor(table).filter((r) => evalPred(pred, r));
        return rows.map((r) => project(r, projection));
      }
      return builder;
    },

    insert(table: { __t: string }) {
      return {
        values(v: Record<string, unknown>) {
          const builder: Record<string, unknown> = {
            onConflictDoNothing(_opts?: unknown) {
              return {
                returning(projection?: Record<string, ColRef>) {
                  // sends de-dup on (followupId, scheduledFor)
                  if (table.__t === "sends") {
                    const dup = store.sends.find(
                      (s) =>
                        s.followupId === v["followupId"] &&
                        s.scheduledFor.getTime() ===
                          (v["scheduledFor"] as Date).getTime(),
                    );
                    if (dup) return Promise.resolve([]);
                  }
                  const row = insertRow(table, v);
                  if (!row) return Promise.resolve([]);
                  return Promise.resolve([project(row, projection)]);
                },
                then(
                  resolve: (v: unknown) => unknown,
                  reject?: (e: unknown) => unknown,
                ) {
                  // users insert path — no returning, just commit.
                  insertRow(table, v);
                  return Promise.resolve(undefined).then(resolve, reject);
                },
              };
            },
            onConflictDoUpdate(_opts: unknown) {
              return {
                then(
                  resolve: (v: unknown) => unknown,
                  reject?: (e: unknown) => unknown,
                ) {
                  insertRow(table, v);
                  return Promise.resolve(undefined).then(resolve, reject);
                },
              };
            },
            returning(projection?: Record<string, ColRef>) {
              const row = insertRow(table, v);
              if (!row) return Promise.resolve([]);
              return Promise.resolve([project(row, projection)]);
            },
          };
          return builder;
        },
      };
    },

    update(table: { __t: string }) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where(pred: Pred) {
              const apply = (): Record<string, unknown>[] => {
                const rows = rowsFor(table).filter((r) =>
                  evalPred(pred, r),
                );
                for (const r of rows) Object.assign(r, values);
                return rows;
              };
              const builder: Record<string, unknown> = {
                returning(projection?: Record<string, ColRef>) {
                  const rows = apply();
                  return Promise.resolve(
                    rows.map((r) => project(r, projection)),
                  );
                },
                then(
                  resolve: (v: unknown) => unknown,
                  reject?: (e: unknown) => unknown,
                ) {
                  apply();
                  return Promise.resolve(undefined).then(resolve, reject);
                },
              };
              return builder;
            },
          };
        },
      };
    },

    delete(table: { __t: string }) {
      return {
        where(pred: Pred) {
          const arr = rowsFor(table);
          const keep = arr.filter((r) => !evalPred(pred, r));
          arr.length = 0;
          arr.push(...keep);
          return Promise.resolve();
        },
      };
    },
  };

  return {
    db,
    safeguardFollowupsTable: tFollowups,
    safeguardProfilesTable: tProfiles,
    safeguardPushSubscriptionsTable: tSubs,
    safeguardReminderSendsTable: tSends,
    safeguardUsersTable: tUsers,
    safeguardAppointmentsTable: tAppointments,
    safeguardAppointmentIntakeTable: tAppointmentIntake,
    safeguardAppointmentSummariesTable: tAppointmentSummaries,
    safeguardAppointmentUtterancesTable: tAppointmentUtterances,
    safeguardAppointmentExportsTable: tAppointmentExports,
    safeguardAppointmentExportDeliveriesTable: tAppointmentExportDeliveries,
    safeguardCheckinsTable: tCheckins,
    safeguardTranslationsTable: tTranslations,
    safeguardObservationsTable: tObservations,
  };
});

// web-push mock — programmable per endpoint.
const pushResponses = new Map<string, { status: number } | "ok">();
const pushCalls: { endpoint: string; payload: string }[] = [];

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(
      async (sub: { endpoint: string }, payload: string) => {
        pushCalls.push({ endpoint: sub.endpoint, payload });
        const r = pushResponses.get(sub.endpoint);
        if (!r || r === "ok") return { statusCode: 201 };
        const err: Error & { statusCode?: number } = new Error(
          `push failed ${r.status}`,
        );
        err.statusCode = r.status;
        throw err;
      },
    ),
  },
}));

// Imports AFTER mocks are registered.
const express = (await import("express")).default;
const { default: pushRouter, reminderTickHandler } = await import("./push");
const { default: appointmentsRouter } = await import("./appointments");
const { runReminderTick } = await import("../lib/reminderWorker");

// Build a minimal app that mirrors `app.ts` for the surfaces under test.
function makeApp(): import("express").Express {
  const app = express();
  app.use(express.json());
  // Cron tick mounted BEFORE the gate, just like production.
  app.use("/safeguard-api", reminderTickHandler());
  // Test gate: Bearer <userId>. Mirrors the contract of `requireClerkUser`
  // (401 missing_token / sets req.auth.userId).
  app.use("/safeguard-api", (req, res, next) => {
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing_token" });
      return;
    }
    req.auth = { userId: auth.slice(7) };
    next();
  });
  app.use("/safeguard-api", pushRouter);
  app.use("/safeguard-api", appointmentsRouter);
  return app;
}

interface JsonResponse {
  status: number;
  body: unknown;
}

async function call(
  app: import("express").Express,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<JsonResponse> {
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    let body: string | undefined;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["content-type"] = "application/json";
    }
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body,
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: res.status, body: parsed };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

beforeEach(() => {
  store.followups = [];
  store.profiles = [];
  store.subs = [];
  store.sends = [];
  store.nextId = 1;
  pushResponses.clear();
  pushCalls.length = 0;
  delete process.env.REMINDER_CRON_SECRET;
});

const USER = "user_test";
const authH = (uid: string = USER): Record<string, string> => ({
  authorization: `Bearer ${uid}`,
});

// ---------------------------------------------------------------------------
// Push subscription endpoints
// ---------------------------------------------------------------------------

describe("POST /me/push/subscribe", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const app = makeApp();
    const res = await call(app, "POST", "/safeguard-api/me/push/subscribe", {
      body: {
        endpoint: "https://push.example/abc",
        keys: { p256dh: "k", auth: "a" },
      },
    });
    expect(res.status).toBe(401);
    expect(store.subs).toHaveLength(0);
  });

  it("creates a new subscription on the happy path", async () => {
    const app = makeApp();
    store.profiles.push({ userId: USER, preferredLanguage: "pl" });
    const res = await call(app, "POST", "/safeguard-api/me/push/subscribe", {
      headers: authH(),
      body: {
        endpoint: "https://push.example/abc",
        keys: { p256dh: "k1", auth: "a1" },
        userAgent: "Mozilla/Test",
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ refreshed: false });
    expect((res.body as { subscriptionId: string }).subscriptionId).toMatch(
      /^sub-/,
    );
    expect(store.subs).toHaveLength(1);
    const sub = store.subs[0]!;
    expect(sub.userId).toBe(USER);
    expect(sub.endpoint).toBe("https://push.example/abc");
    expect(sub.p256dh).toBe("k1");
    expect(sub.auth).toBe("a1");
    // Snapshotted from the profile so the worker doesn't have to re-read it.
    expect(sub.lang).toBe("pl");
    expect(sub.userAgent).toBe("Mozilla/Test");
  });

  it("refreshes an existing subscription rather than duplicating it", async () => {
    const app = makeApp();
    store.profiles.push({ userId: USER, preferredLanguage: "en" });
    const first = await call(app, "POST", "/safeguard-api/me/push/subscribe", {
      headers: authH(),
      body: {
        endpoint: "https://push.example/abc",
        keys: { p256dh: "k1", auth: "a1" },
      },
    });
    const firstId = (first.body as { subscriptionId: string }).subscriptionId;

    const second = await call(
      app,
      "POST",
      "/safeguard-api/me/push/subscribe",
      {
        headers: authH(),
        body: {
          endpoint: "https://push.example/abc",
          keys: { p256dh: "k2-new", auth: "a2-new" },
          userAgent: "Mozilla/Refreshed",
        },
      },
    );
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      refreshed: true,
      subscriptionId: firstId,
    });
    expect(store.subs).toHaveLength(1);
    expect(store.subs[0]!.p256dh).toBe("k2-new");
    expect(store.subs[0]!.auth).toBe("a2-new");
    expect(store.subs[0]!.userAgent).toBe("Mozilla/Refreshed");
  });

  it("400s on a malformed body", async () => {
    const app = makeApp();
    const res = await call(app, "POST", "/safeguard-api/me/push/subscribe", {
      headers: authH(),
      body: { endpoint: "not-a-url", keys: { p256dh: "k", auth: "a" } },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("invalid_body");
  });
});

describe("DELETE /me/push/subscribe", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const app = makeApp();
    const res = await call(app, "DELETE", "/safeguard-api/me/push/subscribe", {
      body: { endpoint: "https://push.example/abc" },
    });
    expect(res.status).toBe(401);
  });

  it("removes only the matching endpoint, leaving others intact", async () => {
    const app = makeApp();
    const now = new Date();
    store.subs.push(
      {
        id: "sub-keep",
        userId: USER,
        endpoint: "https://push.example/keep",
        p256dh: "k",
        auth: "a",
        lang: "en",
        userAgent: "",
        createdAt: now,
        lastSeenAt: now,
      },
      {
        id: "sub-drop",
        userId: USER,
        endpoint: "https://push.example/drop",
        p256dh: "k",
        auth: "a",
        lang: "en",
        userAgent: "",
        createdAt: now,
        lastSeenAt: now,
      },
      // Different user with the same endpoint must NOT be touched.
      {
        id: "sub-other",
        userId: "user_other",
        endpoint: "https://push.example/drop",
        p256dh: "k",
        auth: "a",
        lang: "en",
        userAgent: "",
        createdAt: now,
        lastSeenAt: now,
      },
    );
    const res = await call(app, "DELETE", "/safeguard-api/me/push/subscribe", {
      headers: authH(),
      body: { endpoint: "https://push.example/drop" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const ids = store.subs.map((s) => s.id).sort();
    expect(ids).toEqual(["sub-keep", "sub-other"]);
  });
});

describe("GET /me/push/subscriptions", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const app = makeApp();
    const res = await call(
      app,
      "GET",
      "/safeguard-api/me/push/subscriptions",
    );
    expect(res.status).toBe(401);
  });

  it("returns only the caller's subscriptions", async () => {
    const app = makeApp();
    const now = new Date();
    store.subs.push(
      {
        id: "sub-mine",
        userId: USER,
        endpoint: "https://push.example/mine",
        p256dh: "k",
        auth: "a",
        lang: "en",
        userAgent: "Test",
        createdAt: now,
        lastSeenAt: now,
      },
      {
        id: "sub-theirs",
        userId: "user_other",
        endpoint: "https://push.example/theirs",
        p256dh: "k",
        auth: "a",
        lang: "en",
        userAgent: "",
        createdAt: now,
        lastSeenAt: now,
      },
    );
    const res = await call(
      app,
      "GET",
      "/safeguard-api/me/push/subscriptions",
      { headers: authH() },
    );
    expect(res.status).toBe(200);
    const subs = (res.body as { subscriptions: Array<{ id: string }> })
      .subscriptions;
    expect(subs).toHaveLength(1);
    expect(subs[0]!.id).toBe("sub-mine");
  });
});

// ---------------------------------------------------------------------------
// Cron tick endpoint — secret check
// ---------------------------------------------------------------------------

describe("POST /reminders/tick", () => {
  it("returns 503 when REMINDER_CRON_SECRET is unset", async () => {
    const app = makeApp();
    const res = await call(app, "POST", "/safeguard-api/reminders/tick");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "tick_disabled" });
  });

  it("returns 401 on a bad / missing secret", async () => {
    process.env.REMINDER_CRON_SECRET = "expected-secret";
    const app = makeApp();
    const noHeader = await call(
      app,
      "POST",
      "/safeguard-api/reminders/tick",
    );
    expect(noHeader.status).toBe(401);
    expect(noHeader.body).toEqual({ error: "invalid_secret" });

    const wrong = await call(app, "POST", "/safeguard-api/reminders/tick", {
      headers: { "x-reminder-cron-secret": "nope" },
    });
    expect(wrong.status).toBe(401);
  });

  it("runs the tick and returns the result on a good secret", async () => {
    process.env.REMINDER_CRON_SECRET = "expected-secret";
    const app = makeApp();
    const res = await call(app, "POST", "/safeguard-api/reminders/tick", {
      headers: { "x-reminder-cron-secret": "expected-secret" },
    });
    expect(res.status).toBe(200);
    // No followups in the store, so the tick is a no-op but the shape
    // should match `runReminderTick` output.
    expect(res.body).toMatchObject({
      considered: 0,
      fired: 0,
      delivered: 0,
      pruned: 0,
      errors: 0,
    });
  });

  it("does NOT require a Clerk JWT — only the cron secret", async () => {
    // The real concern: if someone accidentally moved the cron mount
    // behind the gate, every external scheduler would silently 401.
    process.env.REMINDER_CRON_SECRET = "expected-secret";
    const app = makeApp();
    const res = await call(app, "POST", "/safeguard-api/reminders/tick", {
      headers: { "x-reminder-cron-secret": "expected-secret" },
      // No `authorization` header.
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Followup mute / complete — verify the worker honours both flips.
// ---------------------------------------------------------------------------

function seedDueFollowup(
  overrides: Partial<FollowupRow> = {},
): FollowupRow {
  const startAt = new Date("2026-05-08T08:00:00.000Z");
  const cadence = {
    kind: "recurring" as const,
    startAt: startAt.toISOString(),
    timesPerDay: 2,
    durationDays: 3,
  };
  const row: FollowupRow = {
    id: "fu-seed",
    userId: USER,
    appointmentId: "appt-1",
    kind: "medication",
    remindersEnabled: true,
    completedAt: null,
    nextReminderAt: startAt,
    reminderCount: 0,
    cadence,
    titleOriginal: "Take amoxicillin",
    titleTranslated: "Take amoxicillin",
    detailOriginal: "500mg",
    detailTranslated: "500mg",
    plainExplanation: "Antibiotic",
    targetLang: "en",
    sourceLang: "en",
    confidence: "high",
    dueAt: startAt,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  store.followups.push(row);
  store.profiles.push({ userId: row.userId, preferredLanguage: "en" });
  store.subs.push({
    id: "sub-1",
    userId: row.userId,
    endpoint: "https://push.example/ok",
    p256dh: "k",
    auth: "a",
    lang: "en",
    userAgent: "",
    createdAt: new Date(),
    lastSeenAt: new Date(),
  });
  pushResponses.set("https://push.example/ok", "ok");
  return row;
}

describe("POST /me/followups/:id/complete", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const app = makeApp();
    const res = await call(
      app,
      "POST",
      "/safeguard-api/me/followups/fu-seed/complete",
    );
    expect(res.status).toBe(401);
  });

  it("flips completedAt + clears nextReminderAt and the worker then skips the row", async () => {
    const app = makeApp();
    seedDueFollowup();

    const res = await call(
      app,
      "POST",
      "/safeguard-api/me/followups/fu-seed/complete",
      { headers: authH() },
    );
    expect(res.status).toBe(200);
    const fu = store.followups[0]!;
    expect(fu.completedAt).toBeInstanceOf(Date);
    expect(fu.nextReminderAt).toBeNull();

    // Tick well after the original due time — the worker must skip it.
    const result = await runReminderTick(
      new Date("2026-05-08T09:00:00.000Z"),
    );
    expect(result.considered).toBe(0);
    expect(result.fired).toBe(0);
    expect(pushCalls).toHaveLength(0);
    expect(store.sends).toHaveLength(0);
  });

  it("returns 404 when the followup does not belong to the caller", async () => {
    const app = makeApp();
    seedDueFollowup({ userId: "someone_else" });
    const res = await call(
      app,
      "POST",
      "/safeguard-api/me/followups/fu-seed/complete",
      { headers: authH() },
    );
    expect(res.status).toBe(404);
    // Untouched.
    expect(store.followups[0]!.completedAt).toBeNull();
  });
});

describe("PATCH /me/followups/:id (mute toggle)", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const app = makeApp();
    const res = await call(
      app,
      "PATCH",
      "/safeguard-api/me/followups/fu-seed",
      { body: { remindersEnabled: false } },
    );
    expect(res.status).toBe(401);
  });

  it("flips remindersEnabled and the worker then skips the row", async () => {
    const app = makeApp();
    seedDueFollowup();

    const res = await call(
      app,
      "PATCH",
      "/safeguard-api/me/followups/fu-seed",
      { headers: authH(), body: { remindersEnabled: false } },
    );
    expect(res.status).toBe(200);
    expect(store.followups[0]!.remindersEnabled).toBe(false);
    // nextReminderAt should NOT be cleared by a mute toggle — un-muting
    // must resume from the same slot.
    expect(store.followups[0]!.nextReminderAt).not.toBeNull();

    const result = await runReminderTick(
      new Date("2026-05-08T09:00:00.000Z"),
    );
    expect(result.considered).toBe(0);
    expect(result.fired).toBe(0);
    expect(pushCalls).toHaveLength(0);
    expect(store.sends).toHaveLength(0);
  });

  it("re-enabling reminders lets the worker pick it up again", async () => {
    const app = makeApp();
    seedDueFollowup({ remindersEnabled: false });

    // Confirm muted state is initially skipped.
    let result = await runReminderTick(
      new Date("2026-05-08T09:00:00.000Z"),
    );
    expect(result.considered).toBe(0);

    const res = await call(
      app,
      "PATCH",
      "/safeguard-api/me/followups/fu-seed",
      { headers: authH(), body: { remindersEnabled: true } },
    );
    expect(res.status).toBe(200);
    expect(store.followups[0]!.remindersEnabled).toBe(true);

    result = await runReminderTick(new Date("2026-05-08T09:00:00.000Z"));
    expect(result.considered).toBe(1);
    expect(result.fired).toBe(1);
    expect(pushCalls).toHaveLength(1);
  });

  it("400s when the body has no recognised updates", async () => {
    const app = makeApp();
    seedDueFollowup();
    const res = await call(
      app,
      "PATCH",
      "/safeguard-api/me/followups/fu-seed",
      { headers: authH(), body: {} },
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("no_updates");
  });

  it("returns 404 when the followup does not belong to the caller", async () => {
    const app = makeApp();
    seedDueFollowup({ userId: "someone_else" });
    const res = await call(
      app,
      "PATCH",
      "/safeguard-api/me/followups/fu-seed",
      { headers: authH(), body: { remindersEnabled: false } },
    );
    expect(res.status).toBe(404);
    expect(store.followups[0]!.remindersEnabled).toBe(true);
  });
});
