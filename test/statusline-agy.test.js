// Agy statusline: identical to the original until usage data exists, then the quota segment —
// both windows of the active model's group, at the precision the vendor published.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runStatusline, tmpHome, NOW } = require('./helpers/run');
const { stripAnsi } = require('./helpers/ansi');
const cases = require('./fixtures/cases');
const usageCases = require('./fixtures/usage-cases');
const golden = require('./fixtures/golden/agy.json');

const { MIN, HOUR, agyPayload } = cases;
const SCRIPT = path.join(__dirname, '..', 'statuslines/agy/statusline.js');
const CACHE_REL = '.gemini/antigravity-cli/cache/status-line-usage.json';
const NO_AGY = { STATUS_LINE_AGY_BIN: '/nonexistent/agy' };
const ESC = '\x1b';

// Shape of `agy -p "/usage" --output-format json` -> command.data.groups (captured 2026-10-06).
// `weeklyReset` defaults to a week out; the 5h bucket resets at `reset`.
function groups({
  gemini = 1, geminiWeekly = 0.9, thirdParty = 1, thirdPartyWeekly = 0.5,
  reset = NOW + 2 * HOUR + 14 * MIN, weeklyReset = NOW + 7 * 24 * HOUR,
} = {}) {
  const iso = (ms) => new Date(ms).toISOString();
  const bucket = (id, window, fraction) => {
    const b = { id, name: window === '5h' ? 'Five Hour Limit Remaining' : 'Weekly Limit Remaining', window,
      reset_time: iso(window === '5h' ? reset : weeklyReset) };
    if (fraction !== null) b.remaining_fraction = fraction; // null: field omitted
    return b;
  };
  return [
    { name: 'Gemini Models', description: 'Models within this group: Gemini Flash, Gemini Pro',
      buckets: [bucket('gemini-weekly', 'weekly', geminiWeekly), bucket('gemini-5h', '5h', gemini)] },
    { name: 'Claude and GPT models', description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
      buckets: [bucket('3p-weekly', 'weekly', thirdPartyWeekly), bucket('3p-5h', '5h', thirdParty)] },
  ];
}

function withCache(cache, stdin = JSON.stringify(agyPayload())) {
  return runStatusline(SCRIPT, { stdin, env: NO_AGY, files: { [CACHE_REL]: cache } });
}

// Shared usage-case windows -> the agy cache shape: one group whose buckets are those windows.
function cacheFromWindows(windows) {
  const byLabel = Object.fromEntries(windows.map((w) => [w.label, w]));
  const bucket = (label, window) => {
    const w = byLabel[label];
    if (!w) return null;
    return {
      id: label === '5h' ? 'gemini-5h' : 'gemini-weekly',
      name: label === '5h' ? 'Five Hour Limit Remaining' : 'Weekly Limit Remaining',
      window,
      reset_time: w.resetsAt ? new Date(w.resetsAt).toISOString() : undefined,
      remaining_fraction: Math.max(0, 1 - w.pct / 100),
    };
  };
  return [{
    name: 'Gemini Models', description: 'Models within this group: Gemini Flash, Gemini Pro',
    buckets: [bucket('5h', '5h'), bucket('wk', 'weekly')].filter(Boolean),
  }];
}

test('every agy case has a golden', () => {
  assert.deepStrictEqual(Object.keys(golden).sort(), Object.keys(cases.agy).sort());
});

for (const [id, c] of Object.entries(cases.agy)) {
  test(`agy output without usage data matches original: ${id}`, () => {
    const r = runStatusline(SCRIPT, { ...c, env: NO_AGY });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, golden[id]);
  });
}

test('both buckets of the group are shown, at the published precision', () => {
  const r = withCache({ fetchedAt: NOW - MIN, groups: groups({ gemini: 0.9844, geminiWeekly: 0.9974 }) });
  assert.strictEqual(r.stdout,
    `${golden['gemini-full']} │ usage: ${ESC}[32m5h ${'\u2591'.repeat(10)} 1.6% (2h14m) · wk 0.3% (7d)${ESC}[0m`);
});

test('the weekly bucket is shown even when it is the only one that moved', () => {
  const r = withCache({ fetchedAt: NOW - MIN, groups: groups({ gemini: 1, geminiWeekly: 0.5 }) });
  assert.match(stripAnsi(r.stdout), /usage: 5h \u2591{10} 0\.0% \(2h14m\) · wk 50% \(7d\)$/);
  assert.ok(r.stdout.includes(`usage: ${ESC}[32m`), r.stdout);
});

test('claude and gpt models use the Claude and GPT group', () => {
  const cache = { fetchedAt: NOW - MIN, groups: groups({ gemini: 1, thirdParty: 0.2 }) };
  for (const id of ['claude-model', 'gpt-model']) {
    const r = withCache(cache, cases.agy[id].stdin);
    assert.match(stripAnsi(r.stdout), /usage: 5h \u2588{8}\u2591{2} 80% \(2h14m\) · wk 50% \(7d\)$/, id);
    assert.ok(r.stdout.includes(`usage: ${ESC}[38;5;208m`), id);
  }
});

test('usage colors follow the existing thresholds', () => {
  const expect = { 0.9: '32m', 0.4: '33m', 0.3: '33m', 0.2: '38;5;208m', 0.05: '31m' };
  for (const [fraction, color] of Object.entries(expect)) {
    const r = withCache({ fetchedAt: NOW - MIN, groups: groups({ gemini: Number(fraction) }) });
    assert.ok(r.stdout.includes(`usage: ${ESC}[${color}`), `${fraction}: ${r.stdout}`);
  }
});

test('missing remaining_fraction (proto3 omits zero) means fully used', () => {
  const r = withCache({ fetchedAt: NOW - MIN, groups: groups({ gemini: null }) });
  assert.match(stripAnsi(r.stdout), /usage: 5h \u2588{10} 100% \(2h14m\)/);
});

test('unknown model family hides the usage segment', () => {
  const stdin = JSON.stringify(agyPayload({ model: { display_name: 'Mystery 1' } }));
  const r = withCache({ fetchedAt: NOW - MIN, groups: groups() }, stdin);
  assert.strictEqual(r.stdout, golden['gemini-full'].replace('Gemini 3.8 Flash (High)', 'Mystery 1'));
});

test('a cache older than 10 minutes is dimmed with its age', () => {
  const r = withCache({ fetchedAt: NOW - 25 * MIN, groups: groups({ gemini: 0.7 }) });
  assert.strictEqual(r.stdout,
    `${golden['gemini-full']} │ usage: ${ESC}[2m5h \u2588\u2588\u2588\u2591\u2591\u2591\u2591\u2591\u2591\u2591 30% (2h14m) · wk 10% (7d) · 25m ago${ESC}[0m`);
});

test('a window past its reset is dropped, the live one stays', () => {
  const r = withCache({ fetchedAt: NOW - MIN, groups: groups({ gemini: 0.7, reset: NOW - MIN }) });
  assert.match(stripAnsi(r.stdout), /usage: wk \u2588\u2591{9} 10% \(7d\)$/);
});

test('nothing live hides the segment', () => {
  const r = withCache({
    fetchedAt: NOW - 3 * HOUR,
    groups: groups({ gemini: 0.7, reset: NOW - MIN, weeklyReset: NOW - MIN }),
  });
  assert.strictEqual(r.stdout, golden['gemini-full']);
});

test('fallback line (no stdin model) uses the model from agy settings.json', () => {
  const r = runStatusline(SCRIPT, {
    stdin: '', env: NO_AGY,
    files: {
      [CACHE_REL]: { fetchedAt: NOW - MIN, groups: groups({ gemini: 0.9 }) },
      '.gemini/antigravity-cli/settings.json': { model: 'Gemini 3.8 Flash (High)' },
    },
  });
  assert.match(stripAnsi(r.stdout), /usage: 5h \u2588\u2591{9} 10% \(2h14m\) · wk 10% \(7d\)$/);
});

// The shared real-usage contract: the same windows must render identically here and in Claude Code.
// The match is anchored to the end of the line so a trailing stale marker or a dollar suffix cannot
// pass as the expected segment.
for (const c of usageCases) {
  test(`agy usage segment: ${c.name}`, () => {
    const r = withCache({ fetchedAt: NOW - MIN, groups: cacheFromWindows(c.windows) });
    const line = stripAnsi(r.stdout);
    if (c.segment === null) assert.ok(!line.includes('usage:'), line);
    else assert.match(line, new RegExp(`usage: ${c.segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), line);
  });
}

// A fake agy that records each call and prints the captured /usage JSON.
function fakeAgy(dir, { sleepMs = 0 } = {}) {
  const bin = path.join(dir, 'fake-agy');
  const payload = { status: 'SUCCESS', command: { name: 'usage', data: { groups: groups({ gemini: 0.25 }) } } };
  fs.writeFileSync(bin, `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(path.join(dir, 'calls'))}, JSON.stringify(process.argv.slice(2)) + '\\n');
setTimeout(() => console.log(${JSON.stringify(JSON.stringify(payload))}), ${sleepMs});
`, { mode: 0o755 });
  return bin;
}

function waitFor(predicate, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return false;
}

test('--refresh-usage runs `agy -p /usage --output-format json` and caches the groups', () => {
  const dir = tmpHome();
  const r = runStatusline(SCRIPT, { args: ['--refresh-usage'], env: { STATUS_LINE_AGY_BIN: fakeAgy(dir) } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'calls'), 'utf8')),
    ['-p', '/usage', '--output-format', 'json']);
  const cache = JSON.parse(fs.readFileSync(path.join(r.home, CACHE_REL), 'utf8'));
  assert.strictEqual(cache.fetchedAt, NOW);
  assert.strictEqual(cache.groups[0].buckets[1].remaining_fraction, 0.25);
});

test('a stale cache triggers one detached refresh without blocking the render', () => {
  const dir = tmpHome();
  const env = { STATUS_LINE_AGY_BIN: fakeAgy(dir, { sleepMs: 3000 }) };
  const r = runStatusline(SCRIPT, { stdin: cases.agy['gemini-full'].stdin, env });
  assert.strictEqual(r.stdout, golden['gemini-full']);
  assert.ok(r.ms < 1500, `render took ${r.ms}ms`);
  const cacheFile = path.join(r.home, CACHE_REL);
  assert.strictEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).attemptedAt, NOW);
  assert.ok(waitFor(() => fs.existsSync(path.join(dir, 'calls'))), 'refresh never ran agy');
  assert.ok(waitFor(() => JSON.parse(fs.readFileSync(cacheFile, 'utf8')).groups), 'refresh never wrote the cache');
});

test('no refresh while the cache is fresh or a refresh was attempted within a minute', () => {
  for (const cache of [{ fetchedAt: NOW - 30000, groups: groups() }, { attemptedAt: NOW - 30000 }]) {
    const dir = tmpHome();
    runStatusline(SCRIPT, {
      stdin: cases.agy['gemini-full'].stdin, env: { STATUS_LINE_AGY_BIN: fakeAgy(dir) }, files: { [CACHE_REL]: cache },
    });
    assert.ok(!waitFor(() => fs.existsSync(path.join(dir, 'calls')), 1000), `refreshed with ${JSON.stringify(cache)}`);
  }
});
