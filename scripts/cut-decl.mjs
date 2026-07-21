// Delete a top-level declaration by name. A top-level function/const/interface in this
// codebase always ends at a line that is exactly "}" (or ends with ";" for one-liners).
// No lexing: line shape alone is unambiguous at depth 0, which is all we target.
import { readFileSync, writeFileSync } from 'node:fs';
const [file, ...names] = process.argv.slice(2);
let lines = readFileSync(file, 'utf8').split('\n');
const failed = [];
for (const name of names) {
  const re = new RegExp(`^(?:export )?(?:async )?(?:function|const|let|interface|type|class) ${name}\\b`);
  const start = lines.findIndex((l) => re.test(l));
  if (start === -1) { failed.push(name); continue; }
  let end = start;
  if (/;\s*$/.test(lines[start]) && !/[{(]\s*$/.test(lines[start])) {
    // one-line declaration
  } else {
    while (end < lines.length && lines[end] !== '}' && !/^\};?$/.test(lines[end])) end++;
  }
  let from = start;
  while (from > 0 && /^\s*(\/\*\*|\*|\*\/|\/\/)/.test(lines[from - 1])) from--;
  lines.splice(from, end - from + 1);
}
writeFileSync(file, lines.join('\n').replace(/\n{3,}/g, '\n\n'));
console.log(`${file}: cut ${names.length - failed.length}/${names.length}${failed.length ? ` FAILED: ${failed}` : ''}`);
