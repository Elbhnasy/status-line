// The real-usage contract, shared by the Claude and agy suites: identical windows in, identical
// segment text out, so the two standalone statusline scripts cannot drift.
// `resetsInMs === null` means the source published no reset time.
const { NOW } = require('../helpers/run');
const MIN = 60000, HOUR = 60 * MIN;

const w = (label, pct, resetsInMs) => ({ label, pct, resetsInMs });
const at = (c) => ({ ...c, resetsAt: c.resetsInMs === null ? null : NOW + c.resetsInMs });

module.exports = [
  { name: 'week binds: both windows, bar on the week',
    windows: [w('5h', 1.0, 4 * HOUR + 4 * MIN), w('wk', 3.0, 33 * HOUR)],
    segment: '░░░░░░░░░░ wk 3.0% (1d9h) · 5h 1.0% (4h4m)' },
  { name: 'tiny values keep a decimal',
    windows: [w('5h', 1.5603, 4 * HOUR + 33 * MIN), w('wk', 0.2601, 6 * 24 * HOUR + 23 * HOUR)],
    segment: '░░░░░░░░░░ 5h 1.6% (4h33m) · wk 0.3% (6d23h)' },
  { name: '5h binds: week follows the bar',
    windows: [w('5h', 42, 2 * HOUR + 14 * MIN), w('wk', 5, 4 * 24 * HOUR)],
    segment: '████░░░░░░ 5h 42% (2h14m) · wk 5.0% (4d)' },
  { name: 'a window past its reset is not shown',
    windows: [w('5h', 88, -MIN), w('wk', 41.2, 4 * 24 * HOUR)],
    segment: '████░░░░░░ wk 41% (4d)' },
  { name: 'only one window published',
    windows: [w('5h', 42, 2 * HOUR + 14 * MIN)],
    segment: '████░░░░░░ 42% (2h14m)' },
  { name: 'nothing live leaves no segment', windows: [], segment: null },
].map((c) => ({ ...c, windows: c.windows.map(at) }));
