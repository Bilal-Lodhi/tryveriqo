/**
 * Similarity reference material.
 *
 * The similarity report has a settled structure, but until now the corpus it
 * compared against was supplied by the caller and **no caller supplied any** — the
 * ingest route passed an empty array. So "similarity" meant similarity to nothing,
 * which is worse than a weak signal: it reads as a check that is not happening.
 *
 * This module gives it a real, self-hosted source that is already in the store:
 * the **reference solution of the assessment the session belongs to**. A generated
 * suite carries `expectedAnswer` (and often `starterCode`) per problem, written by
 * the operator or the model at generation time, and the suite is already
 * persisted. Using it means:
 *
 *   - the source is explicit and reviewable — a suite id and a problem id;
 *   - no candidate's code is ever used to analyse another candidate, so this
 *     introduces no cross-candidate exposure;
 *   - nothing is scraped, fetched, or sent to a third party;
 *   - the computation is bounded by a fixed reference and character budget.
 *
 * The convention it relies on: a session's `assessmentId` names the stored suite's
 * `suiteId`. When no suite matches, the report says so rather than implying a
 * comparison happened.
 *
 * A similarity score against a reference solution is **not** a plagiarism finding.
 * Matching a published solution is one explanation among several — a correct,
 * idiomatic answer looks like a correct, idiomatic answer. The report says so, and
 * the advisory flag this module drives is worded accordingly.
 */

import type { ReferenceSource } from "./types.js";

/** At most this many reference strings are supplied to an analysis. */
export const MAX_REFERENCES = 3;

/**
 * Total character budget across all references.
 *
 * Bounds both the provider request and the analysis cost. A reference longer than
 * the whole budget is truncated rather than dropped, so a single large solution
 * still contributes something.
 */
export const MAX_REFERENCE_CHARS = 20_000;

export interface BuiltReferences {
  references: string[];
  source: ReferenceSource;
}

/** No comparison source was available, and why. */
function none(reason: string): BuiltReferences {
  return {
    references: [],
    source: { kind: "none", suiteId: null, problemId: null, count: 0, reason },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Builds the reference completions for one session's problem from its stored suite.
 *
 * `suite` is whatever the tool returned — untrusted as far as this function is
 * concerned, since it round-trips through the datastore. Anything unusable yields
 * an explicit `none` source rather than a silent empty comparison.
 */
export function buildReferenceCompletions(
  suite: unknown,
  problemId: string | null,
): BuiltReferences {
  const suiteRecord = asRecord(suite);
  if (!suiteRecord) {
    return none("No stored assessment suite matched this session's assessmentId.");
  }

  const suiteId = typeof suiteRecord["metadata"] === "object" && suiteRecord["metadata"] !== null
    ? String((suiteRecord["metadata"] as Record<string, unknown>)["suiteId"] ?? "")
    : "";

  const problems = Array.isArray(suiteRecord["problems"]) ? suiteRecord["problems"] : [];
  if (problems.length === 0) {
    return none("The stored assessment suite contains no problems.");
  }

  // Prefer the problem the session names; fall back to the first, and say which.
  let problem: Record<string, unknown> | null = null;
  let matchedBy = "first problem";
  if (problemId) {
    for (const candidate of problems) {
      const record = asRecord(candidate);
      if (record && String(record["problemId"] ?? "") === problemId) {
        problem = record;
        matchedBy = "problemId";
        break;
      }
    }
  }
  problem ??= asRecord(problems[0]);
  if (!problem) {
    return none("The stored assessment suite has no usable problem.");
  }

  const resolvedProblemId = String(problem["problemId"] ?? "") || null;

  const candidates: Array<{ label: string; text: string }> = [];
  const expectedAnswer = problem["expectedAnswer"];
  if (typeof expectedAnswer === "string" && expectedAnswer.trim().length > 0) {
    candidates.push({ label: "assessment reference solution", text: expectedAnswer });
  }
  const starterCode = problem["starterCode"];
  if (
    typeof starterCode === "string" &&
    starterCode.trim().length > 0 &&
    starterCode.trim() !== (typeof expectedAnswer === "string" ? expectedAnswer.trim() : "")
  ) {
    candidates.push({ label: "assessment starter code", text: starterCode });
  }

  if (candidates.length === 0) {
    return {
      references: [],
      source: {
        kind: "none",
        suiteId: suiteId || null,
        problemId: resolvedProblemId,
        count: 0,
        reason: "The stored assessment problem carries no reference answer or starter code.",
      },
    };
  }

  const references: string[] = [];
  let budget = MAX_REFERENCE_CHARS;
  for (const candidate of candidates.slice(0, MAX_REFERENCES)) {
    if (budget <= 0) break;
    const text =
      candidate.text.length > budget ? candidate.text.slice(0, budget) : candidate.text;
    references.push(text);
    budget -= text.length;
  }

  return {
    references,
    source: {
      kind: "assessment-solution",
      suiteId: suiteId || null,
      problemId: resolvedProblemId,
      count: references.length,
      // Recorded so a reviewer knows the comparison was against the assessment's
      // own solution and not against other candidates.
      matchedBy,
    },
  };
}
