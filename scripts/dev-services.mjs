#!/usr/bin/env node
/**
 * Local development process manager.
 *
 * Runs the MCP tool transport and the API together with prefixed output. Assumes
 * MongoDB is already reachable at MONGODB_URI (docker compose up mongo, or a
 * local mongod).
 *
 *   npm run dev
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

if (existsSync(join(root, '.env'))) {
  loadDotenv({ path: join(root, '.env') });
} else {
  console.log('[dev] No .env found. Copy .env.example to .env to configure the stack.');
}

const mcpDist = join(root, 'packages', 'mcp-mongodb', 'dist', 'http-server-main.js');
const apiDist = join(root, 'apps', 'api', 'dist', 'index.js');

for (const [label, path] of [
  ['MCP', mcpDist],
  ['API', apiDist],
]) {
  if (!existsSync(path)) {
    console.error(`[dev] Missing build output for ${label} at ${path}. Run "npm run build" first.`);
    process.exit(1);
  }
}

const COLORS = {
  MCP: '\u001b[35m',
  API: '\u001b[36m',
  dev: '\u001b[33m',
  reset: '\u001b[0m',
};

/** @type {Map<string, import('node:child_process').ChildProcess>} */
const children = new Map();

function prefix(label) {
  const stamp = new Date().toISOString().slice(11, 19);
  return `${COLORS[label] ?? ''}[${stamp} ${label}]${COLORS.reset}`;
}

function launch(label, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'pipe',
    windowsHide: true,
  });

  const relay = (stream, sink) => {
    stream?.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) sink.write(`${prefix(label)} ${line}\n`);
      }
    });
  };

  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);
  child.on('exit', (code, signal) => {
    console.log(`${prefix(label)} exited (code=${code ?? 'null'} signal=${signal ?? 'none'})`);
    children.delete(label);
    if (children.size === 0) process.exit(code ?? 0);
  });

  children.set(label, child);
  return child;
}

function shutdown() {
  for (const [label, child] of children) {
    console.log(`${prefix('dev')} Stopping ${label} (pid ${child.pid})`);
    child.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
  }
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const mcpPort = process.env.MCP_PORT ?? '3001';
const apiPort = process.env.PORT ?? '8080';

console.log(`
${COLORS.dev}tryveriqo — development stack${COLORS.reset}
  API  http://localhost:${apiPort}
  MCP  http://127.0.0.1:${mcpPort}  (internal)
  Mongo ${process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017'}
`);

launch('MCP', [mcpDist], {
  MCP_PORT: mcpPort,
  MCP_HOST: '127.0.0.1',
});

setTimeout(() => {
  launch('API', [apiDist], {
    PORT: apiPort,
    MCP_SERVER_ENDPOINT: process.env.MCP_SERVER_ENDPOINT ?? `http://127.0.0.1:${mcpPort}`,
  });
}, 1500);
