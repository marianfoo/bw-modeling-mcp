import { BwClient, MEDIA_TYPES } from '../bw-client.js';

interface XrefEntry {
  objectName: string;
  objectType: string;
  objectStatus: string;
  title: string;
  href: string;
}

/**
 * Parse <atom:entry> elements from a BW Atom feed (xref / search responses).
 * Each entry contains a <bwModel:object> with objectName, objectType, objectStatus.
 */
function parseAtomEntries(xml: string): XrefEntry[] {
  const entries: XrefEntry[] = [];
  const entryRegex = /<atom:entry>([\s\S]*?)<\/atom:entry>/g;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(xml)) !== null) {
    const body = match[1];
    const nameMatch = body.match(/objectName="([^"]+)"/);
    const typeMatch = body.match(/objectType="([^"]+)"/);
    const statusMatch = body.match(/objectStatus="([^"]+)"/);
    const titleMatch = body.match(/<atom:title>([^<]+)<\/atom:title>/);
    const hrefMatch = body.match(/href="([^"]+)"/);

    if (nameMatch && typeMatch) {
      entries.push({
        objectName: nameMatch[1],
        objectType: typeMatch[1],
        objectStatus: statusMatch?.[1] ?? 'unknown',
        title: titleMatch?.[1] ?? '',
        href: hrefMatch?.[1] ?? '',
      });
    }
  }
  return entries;
}

/**
 * bw_get_dtps — list DTPs that depend on an object (via xref).
 *
 * Uses the cross-reference endpoint to find all DTPA objects that use the given object.
 * Filters xref results to objectType=DTPA only.
 *
 * After activating a Transformation, the activation response lists deactivated DTPs.
 * This tool can be used independently to find dependent DTPs before activation.
 */
export async function bwGetDtps(
  client: BwClient,
  objectType: string,
  objectName: string
): Promise<string> {
  const path = `/sap/bw/modeling/repo/is/xref?objectType=${encodeURIComponent(objectType.toUpperCase())}&objectName=${encodeURIComponent(objectName.toUpperCase())}`;
  const result = await client.get(path, 'application/atom+xml;type=feed');

  const allEntries = parseAtomEntries(result.body);
  const dtps = allEntries.filter((e) => e.objectType === 'DTPA');

  if (dtps.length === 0) {
    return `No dependent DTPs found for ${objectType.toUpperCase()} ${objectName.toUpperCase()}.`;
  }

  const lines = [
    `Found ${dtps.length} DTP(s) dependent on ${objectType.toUpperCase()} ${objectName.toUpperCase()}:`,
    '',
    ...dtps.map(
      (d, i) =>
        `${i + 1}. ${d.objectName} — status: ${d.objectStatus}` +
        (d.title ? ` — "${d.title}"` : '')
    ),
    '',
    'To activate all inactive DTPs: call bw_activate for each with object_type="dtpa" and lock_handle="".',
  ];

  return lines.join('\n');
}

// ── bwGetDtp ──────────────────────────────────────────────────────────────────

interface DtpFilterSelection {
  operator: string;
  excluding: boolean;
  low: string;
}

interface DtpFilterField {
  name: string;
  dtaName: string;
  description: string;
  selected: boolean;
  selections: DtpFilterSelection[];
  hasRoutine: boolean;
  routineCode: string[];
}

interface DtpInfo {
  name: string;
  description: string;
  status: string;
  source: { type: string; name: string; description: string };
  target: { type: string; name: string; description: string };
  transformation: { name: string; description: string };
  extractionMode: string;
  packageSize: string;
  filterFields: DtpFilterField[];
  globalRoutineCode: string[];
}

function parseDtpXml(xml: string, status: string): DtpInfo {
  const attr = (tag: string, name: string) => {
    const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
    return m ? m[1] : '';
  };

  // Root attributes
  const rootMatch = xml.match(/<dtpa:dataTransferProcess([^>]*)>/);
  const rootAttrs = rootMatch?.[1] ?? '';
  const name = attr(rootAttrs, 'name');
  const description = attr(rootAttrs, 'description');

  // Extraction settings
  const extrMatch = xml.match(/<extractionSettings([^>]*)\/?>/);
  const extractionMode = attr(extrMatch?.[1] ?? '', 'extractionMode');
  const packageSize = attr(extrMatch?.[1] ?? '', 'packageSize');

  // Source / target
  const srcMatch = xml.match(/<source([^>]*)\/?>/);
  const tgtMatch = xml.match(/<target([^>]*)\/?>/);
  const source = {
    type: attr(srcMatch?.[1] ?? '', 'type'),
    name: attr(srcMatch?.[1] ?? '', 'name'),
    description: attr(srcMatch?.[1] ?? '', 'description'),
  };
  const target = {
    type: attr(tgtMatch?.[1] ?? '', 'type'),
    name: attr(tgtMatch?.[1] ?? '', 'name'),
    description: attr(tgtMatch?.[1] ?? '', 'description'),
  };

  // Transformation (overview/object)
  const ovMatch = xml.match(/<overview>[\s\S]*?<object([^>]*)\/?>[\s\S]*?<\/overview>/);
  const transformation = {
    name: attr(ovMatch?.[1] ?? '', 'name'),
    description: attr(ovMatch?.[1] ?? '', 'description'),
  };

  // Filter fields
  const filterFields: DtpFilterField[] = [];
  const fieldsRegex = /<fields([^>]*)>([\s\S]*?)<\/fields>/g;
  let fm: RegExpExecArray | null;
  while ((fm = fieldsRegex.exec(xml)) !== null) {
    const fieldAttrs = fm[1];
    const fieldBody = fm[2];

    const selections: DtpFilterSelection[] = [];
    const selRegex = /<selection\b([^>]*)(?:\/>|>([\s\S]*?)<\/selection>)/g;
    let sm: RegExpExecArray | null;
    while ((sm = selRegex.exec(fieldBody)) !== null) {
      const selAttrs = sm[1];
      const selBody = sm[2] ?? '';
      const operator = selAttrs.match(/\boperator="([^"]*)"/)?.[1] ?? '';
      const excluding = selAttrs.includes('excluding="true"');
      const low = selBody.match(/<low[^>]*\bvalue="([^"]*)"/)?.[1] ?? '';
      selections.push({ operator, excluding, low });
    }

    const hasRoutine = /<routine[\s>]/.test(fieldBody) && !/<routine\s*\/>/.test(fieldBody);
    const routineCode: string[] = [];
    if (hasRoutine) {
      const codeRegex = /<code(?:\s[^>]*)?>([^<]*)<\/code>/g;
      let cm: RegExpExecArray | null;
      while ((cm = codeRegex.exec(fieldBody)) !== null) {
        routineCode.push(cm[1]);
      }
    }

    filterFields.push({
      name: attr(fieldAttrs, 'name'),
      dtaName: attr(fieldAttrs, 'dtaName'),
      description: attr(fieldAttrs, 'description'),
      selected: fieldAttrs.includes('selected="true"'),
      selections,
      hasRoutine,
      routineCode,
    });
  }

  // Global routine code
  const globalRoutineCode: string[] = [];
  const globalRegex = /<globalRoutineCode>([^<]*)<\/globalRoutineCode>/g;
  let gm: RegExpExecArray | null;
  while ((gm = globalRegex.exec(xml)) !== null) {
    globalRoutineCode.push(gm[1]);
  }

  return {
    name,
    description,
    status,
    source,
    target,
    transformation,
    extractionMode,
    packageSize,
    filterFields,
    globalRoutineCode,
  };
}

/**
 * bw_get_dtp — read a DTP definition and return a structured summary + raw XML.
 *
 * Flow:
 *   GET /sap/bw/modeling/dtpa/{dtpName}/m?forceCacheUpdate=true
 *   Parse key fields and return readable summary.
 */
export async function bwGetDtp(client: BwClient, dtpName: string): Promise<string> {
  // Fresh session: the shared client's buffer serves the stale inactive shadow
  // after this session touched the DTP (forceCacheUpdate alone does not help there).
  const path = `/sap/bw/modeling/dtpa/${dtpName.toLowerCase()}/m`;
  const result = await client.freshGet(path, MEDIA_TYPES['dtpa']);
  const status = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? 'unknown';

  const info = parseDtpXml(result.body, status);

  const modeLabel = info.extractionMode === 'F' ? 'Full' : info.extractionMode === 'D' ? 'Delta' : info.extractionMode;

  const lines: string[] = [
    `DTP: ${info.name}`,
    `Status: ${info.status}`,
    `Description: ${info.description}`,
    '',
    `Source: ${info.source.type} ${info.source.name}` + (info.source.description ? ` — ${info.source.description}` : ''),
    `Target: ${info.target.type} ${info.target.name}` + (info.target.description ? ` — ${info.target.description}` : ''),
    `Transformation: ${info.transformation.name}` + (info.transformation.description ? ` — ${info.transformation.description}` : ''),
    '',
    `── Extraction Settings ──`,
    `  Mode:        ${modeLabel} (${info.extractionMode})`,
    `  Package Size: ${info.packageSize}`,
    '',
    `── Filter Fields (${info.filterFields.length}) ──`,
  ];

  if (info.filterFields.length === 0) {
    lines.push('  (no filter fields)');
  } else {
    for (const f of info.filterFields) {
      lines.push(`  [${f.selected ? 'selected' : 'inactive'}] ${f.name} (${f.dtaName})`);
      if (f.selections.length > 0) {
        for (const s of f.selections) {
          const sign = s.excluding ? '≠' : '=';
          const val = s.low === '' ? "''" : `"${s.low}"`;
          lines.push(`    → ${s.operator} ${sign} ${val}`);
        }
      }
      if (f.hasRoutine) {
        lines.push(`    → Routine (${f.routineCode.length} lines):`);
        for (const codeLine of f.routineCode) {
          lines.push(`       ${codeLine}`);
        }
      }
      if (!f.hasRoutine && f.selections.length === 0) {
        lines.push('    → (no selection / no routine)');
      }
    }
  }

  if (info.globalRoutineCode.length > 0) {
    lines.push('', '── Global Routine Code ──');
    for (const line of info.globalRoutineCode) {
      lines.push(`  ${line}`);
    }
  }

  lines.push('', `── Raw XML ──`, result.body);

  return lines.join('\n');
}

// ── DTP lock release ──────────────────────────────────────────────────────────

// ── bwCreateDtp ───────────────────────────────────────────────────────────────

// ── bwRunDtp ──────────────────────────────────────────────────────────────────

// ── bwUpdateDtp ───────────────────────────────────────────────────────────────

// ── bwSetDtpFilterRoutine ─────────────────────────────────────────────────────

