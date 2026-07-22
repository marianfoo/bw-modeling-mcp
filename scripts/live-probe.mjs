// Drive the built stdio server against a live BW system and report per-tool results.
// Useful for checking which tools a given system actually supports — availability
// varies with BW Search activation, published OData services, and the discovery doc.
//
//   BW_URL=http://bw.example.com:8000 BW_USER=… BW_PASSWORD=… BW_CLIENT=001 \
//     node scripts/live-probe.mjs
//   … node scripts/live-probe.mjs bw_get_infoobject '{"infoobject_name":"0CALDAY"}'
//
// Reads credentials from the environment only; nothing is stored here.
import { spawn } from 'node:child_process';

for (const v of ['BW_URL', 'BW_USER', 'BW_PASSWORD']) {
  if (!process.env[v]) {
    console.error(`${v} is required. See the header of this file.`);
    process.exit(1);
  }
}

const srv = spawn('node', ['dist/stdio.js'], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });

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
      // A smoke set that needs no prior knowledge of the system's content.
      ['bw_list_contents', { path: '/' }],
      ['bw_list_source_systems', {}],
      ['bw_get_infoobject', { infoobject_name: '0CALDAY' }],
      ['bw_search', { search_term: '*', object_type: 'ADSO' }],
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
