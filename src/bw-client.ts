import axios, { AxiosInstance, AxiosResponse } from 'axios';
import https from 'https';
import * as fs from 'fs';

// Media types for each BW object type (from BW/4HANA discovery).
// Hardcoded fallbacks; loadMediaTypes() overwrites them at runtime.
export const MEDIA_TYPES: Record<string, string> = {
  adso: 'application/vnd.sap.bw.modeling.adso-v1_7_0+xml',
  iobj: 'application/vnd.sap-bw-modeling.iobj-v2_2_0+xml',
  trfn: 'application/vnd.sap.bw.modeling.trfn-v1_0_0+xml',
  dtpa: 'application/vnd.sap.bw.modeling.dtpa-v1_0_0+xml',
  area: 'application/vnd.sap.bw.modeling.area-v1_1_0+xml',
  trcs: 'application/vnd.sap.bw.modeling.trcs-v1_0_0+xml',
  rsds: 'application/vnd.sap.bw.modeling.rsds-v1_1_0+xml',
  hcpr: 'application/vnd.sap.bw.modeling.hcpr-v1_15_0+xml',
  dest: 'application/vnd.sap.bw.modeling.dest-v1_0_0+xml',
  alvl: 'application/vnd.sap.bw.modeling.alvl-v1_0_0+xml',
  plcr: 'application/vnd.sap.bw.modeling.plcr-v1_0_0+xml',
  plsq: 'application/vnd.sap.bw.modeling.plsq-v1_0_0+xml',
  plse: 'application/vnd.sap.bw.modeling.plse-v2_0_0+xml',
  valuehelp: 'application/vnd.sap-bw-modeling.valuehelp2-v1_1_0+xml',
};

export interface GetResult {
  body: string;
  headers: Record<string, string>;
}

/** Cloud Connector hop. `token` is a connectivity JWT and expires — build one per request. */
export interface BwProxyConfig {
  host: string;
  port: number;
  /** Connectivity-service access token, sent as `Proxy-Authorization: Bearer …`. */
  token: string;
  /** Sent as `SAP-Connectivity-SCC-Location_ID` when several CCs serve the subaccount. */
  locationId?: string;
}

/**
 * How a client authenticates to BW. Exactly one mode; they cannot be combined.
 *
 * There is deliberately no way to express "principal propagation *and* a shared
 * credential". A per-user client that can fall back to BW_USER/BW_PASSWORD is a
 * principal-propagation server with an admin backdoor, so the type forbids it
 * rather than a runtime flag discouraging it.
 */
export type BwAuth =
  /** stdio / local development. */
  | { kind: 'basic'; user: string; password: string }
  /** stdio against a SAML/OAuth-fronted system, cookies exported from a browser. */
  | { kind: 'cookies'; cookies: Record<string, string> }
  /** BTP principal propagation: the value for the `SAP-Connectivity-Authentication` header. */
  | { kind: 'pp'; connectivityAuth: string };

export interface BwClientOptions {
  url: string;
  auth: BwAuth;
  client?: string;
  language?: string;
  proxy?: BwProxyConfig;
}

export class BwClient {
  private http: AxiosInstance;
  private csrfToken: string | null = null;
  private csrfTokenFetchedAt: number = 0;
  // SAP sessions time out after ~5 minutes of inactivity; refresh the token before that.
  private static readonly CSRF_TOKEN_TTL_MS = 4 * 60 * 1000;
  private cookies: Map<string, string> = new Map();
  private readonly auth: BwAuth;
  private readonly proxy?: BwProxyConfig;
  private readonly frozenCookies: Set<string> = new Set();
  // Session diagnostics — enable with BW_DEBUG_SESSION=1 (or "true").
  // All debug output goes to stderr so it never corrupts the MCP stdio protocol.
  private readonly sessionDebug: boolean =
    process.env.BW_DEBUG_SESSION === '1' || process.env.BW_DEBUG_SESSION === 'true';

  constructor(opts: BwClientOptions) {
    this.auth = opts.auth;
    this.proxy = opts.proxy;

    // Neither cookie mode nor PP sends `X-sap-adt-sessiontype: stateful`:
    //  - BW Bridge 401s on stateful requests with no pre-established backend session.
    //  - Under PP each request carries its own short-lived identity, so a stateful
    //    session would pin to one work process for no benefit. Every tool here reads.
    const stateful = opts.auth.kind === 'basic';
    this.http = axios.create({
      baseURL: opts.url,
      proxy: opts.proxy
        ? { host: opts.proxy.host, port: opts.proxy.port, protocol: 'http' }
        : false,
      headers: {
        ...(opts.client ? { 'sap-client': opts.client } : {}),
        ...(stateful ? { 'X-sap-adt-sessiontype': 'stateful' } : {}),
        ...(opts.language ? { 'sap-language': opts.language } : {}),
      },
      // Direct connections may hit a self-signed BW certificate. Through the Cloud
      // Connector the app→proxy hop is plain HTTP and the CC owns TLS to the backend,
      // so this only ever applies to the local/stdio path.
      ...(opts.proxy ? {} : { httpsAgent: new https.Agent({ rejectUnauthorized: !process.env.BW_INSECURE }) }),
      validateStatus: () => true,
    });
    delete this.http.defaults.headers.post['Content-Type'];
    delete (this.http.defaults.headers as any).common['Content-Type'];

    if (opts.auth.kind === 'cookies') {
      for (const [name, value] of Object.entries(opts.auth.cookies)) {
        this.cookies.set(name, value);
        // Names from the cookie file are frozen — set-cookie responses must not overwrite them.
        this.frozenCookies.add(name);
      }
    }
  }

  /**
   * Per-request auth headers. The single place any credential reaches the wire.
   *
   * PP sends two *different* tokens: `SAP-Connectivity-Authentication` carries the
   * user identity for the Cloud Connector to convert into a short-lived X.509 cert,
   * while `Proxy-Authorization` authenticates this app to the connectivity proxy.
   * `Authorization` is never sent in a PP scenario — SAP reserves it for basic auth
   * to the backend, and sending it here breaks identity propagation.
   */
  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.auth.kind === 'basic') {
      h['Authorization'] = 'Basic ' + Buffer.from(`${this.auth.user}:${this.auth.password}`).toString('base64');
    } else if (this.auth.kind === 'pp') {
      h['SAP-Connectivity-Authentication'] = this.auth.connectivityAuth;
    }
    if (this.proxy) {
      h['Proxy-Authorization'] = `Bearer ${this.proxy.token}`;
      if (this.proxy.locationId) h['SAP-Connectivity-SCC-Location_ID'] = this.proxy.locationId;
    }
    return h;
  }

  // ── Session info (debug) ──────────────────────────────────────────────────

  /** Returns a snapshot of the current session cookies — for debug assertions only. */
  public sessionInfo(): Record<string, string> {
    return Object.fromEntries(this.cookies.entries());
  }

  // ── Cookie management ──────────────────────────────────────────────────────

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private updateCookies(response: AxiosResponse): void {
    const setCookies = response.headers['set-cookie'];
    if (!setCookies) return;
    if (this.sessionDebug) {
      console.error(`[bw-session] Set-Cookie received: ${JSON.stringify(setCookies)}`);
    }
    for (const c of setCookies) {
      const attrs = c.split(';');
      const part = attrs[0];
      const eqIdx = part.indexOf('=');
      if (eqIdx <= 0) continue;
      const name = part.substring(0, eqIdx).trim();
      if (this.frozenCookies.has(name)) continue;
      const value = part.substring(eqIdx + 1).trim();
      // Honour explicit cookie deletions (Max-Age<=0 or Expires in the past): drop the
      // cookie from the jar instead of re-sending a stale value. Re-sending a session
      // cookie (e.g. sap-contextid) that the server has already rolled out is a likely
      // cause of intermittent "No Suitable Resource Found" errors on stateful calls.
      if (this.isCookieDeletion(attrs)) {
        this.cookies.delete(name);
        continue;
      }
      this.cookies.set(name, value);
    }
    if (this.sessionDebug) {
      console.error(`[bw-session] cookie jar now: ${JSON.stringify(Object.fromEntries(this.cookies.entries()))}`);
    }
  }

  // A Set-Cookie is a deletion when Max-Age is <= 0 or Expires is in the past.
  private isCookieDeletion(attrs: string[]): boolean {
    for (const a of attrs.slice(1)) {
      const eq = a.indexOf('=');
      const key = (eq >= 0 ? a.slice(0, eq) : a).trim().toLowerCase();
      const val = eq >= 0 ? a.slice(eq + 1).trim() : '';
      if (key === 'max-age') {
        const n = parseInt(val, 10);
        if (Number.isFinite(n) && n <= 0) return true;
      } else if (key === 'expires') {
        const t = Date.parse(val);
        if (Number.isFinite(t) && t <= Date.now()) return true;
      }
    }
    return false;
  }

  // ── CSRF token ─────────────────────────────────────────────────────────────

  private async fetchCsrfToken(): Promise<void> {
    const response = await this.http.get('/sap/bw/modeling/repo/is/systeminfo', {
      headers: {
        'X-CSRF-Token': 'Fetch',
        Accept: 'application/xml',
        ...this.authHeaders(),
        ...this.cookieHeaders(),
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    const token = response.headers['x-csrf-token'] as string | undefined;
    if (!token || token.toLowerCase() === 'fetch') {
      if (this.auth.kind === 'basic') {
        throw new Error(
          `Failed to fetch CSRF token (HTTP ${response.status}). Check BW_URL, BW_USER, BW_PASSWORD, BW_CLIENT.`
        );
      } else {
        throw new Error(
          `Failed to fetch CSRF token (HTTP ${response.status}). ` +
          `Cookie mode in use — refresh cookies in BW_COOKIE_FILE and restart the MCP server.`
        );
      }
    }
    this.csrfToken = token;
    this.csrfTokenFetchedAt = Date.now();
  }

  private async ensureCsrf(): Promise<void> {
    const stale = !this.csrfToken ||
      (Date.now() - this.csrfTokenFetchedAt) > BwClient.CSRF_TOKEN_TTL_MS;
    if (stale) {
      await this.fetchCsrfToken();
    }
  }

  public clearCsrfToken(): void {
    this.csrfToken = null;
  }

  private cookieHeaders(): Record<string, string> {
    const hdr = this.cookieHeader();
    return hdr ? { Cookie: hdr } : {};
  }

  // ── Public HTTP helpers ────────────────────────────────────────────────────

  /**
   * Read bypassing the BW server-side model buffer (`forceCacheUpdate=true`),
   * so an unactivated M draft is returned rather than a stale projection.
   *
   * Was a module-level `freshRead()` that called `createClientFromEnv()` — i.e. it
   * silently minted a second, env-authenticated session mid-request. Under principal
   * propagation that is an identity downgrade, so it is now a method on the caller's
   * own client. The "fresh session" half of the original rationale is satisfied by
   * construction: every PP request already gets its own session.
   */
  async freshGet(path: string, accept: string): Promise<GetResult> {
    const sep = path.includes('?') ? '&' : '?';
    return this.get(`${path}${sep}forceCacheUpdate=true`, accept);
  }

  async get(path: string, accept: string): Promise<GetResult> {
    await this.ensureCsrf();
    const IOBJ_ACCEPT_ALL = 'application/vnd.sap-bw-modeling.iobj-v1_0_0+xml, application/vnd.sap-bw-modeling.iobj-v1_1_0+xml, application/vnd.sap-bw-modeling.iobj-v1_2_0+xml, application/vnd.sap-bw-modeling.iobj-v1_3_0+xml, application/vnd.sap-bw-modeling.iobj-v1_4_0+xml, application/vnd.sap-bw-modeling.iobj-v1_5_0+xml, application/vnd.sap-bw-modeling.iobj-v1_6_0+xml, application/vnd.sap-bw-modeling.iobj-v1_7_0+xml, application/vnd.sap-bw-modeling.iobj-v1_8_0+xml, application/vnd.sap-bw-modeling.iobj-v1_9_0+xml, application/vnd.sap-bw-modeling.iobj-v2_0_0+xml, application/vnd.sap-bw-modeling.iobj-v2_1_0+xml, application/vnd.sap-bw-modeling.iobj-v2_2_0+xml, application/vnd.sap-bw-modeling.iobj-v2_3_0+xml, application/vnd.sap-bw-modeling.iobj-v2_4_0+xml';
    const resolvedAccept = accept.includes('iobj') ? IOBJ_ACCEPT_ALL : `application/xml, ${accept}`;
    const response = await this.http.get(path, {
      headers: {
        Accept: resolvedAccept,
        'bwmt-level': '50',
        'X-CSRF-Token': this.csrfToken!,
        ...this.authHeaders(),
        ...this.cookieHeaders(),
      },
      responseType: 'text',
      transformResponse: [(data) => data],
    });
    this.updateCookies(response);
    if (response.status >= 400) {
      throw new Error(`GET ${path} → HTTP ${response.status}\n${response.data}`);
    }
    return {
      body: response.data as string,
      headers: response.headers as Record<string, string>,
    };
  }

  /**
   * Unlock a BW object after activation.
   * DTPs (dtpa) are skipped — they require no unlock.
   * Pattern: POST /sap/bw/modeling/{type}/{name}?action=unlock
   */
  /**
   * Returns the current CSRF token, fetching it first if needed.
   * Callers that need to pass the token explicitly (e.g. rawPost) use this.
   */
  async getCsrfToken(): Promise<string> {
    await this.ensureCsrf();
    return this.csrfToken!;
  }

  /**
   * POST with a completely clean axios instance — no default headers at all.
   * Only sends Authorization (Basic Auth) + Cookie (session continuity) + the
   * headers explicitly passed by the caller.  Nothing else.
   *
   * Use this when you need to control the exact wire headers (e.g. for
   * Transformation creation where Eclipse sends a very specific header set).
   */
  async rawPost(
    url: string,
    body: string,
    headers: Record<string, string>
  ): Promise<{ body: string; headers: Record<string, string> }> {
    const freshHttp = axios.create({
      baseURL: this.http.defaults.baseURL,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: () => true,
      // Wipe every axios default-header bucket so nothing leaks through
      headers: { common: {}, get: {}, post: {}, put: {}, patch: {}, delete: {}, head: {} } as any,
    });

    const cookieHdr = this.cookieHeader();
    const response = await freshHttp.post(url, body, {
      headers: {
        ...this.authHeaders(),
        ...(cookieHdr ? { Cookie: cookieHdr } : {}),
        ...headers,
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    if (response.status >= 400) {
      throw new Error(`POST ${url} → HTTP ${response.status}\n${response.data}`);
    }
    return {
      body: response.data as string,
      headers: response.headers as Record<string, string>,
    };
  }

  /**
   * GET to an arbitrary path using the shared session.
   * Passes the CSRF token and session cookies; the caller controls all other headers.
   * Use this for endpoints that need custom Accept or non-standard request headers.
   */
  async rawGet(
    url: string,
    headers: Record<string, string>
  ): Promise<{ body: string; headers: Record<string, string> }> {
    await this.ensureCsrf();
    const response = await this.http.get(url, {
      headers: {
        'X-CSRF-Token': this.csrfToken!,
        ...this.authHeaders(),
        ...this.cookieHeaders(),
        ...headers,
      },
      responseType: 'text',
      transformResponse: [(data) => data],
    });
    this.updateCookies(response);
    if (response.status >= 400) {
      throw new Error(`GET ${url} → HTTP ${response.status}\n${response.data}`);
    }
    return {
      body: response.data as string,
      headers: response.headers as Record<string, string>,
    };
  }

  /**
   * Fetch the BW modeling discovery document and populate MEDIA_TYPES at runtime.
   * Entries returned by the server overwrite the hardcoded fallback defaults.
   * Entries not returned by the server are left unchanged.
   */
  async loadMediaTypes(): Promise<void> {
    const response = await this.http.get('/sap/bw/modeling/discovery', {
      headers: {
        Accept: 'application/atomsvc+xml',
        ...this.authHeaders(),
        ...this.cookieHeaders(),
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    if (response.status >= 400) {
      throw new Error(`Discovery GET → HTTP ${response.status}\n${response.data}`);
    }
    const xml: string = response.data as string;
    // A single <app:collection> publishes one OR MORE <app:accept> media types,
    // mixing +xml/+json and bw/bw4 namespaces. Split on collection start tags so
    // every accept is attributed to its own collection: the previous single-regex
    // approach captured only the first accept per collection, which silently
    // skipped the +xml variant whenever a +json entry was listed first (e.g. iobj).
    const extractVersion = (mt: string): number => {
      const m = mt.match(/-v(\d+)_(\d+)_(\d+)\+xml$/);
      return m ? parseInt(m[1]) * 10000 + parseInt(m[2]) * 100 + parseInt(m[3]) : 0;
    };
    const segments = xml.split(/(?=<app:collection\s)/);
    for (const segment of segments) {
      const hrefMatch = segment.match(/^<app:collection\b[^>]*?\shref="([^"]+)"/);
      if (!hrefMatch) continue;
      // Extract last URL segment as the key (e.g. ".../adso" → "adso")
      const key = hrefMatch[1].split('/').pop()?.toLowerCase();
      if (!key) continue;
      // Consider only versioned XML modeling media types ("...-vX_Y_Z+xml").
      // Sub-resource accepts (e.g. "jobs.job+xml") and +json variants score 0.
      const versioned = [...segment.matchAll(/<app:accept>([^<]+)<\/app:accept>/g)]
        .map((a) => a[1].trim())
        .filter((mt) => extractVersion(mt) > 0);
      if (versioned.length === 0) continue;
      const best = versioned.reduce((a, b) => (extractVersion(b) >= extractVersion(a) ? b : a));
      // Discovery always wins over the hardcoded fallback, including downgrades.
      //
      // The fallbacks are a guess for when discovery is unreachable; the discovery
      // document is this system's authoritative statement of what it accepts. A
      // "never downgrade" rule kept the seeded adso-v1_7_0 on a system advertising
      // adso-v1_2_0, and BW answered every aDSO read with
      //   HTTP 415 "Requested content type ... does not match back-end content type"
      // Live-verified on ABAP Platform 2025 / SAP_BASIS 816.
      //
      // Picking the highest version still applies *within* one collection's accepts,
      // which is what `best` above does.
      MEDIA_TYPES[key] = best;
    }
    process.stderr.write(`[bw-modeling-mcp] Loaded media types from discovery: ${JSON.stringify(MEDIA_TYPES)}\n`);
  }

  // ── ADT class write flow (ABAP runtime only) ──────────────────────────────

}

/**
 * Shared client from environment variables. This is the stdio / local-development
 * path only: it holds one credential for every caller.
 *
 * The HTTP transport never calls this — see createPerUserClient() in pp-client.ts.
 * assertNoSharedCredentials() (http.ts) refuses to start the server if these
 * variables are set alongside principal propagation, so a shared session can never
 * shadow a per-user identity.
 */
export function createClientFromEnv(): BwClient {
  const url = process.env.BW_URL;
  const client = process.env.BW_CLIENT ?? '001';
  const language = process.env.BW_LANGUAGE;
  const cookieFile = process.env.BW_COOKIE_FILE;

  if (!url) {
    throw new Error('Required environment variable missing: BW_URL');
  }

  // Cookie mode: BW Bridge or other SAML/OAuth-fronted BW systems where Basic Auth
  // is not available. Cookies are exported from an authenticated browser session.
  // File format (vsp-compatible): Netscape (7 tab-separated fields) or simple
  // "name=value" lines. Lines starting with # are comments.
  if (cookieFile) {
    let raw: string;
    try {
      raw = fs.readFileSync(cookieFile, 'utf-8');
    } catch (err) {
      throw new Error(
        `Failed to read BW_COOKIE_FILE at ${cookieFile}: ${(err as Error).message}`
      );
    }
    const cookies: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parts = trimmed.split('\t');
      if (parts.length >= 7) {
        cookies[parts[5]] = parts[6];
      } else {
        const eq = trimmed.indexOf('=');
        if (eq > 0) {
          cookies[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
        }
      }
    }
    if (Object.keys(cookies).length === 0) {
      throw new Error(
        `BW_COOKIE_FILE at ${cookieFile} contains no parseable cookies (expected Netscape or name=value format).`
      );
    }
    return new BwClient({ url, client, language, auth: { kind: 'cookies', cookies } });
  }

  // Basic Auth mode: classic on-premise BW/4HANA — unchanged from previous behavior.
  const user = process.env.BW_USER;
  const password = process.env.BW_PASSWORD;
  if (!user || !password) {
    throw new Error(
      'Required environment variables missing: BW_URL, BW_USER, BW_PASSWORD'
    );
  }
  return new BwClient({ url, client, language, auth: { kind: 'basic', user, password } });
}

