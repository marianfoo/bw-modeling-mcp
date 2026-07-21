// One-shot codemod: reduce index.ts to the read-only tool set.
//
// Bounded by design (it may only touch two regions it fully understands):
//   1. tool-definition objects inside the ListTools array  -> `    {` … matching `    }`
//   2. `      case 'bw_x':` … `        break;` blocks in the CallTool switch
// It never edits anything else. Everything outside those two regions is copied verbatim.
//
//   node scripts/prune-to-readonly.mjs [--dry]

import { readFileSync, writeFileSync } from 'node:fs';

// The read-only surface. Derived from an HTTP-verb audit of every tool implementation,
// not from tool names. See docs/READONLY.md for the classification and the two judgement calls.
const KEEP = new Set([
  'bw_search', 'bw_xref', 'bw_list_contents', 'bw_get_dataflow',
  'bw_get_adso', 'bw_get_infoobject', 'bw_get_infoarea', 'bw_get_infosource',
  'bw_get_transformation', 'bw_get_composite_provider', 'bw_get_open_hub',
  'bw_get_dtps', 'bw_get_dtp',
  'bw_get_process_chain', 'bw_get_process_variant',
  'bw_list_process_chain_runs', 'bw_get_process_chain_run_detail',
  'bw_list_process_chain_last_status',
  'bw_list_requests', 'bw_get_request',
  'bw_list_source_systems', 'bw_list_datasources', 'bw_get_source_system',
  'bw_get_datasource', 'bw_list_remote_entities',
  'bw_get_query', 'bw_get_ckf', 'bw_get_rkf', 'bw_get_structure',
  'bw_get_filter_values', 'bw_query_data',
  'bw_get_roles', 'bw_get_query_roles', 'bw_get_role_queries',
  'bw_get_aggregation_level', 'bw_get_planning_function',
  'bw_get_planning_sequence', 'bw_get_planning_properties',
  'bw_list_changeable_transports',
]);

const FILE = 'src/index.ts';
const src = readFileSync(FILE, 'utf8');
const lines = src.split('\n');

// Brace depth of a line, ignoring braces inside string literals and line comments.
function braceDelta(line) {
  let delta = 0, quote = null, prev = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote && prev !== '\\') quote = null;
    } else if (c === "'" || c === '"' || c === '`') {
      quote = c;
    } else if (c === '/' && line[i + 1] === '/') {
      break;
    } else if (c === '{') delta++;
    else if (c === '}') delta--;
    prev = c;
  }
  return delta;
}

const out = [];
const dropped = { defs: [], cases: [] };
const kept = { defs: [], cases: [] };
let i = 0;

while (i < lines.length) {
  const line = lines[i];

  // Region 1: a tool-definition object. Exactly `    {` followed by `      name: 'bw_...'`.
  const defName = line === '    {' && /^      name: '([a-z_0-9]+)',$/.exec(lines[i + 1] ?? '');
  if (defName) {
    let depth = 0, j = i;
    do { depth += braceDelta(lines[j]); j++; } while (depth > 0 && j < lines.length);
    const name = defName[1];
    (KEEP.has(name) ? kept.defs : dropped.defs).push(name);
    if (KEEP.has(name)) out.push(...lines.slice(i, j));
    i = j;
    continue;
  }

  // Region 2: a switch case block. `      case 'bw_x':` up to the next case/default at same indent.
  // Two shapes in this file: `case 'x':` and `case 'x': {` (braced block).
  const caseName = /^      case '([a-z_0-9]+)': ?\{?$/.exec(line);
  if (caseName) {
    let j = i + 1;
    while (j < lines.length && !/^      (case '|default:)/.test(lines[j])) j++;
    const name = caseName[1];
    (KEEP.has(name) ? kept.cases : dropped.cases).push(name);
    if (KEEP.has(name)) out.push(...lines.slice(i, j));
    i = j;
    continue;
  }

  out.push(line);
  i++;
}

const missing = [...KEEP].filter((n) => !kept.defs.includes(n));
console.error(`definitions: kept ${kept.defs.length}, dropped ${dropped.defs.length}`);
console.error(`switch cases: kept ${kept.cases.length}, dropped ${dropped.cases.length}`);
if (missing.length) console.error(`!! in KEEP but no definition found: ${missing.join(', ')}`);
const defOnly = kept.defs.filter((n) => !kept.cases.includes(n));
if (defOnly.length) console.error(`!! kept definition with no switch case: ${defOnly.join(', ')}`);

if (!process.argv.includes('--dry')) {
  writeFileSync(FILE, out.join('\n'));
  console.error(`wrote ${FILE}`);
}
