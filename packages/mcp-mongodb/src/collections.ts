/**
 * MongoDB collection names for the Assessment integrity store.
 *
 * Readers and writers both resolve collections through `COLLECTIONS`, so a
 * collection can never be read from one name and written to another.
 */

export const COLLECTIONS = Object.freeze({
  /** Generated assessment suites (`GeneratedTestSuite`). */
  testSuites: "generated_test_suites",
  /** Candidate assessment sessions and their lifecycle status. */
  sessions: "assessment_sessions",
  /** High-frequency browser/workspace telemetry events. */
  microEvents: "micro_events",
  /** Structured integrity (suspicion + plagiarism) reports. */
  integrityReports: "integrity_reports",
} as const);

/** Semantic key identifying a collection, e.g. "sessions". */
export type CollectionName = keyof typeof COLLECTIONS;
/** Actual MongoDB collection name, e.g. "assessment_sessions". */
export type CollectionValue = (typeof COLLECTIONS)[CollectionName];

/** Default database name used when `MONGODB_DATABASE` is not set. */
export const DEFAULT_DATABASE_NAME = "assessment";
