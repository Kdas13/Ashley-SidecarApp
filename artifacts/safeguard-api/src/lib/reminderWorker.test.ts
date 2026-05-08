import { describe, it, expect, beforeEach, vi } from "vitest";

// Set VAPID env BEFORE the worker module is evaluated so `ensureVapid()`
// returns true and the tick actually runs.
vi.stubEnv("VAPID_PUBLIC_KEY", "test-public-key");
vi.stubEnv("VAPID_PRIVATE_KEY", "test-private-key");
vi.stubEnv("VAPID_SUBJECT", "mailto:test@example.org");

// ---------------------------------------------------------------------------
// In-memory stand-ins for the four tables the worker touches.
// Test cases reset & seed these via the exported `__store` handle.
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

// Tagged column / table identities so our predicate evaluator can read row
// values out of the in-memory store.
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
  isNull: (col: ColRef) => ({ __op: "isNull", col }),
  and: (...args: Pred[]) => ({ __op: "and", args }),
}));

vi.mock("@workspace/db", () => {
  const db = {
    select(projection?: Record<string, ColRef>) {
      let table: { __t: string } | null = null;
      let pred: Pred = undefined;
      const builder = {
        from(t: { __t: string }) {
          table = t;
          return builder;
        },
        where(p: Pred) {
          pred = p;
          return builder;
        },
        limit(_n: number) {
          return Promise.resolve(execute());
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
          return {
            onConflictDoNothing(_opts: { target?: ColRef[] }) {
              return {
                returning(projection: Record<string, ColRef>) {
                  if (table.__t === "sends") {
                    const dup = store.sends.find(
                      (s) =>
                        s.followupId === v["followupId"] &&
                        s.scheduledFor.getTime() ===
                          (v["scheduledFor"] as Date).getTime(),
                    );
                    if (dup) return Promise.resolve([]);
                    const row: SendRow = {
                      id: nextId("send"),
                      followupId: v["followupId"] as string,
                      userId: v["userId"] as string,
                      scheduledFor: v["scheduledFor"] as Date,
                      success: (v["success"] as boolean) ?? false,
                      deliveredCount:
                        (v["deliveredCount"] as number) ?? 0,
                      errorMessage: (v["errorMessage"] as string) ?? "",
                    };
                    store.sends.push(row);
                    return Promise.resolve([
                      project(
                        row as unknown as Record<string, unknown>,
                        projection,
                      ),
                    ]);
                  }
                  return Promise.resolve([]);
                },
              };
            },
          };
        },
      };
    },

    update(table: { __t: string }) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where(pred: Pred) {
              const rows = rowsFor(table).filter((r) => evalPred(pred, r));
              for (const r of rows) {
                Object.assign(r, values);
              }
              return Promise.resolve();
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
  };
});

// web-push: per-test programmable response per endpoint.
const pushResponses = new Map<string, { status: number } | "ok">();
const pushCalls: { endpoint: string; payload: string }[] = [];

vi.mock("web-push", () => {
  return {
    default: {
      setVapidDetails: vi.fn(),
      sendNotification: vi.fn(
        async (
          sub: { endpoint: string },
          payload: string,
          _opts: unknown,
        ) => {
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
  };
});

// Import AFTER mocks are registered.
const { runReminderTick } = await import("./reminderWorker");
const { nthReminderAt } = await import("./reminderScheduler");

beforeEach(() => {
  store.followups = [];
  store.profiles = [];
  store.subs = [];
  store.sends = [];
  store.nextId = 1;
  pushResponses.clear();
  pushCalls.length = 0;
});

describe("runReminderTick", () => {
  it(
    "delivers a due reminder, advances next_reminder_at, increments " +
      "reminder_count, writes a single send row, and prunes 410 subs",
    async () => {
      const startAt = new Date("2026-05-08T08:00:00.000Z");
      const cadence = {
        kind: "recurring" as const,
        startAt: startAt.toISOString(),
        timesPerDay: 2,
        durationDays: 3,
      };
      const userId = "user_test";
      store.profiles.push({ userId, preferredLanguage: "en" });
      store.followups.push({
        id: "fu-1",
        userId,
        appointmentId: "appt-1",
        kind: "medication",
        remindersEnabled: true,
        completedAt: null,
        nextReminderAt: startAt,
        reminderCount: 0,
        cadence,
        titleOriginal: "Take amoxicillin",
        titleTranslated: "Take amoxicillin",
        detailOriginal: "500mg with water",
        detailTranslated: "500mg with water",
        plainExplanation: "Antibiotic — finish the course",
        targetLang: "en",
      });
      store.subs.push(
        {
          id: "sub-good",
          userId,
          endpoint: "https://push.example/good",
          p256dh: "k1",
          auth: "a1",
        },
        {
          id: "sub-gone",
          userId,
          endpoint: "https://push.example/gone",
          p256dh: "k2",
          auth: "a2",
        },
      );
      pushResponses.set("https://push.example/good", "ok");
      pushResponses.set("https://push.example/gone", { status: 410 });

      // Tick at startAt + 1ms — the slot is due.
      const result = await runReminderTick(
        new Date(startAt.getTime() + 1000),
      );

      expect(result.considered).toBe(1);
      expect(result.fired).toBe(1);
      expect(result.delivered).toBe(1);
      expect(result.pruned).toBe(1);
      expect(result.errors).toBe(0);

      // Exactly one send row, success, delivered_count=1, dedup key = the slot.
      expect(store.sends).toHaveLength(1);
      const sentRow = store.sends[0]!;
      expect(sentRow.followupId).toBe("fu-1");
      expect(sentRow.userId).toBe(userId);
      expect(sentRow.scheduledFor.getTime()).toBe(startAt.getTime());
      expect(sentRow.success).toBe(true);
      expect(sentRow.deliveredCount).toBe(1);

      // Followup advanced to slot #1 and reminder_count incremented.
      const fu = store.followups[0]!;
      expect(fu.reminderCount).toBe(1);
      const expectedNext = nthReminderAt(cadence, 1);
      expect(fu.nextReminderAt?.getTime()).toBe(expectedNext?.getTime());

      // The 410 subscription was pruned; the good one stays.
      expect(store.subs.map((s) => s.id)).toEqual(["sub-good"]);

      // web-push was called once per subscription.
      expect(pushCalls).toHaveLength(2);
      const payload = JSON.parse(pushCalls[0]!.payload);
      expect(payload.followupId).toBe("fu-1");
      expect(payload.title).toBe("Take amoxicillin");
    },
  );

  it("is idempotent: a second tick at the same instant does not re-send the same slot", async () => {
    const startAt = new Date("2026-05-08T08:00:00.000Z");
    const cadence = {
      kind: "once" as const,
      at: startAt.toISOString(),
    };
    const userId = "user_idem";
    store.profiles.push({ userId, preferredLanguage: "en" });
    store.followups.push({
      id: "fu-once",
      userId,
      appointmentId: "appt-1",
      kind: "followup",
      remindersEnabled: true,
      completedAt: null,
      nextReminderAt: startAt,
      reminderCount: 0,
      cadence,
      titleOriginal: "Book follow-up",
      titleTranslated: "Book follow-up",
      detailOriginal: "",
      detailTranslated: "",
      plainExplanation: "",
      targetLang: "en",
    });
    store.subs.push({
      id: "sub-1",
      userId,
      endpoint: "https://push.example/ok",
      p256dh: "k",
      auth: "a",
    });
    pushResponses.set("https://push.example/ok", "ok");

    await runReminderTick(new Date(startAt.getTime() + 1000));
    // Once cadence: nextReminderAt becomes null, so re-running should be a no-op.
    const fu = store.followups[0]!;
    expect(fu.nextReminderAt).toBeNull();
    expect(fu.reminderCount).toBe(1);
    expect(store.sends).toHaveLength(1);

    const second = await runReminderTick(
      new Date(startAt.getTime() + 60_000),
    );
    expect(second.considered).toBe(0);
    expect(second.fired).toBe(0);
    expect(store.sends).toHaveLength(1);
  });

  it("does not re-send when the (followupId, scheduledFor) slot is already claimed", async () => {
    // Simulate a sibling worker (in-process tick + cron, etc.) having
    // already claimed this exact slot by pre-inserting the send row with
    // the same dedup key. The tick must lose the race cleanly: no extra
    // send row, no push call, and no advancement of next_reminder_at.
    const startAt = new Date("2026-05-08T08:00:00.000Z");
    const userId = "user_race";
    store.profiles.push({ userId, preferredLanguage: "en" });
    store.followups.push({
      id: "fu-race",
      userId,
      appointmentId: "appt-1",
      kind: "medication",
      remindersEnabled: true,
      completedAt: null,
      nextReminderAt: startAt,
      reminderCount: 0,
      cadence: {
        kind: "recurring",
        startAt: startAt.toISOString(),
        timesPerDay: 2,
        durationDays: 3,
      },
      titleOriginal: "x",
      titleTranslated: "x",
      detailOriginal: "",
      detailTranslated: "",
      plainExplanation: "",
      targetLang: "en",
    });
    store.subs.push({
      id: "sub-1",
      userId,
      endpoint: "https://push.example/ok",
      p256dh: "k",
      auth: "a",
    });
    pushResponses.set("https://push.example/ok", "ok");
    // Pre-claim the slot.
    store.sends.push({
      id: "send-existing",
      followupId: "fu-race",
      userId,
      scheduledFor: startAt,
      success: true,
      deliveredCount: 1,
      errorMessage: "",
    });

    const result = await runReminderTick(new Date(startAt.getTime() + 1000));
    expect(result.considered).toBe(1);
    expect(result.fired).toBe(0);
    expect(pushCalls).toHaveLength(0);
    // No extra send row; the existing claim is untouched.
    expect(store.sends).toHaveLength(1);
    expect(store.sends[0]!.id).toBe("send-existing");
    // Followup state must NOT advance — the claiming worker owns that.
    const fu = store.followups[0]!;
    expect(fu.reminderCount).toBe(0);
    expect(fu.nextReminderAt?.getTime()).toBe(startAt.getTime());
  });

  it("skips followups that are completed or have reminders disabled", async () => {
    const now = new Date("2026-05-08T10:00:00.000Z");
    const past = new Date(now.getTime() - 60_000);
    const userId = "user_skip";
    store.profiles.push({ userId, preferredLanguage: "en" });
    store.subs.push({
      id: "sub-1",
      userId,
      endpoint: "https://push.example/ok",
      p256dh: "k",
      auth: "a",
    });
    pushResponses.set("https://push.example/ok", "ok");
    store.followups.push(
      {
        id: "fu-completed",
        userId,
        appointmentId: "appt-1",
        kind: "medication",
        remindersEnabled: true,
        completedAt: new Date(now.getTime() - 1000),
        nextReminderAt: past,
        reminderCount: 0,
        cadence: { kind: "once", at: past.toISOString() },
        titleOriginal: "x",
        titleTranslated: "x",
        detailOriginal: "",
        detailTranslated: "",
        plainExplanation: "",
        targetLang: "en",
      },
      {
        id: "fu-disabled",
        userId,
        appointmentId: "appt-1",
        kind: "medication",
        remindersEnabled: false,
        completedAt: null,
        nextReminderAt: past,
        reminderCount: 0,
        cadence: { kind: "once", at: past.toISOString() },
        titleOriginal: "x",
        titleTranslated: "x",
        detailOriginal: "",
        detailTranslated: "",
        plainExplanation: "",
        targetLang: "en",
      },
    );

    const result = await runReminderTick(now);
    expect(result.considered).toBe(0);
    expect(store.sends).toHaveLength(0);
    expect(pushCalls).toHaveLength(0);
  });
});
