#!/usr/bin/env node
/**
 * Credential guard.
 *
 * Fails when the repository could be about to publish a secret or a real cloud
 * identifier. This is a structural check, not a secret scanner: gitleaks runs
 * alongside it in CI for entropy-based detection.
 *
 *   node scripts/guards/credential-guard.mjs
 *   node scripts/guards/credential-guard.mjs --include-untracked
 *   node scripts/guards/credential-guard.mjs --self-test
 *
 * ## Which files it inspects, and why that is a decision
 *
 * The default set is **tracked files** (`git ls-files`). That is what makes the
 * verdict reproducible: CI checks out exactly the tracked tree, so a local run
 * over tracked files and a CI run over the same commit must agree. The guard
 * previously walked the working directory, which meant an untracked local file
 * could fail it locally while CI passed — a guard whose two verdicts differ for
 * the same repository content is one contributors learn to ignore.
 *
 * `--include-untracked` widens the set to tracked **plus committable** files
 * (untracked and not ignored), which is the set a `git commit -a` would publish.
 * It is a local pre-commit aid: CI cannot reproduce a failure it finds in a file
 * that is not in the repository, and the output says so.
 *
 * Ignored files — including `.env` and `application_default_credentials.json` —
 * are outside both sets by design, because an ignored file cannot be published.
 * `.gitignore` covers them, and CI separately asserts that no environment file is
 * tracked.
 */

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Files that legitimately contain the literal patterns this guard searches for. */
const SELF = new Set(['credential-guard.mjs', 'identifier-guard.mjs']);

/**
 * Tracked files that name a retired identifier on purpose.
 *
 * `.gitleaks.toml` lists the retired project id as a detection pattern, exactly
 * as the guards name what they forbid. It is exempted by path rather than by
 * dropping `.toml` from the scanned extensions, so a *different* TOML file
 * carrying a real project id is still caught.
 */
const EXEMPT_PATHS = new Set(['.gitleaks.toml']);

/** Extensions worth reading. Binary assets are skipped. */
const TEXT_EXTENSIONS = /\.(ts|js|mjs|cjs|json|ya?ml|md|sh|ps1|dart|example|txt|toml)$/i;

/** Real project ids are lowercase, and typically include a hyphen and digits. */
const PROJECT_ID_PATTERN = /\b[a-z][a-z0-9-]{4,28}[0-9]\b/;
const CLOUD_KEYS = ['GCP_PROJECT_ID', 'GEMINI_VERTEX_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'PROJECT_ID'];
const KNOWN_RETIRED = ['webscraping-464710'];

const ENV_FILE_NAMES = new Set(['.env', 'application_default_credentials.json']);
const KEY_EXTENSION = /\.(pem|p12|pfx|key)$/i;

// ─── File discovery ────────────────────────────────────────────────

/** Runs git in `cwd` and returns its NUL-separated stdout as paths. */
function gitPaths(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`);
  }
  return (result.stdout ?? '').split('\0').filter((entry) => entry.length > 0);
}

/**
 * The files to inspect, relative to `cwd`.
 *
 * `--exclude-standard` keeps ignored files out of the untracked half, so the
 * widened set is exactly "what a commit could publish".
 */
export function filesToInspect(cwd, includeUntracked) {
  const args = includeUntracked
    ? ['ls-files', '-z', '--cached', '--others', '--exclude-standard']
    : ['ls-files', '-z'];
  return gitPaths(args, cwd).sort();
}

// ─── Checks ────────────────────────────────────────────────────────

/**
 * Inspects one set of files and returns the failures found.
 *
 * Exported shape kept simple on purpose: `runChecks` is pure over (cwd, files) so
 * the self-test can drive it in a scratch repository.
 */
export function runChecks(cwd, files) {
  const failures = [];

  for (const relativePath of files) {
    const name = basename(relativePath);
    const full = join(cwd, relativePath);

    // ── 1. No committed environment file or credential material ──────
    if (ENV_FILE_NAMES.has(name)) {
      failures.push(
        name === 'application_default_credentials.json'
          ? `Google ADC file present: ${relativePath}`
          : `environment file present: ${relativePath}`,
      );
    }
    if (KEY_EXTENSION.test(name) && !name.endsWith('.example')) {
      failures.push(`key material present: ${relativePath}`);
    }

    if (SELF.has(name)) continue;
    if (EXEMPT_PATHS.has(relativePath)) continue;
    if (!TEXT_EXTENSIONS.test(relativePath)) continue;

    let text;
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      // A tracked path that is not on disk (a deleted-but-unstaged file) is not
      // something this guard can judge. Skip it rather than fail.
      continue;
    }

    // ── 2. No retired cloud project identifier ──────────────────────
    for (const retired of KNOWN_RETIRED) {
      if (text.includes(retired)) failures.push(`retired project id "${retired}" in ${relativePath}`);
    }

    // ── 3. No real-looking project id assigned to a cloud key ───────
    for (const line of text.split('\n')) {
      const match = /^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (!match) continue;
      const [, key, value] = match;
      if (!CLOUD_KEYS.includes(key)) continue;
      if (value.length === 0 || value.startsWith('#') || value.startsWith('$')) continue;
      if (PROJECT_ID_PATTERN.test(value)) {
        failures.push(`looks like a real project id in ${relativePath}: ${key}=${value}`);
      }
    }

    // ── 4. No private key block ─────────────────────────────────────
    if (text.includes('-----BEGIN') && text.includes('PRIVATE KEY-----')) {
      failures.push(`private key block in ${relativePath}`);
    }
  }

  // ── 5. The template must never carry a credential value ───────────
  try {
    const template = readFileSync(join(cwd, '.env.example'), 'utf8');
    for (const line of template.split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const [, key, value] = match;
      if (!/(KEY|TOKEN|SECRET|PASSWORD|URI)$/.test(key)) continue;
      if (value.length === 0) continue;
      if (/^mongodb:\/\/[a-z0-9.]+:\d+$/i.test(value)) continue;
      failures.push(`.env.example sets a value for ${key}; templates must stay blank`);
    }
  } catch {
    // Only a tracked repository is expected to have the template. A scratch
    // repository in the self-test has none, and that is not a failure.
  }

  return failures;
}

// ─── Self-test ─────────────────────────────────────────────────────

/**
 * Deterministic scenarios in a scratch repository.
 *
 * The property under test is the one the guard previously lacked: the same
 * repository content must produce the same verdict locally and in CI, and an
 * untracked local file must not change the default verdict.
 *
 * The scenarios call the real discovery and check functions against the scratch
 * repository rather than spawning the script, because the script resolves its own
 * root from its own location — spawning it would inspect this repository instead.
 */
function selfTest() {
  const scratch = mkdtempSync(join(tmpdir(), 'credential-guard-selftest-'));
  const results = [];

  /** Runs the guard's real logic over the scratch repository. */
  const inspect = (includeUntracked) => {
    try {
      const files = filesToInspect(scratch, includeUntracked);
      return { status: runChecks(scratch, files).length === 0 ? 0 : 1, output: runChecks(scratch, files).join('\n') };
    } catch (error) {
      return { status: 2, output: error instanceof Error ? error.message : String(error) };
    }
  };

  try {
    mkdirSync(scratch, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: scratch });
    spawnSync('git', ['config', 'user.email', 'selftest@example.invalid'], { cwd: scratch });
    spawnSync('git', ['config', 'user.name', 'selftest'], { cwd: scratch });

    // A clean tracked file plus the template the guard expects.
    writeFileSync(join(scratch, '.env.example'), 'GEMINI_API_KEY=\nASSESSMENT_API_TOKEN=\n');
    writeFileSync(join(scratch, 'clean.txt'), 'nothing sensitive here\n');
    spawnSync('git', ['add', '.env.example', 'clean.txt'], { cwd: scratch });

    results.push(['a clean tracked tree passes', inspect(false).status === 0]);

    // An untracked file carrying a retired identifier must NOT change the default
    // verdict — this is the exact case that made the guard unreproducible.
    writeFileSync(join(scratch, 'local-only.md'), 'project webscraping-464710\n');
    const untrackedDefault = inspect(false);
    results.push([
      'an untracked local file does not fail the default verdict',
      untrackedDefault.status === 0,
      untrackedDefault.output,
    ]);

    const untrackedWidened = inspect(true);
    results.push([
      '--include-untracked does catch a committable local file',
      untrackedWidened.status === 1 && untrackedWidened.output.includes('webscraping-464710'),
      untrackedWidened.output,
    ]);

    // A tracked file carrying the same identifier must fail in both modes.
    writeFileSync(join(scratch, 'tracked.md'), 'project webscraping-464710\n');
    spawnSync('git', ['add', 'tracked.md'], { cwd: scratch });
    results.push(['a tracked retired identifier fails the default verdict', inspect(false).status === 1]);
    results.push(['a tracked retired identifier fails the widened verdict', inspect(true).status === 1]);

    // A template carrying a credential value must fail.
    writeFileSync(join(scratch, '.env.example'), 'GEMINI_API_KEY=real-looking-value\n');
    spawnSync('git', ['add', '.env.example'], { cwd: scratch });
    const template = inspect(false);
    results.push([
      'a populated .env.example fails',
      template.status === 1 && template.output.includes('.env.example sets a value'),
      template.output,
    ]);

    // A real-looking project id assigned to a cloud key must fail.
    writeFileSync(join(scratch, 'cloud.md'), 'GEMINI_VERTEX_PROJECT=my-real-project-12345\n');
    spawnSync('git', ['add', 'cloud.md'], { cwd: scratch });
    results.push(['a real-looking project id fails', inspect(false).status === 1]);

    // An ignored file is outside both sets, because it cannot be published.
    // Asserted on the *specific* file rather than on the whole verdict, since the
    // scratch repository still holds the deliberate failures from earlier steps.
    writeFileSync(join(scratch, '.gitignore'), '.env\nignored.md\n');
    writeFileSync(join(scratch, 'ignored.md'), 'project webscraping-464710\n');
    writeFileSync(join(scratch, '.env'), 'ASSESSMENT_API_TOKEN=secret-value\n');
    spawnSync('git', ['add', '.gitignore'], { cwd: scratch });

    const widenedFiles = filesToInspect(scratch, true);
    results.push([
      'an ignored file is not inspected',
      !widenedFiles.includes('ignored.md') && !widenedFiles.includes('.env'),
      widenedFiles.filter((file) => file.includes('ignored') || file === '.env').join(', '),
    ]);

    // And it must not be reported even when it is sitting right there.
    const ignoredOutput = inspect(true).output;
    results.push([
      'an ignored file is never reported',
      !ignoredOutput.includes('ignored.md') && !ignoredOutput.includes('environment file present'),
      ignoredOutput,
    ]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const failed = results.filter(([, ok]) => !ok);
  for (const [name, ok, detail] of results) {
    console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}`);
    if (!ok && detail) console.log(`        ${String(detail).trim().split('\n').join('\n        ')}`);
  }
  if (failed.length > 0) {
    console.error(`\nCredential guard self-test failed (${failed.length} of ${results.length}).`);
    process.exit(1);
  }
  console.log(`\nCredential guard self-test passed (${results.length} scenarios).`);
}

// ─── Entry point ───────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--self-test')) {
    selfTest();
    return;
  }

  const includeUntracked = args.includes('--include-untracked');
  const unknown = args.filter((arg) => arg !== '--include-untracked');
  if (unknown.length > 0) {
    console.error(`Credential guard: unknown argument(s): ${unknown.join(', ')}`);
    process.exit(2);
  }

  let files;
  try {
    files = filesToInspect(root, includeUntracked);
  } catch (error) {
    console.error(
      `Credential guard could not list repository files: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(2);
  }

  const failures = runChecks(root, files);

  if (failures.length > 0) {
    console.error('Credential guard failed:');
    for (const failure of failures) console.error(`  - ${failure}`);
    if (includeUntracked) {
      console.error(
        '\n  Note: --include-untracked inspects files that are not in the repository,\n' +
          '  so CI cannot reproduce these findings. Commit or remove the file, or re-run\n' +
          '  without the flag to check the tracked tree only.',
      );
    }
    process.exit(1);
  }

  const scope = includeUntracked ? 'tracked and committable files' : 'tracked files';
  console.log(`Credential guard passed (${files.length} ${scope} inspected).`);
}

// Only run when executed directly, so the self-test can import nothing by accident.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
