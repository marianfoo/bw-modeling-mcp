// Freeze the LLM-visible tool surface. Run before and after any refactor; diff the fixture.
//   node scripts/snapshot-tools.mjs > tests/fixtures/tools.json
import { spawn } from 'node:child_process';

const srv = spawn('node', ['dist/stdio.js'], {
  env: { ...process.env, BW_URL: 'http://snapshot.invalid:8000', BW_USER: 'X', BW_PASSWORD: 'X' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

const send = (msg) => srv.stdin.write(JSON.stringify(msg) + '\n');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'snapshot', version: '1' } } });

let buf = '';
srv.stdout.on('data', (d) => {
  buf += d;
  for (const line of buf.split('\n').slice(0, -1)) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === 1) {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    } else if (msg.id === 2) {
      const tools = msg.result.tools.sort((a, b) => a.name.localeCompare(b.name));
      process.stdout.write(JSON.stringify({ count: tools.length, tools }, null, 2) + '\n');
      srv.kill();
      process.exit(0);
    }
  }
  buf = buf.slice(buf.lastIndexOf('\n') + 1);
});

setTimeout(() => { console.error('timeout'); srv.kill(); process.exit(1); }, 20000);
