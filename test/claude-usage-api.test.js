// The Claude script's pure helpers: the cold path (OAuth usage API) and the precision/expiry rules
// are not reachable through the CLI-level goldens, which need credentials and the network.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  formatDuration, formatWindowPercent, usageParts, usageFromApi, usageFromStdin,
} = require(path.join(__dirname, '..', 'statuslines/claude/statusline.js'));

const NOW = 1790000000000;
const HOUR = 3600000;

test('duration rule drops zero components', () => {
  assert.strictEqual(formatDuration(60000), '1m');
  assert.strictEqual(formatDuration(3540000), '59m');
  assert.strictEqual(formatDuration(2 * HOUR), '2h');
  assert.strictEqual(formatDuration(2 * HOUR + 14 * 60000), '2h14m');
  assert.strictEqual(formatDuration(33 * HOUR), '1d9h');
  assert.strictEqual(formatDuration(4 * 24 * HOUR), '4d');
});

test('percent rule: one decimal below 10, the published number above it, capped at 100', () => {
  assert.strictEqual(formatWindowPercent(1.5603), '1.6');
  assert.strictEqual(formatWindowPercent(0.2601), '0.3');
  assert.strictEqual(formatWindowPercent(9.4), '9.4');
  assert.strictEqual(formatWindowPercent(9.99), '10');
  assert.strictEqual(formatWindowPercent(9.999999999999998), '10');
  assert.strictEqual(formatWindowPercent(12.46), '12');   // never double-rounded to 13
  assert.strictEqual(formatWindowPercent(12.5), '13');
  assert.strictEqual(formatWindowPercent(41.2), '41');
  assert.strictEqual(formatWindowPercent(100.4), '100');
});

test('a percentage from the usage API stays a percentage', () => {
  // The endpoint reports percentages: `five_hour.utilization` and `limits[].percent` agree, so 1.0
  // is a 1% session, never a full window (the Hermes fetcher got this wrong).
  const parsed = usageFromApi({
    five_hour: { utilization: 1.0, resets_at: new Date(NOW + HOUR).toISOString() },
    seven_day: { utilization: 20.0, resets_at: new Date(NOW + 48 * HOUR).toISOString() },
  });
  assert.deepStrictEqual(parsed.windows.map((w) => [w.label, w.pct]), [['5h', 1.0], ['wk', 20.0]]);
  assert.strictEqual(parsed.spend, null);
});

test('the usage API also carries the model-scoped weekly windows and extra-usage dollars', () => {
  const parsed = usageFromApi({
    five_hour: { utilization: 4, resets_at: new Date(NOW + HOUR).toISOString() },
    seven_day_opus: { utilization: 62.8, resets_at: new Date(NOW + 96 * HOUR).toISOString() },
    extra_usage: { is_enabled: true, used_credits: 3.2, monthly_limit: 12.5, currency: 'USD' },
  });
  assert.deepStrictEqual(parsed.windows.map((w) => [w.label, w.pct]), [['5h', 4], ['opus wk', 62.8]]);
  assert.strictEqual(parsed.spend, '3.20/12.50 USD');
});

test('an empty usage API body is nothing to show', () => {
  assert.strictEqual(usageFromApi({}), null);
  assert.strictEqual(usageFromApi({ five_hour: null, extra_usage: { is_enabled: false } }), null);
});

test('stdin dollars are taken as published and survive without a window', () => {
  const withWindow = usageFromStdin({
    rate_limits: {
      five_hour: { used_percentage: 42, resets_at: Math.floor((NOW + HOUR) / 1000) },
      spend_limit: { used_percentage: 6.4, used_usd: 3.2, limit_usd: 12.5, period: 'monthly' },
    },
  });
  assert.strictEqual(withWindow.spend, '$3.20/$12.5 m');

  const dollarsOnly = usageFromStdin({
    rate_limits: { spend_limit: { used_usd: 3.2, limit_usd: 12.5 } },
  });
  assert.deepStrictEqual([dollarsOnly.windows, dollarsOnly.spend], [[], '$3.20/$12.5']);

  assert.strictEqual(usageFromStdin({}), null);
  assert.strictEqual(usageFromStdin({ rate_limits: { five_hour: { used_percentage: null } } }), null);
});

test('usageParts labels every window, binds the bar to the highest, and drops expired ones', () => {
  const both = usageParts([
    { label: '5h', pct: 1.0, resetsAt: NOW + 4 * HOUR + 4 * 60000 },
    { label: 'wk', pct: 3.0, resetsAt: NOW + 33 * HOUR },
  ], NOW);
  assert.strictEqual(both.bar, '░'.repeat(10));
  assert.strictEqual(both.text, 'wk 3.0% (1d9h) · 5h 1.0% (4h4m)');

  // A single live window keeps its label: Claude Code drops expired windows before sending them,
  // so the survivor must not read as the 5-hour window.
  const onlyWeek = usageParts([
    { label: '5h', pct: 88, resetsAt: NOW - 60000 },
    { label: 'wk', pct: 41.2, resetsAt: NOW + 4 * 24 * HOUR },
  ], NOW);
  assert.strictEqual(onlyWeek.text, 'wk 41% (4d)');
  assert.strictEqual(onlyWeek.bar, '█'.repeat(4) + '░'.repeat(6));

  assert.strictEqual(usageParts([{ label: '5h', pct: 88, resetsAt: NOW - 60000 }], NOW), null);
  assert.strictEqual(usageParts([], NOW), null);
});
