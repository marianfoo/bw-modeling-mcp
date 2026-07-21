/**
 * Per-user BW client via BTP principal propagation.
 *
 * Flow: the caller's XSUAA JWT -> Destination service (with X-User-Token) -> a
 * `SAP-Connectivity-Authentication` value -> Cloud Connector, which converts it into
 * a short-lived X.509 certificate and presents that to BW as `SSL_CLIENT_CERT`. BW
 * maps the certificate subject to an ABAP user via CERTRULE. ARC-1 runs the same
 * shape (see its server.ts createPerUserClient).
 *
 * Everything here fails closed. There is no path that returns a client holding a
 * shared credential.
 */
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { BTPConfig, BTPProxyConfig } from '@arc-mcp/xsuaa-auth/btp';
import { BwClient } from './bw-client.js';

export interface PpDeps {
  btpConfig: BTPConfig;
  proxy?: BTPProxyConfig;
  destinationName: string;
}

/**
 * The destination URL must be http:// when routed through the Cloud Connector.
 *
 * Two independent reasons, same symptom. SAP: "When connecting to HTTP(S) on-premise
 * resources, the call from the cloud application must always use HTTP. If HTTPS is
 * used, a 405 response will be returned." And empirically, axios tunnels https://
 * targets with CONNECT, which silently drops *both* Proxy-Authorization and
 * SAP-Connectivity-Authentication before the proxy ever sees them — so the failure
 * arrives as an opaque 405 with no hint that the identity went missing.
 *
 * The Cloud Connector owns TLS to the backend; the app->proxy hop is plain HTTP
 * inside the CF landscape.
 */
export function assertProxyableUrl(url: string, destinationName: string): void {
  if (!url.startsWith('http://')) {
    throw new Error(
      `Destination '${destinationName}' has URL '${url}', but Cloud Connector routing requires http://. ` +
        'An https:// destination makes the HTTP client tunnel via CONNECT, which drops the principal-propagation ' +
        'headers and returns 405. Configure the CC-facing virtual host as http:// (the CC still uses HTTPS to BW).',
    );
  }
}

export async function createPerUserClient(deps: PpDeps, authInfo: AuthInfo | undefined): Promise<BwClient> {
  const token = authInfo?.token;
  if (!token || token.split('.').length !== 3) {
    throw new Error('Principal propagation requires a JWT bearer token (an API key or missing token cannot identify a user).');
  }

  const { lookupDestinationWithUserToken } = await import('@arc-mcp/xsuaa-auth/btp');
  const { destination, authTokens } = await lookupDestinationWithUserToken(deps.btpConfig, deps.destinationName, token);

  // lookupDestinationWithUserToken populates sapConnectivityAuth. It never sets
  // ppProxyAuth — that field is reserved for a consumer implementing the newer
  // jwt-bearer exchange itself, so branching on it would always miss.
  const connectivityAuth = authTokens.sapConnectivityAuth;
  if (!connectivityAuth) {
    throw new Error(
      `Principal propagation failed for destination '${deps.destinationName}': the Destination service returned no ` +
        'SAP-Connectivity-Authentication header. Check that the destination has Authentication=PrincipalPropagation, ' +
        'that the Cloud Connector is connected, and that the issuing IdP is trusted and synchronized in the CC.',
    );
  }

  // Only on-premise destinations go through the Cloud Connector. Routing an
  // internet destination through the SCC proxy would be wrong, not merely slow.
  const proxy =
    destination.ProxyType === 'OnPremise' && deps.proxy
      ? {
          host: deps.proxy.host,
          port: deps.proxy.port,
          token: await deps.proxy.getProxyToken(),
          // The destination's own location id wins: with several CCs on one
          // subaccount, reusing the startup one routes to the wrong connector.
          locationId: destination.CloudConnectorLocationId ?? deps.proxy.locationId,
        }
      : undefined;

  if (proxy) assertProxyableUrl(destination.URL, deps.destinationName);

  return new BwClient({
    url: destination.URL,
    // sap-client is not a documented destination property for PrincipalPropagation,
    // so it stays server configuration rather than being read off the destination.
    client: process.env.BW_CLIENT,
    language: process.env.BW_LANGUAGE,
    auth: { kind: 'pp', connectivityAuth },
    proxy,
  });
}

/** Display name for logs. The JWT was already verified by the bearer middleware. */
export function userLabel(authInfo: AuthInfo | undefined): string {
  const token = authInfo?.token;
  if (!token) return 'anonymous';
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return payload.user_name ?? payload.email ?? payload.sub ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
