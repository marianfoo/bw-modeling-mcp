import { BwClient, MEDIA_TYPES } from '../bw-client.js';

// ── aDSO type presets ────────────────────────────────────────────────────────

// Read at call time, not module load. `const X = MEDIA_TYPES['adso']` snapshots the
// hardcoded fallback before loadMediaTypes() has run, so a system advertising an older
// version (e.g. adso-v1_2_0 on ABAP Platform 2025) still got asked for the seeded
// v1_7_0 and answered HTTP 415 "does not match back-end content type".
const adsoAccept = () => MEDIA_TYPES['adso'];

/**
 * bw_get_adso — read aDSO structure (inactive version).
 * format="raw": raw XML + header. format="text": structured plain-text summary.
 */
export async function bwGetAdso(
  client: BwClient,
  adsoName: string,
  format: 'text' | 'raw' = 'text',
): Promise<string> {
  const path = `/sap/bw/modeling/adso/${adsoName.toLowerCase()}/m`;
  const result = await client.freshGet(path, adsoAccept());
  const status = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? 'unknown';
  const ts = result.headers['timestamp'] ?? '';
  const rawOutput = `aDSO: ${adsoName.toUpperCase()}\nStatus: ${status}\nTimestamp: ${ts}\n\n${result.body}`;
  if (format === 'raw') return rawOutput;
  return summarizeAdso(adsoName.toUpperCase(), status, result.body);
}

function summarizeAdso(adsoName: string, status: string, xml: string): string {
  const lines: string[] = [];

  // ── Attribute helpers ─────────────────────────────────────────────────────
  const rootTagStr = xml.match(/<adso:dataStore\b[^>]*/)?.[0] ?? '';
  const strAttr = (name: string, src: string = rootTagStr): string =>
    src.match(new RegExp(`\\b${name}="([^"]*)"`)) ?.[1] ?? '';
  const boolAttr = (name: string, def = false): boolean => {
    const v = strAttr(name);
    return v === 'true' ? true : v === 'false' ? false : def;
  };
  const flag = (name: string): string => strAttr(name) || 'false';

  // ── Section 1: General ────────────────────────────────────────────────────
  const name = strAttr('name') || adsoName;
  const rawDesc = xml.match(/<endUserTexts label="([^"]*)"/)?.[1] ?? '';
  const desc = rawDesc
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'");
  const infoArea = xml.match(/<infoArea>([^<]*)<\/infoArea>/)?.[1] ?? '';
  const pkg = xml.match(/<adtcore:packageRef\b[^>]*\badtcore:name="([^"]*)"/)?.[1] ?? '';
  const objectVersion = xml.match(/<objectVersion>([^<]*)<\/objectVersion>/)?.[1] ?? '';
  const versionMap: Record<string, string> = { M: 'Inactive', A: 'Active' };
  const versionLabel = objectVersion
    ? `${objectVersion} (${versionMap[objectVersion] ?? objectVersion})`
    : '';

  const tlogoStr = xml.match(/<tlogoProperties\b[^>]*/)?.[0] ?? '';
  const createdAt = strAttr('adtcore:createdAt', tlogoStr);
  const createdBy = strAttr('adtcore:createdBy', tlogoStr);
  const changedAt = strAttr('adtcore:changedAt', tlogoStr);
  const changedBy = strAttr('adtcore:changedBy', tlogoStr);

  lines.push('── General ──');
  lines.push(`aDSO:        ${name}`);
  lines.push(`Description: ${desc}`);
  lines.push(`InfoArea:    ${infoArea}`);
  lines.push(`Package:     ${pkg}`);
  lines.push(`Status:      ${status}`);
  lines.push(`Version:     ${versionLabel}`);
  lines.push(`Created:     ${createdAt} (${createdBy})`);
  lines.push(`Changed:     ${changedAt} (${changedBy})`);

  // ── Section 2: Flags ──────────────────────────────────────────────────────
  lines.push('');
  lines.push('── Flags ──');
  lines.push(`Externe SAP HANA-View:              ${flag('withHanaModel')}`);
  lines.push(`Lesezugriffsausgabe protokollieren: ${flag('logRalOutput')}`);
  lines.push(`Schreib-Interface aktiviert:        ${flag('pushMode')}`);
  lines.push(`Planung aktiviert:                  ${flag('planningMode')}`);
  lines.push(`Bestand aktiviert:                  ${flag('isNcum')}`);

  // ── Section 3: Modelling Type ─────────────────────────────────────────────
  const directUpdate     = boolAttr('directUpdate');
  const cubeDeltaOnly    = boolAttr('cubeDeltaOnly');
  const noAqDeletion     = boolAttr('noAqDeletion');
  const isReportingObject = boolAttr('isReportingObject', true);
  const activateData     = boolAttr('activateData', true);
  const writeChangelog   = boolAttr('writeChangelog');
  const snapShotScenario = boolAttr('snapShotScenario');
  const uniqueDataRecords = boolAttr('uniqueDataRecords');

  let modellingType: string;
  if (directUpdate) {
    modellingType = 'DataStore-Objekt mit direkter Fortschreibung';
  } else if (cubeDeltaOnly && !noAqDeletion) {
    modellingType = 'Staging — Nur Eingangs-Queue';
  } else if (!cubeDeltaOnly && noAqDeletion) {
    modellingType = 'Staging — Daten komprimieren';
  } else if (cubeDeltaOnly && noAqDeletion) {
    modellingType = 'Staging — Reporting aktiviert';
  } else if (!isReportingObject && activateData && !cubeDeltaOnly) {
    modellingType = 'Data-Mart-DataStore-Objekt';
  } else {
    modellingType = 'Standard-DataStore-Objekt';
  }

  lines.push('');
  lines.push('── Modelling Type ──');
  lines.push(modellingType);
  if (writeChangelog)    lines.push('  Change Log schreiben: yes');
  if (snapShotScenario)  lines.push('  Snapshot-Unterstützung: yes');
  if (uniqueDataRecords) lines.push('  Eindeutige Datensätze: yes');

  // ── Section 4: Data Tiering ───────────────────────────────────────────────
  const tempMap: Record<string, string> = {
    HO:   'Hot',
    HWO:  'Hot, Warm',
    HWCP: 'Hot, Warm, Cold',
    WO:   'Warm only',
    WCP:  'Warm, Cold',
    CO:   'Cold only',
    HCO:  'Hot, Cold',
  };
  const tempRaw = strAttr('temperatureSchema');
  const exceptionalUpdate = flag('exceptionalUpdate');
  const dapOrigin = strAttr('dapOrigin');

  lines.push('');
  lines.push('── Data Tiering ──');
  lines.push(`Data Tiering:                      ${tempMap[tempRaw] ?? tempRaw}`);
  lines.push(`Außergewöhnliche Fortschreibungen: ${exceptionalUpdate}`);
  if (dapOrigin) lines.push(`Verbindung (DAP):                  ${dapOrigin}`);

  // ── Section 5: Key Fields ─────────────────────────────────────────────────
  const keyElements: string[] = [];
  const keySet = new Set<string>();
  const keyRe = /<keyElement>([^<]*)<\/keyElement>/g;
  let km: RegExpExecArray | null;
  while ((km = keyRe.exec(xml)) !== null) {
    const v = km[1].trim().replace(/^#\/\/\//, '');
    keyElements.push(v);
    keySet.add(v);
  }

  lines.push('');
  lines.push('── Key Fields ──');
  lines.push(keyElements.length > 0 ? keyElements.join(', ') : '(none)');

  // ── Section 6: Fields table ───────────────────────────────────────────────
  interface FieldRow {
    name: string; type: string; length: string; agg: string;
    dim: string; dimRaw: string; isKey: boolean; keyOrder: number; label: string;
  }

  const fields: FieldRow[] = [];
  const elemRe = /<element\b([^>]*)>([\s\S]*?)<\/element>/g;
  let em: RegExpExecArray | null;

  const getAttr = (s: string, key: string) =>
    s.match(new RegExp(`\\b${key}="([^"]*)"`)) ?.[1] ?? '';

  while ((em = elemRe.exec(xml)) !== null) {
    const openAttrs = em[1];
    const body      = em[2];
    const fieldName = getAttr(openAttrs, 'name');
    if (!fieldName) continue;

    const itStr      = body.match(/<inlineType\b[^>]*/)?.[0] ?? '';
    const fieldType  = getAttr(itStr, 'name');
    const lengthRaw  = getAttr(itStr, 'length');
    const precRaw    = getAttr(itStr, 'precision');
    const scaleRaw   = getAttr(itStr, 'scale');
    const agg        = getAttr(openAttrs, 'aggregationBehavior');
    const dimRaw     = getAttr(openAttrs, 'dimension');
    const dim        = dimRaw.replace(/^#\/\/\//, '').replace(/§$/, '');
    // QUAN/CURR: XML has precision=total_digits, scale=decimal_places (no length attr)
    // DEC: XML has length=total_digits, precision=decimal_places
    // Others: length only
    let lengthDisp: string;
    if (precRaw && scaleRaw) {
      lengthDisp = `${precRaw},${scaleRaw}`;
    } else if (lengthRaw && precRaw) {
      lengthDisp = `${lengthRaw},${precRaw}`;
    } else {
      lengthDisp = lengthRaw;
    }
    const isKey      = keySet.has(fieldName);
    const keyOrder   = isKey ? keyElements.indexOf(fieldName) : -1;
    const rawLabel   = body.match(/<endUserTexts label="([^"]*)"/)?.[1]
                    ?? body.match(/<descriptions label="([^"]*)"/)?.[1]
                    ?? '';
    const label = rawLabel
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'");

    fields.push({ name: fieldName, type: fieldType, length: lengthDisp, agg, dim, dimRaw, isKey, keyOrder, label });
  }

  fields.sort((a, b) => {
    if (a.isKey && b.isKey) return a.keyOrder - b.keyOrder;
    if (a.isKey) return -1;
    if (b.isKey) return 1;
    const aKyf = a.dimRaw.includes('KEYFIGURES');
    const bKyf = b.dimRaw.includes('KEYFIGURES');
    if (!aKyf && bKyf) return -1;
    if (aKyf && !bKyf) return 1;
    return 0;
  });

  lines.push('');
  lines.push(`── Fields (${fields.length}) ──`);

  const headers = ['NAME', 'TYPE', 'LENGTH', 'AGG', 'DIM', 'KEY', 'LABEL'];
  const cols = fields.map(f => [f.name, f.type, f.length, f.agg, f.dim, f.isKey ? 'yes' : 'no', f.label]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...cols.map(r => r[i].length))
  );
  const row = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i])).join('  ');

  lines.push(row(headers));
  lines.push(widths.map(w => '-'.repeat(w)).join('  '));
  for (const r of cols) lines.push(row(r));

  return lines.join('\n');
}

// ── Pure field support ───────────────────────────────────────────────────────

