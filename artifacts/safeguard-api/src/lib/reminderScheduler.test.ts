import { describe, it, expect } from "vitest";
import {
  parseCadence,
  nthReminderAt,
  nextReminderAfter,
  type Cadence,
} from "./reminderScheduler";

describe("parseCadence", () => {
  it("returns none for nullish / non-object input", () => {
    expect(parseCadence(null)).toEqual({ kind: "none" });
    expect(parseCadence(undefined)).toEqual({ kind: "none" });
    expect(parseCadence("once")).toEqual({ kind: "none" });
    expect(parseCadence(42)).toEqual({ kind: "none" });
  });

  it("returns none for unrecognised kinds", () => {
    expect(parseCadence({ kind: "weekly" })).toEqual({ kind: "none" });
    expect(parseCadence({})).toEqual({ kind: "none" });
  });

  it("parses a valid once cadence and normalises the timestamp", () => {
    const at = "2026-05-08T09:00:00.000Z";
    const c = parseCadence({ kind: "once", at });
    expect(c).toEqual({ kind: "once", at });
  });

  it("rejects a once cadence with a bad timestamp", () => {
    expect(parseCadence({ kind: "once", at: "not a date" })).toEqual({
      kind: "none",
    });
    expect(parseCadence({ kind: "once" })).toEqual({ kind: "none" });
  });

  it("parses recurring cadences across the supported ranges", () => {
    const startAt = "2026-05-08T08:00:00.000Z";
    for (const tpd of [1, 2, 3, 4, 5, 6]) {
      for (const dd of [1, 7, 30, 60]) {
        const c = parseCadence({
          kind: "recurring",
          startAt,
          timesPerDay: tpd,
          durationDays: dd,
        });
        expect(c).toEqual({
          kind: "recurring",
          startAt,
          timesPerDay: tpd,
          durationDays: dd,
        });
      }
    }
  });

  it("clamps recurring cadences with out-of-range numbers to none", () => {
    const startAt = "2026-05-08T08:00:00.000Z";
    expect(
      parseCadence({
        kind: "recurring",
        startAt,
        timesPerDay: 0,
        durationDays: 5,
      }),
    ).toEqual({ kind: "none" });
    expect(
      parseCadence({
        kind: "recurring",
        startAt,
        timesPerDay: 7,
        durationDays: 5,
      }),
    ).toEqual({ kind: "none" });
    expect(
      parseCadence({
        kind: "recurring",
        startAt,
        timesPerDay: 2,
        durationDays: 0,
      }),
    ).toEqual({ kind: "none" });
    expect(
      parseCadence({
        kind: "recurring",
        startAt,
        timesPerDay: 2,
        durationDays: 61,
      }),
    ).toEqual({ kind: "none" });
  });

  it("rounds non-integer times/durations to the nearest integer", () => {
    const startAt = "2026-05-08T08:00:00.000Z";
    expect(
      parseCadence({
        kind: "recurring",
        startAt,
        timesPerDay: 2.4,
        durationDays: 7.6,
      }),
    ).toEqual({
      kind: "recurring",
      startAt,
      timesPerDay: 2,
      durationDays: 8,
    });
  });

  it("coerces numeric strings inside the allowed range", () => {
    const startAt = "2026-05-08T08:00:00.000Z";
    expect(
      parseCadence({
        kind: "recurring",
        startAt,
        timesPerDay: "3",
        durationDays: "5",
      }),
    ).toEqual({
      kind: "recurring",
      startAt,
      timesPerDay: 3,
      durationDays: 5,
    });
  });

  it("rejects recurring with NaN / non-numeric / missing fields", () => {
    const startAt = "2026-05-08T08:00:00.000Z";
    expect(
      parseCadence({
        kind: "recurring",
        startAt,
        timesPerDay: "many",
        durationDays: 5,
      }),
    ).toEqual({ kind: "none" });
    expect(
      parseCadence({
        kind: "recurring",
        startAt,
        durationDays: 5,
      }),
    ).toEqual({ kind: "none" });
    expect(
      parseCadence({
        kind: "recurring",
        timesPerDay: 2,
        durationDays: 5,
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("nthReminderAt", () => {
  it("returns null for negative indexes", () => {
    expect(
      nthReminderAt({ kind: "once", at: "2026-05-08T09:00:00Z" }, -1),
    ).toBeNull();
  });

  it("returns null for kind=none", () => {
    expect(nthReminderAt({ kind: "none" }, 0)).toBeNull();
  });

  it("returns the once timestamp at index 0 and null afterwards", () => {
    const at = "2026-05-08T09:00:00.000Z";
    expect(nthReminderAt({ kind: "once", at }, 0)?.toISOString()).toBe(at);
    expect(nthReminderAt({ kind: "once", at }, 1)).toBeNull();
  });

  it("spaces recurring slots evenly across 24h", () => {
    const startAt = "2026-05-08T08:00:00.000Z";
    const c: Cadence = {
      kind: "recurring",
      startAt,
      timesPerDay: 4,
      durationDays: 2,
    };
    // 4x daily => every 6 hours
    expect(nthReminderAt(c, 0)?.toISOString()).toBe(startAt);
    expect(nthReminderAt(c, 1)?.toISOString()).toBe(
      "2026-05-08T14:00:00.000Z",
    );
    expect(nthReminderAt(c, 2)?.toISOString()).toBe(
      "2026-05-08T20:00:00.000Z",
    );
    expect(nthReminderAt(c, 3)?.toISOString()).toBe(
      "2026-05-09T02:00:00.000Z",
    );
  });

  it("returns null once the recurring schedule is exhausted", () => {
    const c: Cadence = {
      kind: "recurring",
      startAt: "2026-05-08T08:00:00.000Z",
      timesPerDay: 2,
      durationDays: 3,
    };
    // total = 6 slots (indexes 0..5)
    expect(nthReminderAt(c, 5)).not.toBeNull();
    expect(nthReminderAt(c, 6)).toBeNull();
    expect(nthReminderAt(c, 100)).toBeNull();
  });
});

describe("nextReminderAfter", () => {
  it("matches nthReminderAt(cadence, alreadySent)", () => {
    const c: Cadence = {
      kind: "recurring",
      startAt: "2026-05-08T08:00:00.000Z",
      timesPerDay: 3,
      durationDays: 1,
    };
    expect(nextReminderAfter(c, 0)?.toISOString()).toBe(
      nthReminderAt(c, 0)?.toISOString(),
    );
    expect(nextReminderAfter(c, 2)?.toISOString()).toBe(
      nthReminderAt(c, 2)?.toISOString(),
    );
    expect(nextReminderAfter(c, 3)).toBeNull();
  });
});
