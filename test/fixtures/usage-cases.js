// The real-usage contract, shared by the Claude and agy suites: identical windows in, identical
// segment text out, so the two standalone statusline scripts cannot drift.
// `resetsInMs === null` means the source published no reset time.
const { NOW } = require('../helpers/run');
const MIN = 60000, HOUR = 60 * MIN;

const w = (label, pct, resetsInMs) => ({ label, pct, resetsInMs });
const at = (c) => ({ ...c, resetsAt: c.resetsInMs === null ? null : NOW + c.resetsInMs });

module.exports = [
  { name: 'a busier week still leaves the bar on the 5h window',
    windows: [w('5h', 1.0, 4 * HOUR + 4 * MIN), w('wk', 3.0, 33 * HOUR)],
    segment: '5h ░░░░░░░░░░ 1.0% (4h4m) · wk 3.0% (1d9h)' },
  { name: 'tiny values keep a decimal',
    windows: [w('5h', 1.5603, 4 * HOUR + 33 * MIN), w('wk', 0.2601, 6 * 24 * HOUR + 23 * HOUR)],
    segment: '5h ░░░░░░░░░░ 1.6% (4h33m) · wk 0.3% (6d23h)' },
  { name: '5h owns the bar: week follows it',
    windows: [w('5h', 42, 2 * HOUR + 14 * MIN), w('wk', 5, 4 * 24 * HOUR)],
    segment: '5h ████░░░░░░ 42% (2h14m) · wk 5.0% (4d)' },
  { name: 'a week just below the takeover keeps the bar on 5h',
    windows: [w('5h', 20, 2 * HOUR + 14 * MIN), w('wk', 89, 2 * 24 * HOUR)],
    segment: '5h ██░░░░░░░░ 20% (2h14m) · wk 89% (2d)' },
  { name: 'a week at the takeover takes the bar',
    windows: [w('5h', 20, 2 * HOUR + 14 * MIN), w('wk', 90, 2 * 24 * HOUR)],
    segment: 'wk █████████░ 90% (2d) · 5h 20% (2h14m)' },
  { name: 'past the takeover the more-used window keeps the bar',
    windows: [w('5h', 95, 2 * HOUR + 14 * MIN), w('wk', 92, 2 * 24 * HOUR)],
    segment: '5h ██████████ 95% (2h14m) · wk 92% (2d)' },
  { name: 'a window past its reset is not shown',
    windows: [w('5h', 88, -MIN), w('wk', 41.2, 4 * 24 * HOUR)],
    segment: 'wk ████░░░░░░ 41% (4d)' },
  { name: 'only one window published keeps its label',
    windows: [w('5h', 42, 2 * HOUR + 14 * MIN)],
    segment: '5h ████░░░░░░ 42% (2h14m)' },
  { name: 'both windows expired leaves no segment',
    windows: [w('5h', 88, -MIN), w('wk', 41.2, -MIN)],
    segment: null },
  { name: 'nothing published leaves no segment', windows: [], segment: null },
].map((c) => ({ ...c, windows: c.windows.map(at) }));
