/**
 * Diagnostic command predicate.
 *
 * Triggers ONLY when the entire raw user message, after trimming outer
 * whitespace only, equals "run diagnostics" case-insensitively.
 *
 * Must be called with the raw, unmodified message string — before any
 * processing. No regex, no line-splitting, no alias matching.
 */
export function isDiagnosticsCommand(rawMessage: unknown): boolean {
  if (typeof rawMessage !== "string") return false;
  return rawMessage.trim().toLowerCase() === "run diagnostics";
}
