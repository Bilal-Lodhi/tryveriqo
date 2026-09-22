/**
 * Input handling for assessment generation requests.
 *
 * Two layers, in order:
 *   1. `validateGenerateRequest` — structural validation of the HTTP body.
 *   2. `runContentPreFilter`     — a fast, deterministic check for input that
 *      cannot be a real assessment request (empty, greeting-only, keyboard
 *      mashing, profanity). This runs before the AI classifier so that obvious
 *      junk costs nothing and is rejected instantly.
 *
 * The AI classifier remains the semantic gatekeeper; the pre-filter only
 * removes input that is unambiguously unusable.
 */

import type { DifficultyMix, GenerateTestSuiteRequest } from "./types.js";

export interface ValidationFailure {
  ok: false;
  error: string;
}

export interface ValidationSuccess {
  ok: true;
  value: Required<Pick<GenerateTestSuiteRequest, "prompt" | "roleContext" | "problemCount">> & {
    difficultyMix: DifficultyMix;
  };
}

export type GenerateValidation = ValidationSuccess | ValidationFailure;

export const MIN_PROBLEM_COUNT = 1;
export const MAX_PROBLEM_COUNT = 25;
export const DEFAULT_PROBLEM_COUNT = 5;

const DEFAULT_DIFFICULTY_MIX: DifficultyMix = {
  beginner: 0.33,
  intermediate: 0.34,
  advanced: 0.33,
};

function isDifficultyMix(value: unknown): value is DifficultyMix {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["beginner"] === "number" &&
    typeof candidate["intermediate"] === "number" &&
    typeof candidate["advanced"] === "number"
  );
}

/**
 * Validates the shape of a generation request. Returns a structured failure
 * rather than throwing so the route can map it to a 400.
 */
export function validateGenerateRequest(body: unknown): GenerateValidation {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const candidate = body as Record<string, unknown>;

  const prompt = candidate["prompt"];
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return { ok: false, error: "Field 'prompt' is required and must be a non-empty string." };
  }

  const roleContext = candidate["roleContext"];
  if (typeof roleContext !== "string" || roleContext.trim().length === 0) {
    return { ok: false, error: "Field 'roleContext' is required and must be a non-empty string." };
  }

  const rawCount = candidate["problemCount"];
  const problemCount = rawCount === undefined ? DEFAULT_PROBLEM_COUNT : Number(rawCount);
  if (!Number.isInteger(problemCount) || problemCount < MIN_PROBLEM_COUNT || problemCount > MAX_PROBLEM_COUNT) {
    return {
      ok: false,
      error: `Field 'problemCount' must be an integer between ${MIN_PROBLEM_COUNT} and ${MAX_PROBLEM_COUNT}.`,
    };
  }

  const rawMix = candidate["difficultyMix"];
  const difficultyMix = rawMix === undefined ? DEFAULT_DIFFICULTY_MIX : rawMix;
  if (!isDifficultyMix(difficultyMix)) {
    return {
      ok: false,
      error:
        "Field 'difficultyMix' must be an object with numeric 'beginner', 'intermediate' and 'advanced' weights.",
    };
  }

  return {
    ok: true,
    value: {
      prompt: prompt.trim(),
      roleContext: roleContext.trim(),
      problemCount,
      difficultyMix,
    },
  };
}

// ─── Content pre-filter ────────────────────────────────────────────

export type PreFilterFlag =
  | "EMPTY_INPUT"
  | "GREETING_ONLY"
  | "TOO_SHORT"
  | "PROFANITY"
  | "GIBBERISH";

export interface PreFilterResult {
  passed: boolean;
  reason: string;
  flags: PreFilterFlag[];
}

/**
 * Deliberately small profanity list limited to unambiguous, high-severity
 * terms. Slurs and sexual content are covered; mild language is left to the
 * semantic classifier so legitimate technical prompts are never blocked.
 */
const PROFANITY_PATTERNS: readonly RegExp[] = [
  /\bf+u+c+k+\w*\b/i,
  /\bs+h+i+t+\w*\b/i,
  /\bb+i+t+c+h+\w*\b/i,
  /\bc+u+n+t+\w*\b/i,
  /\bass+hole\w*\b/i,
  /\bbastard\w*\b/i,
  /\bwh+o+r+e+\w*\b/i,
  /\bsl+u+t+\w*\b/i,
  /\bn+i+g+g+\w*\b/i,
  /\bf+a+g+g+o+t+\w*\b/i,
  /\br+e+t+a+r+d+\w*\b/i,
];

/**
 * Keyboard mashing and low-entropy patterns.
 *
 * Only high-precision rules live here, because a false rejection of a
 * legitimate prompt is worse than letting a borderline input reach the semantic
 * classifier. A vowel-density heuristic was tried and removed: long technical
 * words ("microservices", "troubleshooting") sit close to the ratio of real
 * keyboard mashing, so it produced false positives. Ambiguous input is passed
 * to the AI classifier, which is the semantic gatekeeper.
 */
const GIBBERISH_PATTERNS: readonly RegExp[] = [
  /(.)\1{5,}/, // The same character six or more times in a row
  /^[\W\d_]+$/, // No letters at all (punctuation, digits, symbols)
  /^[^aeiou\s]{16,}$/i, // Sixteen or more consonants and no vowel
];

/** Physical keyboard rows, in both directions. */
const KEYBOARD_ROWS: readonly string[] = [
  "qwertyuiop",
  "asdfghjkl",
  "zxcvbnm",
  "1234567890",
].flatMap((row) => [row, [...row].reverse().join("")]);

/**
 * Minimum run of physically adjacent keys before it counts as mashing. Real
 * words do contain short adjacent runs ("as", "we", "zx"), so the threshold is
 * set well above them.
 */
export const MASH_MIN_RUN = 6;

/**
 * True when a single unbroken token is largely a keyboard-row sweep, e.g.
 * "qwertyuiop" or "asdfghjklzxcvbnm". Prose and multi-token input are never
 * treated as mashing.
 */
function looksLikeKeyboardRowMash(input: string): boolean {
  const normalised = input.toLowerCase();
  if (/\s/.test(normalised) || normalised.length < MASH_MIN_RUN + 4) return false;

  return KEYBOARD_ROWS.some((row) => {
    for (let start = 0; start + MASH_MIN_RUN <= row.length; start += 1) {
      if (normalised.includes(row.slice(start, start + MASH_MIN_RUN))) return true;
    }
    return false;
  });
}

const GREETING_PATTERN =
  /^(hi+|hey+|hello+|yo|sup|howdy|hola|greetings)(\s+(there|all|everyone|everybody|folks|team|friend|buddy))?[\s!.,?]*$|^good\s*(morning|afternoon|evening|day)[\s!.,?]*$|^what'?s\s*up[\s!.,?]*$/i;

export function isGreetingOnly(input: string): boolean {
  return GREETING_PATTERN.test(input.trim());
}

/**
 * Runs the deterministic pre-filter. Never throws, and never consults the
 * network.
 */
export function runContentPreFilter(input: string): PreFilterResult {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return { passed: false, reason: "Input is empty.", flags: ["EMPTY_INPUT"] };
  }

  // Greetings are checked before length so that "hi" reports the useful reason.
  if (isGreetingOnly(trimmed)) {
    return {
      passed: false,
      reason: "That is a greeting, not an assessment request. Describe the assessment you want to generate.",
      flags: ["GREETING_ONLY"],
    };
  }

  if (trimmed.length < 3) {
    return { passed: false, reason: "Input is too short to be an assessment request.", flags: ["TOO_SHORT"] };
  }

  for (const pattern of PROFANITY_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        passed: false,
        reason: "The request contains inappropriate language. Please rewrite it.",
        flags: ["PROFANITY"],
      };
    }
  }

  for (const pattern of GIBBERISH_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        passed: false,
        reason: "The request looks like keyboard mashing rather than an assessment description.",
        flags: ["GIBBERISH"],
      };
    }
  }

  if (looksLikeKeyboardRowMash(trimmed)) {
    return {
      passed: false,
      reason: "The request looks like keyboard mashing rather than an assessment description.",
      flags: ["GIBBERISH"],
    };
  }

  return { passed: true, reason: "Pre-filter passed.", flags: [] };
}

/**
 * The difficulty weights are advisory: a model may still be asked to generate
 * even when they do not sum to 1. This reports the deviation so callers can log
 * it without rejecting an otherwise valid request.
 */
export function difficultyMixDeviation(mix: DifficultyMix): number {
  const sum = mix.beginner + mix.intermediate + mix.advanced;
  return Math.abs(sum - 1);
}
