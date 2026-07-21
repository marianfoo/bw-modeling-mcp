// Delete class methods by name. Methods here are indented 2 spaces and end at a line
// that is exactly "  }". Line shape alone is unambiguous at that indent.
import { readFileSync, writeFileSync } from 'node:fs';
const [file, ...names] = process.argv.slice(2);
let lines = readFileSync(file, 'utf8').split('\n');
const failed = [];
for (const name of names) {
  const re = new RegExp(`^  (?:public |private |protected )?(?:async )?${name}\\(`);
  const start = lines.findIndex((l) => re.test(l));
  if (start === -1) { failed.push(name); continue; }
  let end = start;
  while (end < lines.length && lines[end] !== '  }') end++;
  let from = start;
  while (from > 0 && /^\s*(\/\*\*|\*|\*\/|\/\/)/.test(lines[from - 1])) from--;
  lines.splice(from, end - from + 1);
}
writeFileSync(file, lines.join('\n').replace(/\n{3,}/g, '\n\n'));
console.log(`${file}: cut ${names.length - failed.length}/${names.length}${failed.length ? ` FAILED: ${failed}` : ''}`);
