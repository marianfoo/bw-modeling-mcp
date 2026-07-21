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

export class BwClient {
  private http: AxiosInstance;
  private csrfToken: string | null = null;
  private csrfTokenFetchedAt: number = 0;
  // SAP sessions time out after ~5 minutes of inactivity; refresh the token before that.
  private static readonly CSRF_TOKEN_TTL_MS = 4 * 60 * 1000;
  private cookies: Map<string, string> = new Map();
  // Basic Auth is only sent during the initial CSRF fetch to establish the session.
  // All subsequent requests use the session cookie only — sending Basic Auth on PUT
  // causes SAP to create a new stateless session, invalidating the lock handle.
  private readonly basicAuth: string | null;
  private readonly frozenCookies: Set<string> = new Set();
  // Temporary session diagnostics — enable with BW_DEBUG_SESSION=1 (or "true").
  // All debug output goes to stderr so it never corrupts the MCP stdio protocol.
  private readonly sessionDebug: boolean =
    process.env.BW_DEBUG_SESSION === '1' || process.env.BW_DEBUG_SESSION === 'true';

  constructor(
    url: string,
    user: string | null,
    password: string | null,
    client: string,
    language?: string,
    initialCookies?: Record<string, string>
  ) {
    this.basicAuth = (user && password)
      ? 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64')
      : null;

    // In cookie mode (e.g. BW Bridge): do not send sap-client and X-sap-adt-sessiontype
    // as global defaults. BW Bridge rejects stateful requests with 401 when no
    // pre-established backend session exists on the app instance pointed to by __VCAP_ID__.
    const isCookieMode = initialCookies !== undefined;
    this.http = axios.create({
      baseURL: url,
      headers: {
        ...(isCookieMode ? {} : {
          'sap-client': client,
          'X-sap-adt-sessiontype': 'stateful',
        }),
        ...(language ? { 'sap-language': language } : {}),
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: () => true,
    });
    delete this.http.defaults.headers.post['Content-Type'];
    delete (this.http.defaults.headers as any).common['Content-Type'];

    // Cookie mode: pre-populate cookie store from caller. Used for SAML/OAuth-fronted
    // systems where Basic Auth is not available and cookies are exported from a browser.
    if (initialCookies) {
      for (const [name, value] of Object.entries(initialCookies)) {
        this.cookies.set(name, value);
        // Names from the cookie file are frozen — set-cookie responses must not overwrite them.
        this.frozenCookies.add(name);
      }
    }
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
        ...(this.basicAuth ? { Authorization: this.basicAuth } : {}),
        ...this.cookieHeaders(),
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    const token = response.headers['x-csrf-token'] as string | undefined;
    if (!token || token.toLowerCase() === 'fetch') {
      if (this.basicAuth) {
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
        ...(this.basicAuth ? { Authorization: this.basicAuth } : {}),
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
        ...(this.basicAuth ? { Authorization: this.basicAuth } : {}),
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
      const existing = MEDIA_TYPES[key];
      // Only update if the discovered version is >= the existing one (never downgrade).
      if (!existing || extractVersion(best) >= extractVersion(existing)) {
        MEDIA_TYPES[key] = best;
      }
    }
    process.stderr.write(`[bw-modeling-mcp] Loaded media types from discovery: ${JSON.stringify(MEDIA_TYPES)}\n`);
  }

  // ── ADT class write flow (ABAP runtime only) ──────────────────────────────

}

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
    const userOpt = process.env.BW_USER ?? null;
    const passwordOpt = process.env.BW_PASSWORD ?? null;
    return new BwClient(url, userOpt, passwordOpt, client, language, cookies);
  }

  // Basic Auth mode: classic on-premise BW/4HANA — unchanged from previous behavior.
  const user = process.env.BW_USER;
  const password = process.env.BW_PASSWORD;
  if (!user || !password) {
    throw new Error(
      'Required environment variables missing: BW_URL, BW_USER, BW_PASSWORD'
    );
  }
  return new BwClient(url, user, password, client, language);
}

