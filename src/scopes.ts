/**
 * Scope enforcement, modelled on ARC-1's ACTION_POLICY.
 *
 * Two scopes, because there are two meaningfully different things a caller can read:
 *
 *   read  — modelling metadata: object definitions, dependencies, transports,
 *           process-chain runs. 38 of the 40 tools.
 *   data  — actual BW *data*: `bw_query_data` executes a query and returns rows;
 *           `bw_preview_datasource` samples straight from the source system.
 *           ARC-1 draws the same line with allowDataPreview, and for the same reason:
 *           "may inspect the model" and "may see the numbers" are different grants,
 *           and in BW the numbers are often the regulated part.
 *
 * `data` implies `read`, so a data-scoped caller does not also need read listed.
 *
 * This is layer 1 only — it decides who may call this server. What the caller may
 * actually see in BW is decided by BW, against the ABAP user their certificate maps
 * to. Nothing here can widen that.
 *
 * stdio has no authInfo and therefore no scopes: the person running the process
 * already holds the credentials, so there is nothing to restrict.
 */
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

export type Scope = 'read' | 'data';

// Both return actual rows rather than model metadata: bw_query_data executes a BW
// query, bw_preview_datasource samples straight from the source system.
const DATA_TOOLS = new Set(['bw_query_data', 'bw_preview_datasource']);

export function requiredScope(toolName: string): Scope {
  return DATA_TOOLS.has(toolName) ? 'data' : 'read';
}

/** Accepts bare or XSUAA-qualified scopes (`bwmcp!t123.read`). */
function has(scopes: readonly string[], scope: Scope): boolean {
  return scopes.some((s) => s === scope || s.endsWith(`.${scope}`));
}

export function hasScope(authInfo: AuthInfo | undefined, scope: Scope): boolean {
  if (!authInfo) return true; // stdio
  const scopes = authInfo.scopes ?? [];
  if (has(scopes, scope)) return true;
  return scope === 'read' && has(scopes, 'data'); // data implies read
}

/** Hide tools the caller cannot invoke, so the model never proposes a call that will be denied. */
export function filterToolsByScope<T extends { name: string }>(tools: T[], authInfo: AuthInfo | undefined): T[] {
  if (!authInfo) return tools;
  return tools.filter((t) => hasScope(authInfo, requiredScope(t.name)));
}
