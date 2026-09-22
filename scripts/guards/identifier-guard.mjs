#!/usr/bin/env node
/**
 * Retired-identifier guard.
 *
 * Fails when a public product's vocabulary, branding or product-specific
 * semantics leak into the Assessment runtime. The runtime is everything the
 * product executes: API sources, the MCP package, the console, the container and
 * the compose configuration.
 *
 * Documentation that deliberately records provenance is exempt.
 *
 *   node scripts/guards/identifier-guard.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Runtime roots: nothing here may reference another product's vocabulary. */
const RUNTIME_ROOTS = [
  'apps/api/src',
  'packages/mcp-mongodb/src',
  'apps/console/lib',
  'scripts',
  'docker-compose.yml',
  'Dockerfile',
];

/**
 * Guard files that legitimately contain the identifiers they forbid. The
 * credential guard names one retired cloud project id as a known-bad value.
 */
const SELF = new Set(['identifier-guard.mjs', 'credential-guard.mjs']);

/** Files and directories where provenance language is expected and allowed. */
const EXEMPT = [
  join('docs', 'provenance.md'),
  'NOTICE',
  'CHANGELOG.md',
  join('docs', 'post-pivot-evaluation.md'),
  // The guards themselves must name the identifiers they forbid.
  join('scripts', 'guards', 'identifier-guard.mjs'),
];

/**
 * Each entry is a pattern paired with the reason it is forbidden. The
 * provenance document is the only place these are permitted, because an OSS
 * release must be able to explain its own history.
 */
const BANNED = [
  { pattern: /\bgorilla\b/i, reason: 'hackathon-era branding' },
  { pattern: /\bcerberus\b/i, reason: 'successor product name' },
  { pattern: /\bfinsec\b/i, reason: 'successor product name' },
  { pattern: /\bwebscraping-464710\b/, reason: 'real cloud project id' },
  { pattern: /\bemployeeId\b/, reason: 'successor-domain identifier' },
  { pattern: /\bauditId\b/, reason: 'successor-domain identifier' },
  { pattern: /\bvectorId\b/, reason: 'successor-domain identifier' },
  { pattern: /\brisk_assessments\b/, reason: 'successor-domain collection' },
  { pattern: /\bthreat_scenarios\b/, reason: 'successor-domain collection' },
  { pattern: /\bexfiltration/i, reason: 'successor-domain semantics' },
  { pattern: /\binsider[- ]threat/i, reason: 'successor-domain semantics' },
  { pattern: /\bcompliance[- ]matrix/i, reason: 'successor-domain semantics' },
  { pattern: /\bGPT-5\.6\b/, reason: 'unrelated provider migration' },
  { pattern: /\bopenai\b/i, reason: 'unrelated provider migration' },
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.dart_tool', '.git']);

const failures = [];
let inspected = 0;

function isExempt(fullPath) {
  const rel = relative(root, fullPath);
  return EXEMPT.some((entry) => rel === entry || rel.startsWith(`${entry}${require_sep()}`));
}

function require_sep() {
  return process.platform === 'win32' ? '\\' : '/';
}

function inspectFile(fullPath) {
  const base = fullPath.split(/[\\/]/).pop() ?? '';
  if (SELF.has(base)) return;
  if (isExempt(fullPath)) return;
  if (!/\.(ts|mjs|cjs|js|dart|ya?ml|sh|json|html)$/i.test(fullPath)) return;

  const text = readFileSync(fullPath, 'utf8');
  const rel = relative(root, fullPath);
  inspected += 1;

  for (const { pattern, reason } of BANNED) {
    // Line-by-line so the report points at something actionable.
    text.split('\n').forEach((line, index) => {
      if (pattern.test(line)) {
        failures.push(`${rel}:${index + 1} — ${reason}: ${line.trim().slice(0, 120)}`);
      }
    });
  }
}

function walk(target) {
  const full = join(root, target);

  let stat;
  try {
    stat = statSync(full);
  } catch {
    failures.push(`runtime path is missing: ${target}`);
    return;
  }

  if (!stat.isDirectory()) {
    inspectFile(full);
    return;
  }

  for (const entry of readdirSync(full)) {
    if (SKIP_DIRS.has(entry)) continue;
    const child = join(full, entry);
    if (statSync(child).isDirectory()) {
      walk(relative(root, child));
    } else {
      inspectFile(child);
    }
  }
}

for (const target of RUNTIME_ROOTS) walk(target);

if (failures.length > 0) {
  console.error('Retired-identifier guard failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`Retired-identifier guard passed (${inspected} runtime files inspected).`);
