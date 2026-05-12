import { describe, it, expect } from "vitest";
import { isDiagnosticsCommand } from "../diagnosticCommand";

describe("isDiagnosticsCommand", () => {
  it("matches exact phrase", () => {
    expect(isDiagnosticsCommand("run diagnostics")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isDiagnosticsCommand("Run diagnostics")).toBe(true);
    expect(isDiagnosticsCommand("RUN DIAGNOSTICS")).toBe(true);
    expect(isDiagnosticsCommand("Run Diagnostics")).toBe(true);
  });

  it("allows surrounding whitespace only", () => {
    expect(isDiagnosticsCommand("  run diagnostics  ")).toBe(true);
    expect(isDiagnosticsCommand("\trun diagnostics\t")).toBe(true);
  });

  it("does not match trailing words", () => {
    expect(isDiagnosticsCommand("run diagnostics now")).toBe(false);
    expect(isDiagnosticsCommand("run diagnostics please")).toBe(false);
  });

  it("does not match leading words", () => {
    expect(isDiagnosticsCommand("hey run diagnostics")).toBe(false);
    expect(isDiagnosticsCommand("please run diagnostics")).toBe(false);
  });

  it("does not match partial or alias phrases", () => {
    expect(isDiagnosticsCommand("run diagnostic")).toBe(false);
    expect(isDiagnosticsCommand("diagnostics")).toBe(false);
    expect(isDiagnosticsCommand("run")).toBe(false);
    expect(isDiagnosticsCommand("maintainer mode")).toBe(false);
    expect(isDiagnosticsCommand("maintainer mode now")).toBe(false);
  });

  it("does not match multiline messages containing the phrase", () => {
    expect(isDiagnosticsCommand("run diagnostics\nanything else")).toBe(false);
    expect(isDiagnosticsCommand("anything else\nrun diagnostics")).toBe(false);
    expect(
      isDiagnosticsCommand(
        "run diagnostics now\nrun diagnostics please\nhey run diagnostics\ndiagnostics\nmaintainer mode",
      ),
    ).toBe(false);
  });

  it("does not match non-string input", () => {
    expect(isDiagnosticsCommand(null)).toBe(false);
    expect(isDiagnosticsCommand(undefined)).toBe(false);
    expect(isDiagnosticsCommand(42)).toBe(false);
  });

  it("does not match empty string", () => {
    expect(isDiagnosticsCommand("")).toBe(false);
  });
});
