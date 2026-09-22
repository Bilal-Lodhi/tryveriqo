/**
 * Canonical time helpers.
 *
 * All persisted timestamps are UTC ISO-8601 with milliseconds (`Z` suffix).
 * Storage stays UTC so that timelines from different reviewers, regions and
 * containers remain comparable and sortable; conversion to a viewer's local
 * time zone is a presentation concern and happens in the console.
 */

/** Current time as a UTC ISO-8601 string with milliseconds. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Normalises any accepted timestamp value to a UTC ISO-8601 string. */
export function toIso(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid timestamp: ${String(value)}`);
  }
  return date.toISOString();
}

/** Parses a timestamp, returning `null` instead of throwing on bad input. */
export function parseIsoOrNull(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date)) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Human-readable label for a timestamp, rendered in the server's local time
 * zone. Intended for console display and log messages only — never for
 * storage or comparison.
 */
export function formatLocalTimeLabel(value: Date | string, now: Date = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";

  const sameDay =
    now.getFullYear() === date.getFullYear() &&
    now.getMonth() === date.getMonth() &&
    now.getDate() === date.getDate();

  const hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const period = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 || 12;
  const clock = `${hour12}:${minutes} ${period}`;

  if (sameDay) return `Today ${clock}`;

  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[date.getMonth()]} ${date.getDate()}, ${clock}`;
}
