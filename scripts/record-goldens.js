#!/usr/bin/env node
// Record golden stdout for every fixture case from a given statusline script.
// Run this against the ORIGINAL scripts only; the goldens are the behavior contract.
//   node scripts/record-goldens.js claude ~/.claude/hooks/statusline.js
//   node scripts/record-goldens.js agy test/fixtures/original/agy-statusline.js
const fs = require('fs');
const path = require('path');
const cases = require('../test/fixtures/cases');
const { runStatusline } = require('../test/helpers/run');

const [name, script] = process.argv.slice(2);
if (!cases[name] || !script) {
  console.error('usage: record-goldens.js <claude|agy> <script>');
  process.exit(2);
}

const out = {};
for (const [id, c] of Object.entries(cases[name])) {
  // A non-existent agy binary keeps any background refresh inert.
  const r = runStatusline(path.resolve(script), { ...c, env: { STATUS_LINE_AGY_BIN: '/nonexistent/agy', ...c.env } });
  if (r.status !== 0) throw new Error(`${id}: exit ${r.status}\n${r.stderr}`);
  out[id] = r.stdout;
}
const file = path.join(__dirname, '..', 'test', 'fixtures', 'golden', `${name}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${Object.keys(out).length} cases to ${path.relative(process.cwd(), file)}`);
