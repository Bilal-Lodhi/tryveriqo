#!/usr/bin/env node
/**
 * Credential guard.
 *
 * Fails when the working tree could be about to publish a secret or a real
 * cloud identifier. This is a structural check, not a secret scanner: gitleaks
 * runs alongside it in CI for entropy-based detection.
 *
 *   node scripts/guards/credential-guard.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.dart_tool',
  '.idea',
  '.vscode',
]);

/**
 * Files that legitimately contain the literal patterns this guard searches for.
 * They are the guard implementations themselves.
 */
const SELF = new Set(['credential-guard.mjs', 'identifier-guard.mjs']);

const failures = [];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, files);
    } else {
      files.push(full);
    }
  }
  return files;
}

const files = walk(root);

// ── 1. No committed environment file ──────────────────────────────────────
for (const file of files) {
  const name = file.split(/[\\/]/).pop() ?? '';
  if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) {
    failures.push(`environment file present: ${relative(root, file)}`);
  }
  if (name === 'application_default_credentials.json') {
    failures.push(`Google ADC file present: ${relative(root, file)}`);
  }
  if (/\.(pem|p12|pfx|key)$/i.test(name) && !name.endsWith('.example')) {
    failures.push(`key material present: ${relative(root, file)}`);
  }
}

// ── 2. No real Google Cloud project identifier ────────────────────────────
// Real project ids are lowercase, and typically include a hyphen and digits.
const PROJECT_ID_PATTERN = /\b[a-z][a-z0-9-]{4,28}[0-9]\b/;
const CLOUD_KEYS = [
  'GCP_PROJECT_ID',
  'GEMINI_VERTEX_PROJECT',
  'GOOGLE_CLOUD_PROJECT',
  'PROJECT_ID',
];
const KNOWN_RETIRED = ['webscraping-464710'];

for (const file of files) {
  if (SELF.has(file.split(/[\\/]/).pop() ?? '')) continue;
  if (!/\.(ts|js|mjs|cjs|json|ya?ml|md|sh|ps1|dart|example|txt)$/i.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  const where = relative(root, file);

  for (const retired of KNOWN_RETIRED) {
    if (text.includes(retired)) failures.push(`retired project id "${retired}" in ${where}`);
  }

  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (!CLOUD_KEYS.includes(key)) continue;
    if (value.length === 0 || value.startsWith('#') || value.startsWith('$')) continue;
    if (PROJECT_ID_PATTERN.test(value)) {
      failures.push(`looks like a real project id in ${where}: ${key}=${value}`);
    }
  }
}

// ── 3. The template must never carry a value ──────────────────────────────
const templatePath = join(root, '.env.example');
if (!existsSync(templatePath)) {
  failures.push('.env.example is missing');
} else {
  for (const line of readFileSync(templatePath, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (!/(KEY|TOKEN|SECRET|PASSWORD|URI)$/.test(key)) continue;
    // A placeholder URI (no credentials) and a blank value are both fine.
    if (value.length === 0) continue;
    if (/^mongodb:\/\/[a-z0-9.]+:\d+$/i.test(value)) continue;
    failures.push(`.env.example sets a value for ${key}; templates must stay blank`);
  }
}

// ── 4. No private key block anywhere ──────────────────────────────────────
for (const file of files) {
  if (SELF.has(file.split(/[\\/]/).pop() ?? '')) continue;
  if (/(\.png|\.jpg|\.jpeg|\.webp|\.gif|\.ico)$/i.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  if (text.includes('-----BEGIN') && text.includes('PRIVATE KEY-----')) {
    failures.push(`private key block in ${relative(root, file)}`);
  }
}

if (failures.length > 0) {
  console.error('Credential guard failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`Credential guard passed (${files.length} files inspected).`);
