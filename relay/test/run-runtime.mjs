// Start an isolated real workerd/DO instance for the WebSocket integration suite.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const listener = createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
const origin = `http://127.0.0.1:${port}`;
const detached = process.platform !== 'win32';
const worker = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', '.wrangler/integration'], {
  cwd, detached, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, WRANGLER_SEND_METRICS: 'false'},
});
let output = '';
for (const stream of [worker.stdout, worker.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-24_000); });
let spawnError;
worker.on('error', error => { spawnError = error; });
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw spawnError;
    if (worker.exitCode !== null) throw Error(`Worker exited (${worker.exitCode})\n${output}`);
    try {
      const response = await fetch(`${origin}/healthz`, {signal: AbortSignal.timeout(500)});
      const health = await response.json();
      ready = response.ok && health.protocol === 'neko.remoted.v3' && health.version === 3;
    } catch {}
    if (ready) break;
    await delay(200);
  }
  if (!ready) throw Error(`Worker readiness timed out\n${output}`);
  const test = spawn(process.execPath, ['--test', 'test/runtime.mjs'], {cwd, stdio: 'inherit', env: {...process.env, REMOTED_TEST_RELAY: origin}});
  const [code] = await once(test, 'exit');
  process.exitCode = code ?? 1;
} finally {
  try { if (detached) process.kill(-worker.pid, 'SIGTERM'); else worker.kill('SIGTERM'); } catch {}
}
