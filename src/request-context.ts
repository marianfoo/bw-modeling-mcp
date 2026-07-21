/**
 * Request-scoped BW client.
 *
 * Under principal propagation the client is per-request (it carries one user's
 * identity), but the 39 tool functions and their helpers are called several layers
 * deep. Threading a parameter through all of them would be a large diff whose
 * correctness depends on nobody missing a call site — and a missed call site is
 * exactly the failure that matters here.
 *
 * AsyncLocalStorage keeps it in one place instead. `currentClient()` throws when
 * there is no client in scope; it never falls back to environment credentials.
 * That is the whole point: no ambient identity, ever.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BwClient } from './bw-client.js';

const storage = new AsyncLocalStorage<BwClient>();
let stdioFallback: BwClient | undefined;

export function runWithClient<T>(client: BwClient, fn: () => Promise<T>): Promise<T> {
  return storage.run(client, fn);
}

/**
 * Install the process-wide client for **stdio only**.
 *
 * stdio has no per-request identity: one user runs the process with their own
 * credentials. Its MCP request callbacks are invoked from the event loop, outside
 * any AsyncLocalStorage context we could have entered at startup, so a fallback is
 * the only way to reach them.
 *
 * The HTTP transport must never call this. If it did, a request whose principal
 * propagation failed would silently fall back to a shared identity — precisely the
 * failure this module exists to prevent. `assertNoSharedCredentials()` in http.ts
 * blocks the configuration that would make such a client constructible.
 */
export function setStdioFallbackClient(client: BwClient): void {
  stdioFallback = client;
}

export function currentClient(): BwClient {
  const client = storage.getStore() ?? stdioFallback;
  if (!client) {
    throw new Error(
      'No request-scoped BW client. A tool ran outside runWithClient() — principal propagation was never established.',
    );
  }
  return client;
}
