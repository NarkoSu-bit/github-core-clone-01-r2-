// main.ts — the entry lifecycle. In a trial the harness sets MAKEFUN_ENV_URL:
// bind an ephemeral port, POST {"port"} to $MAKEFUN_ENV_URL/register, then
// long-poll GET $MAKEFUN_ENV_URL/done until {"done": true} and exit. Without
// MAKEFUN_ENV_URL the entry runs in local-dev mode: it listens on $PORT
// (default 3000) and serves forever, which is how the kit's local runner
// exercises it.

import { createApp } from './app.ts';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

async function register(port: number): Promise<void> {
  let delay = 250;
  for (;;) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return;
    } catch {
      // The env is not up yet; retry with backoff.
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 5_000);
  }
}

async function waitForDone(): Promise<void> {
  let delay = 250;
  for (;;) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        const data = (await res.json()) as { done?: boolean };
        if (data.done === true) return;
      }
    } catch {
      // Transient; keep polling.
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 5_000);
  }
}

async function main(): Promise<void> {
  const server = createApp();
  if (ENV_URL === '') {
    const port = Number(process.env.PORT ?? 3000);
    await listen(server, port);
    console.log(`[entry] local mode: listening on 127.0.0.1:${port}`);
    return;
  }
  await listen(server, 0);
  const port = (server.address() as AddressInfo).port;
  await register(port);
  await waitForDone();
  server.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
