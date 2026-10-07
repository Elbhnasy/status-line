// The Claude statusline's output is pinned by recorded goldens (scripts/record-goldens.js), and its
// usage segment is checked against the shared real-usage contract (test/fixtures/usage-cases.js)
// that the agy script must satisfy too.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { sha256 } = require('../src/lib/fsutil');
const { runStatusline } = require('./helpers/run');
const { stripAnsi } = require('./helpers/ansi');
const cases = require('./fixtures/cases');
const usageCases = require('./fixtures/usage-cases');
const golden = require('./fixtures/golden/claude.json');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'statuslines/claude/statusline.js');

// sha256 of statuslines/claude/statusline.js as shipped. It is deliberately NO LONGER byte-identical
// to the original at ~/.claude/hooks/statusline.js: reporting both real rate-limit windows at real
// precision is the point of this change. This pin only catches accidental edits.
const PACKAGED_SHA = '80b893255c47d189480bea63bf493e829c12d2960f7fd61e07fdc58e32baa1a3';

test('claude statusline hash is pinned (tripwire only)', () => {
  assert.strictEqual(sha256(SCRIPT), PACKAGED_SHA);
});

test('opencode statusline is byte-identical to the original', () => {
  assert.strictEqual(sha256(path.join(ROOT, 'statuslines/opencode/statusline.tsx')),
    'ea5b09b208ea10ce9324dddba70077586b0d680253d6399810f602970295a8e8');
});

test('every claude case has a golden', () => {
  assert.deepStrictEqual(Object.keys(golden).sort(), Object.keys(cases.claude).sort());
});

for (const [id, c] of Object.entries(cases.claude)) {
  test(`claude output matches the recorded golden: ${id}`, () => {
    const r = runStatusline(SCRIPT, c);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, golden[id]);
  });
}

// The shared real-usage contract: the same windows must render identically here and in agy.
// The match is anchored to the end of the line so a trailing stale marker or a dollar suffix cannot
// pass as the expected segment. The harness rebuilds the child env from scratch (test/helpers/run.js).
for (const c of usageCases) {
  test(`claude usage segment: ${c.name}`, () => {
    const stdin = JSON.stringify(cases.claudePayload({ rate_limits: cases.claudeRateLimits(c.windows) }));
    const line = stripAnsi(runStatusline(SCRIPT, { stdin }).stdout);
    if (c.segment === null) assert.ok(!line.includes('usage:'), line);
    else assert.match(line, new RegExp(`usage: ${c.segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), line);
  });
}

test('gateway dollars are printed as published, next to the windows', () => {
  const r = runStatusline(SCRIPT, { stdin: cases.claude['usage-gateway-spend-limit'].stdin });
  assert.match(stripAnsi(r.stdout), /usage: \u2588{4}\u2591{6} 5h 42% \(2h14m\) · wk 5\.0% \(4d\) · \$3\.20\/\$12\.5 m$/);
});

test('dollars without a live window still show', () => {
  const r = runStatusline(SCRIPT, { stdin: cases.claude['usage-gateway-spend-only'].stdin });
  assert.match(stripAnsi(r.stdout), /usage: \$3\.20\/\$12\.5 m$/);
});
