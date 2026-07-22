// Drive the built stdio server against a live BW system and report per-tool results.
//   node scripts/live-probe.mjs            # default smoke set
//   node scripts/live-probe.mjs bw_search '{"search_term":"Z*"}'
//
// Credentials come from arc-1's .env.infrastructure so nothing is written here.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const INFRA = '/Users/marianzeis/DEV/arc-1/.env.infrastructure';
const env = {};
for (const line of readFileSync(INFRA, 'utf8').split('\n')) {
  const m = /^(SAP_A4H_2025_[A-Z_]+)=(.*?)\s*(?:#.*)?$/.exec(line);
  if (m) env[m[1]] = m[2];
}

const srv = spawn('node', ['dist/stdio.js'], {
  env: {
    ...process.env,
    BW_URL: env.SAP_A4H_2025_HTTP_URL,
    BW_USER: env.SAP_A4H_2025_USER,
    BW_PASSWORD: env.SAP_A4H_2025_PASSWORD,
    BW_CLIENT: env.SAP_A4H_2025_CLIENT,
    BW_LANGUAGE: 'EN',
  },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let nextId = 1;
const pending = new Map();
const send = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

let buf = '';
srv.stdout.on('data', (d) => {
  buf += d;
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const l of lines) {
    if (!l.trim()) continue;
    const msg = JSON.parse(l);
    if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
  }
});

const CASES = process.argv[2]
  ? [[process.argv[2], JSON.parse(process.argv[3] ?? '{}')]]
  : [
      ['bw_list_contents', { path: '/' }],
      ['bw_get_infoobject', { infoobject_name: '0CALDAY' }],
      ['bw_get_infoobject', { infoobject_name: '0CALMONTH' }],
      ['bw_get_infoarea', { infoarea_name: '0BW' }],
      ['bw_list_source_systems', {}],
      ['bw_get_source_system', { source_system: 'A4HCLNT001' }],
      ['bw_list_datasources', { source_system: 'A4HCLNT001' }],
      ['bw_list_requests', {}],
      ['bw_list_process_chain_runs', {}],
      ['bw_list_process_chain_last_status', {}],
    ];

await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'live-probe', version: '1' } });
srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const tools = await send('tools/list', {});
console.log(`tools/list -> ${tools.result.tools.length} tools\n`);

for (const [name, args] of CASES) {
  const t0 = Date.now();
  const res = await send('tools/call', { name, arguments: args });
  const ms = Date.now() - t0;
  const c = res.result?.content?.[0]?.text ?? res.error?.message ?? '(empty)';
  const bad = res.result?.isError || res.error;
  const label = `${name} ${JSON.stringify(args)}`;
  console.log(`${bad ? 'FAIL' : ' OK '} ${String(ms).padStart(6)}ms  ${label}`);
  console.log(`        ${c.slice(0, 4000).replace(/\n/g, '\n        ')}\n`);
}

srv.kill();
process.exit(0);
