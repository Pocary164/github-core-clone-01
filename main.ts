// The forge's entrypoint, run by the grader as `node /bot/main.ts`.
//
// Boot contract: bind an ephemeral port, tell the environment where it is by POSTing
// {"port": N} to $MAKEFUN_ENV_URL/register, serve until GET $MAKEFUN_ENV_URL/done answers
// {"done": true}, then close and exit 0. The bearer token for every surface is the process
// env MAKEFUN_SHOP_TOKEN.

import { createApp } from './app.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (!envUrl) {
    console.error('MAKEFUN_ENV_URL is not set; there is no environment to register with');
    process.exit(1);
  }
  const token = process.env.MAKEFUN_SHOP_TOKEN;

  const server = createApp(token);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (!port) {
    console.error('the server did not bind a port');
    process.exit(1);
  }

  // Register with the environment, retrying transient failures; a 400 or 405 means the
  // registration itself is malformed, which no retry will fix.
  for (;;) {
    let status = 0;
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      status = response.status;
      await response.text().catch(() => '');
    } catch {
      status = 0;
    }
    if (status === 200 || status === 409) break;
    if (status === 400 || status === 405) {
      console.error(`registration refused with HTTP ${status}`);
      process.exit(1);
    }
    await sleep(250);
  }

  // Serve until the environment says the trial is done.
  let delay = 100;
  for (;;) {
    let done = false;
    try {
      const response = await fetch(`${envUrl}/done`);
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        done = payload.done === true;
      }
    } catch {
      done = false;
    }
    if (done) break;
    await sleep(delay);
    delay = Math.min(delay * 2, 1000);
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
