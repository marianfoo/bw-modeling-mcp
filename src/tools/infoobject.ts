import { BwClient, MEDIA_TYPES } from '../bw-client.js';

// ── InfoObject props (used by adso/transformation tools) ─────────────────────

export interface InfoObjectProps {
  conversionRoutine: string;
  label: string;
  dataType: string;
  length: string;
}

/**
 * Parse key properties from an InfoObject XML response.
 * Used by bw_update_adso and bw_update_transformation.
 */
export function parseInfoObjectProps(xml: string): InfoObjectProps {
  const convMatch = xml.match(/conversionRoutine="([^"]+)"/);
  const shortDescMatch = xml.match(/<shortDescription>([^<]+)<\/shortDescription>/);
  const dataTypeMatch = xml.match(/<dataType>([^<]+)<\/dataType>/);
  const lengthMatch = xml.match(/<length>([^<]+)<\/length>/);

  return {
    conversionRoutine: convMatch?.[1] ?? '',
    label: shortDescMatch?.[1] ?? '',
    dataType: dataTypeMatch?.[1] ?? 'CHAR',
    length: lengthMatch?.[1] ?? '20',
  };
}

// ── bwUpdateInfoObject ────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────

/**
 * bw_get_infoobject — read an InfoObject definition (inactive version).
 * Returns raw XML + object status from response headers.
 */
export async function bwGetInfoObject(
  client: BwClient,
  infoObjectName: string
): Promise<string> {
  const accept = MEDIA_TYPES['iobj'];
  const path = `/sap/bw/modeling/iobj/${infoObjectName.toLowerCase()}/m`;
  const result = await client.freshGet(path, accept);
  const status = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? 'unknown';
  return `InfoObject: ${infoObjectName.toUpperCase()}\nStatus: ${status}\n\n${result.body}`;
}
