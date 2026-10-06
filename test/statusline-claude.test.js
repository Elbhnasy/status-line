// The Claude statusline must be the original file, byte for byte, with unchanged output.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { sha256 } = require('../src/lib/fsutil');
const { runStatusline } = require('./helpers/run');
const cases = require('./fixtures/cases');
const golden = require('./fixtures/golden/claude.json');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'statuslines/claude/statusline.js');

// sha256 of ~/.claude/hooks/statusline.js when it was imported.
const ORIGINAL_SHA = 'f7ebef22dd7e08797c8e37c7e487c68fdee44be406170c686d75f391ee0ff5fa';

test('claude statusline is byte-identical to the original', () => {
  assert.strictEqual(sha256(SCRIPT), ORIGINAL_SHA);
});

test('opencode statusline is byte-identical to the original', () => {
  assert.strictEqual(sha256(path.join(ROOT, 'statuslines/opencode/statusline.tsx')),
    'ea5b09b208ea10ce9324dddba70077586b0d680253d6399810f602970295a8e8');
});

test('every claude case has a golden', () => {
  assert.deepStrictEqual(Object.keys(golden).sort(), Object.keys(cases.claude).sort());
});

for (const [id, c] of Object.entries(cases.claude)) {
  test(`claude output matches original: ${id}`, () => {
    const r = runStatusline(SCRIPT, c);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, golden[id]);
  });
}
