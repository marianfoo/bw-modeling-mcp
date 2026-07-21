#!/usr/bin/env node
/**
 * HTTP entry point: BTP Cloud Foundry, XSUAA OAuth, principal propagation.
 *
 * Auth is two independent layers and it is worth keeping them straight:
 *   1. XSUAA decides who may call this server at all, and with which scope
 *      (`read`, `data`). Enforced here.
 *   2. Principal propagation decides who they are *to BW*. Enforced by BW itself,
 *      against the ABAP user the Cloud Connector maps the caller's certificate to.
 *
 * Layer 2 is the one that actually restricts data. Layer 1 only gates the door.
 */
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { setupHttpAuth, loadXsuaaCredentials, resolveAppUrl } from '@arc-mcp/xsuaa-auth';
import { createConnectivityProxy, parseVCAPServices } from '@arc-mcp/xsuaa-auth/btp';
import { server } from './index.js';
import { runWithClient } from './request-context.js';
import { createPerUserClient, userLabel, type PpDeps } from './pp-client.js';

const log = {
  debug: (m: string, x?: unknown) => process.stderr.write(`[debug] ${m} ${x ? JSON.stringify(x) : ''}\n`),
  info: (m: string, x?: unknown) => process.stderr.write(`[info] ${m} ${x ? JSON.stringify(x) : ''}\n`),
  warn: (m: string, x?: unknown) => process.stderr.write(`[warn] ${m} ${x ? JSON.stringify(x) : ''}\n`),
  error: (m: string, x?: unknown) => process.stderr.write(`[error] ${m} ${x ? JSON.stringify(x) : ''}\n`),
};

/**
 * Refuse to start if a shared BW credential is configured alongside principal
 * propagation.
 *
 * A shared session would win: BW ties the session to whichever identity opened it,
 * so one leftover BW_USER turns every per-user request into that user's session, and
 * nothing in the logs would say so. ARC-1 makes the same check (config.ts) and calls
 * it out as a hard topology error rather than a warning.
 */
function assertNoSharedCredentials(): void {
  const offenders = ['BW_USER', 'BW_PASSWORD', 'BW_COOKIE_FILE'].filter((v) => process.env[v]);
  if (offenders.length) {
    throw new Error(
      `Principal propagation is enabled but shared BW credentials are also set: ${offenders.join(', ')}. ` +
        'A shared session silently overrides per-user identity. Unset them (the HTTP transport never uses them).',
    );
  }
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8080);
  const destinationName = process.env.BW_BTP_PP_DESTINATION ?? process.env.BW_BTP_DESTINATION;
  if (!destinationName) {
    throw new Error('BW_BTP_PP_DESTINATION (or BW_BTP_DESTINATION) is required for the HTTP transport.');
  }
  assertNoSharedCredentials();

  const btpConfig = parseVCAPServices(process.env, log);
  if (!btpConfig) {
    throw new Error(
      'No BTP service bindings found in VCAP_SERVICES. Bind a destination service instance ' +
        '(and a connectivity instance for on-premise BW via Cloud Connector) to this app.',
    );
  }
  // Null when no connectivity binding exists — correct for an internet-reachable BW,
  // fatal for an on-premise one. createPerUserClient decides, since only the
  // destination knows whether it is ProxyType=OnPremise.
  const proxy = createConnectivityProxy(btpConfig, process.env.BW_CC_LOCATION_ID, log) ?? undefined;
  const ppDeps: PpDeps = { btpConfig, proxy, destinationName };

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: true }));

  const bearer = setupHttpAuth(
    app,
    {
      xsuaa: {
        credentials: loadXsuaaCredentials(),
        appUrl: resolveAppUrl(process.env, { publicUrlEnvVar: 'BW_PUBLIC_URL', port }),
        clientIdPrefix: 'bwmcp-',
        resourceName: 'BW Modeling MCP (read-only)',
        requiredScopes: ['read'],
      },
      allowedOrigins: process.env.BW_ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean),
      // Never come up open. An unauthenticated MCP server in front of a Cloud
      // Connector is a tunnel into the corporate network.
      required: true,
    },
    log,
  );

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', transport: 'http-streamable', readOnly: true });
  });

  app.all('/mcp', bearer!, async (req, res) => {
    const authInfo = (req as unknown as { auth?: import('@modelcontextprotocol/sdk/server/auth/types.js').AuthInfo }).auth;
    let client;
    try {
      client = await createPerUserClient(ppDeps, authInfo);
    } catch (err) {
      // Fail closed. A principal-propagation failure must never degrade to a shared
      // identity — returning an error is the only safe outcome.
      const message = err instanceof Error ? err.message : String(err);
      log.error('principal propagation failed', { user: userLabel(authInfo), destination: destinationName, message });
      res.status(502).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: `Principal propagation failed: ${message}` },
        id: null,
      });
      return;
    }

    // Stateless: a new transport per request. Under PP identity is re-established
    // every call, so there is no session worth keeping between them.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => void transport.close());
    await runWithClient(client, async () => {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
  });

  app.listen(port, () => {
    process.stderr.write(
      `bw-modeling-mcp listening on :${port} (read-only, XSUAA + principal propagation via '${destinationName}')\n`,
    );
  });
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
