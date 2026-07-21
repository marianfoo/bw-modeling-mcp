import { BwClient, MEDIA_TYPES } from '../bw-client.js';

const TRFN_ACCEPT = MEDIA_TYPES['trfn'];

/**
 * Read the inactive (/m) version of a Transformation through a FRESH session
 * with forceCacheUpdate=true.
 *
 * The shared long-lived client pins a per-session model buffer once it has read
 * an object; later PRE-LOCK reads return that stale state even with
 * forceCacheUpdate=true (verified live). A read-modify-write built on such a
 * read silently resurrects old attribute values on the PUT — this reverted an
 * already-persisted HANARuntime switch. A fresh session always returns the
 * database state, including an existing unactivated M draft. (Locking does
 * refresh the buffer, but the reads below happen before locking.)
 */
async function freshReadInactive(
  client: BwClient,
  trfnLower: string
): Promise<{ body: string; headers: Record<string, string> }> {
  return client.freshGet(`/sap/bw/modeling/trfn/${trfnLower}/m`, TRFN_ACCEPT);
}

// ── bwCreateTransformation ────────────────────────────────────────────────────

/**
 * bw_get_transformation — read a Transformation (inactive version).
 * Returns raw XML + status + timestamp.
 * Note: Transformation name is a UUID-like generated key, not human-readable.
 */
export async function bwGetTransformation(
  client: BwClient,
  transformationName: string,
  format: 'text' | 'raw' = 'text',
): Promise<string> {
  const result = await freshReadInactive(client, transformationName.toLowerCase());
  const status = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? 'unknown';
  const ts = result.headers['timestamp'] ?? '';
  const xml = result.body;
  if (format === 'raw') return xml;
  return summarizeTransformation(transformationName.toUpperCase(), status, ts, xml);
}

/**
 * Parse the transformation XML and return a compact human-readable summary.
 * Extracts: source/target, routine info, and per-field mapping rules.
 */
function summarizeTransformation(
  name: string,
  status: string,
  timestamp: string,
  xml: string
): string {
  const lines: string[] = [];
  lines.push(`Transformation: ${name}`);
  lines.push(`Status: ${status}`);
  lines.push(`Timestamp: ${timestamp}`);

  // ── Header attributes ─────────────────────────────────────────────────────
  const attr = (key: string) =>
    xml.match(new RegExp(`\\b${key}="([^"]*)"`))?.[1] ?? '';

  const description      = attr('description');
  const startRoutine     = attr('startRoutine');
  const endRoutine       = attr('endRoutine');
  const expertRoutine    = attr('expertRoutine');
  const abapProgram      = attr('abapProgram');
  const hanaExec         = attr('sapHANAExecutionPossible');

  if (description)  lines.push(`Description: ${description}`);
  if (abapProgram)  lines.push(`ABAP Program: ${abapProgram}`);
  if (hanaExec)     lines.push(`HANA Execution: ${hanaExec}`);

  // ── Source / Target ───────────────────────────────────────────────────────
  const srcMatch = xml.match(/<source\b[^>]*id="0"[^>]*name="([^"]+)"[^>]*(?:description="([^"]*)")?[^>]*type="([^"]+)"/);
  const tgtMatch = xml.match(/<target\b[^>]*id="0"[^>]*name="([^"]+)"[^>]*(?:description="([^"]*)")?[^>]*type="([^"]+)"/);
  if (srcMatch) lines.push(`Source: ${srcMatch[3]} ${srcMatch[1]}${srcMatch[2] ? ' (' + srcMatch[2] + ')' : ''}`);
  if (tgtMatch) lines.push(`Target: ${tgtMatch[3]} ${tgtMatch[1]}${tgtMatch[2] ? ' (' + tgtMatch[2] + ')' : ''}`);

  // ── Routines ──────────────────────────────────────────────────────────────
  // Also scan rule groups for routinetype=START/END/EXPERT (modern BW/4 style)
  const ruleMatches = [...xml.matchAll(/<rule\b([^>]*)>([\s\S]*?)<\/rule>/g)];

  function findGroupRoutine(type: string): string {
    for (const rm of ruleMatches) {
      const rt = rm[1].match(/routinetype="([^"]*)"/)?.[1] ?? '';
      if (rt.toUpperCase() !== type) continue;
      const sAttrs = rm[2].match(/<step\b([^>]*)/)?.[1] ?? '';
      const cls    = sAttrs.match(/classNameM="([^"]*)"/)?.[1] ?? '';
      const mth    = sAttrs.match(/methodNameM="([^"]*)"/)?.[1] ?? '';
      if (cls) return `${cls}.${mth}`;
    }
    return '';
  }

  const startRef  = startRoutine  || findGroupRoutine('START');
  const endRef    = endRoutine    || findGroupRoutine('END');
  const expertRef = expertRoutine || findGroupRoutine('EXPERT');

  lines.push('');
  lines.push('── Routines ──');
  lines.push(`  startRoutine:  ${startRef  || '(none)'}`);
  lines.push(`  endRoutine:    ${endRef    || '(none)'}`);
  lines.push(`  expertRoutine: ${expertRef || '(none)'}`);

  if (startRef || endRef || expertRef) {
    lines.push(`  NOTE: to read routine code, parse "ClassName.MethodName" from the path above`);
    lines.push(`        and call GetSource(object_type="CLAS", name=ClassName, method=MethodName).`);
    lines.push(`        Never read the ABAP Program listed in the header — it contains the full`);
    lines.push(`        generated class (~5000 lines) and will exceed context limits.`);
  }

  if (ruleMatches.length > 0) {
    lines.push('');
    lines.push('── Field Mappings ──');
    for (const rm of ruleMatches) {
      const ruleAttrs   = rm[1];
      const ruleBody    = rm[2];
      const routinetype = ruleAttrs.match(/routinetype="([^"]*)"/)?.[1] ?? '';

      // Step attributes — use [^>]* so slashes in classNameM paths don't break capture
      const stepMatch   = ruleBody.match(/<step\b([^>]*)/);
      const stepAttrs   = stepMatch?.[1] ?? '';
      const xsiType     = stepAttrs.match(/xsi:type="trfn:Step([^"]+)"/)?.[1] ?? '';
      const stepType    = (stepAttrs.match(/\btype="([^"]*)"/)?.[1] ?? routinetype) || xsiType;
      const classNameM  = stepAttrs.match(/classNameM="([^"]*)"/)?.[1] ?? '';
      const methodNameM = stepAttrs.match(/methodNameM="([^"]*)"/)?.[1] ?? '';
      const constant    = stepAttrs.match(/\bconstant="([^"]*)"/)?.[1] ?? '';

      // Extract source fields from <elementRef>#///source/segment1/FIELD
      const srcFields = [...ruleBody.matchAll(/elementRef>#\/\/\/source\/[^/]+\/([^<]+)<\/elementRef>/g)]
        .map(m => m[1]);
      // Extract target fields from <elementRef>#///target/segment1/FIELD
      const tgtFields = [...ruleBody.matchAll(/elementRef>#\/\/\/target\/[^/]+\/([^<]+)<\/elementRef>/g)]
        .map(m => m[1]);

      const src = srcFields.length > 0 ? srcFields.join(', ') : '(none)';
      const tgt = tgtFields.length > 0 ? tgtFields.join(', ') : '(none)';

      let label = stepType || xsiType || '?';
      // Show routinetype when it adds info not already in the label
      if (routinetype && !label.toUpperCase().includes(routinetype.toUpperCase())) {
        label += ` [${routinetype}]`;
      }
      if (classNameM)  label += ` | ${classNameM}.${methodNameM}`;
      if (constant)    label += ` = "${constant}"`;

      // Extract filter conditions on this rule
      const filterParts: string[] = [];
      for (const fm of ruleBody.matchAll(/<filter\b([^>]*?)(?:\/>|>)/g)) {
        const fa   = fm[1];
        const sign = fa.match(/\bsign="([^"]+)"/)?.[1] ?? '';
        const opt  = fa.match(/\boption="([^"]+)"/)?.[1] ?? '';
        const low  = fa.match(/\blow="([^"]+)"/)?.[1] ?? '';
        const high = fa.match(/\bhigh="([^"]+)"/)?.[1] ?? '';
        const part = high ? `${sign}${opt}[${low},${high}]` : `${sign}${opt}${low}`;
        if (part.trim()) filterParts.push(part);
      }
      const filterSuffix = filterParts.length > 0 ? `  {FILTER: ${filterParts.join('; ')}}` : '';

      lines.push(`  [${label}]  ${src}  →  ${tgt}${filterSuffix}`);

      // Show formula code inline (StepFormula)
      // Formula can be an attribute on <step formula="..."> or a child <formula> element
      const formulaCode = stepAttrs.match(/\bformula="([^"]*)"/)?.[1]?.trim()
        ?? ruleBody.match(/<formula\b[^>]*>([\s\S]*?)<\/formula>/)?.[1]?.trim()
        ?? ruleBody.match(/<code\b[^>]*>([\s\S]*?)<\/code>/)?.[1]?.trim()
        ?? '';
      if (formulaCode) {
        for (const codeLine of formulaCode.split('\n')) {
          lines.push(`      ${codeLine}`);
        }
      }

      // For StepRoutine: show class/method prominently if not already in label
      if (!classNameM && (xsiType === 'Routine' || routinetype === 'ROUTINE')) {
        const routineRef = ruleBody.match(/routineName="([^"]+)"/)?.[1]
          ?? ruleBody.match(/className="([^"]+)"/)?.[1]
          ?? '';
        if (routineRef) lines.push(`      → Routine: ${routineRef}`);
      }
    }
  }

  // ── Source fields ─────────────────────────────────────────────────────────
  // Drill into the first <segment> inside <source> to get all available source fields
  const srcSegContent = xml.match(/<source\b[^>]*>[\s\S]*?<segment\b[^>]*>([\s\S]*?)<\/segment>/)?.[1] ?? '';
  if (srcSegContent) {
    const srcElems = [...srcSegContent.matchAll(/<element\b([^>]*?)(?:\/>|>([\s\S]*?)<\/element>)/g)];
    if (srcElems.length > 0) {
      lines.push('');
      lines.push(`── Source Fields (${srcElems.length}) ──`);
      const keys: string[] = [];
      const vals: string[] = [];
      for (const m of srcElems) {
        const attrs  = m[1];
        const body   = m[2] ?? '';
        const name   = attrs.match(/\bname="([^"]+)"/)?.[1] ?? '';
        const isKey  = attrs.match(/\bkey="([^"]+)"/)?.[1] === 'true';
        const dt     = body.match(/<inlineType\b[^>]*name="([^"]+)"/)?.[1] ?? '';
        const entry  = dt ? `${name}(${dt})` : name;
        if (isKey) keys.push(entry); else vals.push(entry);
      }
      if (keys.length) lines.push(`  Key fields (${keys.length}): ${keys.join(', ')}`);
      if (vals.length) lines.push(`  Value fields (${vals.length}): ${vals.join(', ')}`);
    }
  }

  // ── Target fields ─────────────────────────────────────────────────────────
  const tgtSegContent = xml.match(/<target\b[^>]*>[\s\S]*?<segment\b[^>]*>([\s\S]*?)<\/segment>/)?.[1] ?? '';
  if (tgtSegContent) {
    const tgtElems = [...tgtSegContent.matchAll(/<element\b([^>]*?)(?:\/>|>([\s\S]*?)<\/element>)/g)];
    if (tgtElems.length > 0) {
      lines.push('');
      lines.push(`── Target Fields (${tgtElems.length}) ──`);
      const keys: string[] = [];
      const vals: string[] = [];
      for (const m of tgtElems) {
        const attrs  = m[1];
        const body   = m[2] ?? '';
        const name   = attrs.match(/\bname="([^"]+)"/)?.[1] ?? '';
        const isKey  = attrs.match(/\bkey="([^"]+)"/)?.[1] === 'true';
        const dt     = body.match(/<inlineType\b[^>]*name="([^"]+)"/)?.[1] ?? '';
        const conv   = attrs.match(/\bconversionRoutine="([^"]+)"/)?.[1] ?? '';
        const entry  = [name, dt ? `(${dt})` : '', conv ? `[${conv}]` : ''].filter(Boolean).join('');
        if (isKey) keys.push(entry); else vals.push(entry);
      }
      if (keys.length) lines.push(`  Key fields (${keys.length}): ${keys.join(', ')}`);
      if (vals.length) lines.push(`  Value fields (${vals.length}): ${vals.join(', ')}`);
    }
  }

  return lines.join('\n');
}

// ── XML helpers ──────────────────────────────────────────────────────────────

// ── bwSetTransformationRoutine ───────────────────────────────────────────────

/**
 * bwSetTransformationRoutine — add a Start, End, or Expert routine to a Transformation.
 *
 * Flow:
 * 1. GET XML — derive classNameM from classNameA (_A → _M), error if missing
 * 2. Guard: group id="0" must not already exist
 * 3. Extract fields: source fields for START, target fields for END/EXPERT
 * 4. Build group id="0" block with full step (classNameM + methodNameM included)
 *    - START: <source id="N"> elements, no sourceSegment on group
 *    - END/EXPERT: <target id="N"> elements, sourceSegment="#///source/segment1" on group
 * 5. Lock → single PUT (session-isolated)
 * 6. Return lock_handle for bw_activate
 */

// ── bwSetTransformationExpertRoutine ─────────────────────────────────────────

// ── bwSetTransformationRoutineFields ─────────────────────────────────────────

// ── bwDeleteTransformationRoutine ────────────────────────────────────────────

// ── bwSetTransformationRuntime ────────────────────────────────────────────────

