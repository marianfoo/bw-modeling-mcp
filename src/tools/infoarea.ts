import { BwClient, MEDIA_TYPES } from '../bw-client.js';

// ── bwMoveObject ──────────────────────────────────────────────────────────────

// ── bwCreateInfoArea ──────────────────────────────────────────────────────────

// ── bwGetInfoarea ─────────────────────────────────────────────────────────────

/**
 * bw_get_infoarea — read an InfoArea definition.
 *
 * GET /sap/bw/modeling/area/{name}
 */
export async function bwGetInfoarea(client: BwClient, name: string): Promise<string> {
  const nameLower = name.toLowerCase();
  const result = await client.get(`/sap/bw/modeling/area/${nameLower}`, MEDIA_TYPES['area']);
  const body = result.body;

  try {
    const parsed = JSON.parse(body);

    const infoAreaName: string = parsed['name'] ?? name.toUpperCase();

    const label: string =
      parsed['endUserTexts']?.['label'] ??
      parsed['descriptions']?.['label'] ??
      parsed['label'] ??
      '';

    const parentArea: string | null =
      parsed['tlogoProperties']?.['infoArea'] ??
      parsed['parentInfoArea'] ??
      null;

    const objectStatus: string =
      parsed['tlogoProperties']?.['adtcore:version'] ??
      parsed['tlogoProperties']?.['objectStatus'] ??
      parsed['objectStatus'] ??
      '';

    return JSON.stringify({ name: infoAreaName, label, parent_area: parentArea || null, object_status: objectStatus }, null, 2);
  } catch {
    return JSON.stringify({ raw: body });
  }
}
