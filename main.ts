// main.ts — Lifecycle: bind an ephemeral port, register it with the suite, long-poll
// $MAKEFUN_ENV_URL/done until the suite finishes, then exit 0. Without MAKEFUN_ENV_URL
// (local development) it just serves on $PORT (default 8080) forever.

import { createApp, listen } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const requestedPort = Number.parseInt(process.env.PORT ?? '0', 10) || 0;
  const app = createApp({ port: requestedPort });
  const port = await listen(app, '0.0.0.0', requestedPort);
  console.log(`forge listening on ${port}`);

  if (!ENV_URL) {
    console.log('no MAKEFUN_ENV_URL; serving locally');
    return;
  }

  const registerUrl = `${ENV_URL.replace(/\/$/, '')}/register`;
  const doneUrl = `${ENV_URL.replace(/\/$/, '')}/done`;
  const registerResponse = await fetch(registerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  if (!registerResponse.ok) {
    throw new Error(`register failed: ${registerResponse.status}`);
  }
  console.log('registered with the suite');

  for (;;) {
    const response = await fetch(doneUrl);
    if (response.ok) {
      const body = (await response.json()) as { done?: boolean };
      if (body.done) break;
    }
    await sleep(500);
  }
  console.log('suite done; exiting');
  app.server.close();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
