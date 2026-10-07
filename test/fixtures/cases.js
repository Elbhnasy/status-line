// Statusline input cases. Golden outputs for each case were recorded from the
// ORIGINAL live scripts (scripts/record-goldens.js) before anything changed; goldens for cases that
// the real-usage change deliberately altered are re-recorded from the packaged script.
const { NOW } = require('../helpers/run');

const MIN = 60000;
const HOUR = 60 * MIN;

function claudePayload(over = {}) {
  return {
    session_id: 'sess1',
    model: { display_name: 'Opus 5.5' },
    workspace: { current_dir: '/path/to/my-project' },
    context_window: { remaining_percentage: 70 },
    effort: { level: 'high' },
    ...over,
  };
}

function fiveHour(pct, resetsInMs) {
  return { rate_limits: { five_hour: { used_percentage: pct, resets_at: Math.floor((NOW + resetsInMs) / 1000) } } };
}

// Shared-usage-case windows ({label, pct, resetsAt}) -> the Claude Code stdin shape
// (`five_hour` / `seven_day`, epoch seconds). Also used by the shared-contract tests.
const CLAUDE_WINDOW_KEYS = { '5h': 'five_hour', 'wk': 'seven_day' };
function claudeRateLimits(windows) {
  const out = {};
  for (const w of windows) {
    const key = CLAUDE_WINDOW_KEYS[w.label];
    if (!key) continue;
    out[key] = { used_percentage: w.pct, resets_at: w.resetsAt ? Math.floor(w.resetsAt / 1000) : undefined };
  }
  return out;
}

const claude = {
  'full-with-rate-limits': { stdin: claudePayload(fiveHour(42, 2 * HOUR + 14 * MIN)) },
  'usage-60': { stdin: claudePayload(fiveHour(60, 30 * MIN)) },
  'usage-80': { stdin: claudePayload(fiveHour(80, 4 * HOUR)) },
  'usage-95': { stdin: claudePayload(fiveHour(95, 5 * MIN)) },
  'usage-5h-and-week': {
    stdin: claudePayload({
      rate_limits: claudeRateLimits([
        { label: '5h', pct: 42, resetsAt: NOW + 2 * HOUR + 14 * MIN },
        { label: 'wk', pct: 3.2, resetsAt: NOW + 33 * HOUR },
      ]),
    }),
  },
  'usage-5h-expired': {
    stdin: claudePayload({
      rate_limits: claudeRateLimits([
        { label: '5h', pct: 88, resetsAt: NOW - MIN },
        { label: 'wk', pct: 41.2, resetsAt: NOW + 4 * 24 * HOUR },
      ]),
    }),
  },
  'no-rate-limits-no-creds': { stdin: claudePayload() },
  'context-45': { stdin: claudePayload({ context_window: { remaining_percentage: 55 } }) },
  'context-55': { stdin: claudePayload({ context_window: { remaining_percentage: 45 } }) },
  'context-70': { stdin: claudePayload({ context_window: { remaining_percentage: 30 } }) },
  'context-85': { stdin: claudePayload({ context_window: { remaining_percentage: 15 } }) },
  'context-missing': { stdin: claudePayload({ context_window: undefined }) },
  'no-effort': { stdin: claudePayload({ effort: undefined }) },
  'effort-from-env': { stdin: claudePayload({ effort: undefined }), env: { CLAUDE_CODE_EFFORT_LEVEL: 'low' } },
  'effort-from-settings': {
    stdin: claudePayload({ effort: undefined }),
    files: { '.claude/settings.json': { effortLevel: 'max' } },
  },
  'current-task': {
    stdin: claudePayload(),
    files: { '.claude/todos/sess1-agent-abc.json': [{ status: 'in_progress', activeForm: 'Running tests' }] },
  },
  // usage-cache-v3 holds every window the source published (v2 held one 5-hour percentage).
  'fresh-cache': {
    stdin: claudePayload(),
    files: {
      '.claude/cache/usage-cache-v3.json': {
        windows: [
          { label: '5h', pct: 33, resetsAt: NOW + HOUR },
          { label: 'wk', pct: 12, resetsAt: NOW + 4 * 24 * HOUR },
        ],
        fetchedAt: NOW - MIN,
      },
    },
  },
  'stale-cache-backoff': {
    stdin: claudePayload(),
    files: {
      '.claude/cache/usage-cache-v3.json': {
        windows: [{ label: '5h', pct: 63, resetsAt: NOW + 3 * HOUR }],
        fetchedAt: NOW - 10 * MIN, backoffUntil: NOW + MIN,
      },
    },
  },
  'expired-cache-window': {
    stdin: claudePayload(),
    files: {
      '.claude/cache/usage-cache-v3.json': {
        windows: [{ label: '5h', pct: 63, resetsAt: NOW - MIN }],
        fetchedAt: NOW - 10 * MIN, backoffUntil: NOW + MIN,
      },
    },
  },
  'api-key-with-rate-limits': { stdin: claudePayload(fiveHour(42, HOUR)), env: { ANTHROPIC_API_KEY: 'x' } },
  'api-key-no-rate-limits': { stdin: claudePayload(), env: { ANTHROPIC_API_KEY: 'x' } },
  'empty-stdin': { stdin: '' },
  'malformed-json': { stdin: '{not json' },
};

function agyPayload(over = {}) {
  return {
    session_id: 'conv1',
    model: { display_name: 'Gemini 3.8 Flash (High)' },
    workspace: { current_dir: '/path/to/my-project' },
    context_window: { context_window_size: 1000000, remaining_percentage: 70 },
    ...over,
  };
}

const agy = {
  'gemini-full': { stdin: agyPayload() },
  'claude-model': { stdin: agyPayload({ model: { display_name: 'Claude Opus 4.6 (Thinking)' } }) },
  'gpt-model': { stdin: agyPayload({ model: { display_name: 'GPT-OSS 120B (Medium)' } }) },
  'context-55': { stdin: agyPayload({ context_window: { context_window_size: 1000000, remaining_percentage: 45 } }) },
  'context-70': { stdin: agyPayload({ context_window: { context_window_size: 1000000, remaining_percentage: 30 } }) },
  'context-85': { stdin: agyPayload({ context_window: { context_window_size: 1000000, remaining_percentage: 15 } }) },
  'context-size-zero': { stdin: agyPayload({ context_window: { context_window_size: 0, remaining_percentage: 0 } }) },
  'context-missing': { stdin: agyPayload({ context_window: undefined }) },
  'extra-fields': { stdin: agyPayload({ conversation_title: 'Fix bug', cost: 0.42, effort: { level: 'high' } }) },
  'empty-stdin': { stdin: '' },
  'malformed-json': { stdin: '{not json' },
};

for (const set of [claude, agy]) {
  for (const c of Object.values(set)) {
    if (typeof c.stdin !== 'string') c.stdin = JSON.stringify(c.stdin);
  }
}

module.exports = { claude, agy, NOW, MIN, HOUR, agyPayload, claudePayload, claudeRateLimits };
