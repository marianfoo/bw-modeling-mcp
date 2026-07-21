// Remove named top-level declarations (dead write-path code) from a TS file.
//
// Bounded: only ever deletes a region that starts at a top-level
// `export? [async] function|const|interface|type|class NAME` and ends at that
// declaration's own closing brace / statement end. Preceding JSDoc goes with it.
// Everything else is copied verbatim. It refuses (and reports) anything it cannot
// locate unambiguously.
//
//   node scripts/remove-dead-exports.mjs <file> <name>...

import { readFileSync, writeFileSync } from 'node:fs';

const [file, ...names] = process.argv.slice(2);
const src = readFileSync(file, 'utf8');

// Single pass over the whole file so template literals, comments and strings that
// span lines are tracked correctly. Per-line brace counting gets this wrong: an
// unterminated `` ` `` on one line silently corrupts every line after it.
function scanDepths(text) {
  const depth = new Array(text.length).fill(0);
  let d = 0, i = 0;
  let str = null;          // "'", '"', '`'
  let comment = null;      // 'line' | 'block'
  const tmplStack = [];    // brace depth at each `${` we entered
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    depth[i] = d;
    if (comment === 'line') { if (c === '\n') comment = null; i++; continue; }
    if (comment === 'block') { if (c === '*' && n === '/') { comment = null; i += 2; continue; } i++; continue; }
    if (str) {
      if (c === '\\') { i += 2; continue; }
      if (c === str) { str = null; i++; continue; }
      if (str === '`' && c === '$' && n === '{') { tmplStack.push(d); d++; str = null; i += 2; continue; }
      i++; continue;
    }
    if (c === '/' && n === '/') { comment = 'line'; i += 2; continue; }
    if (c === '/' && n === '*') { comment = 'block'; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') { str = c; i++; continue; }
    if (c === '{') { d++; i++; continue; }
    if (c === '}') {
      d--;
      if (tmplStack.length && d === tmplStack[tmplStack.length - 1]) { tmplStack.pop(); str = '`'; }
      i++; continue;
    }
    i++;
  }
  return depth;
}

const depth = scanDepths(src);
const lineStart = [0];
for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStart.push(i + 1);
const lines = src.split('\n');

const cuts = [], failed = [];
for (const name of names) {
  const re = new RegExp(`^(?:export )?(?:async )?(?:function|const|let|interface|type|class) ${name}\\b`);
  const ln = lines.findIndex((l, i) => re.test(l) && depth[lineStart[i]] === 0);
  if (ln === -1) { failed.push(name); continue; }

  let from = ln;
  while (from > 0 && /^\s*(\/\*\*|\*|\*\/|\/\/)/.test(lines[from - 1])) from--;

  // End = first line after the declaration where depth returns to 0 and the
  // statement is closed (`}` / `;` / a blank line for a bare type alias).
  let to = ln, entered = false;
  for (; to < lines.length; to++) {
    const endOfLine = (lineStart[to + 1] ?? src.length) - 1;
    if (depth[lineStart[to]] === 0 && /[{]/.test(lines[to])) entered = true;
    if (entered && depth[endOfLine] === 0 && /^\}/.test(lines[to])) break;
    if (!entered && /;\s*$/.test(lines[to]) && depth[endOfLine] === 0) break;
  }
  if (to >= lines.length) { failed.push(name + '(unterminated)'); continue; }
  cuts.push([from, to]);
}

const drop = new Set();
for (const [a, b] of cuts) for (let i = a; i <= b; i++) drop.add(i);
const out = lines.filter((_, i) => !drop.has(i));
writeFileSync(file, out.join('\n').replace(/\n{3,}/g, '\n\n'));
console.log(`${file}: removed ${names.length - failed.length}/${names.length}${failed.length ? ` — FAILED: ${failed.join(', ')}` : ''}`);
