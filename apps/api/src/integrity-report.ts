/**
 * Integrity-report selection helpers.
 *
 * Stored integrity reports are untrusted input on the way back out of the
 * datastore: they may predate the current shape, carry a non-numeric score, or
 * arrive in any order. Two rules follow, and both matter for review:
 *
 *   - the *newest* report must be selected by its own `generatedAt`, never by
 *     its position in the array. `getIntegrityReports` sorts newest-first, so a
 *     positional "last element" quietly selects the OLDEST report and shows a
 *     reviewer the earliest score and flags for a session analysed many times.
 *   - a score must be a finite, bounded number before it can drive a threshold
 *     or reach a reviewer. `NaN` propagating into a displayed score is worse
 *     than showing nothing.
 */

/** True when a stored value is a usable, finite integrity score. */
export function isUsableScore(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string" && value.trim().length > 0) {
    return Number.isFinite(Number(value));
  }
  return false;
}

/**
 * Coerces a stored value into a bounded 0-100 score.
 *
 * An unusable value becomes `0`, which is the correct reading for the score
 * itself ("no signal recorded"). Callers that must distinguish "scored zero"
 * from "score unusable" should check `isUsableScore` first, as the review route
 * does before deriving a provisional score.
 */
export function finiteScore(value: unknown): number {
  if (!isUsableScore(value)) return 0;
  const numeric = typeof value === "number" ? value : Number(value);
  return Math.max(0, Math.min(100, numeric));
}

/**
 * Returns the report with the newest `generatedAt`.
 *
 * Selection is by timestamp rather than array position, so it cannot invert if
 * the store's sort order changes. Reports with no usable timestamp are ignored
 * while any timestamped report exists; when none is timestamped, the first entry
 * is used, which is the newest under the store's documented newest-first order.
 */
export function selectLatestReport<T>(reports: readonly T[]): T | null {
  let best: T | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;

  for (const report of reports) {
    const at = generatedAtMs(report);
    if (at !== null && at > bestAt) {
      bestAt = at;
      best = report;
    }
  }

  if (best !== null) return best;
  return reports.find((report) => report !== null && report !== undefined) ?? null;
}

/** Epoch milliseconds of a report's `generatedAt`, or null when unusable. */
function generatedAtMs(report: unknown): number | null {
  if (report === null || typeof report !== "object") return null;
  const raw = (report as Record<string, unknown>)["generatedAt"];
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}
