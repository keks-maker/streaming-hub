// Extrahiert Inline-<script>-Bloecke aus tv.html und prueft die JS-Syntax mit node --check
import { readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const html = readFileSync('tv.html', 'utf8');
const blocks = html.match(/<script>[\s\S]*?<\/script>/g) || [];
console.log('script blocks:', blocks.length);

const files = readdirSync('/tmp').filter(f => f.startsWith('tv_js_'));
files.forEach(f => unlinkSync('/tmp/' + f));

let n = 0;
for (const block of blocks) {
  const body = block.replace(/^<script>/, '').replace(/<\/script>$/, '');
  const out = `/tmp/tv_js_${n}.js`;
  writeFileSync(out, body);
  try {
    execFileSync('node', ['--check', out], { stdio: 'pipe' });
    console.log(`SYNTAX-OK block ${n} (${body.length} chars)`);
  } catch (e) {
    console.log(`SYNTAX-FAIL block ${n}:`, e.stderr?.toString() || e.message);
    process.exitCode = 1;
  }
  n++;
}
