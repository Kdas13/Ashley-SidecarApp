/**
 * Diagnostic command predicate.
 *
 * Only the exact phrase "run diagnostics" (case-insensitive, optional
 * surrounding whitespace) may trigger the diagnostic report.
 *
 * Must be called with the raw, unmodified message string — before any
 * trim(), toLowerCase(), word removal, or other normalisation.
 */
export function isDiagnosticsCommand(rawMessage: string): boolean {
  return /^\s*run diagnostics\s*$/i.test(rawMessage);
}
