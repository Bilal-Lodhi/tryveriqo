#!/usr/bin/env node
/**
 * Thin wrapper that runs a Flutter command inside apps/console.
 *
 * Exists so `npm run test:console` and CI share one definition of how the
 * console is exercised, and so a missing Flutter SDK produces a clear message
 * instead of an opaque npm failure.
 *
 *   node scripts/flutter.mjs test
 *   node scripts/flutter.mjs analyze
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const consoleDir = join(root, 'apps', 'console');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/flutter.mjs <flutter-args...>');
  process.exit(2);
}

const flutter = process.platform === 'win32' ? 'flutter.bat' : 'flutter';

const probe = spawnSync(flutter, ['--version'], { stdio: 'ignore', shell: true });
if (probe.error || probe.status !== 0) {
  console.error(
    'Flutter SDK not found on PATH. Install Flutter to run console checks, or skip this step.',
  );
  process.exit(3);
}

const result = spawnSync(flutter, args, {
  cwd: consoleDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);
