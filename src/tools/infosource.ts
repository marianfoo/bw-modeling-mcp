import { BwClient } from '../bw-client.js';

const TRCS_MEDIA = 'application/vnd.sap.bw.modeling.trcs-v1_0_0+xml';

// ── bwGetInfosource ───────────────────────────────────────────────────────────

/**
 * bw_get_infosource — read the structure of an InfoSource (TRCS).
 *
 * GET /sap/bw/modeling/trcs/{name}/m
 */
export async function bwGetInfosource(client: BwClient, name: string): Promise<string> {
  const nameLower = name.toLowerCase();
  const result = await client.freshGet(`/sap/bw/modeling/trcs/${nameLower}/m`, TRCS_MEDIA);
  const xml = result.body;

  // Root attributes
  const rootName = (xml.match(/trcs:infoSource[^>]+\bname="([^"]+)"/) ?? [])[1] ?? name.toUpperCase();
  const aggregationAttr = (xml.match(/trcs:infoSource[^>]+\baggregation="([^"]+)"/) ?? [])[1];
  const aggregation = aggregationAttr === 'true';

  // endUserTexts label (top-level)
  const labelMatch = xml.match(/^[\s\S]*?<endUserTexts label="([^"]*)"/);
  const label = labelMatch ? labelMatch[1] : '';

  // tlogoProperties
  const tlogoPart = (xml.match(/<tlogoProperties([^>]*)>/) ?? [])[1] ?? '';
  const description = (tlogoPart.match(/adtcore:description="([^"]*)"/) ?? [])[1] ?? '';
  const objectStatus = (tlogoPart.match(/adtcore:version="([^"]*)"/) ?? [])[1] ?? '';

  // <infoArea>
  const infoArea = (xml.match(/<infoArea>([^<]*)<\/infoArea>/) ?? [])[1] ?? '';

  // Collect keyElement names: #///NAME → NAME
  const keyElements = new Set<string>();
  const keyRe = /<keyElement>#\/\/\/([^<]+)<\/keyElement>/g;
  let km: RegExpExecArray | null;
  while ((km = keyRe.exec(xml)) !== null) {
    keyElements.add(km[1].toUpperCase());
  }

  // Parse <element> blocks
  const fields: Record<string, unknown>[] = [];
  const elemRe = /<element\b([\s\S]*?)<\/element>/g;
  let em: RegExpExecArray | null;
  while ((em = elemRe.exec(xml)) !== null) {
    const block = em[1];
    const fieldName = (block.match(/\bname="([^"]+)"/) ?? [])[1];
    if (!fieldName) continue;

    const iObjName = (block.match(/\binfoObjectName="([^"]+)"/) ?? [])[1];
    const fieldLabel = (block.match(/<endUserTexts label="([^"]*)"/) ??
                        block.match(/<descriptions label="([^"]*)"/) ?? [])[1] ?? '';
    const dataType = (block.match(/<inlineType\b[^>]*\bname="([^"]+)"/) ?? [])[1] ?? '';
    const lengthStr = (block.match(/<inlineType\b[^>]*\blength="([^"]+)"/) ?? [])[1];
    const aggrBehav = (block.match(/\baggregationBehavior="([^"]+)"/) ?? [])[1];

    const field: Record<string, unknown> = {
      name: fieldName,
      label: fieldLabel,
      data_type: dataType,
      is_key: keyElements.has(fieldName.toUpperCase()),
    };
    if (iObjName) field['infoobject_name'] = iObjName;
    if (lengthStr !== undefined) field['length'] = Number(lengthStr);
    if (aggrBehav) field['aggregation_behavior'] = aggrBehav;

    fields.push(field);
  }

  return JSON.stringify({
    name: rootName,
    label,
    description,
    info_area: infoArea,
    object_status: objectStatus,
    aggregation,
    fields,
  }, null, 2);
}

// ── Field building ────────────────────────────────────────────────────────────

// ── bw_create_infosource ──────────────────────────────────────────────────────

// ── bw_update_infosource ──────────────────────────────────────────────────────
