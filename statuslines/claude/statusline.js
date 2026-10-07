#!/usr/bin/env node
// Claude Code Enhanced Statusline
// Shows: directory | model | context usage | API usage (rate-limit windows) | current task
// Auto-detects API key vs subscription usage
// https://github.com/TahaSabir0/claude-statusline
//
// Usage segment: every rate-limit window the source publishes (5-hour + weekly), labelled, at real
// precision, each with its own reset countdown — plus the gateway's dollar figures when it exposes
// them. Source order: stdin rate_limits (from Claude Code) -> fresh shared cache -> OAuth usage API
// (with 429 backoff) -> stale cache shown dimmed with its age. A window whose resets_at has passed
// is dropped, exactly as Claude Code drops it; with no live window left the segment is hidden.

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const IS_API_KEY = !!process.env.ANTHROPIC_API_KEY;

// Cache configuration (shared across all sessions)
const CACHE_DIR = path.join(os.homedir(), '.claude', 'cache');
const USAGE_CACHE_FILE = path.join(CACHE_DIR, 'usage-cache-v3.json'); // v2 held one 5-hour number
const CACHE_FRESH_MS = 180000;     // Don't hit the API while the cache is younger than 3 min
const BACKOFF_DEFAULT_MS = 300000; // After an API failure, wait 5 min before retrying

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  orange: '\x1b[38;5;208m',
  red: '\x1b[31m',
  blink: '\x1b[5m'
};

function getUsageColor(percentage) {
  if (percentage < 50) return colors.green;
  if (percentage < 75) return colors.yellow;
  if (percentage < 90) return colors.orange;
  return colors.red;
}

function getContextBar(remaining) {
  const effectiveRemaining = remaining ?? 100;
  const used = Math.max(0, Math.min(100, 100 - Math.round(effectiveRemaining)));

  const filled = Math.floor(used / 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);

  let coloredBar;
  if (used < 50) {
    coloredBar = `${colors.green}${bar} ${used}%${colors.reset}`;
  } else if (used < 65) {
    coloredBar = `${colors.yellow}${bar} ${used}%${colors.reset}`;
  } else if (used < 80) {
    coloredBar = `${colors.orange}${bar} ${used}%${colors.reset}`;
  } else {
    coloredBar = `${colors.blink}${colors.red}\u{1F480} ${bar} ${used}%${colors.reset}`;
  }

  return coloredBar;
}

// 4d / 1d9h / 2h14m / 25m — zero components are dropped, days keep long windows readable.
function formatDuration(ms) {
  const totalMins = Math.max(0, Math.floor(ms / 60000));
  const totalHours = Math.floor(totalMins / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const mins = totalMins % 60;
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (totalHours > 0) return mins > 0 ? `${totalHours}h${mins}m` : `${totalHours}h`;
  return `${totalMins}m`;
}

// One decimal below 10% (1.5603 -> "1.6"), an integer at or above (41.2 -> "41"): the precision the
// provider published, never rounded away (1.5603% is not 2%). The *branch* comes from the value
// rounded to one decimal (so 9.96 and a `1 - 0.9` float artifact still print "10"), but the integer
// is rounded from the raw number: rounding twice would print 12.46% as "13". Capped at 100 — nothing
// published above a full window, and a source that scales oddly must not print 120%.
function formatWindowPercent(pct) {
  const value = Math.min(100, pct);
  const oneDecimal = Math.round(value * 10) / 10;
  return oneDecimal < 10 ? oneDecimal.toFixed(1) : String(Math.round(value));
}

const BAR_WIDTH = 10;
const WINDOW_ORDER = ['5h', 'wk', 'opus wk', 'sonnet wk'];

// The provider's own windows, labelled: `wk 3.0% (1d9h) · 5h 1.0% (4h4m)`. The bar comes from the
// binding window (the live one with the highest used_percentage); a window whose resets_at has
// passed is dropped rather than shown stale. Every window keeps its label even when it is the only
// one left (Claude Code drops expired windows before sending them), so the survivor can never be
// read as a different window. Returns null when nothing is live.
function usageParts(windows, now) {
  const usable = (windows || []).filter(w => typeof w.pct === 'number' && Number.isFinite(w.pct) && w.pct >= 0);
  const live = usable.filter(w => w.resetsAt == null || w.resetsAt > now);
  if (!live.length) return null;
  const binding = live.reduce((a, b) => (b.pct > a.pct ? b : a));
  const rest = live.filter(w => w !== binding)
    .sort((a, b) => WINDOW_ORDER.indexOf(a.label) - WINDOW_ORDER.indexOf(b.label));
  const text = [binding, ...rest].map((w) =>
    `${w.label} ${formatWindowPercent(w.pct)}%${w.resetsAt ? ` (${formatDuration(w.resetsAt - now)})` : ''}`
  ).join(' · ');
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((binding.pct / 100) * BAR_WIDTH)));
  return {
    pct: binding.pct,
    bar: '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled),
    text,
  };
}

// The full `usage:` value: the window segment, the gateway's dollars when it published any, and a
// dimmed age marker when the numbers could not be refreshed. Dollars without a live window still
// show: they are published values too.
function renderUsage(state, now) {
  const parts = state && usageParts(state.windows, now);
  if (!parts) {
    return state && state.spend && state.staleAgeMs === undefined
      ? `${colors.dim}${state.spend}${colors.reset}` : null;
  }
  if (state.staleAgeMs !== undefined) {
    return `${colors.dim}${parts.bar} ${parts.text} · ${formatDuration(state.staleAgeMs)} ago${colors.reset}`;
  }
  const color = getUsageColor(parts.pct);
  const spend = state.spend ? `${colors.dim} · ${state.spend}${colors.reset}` : '';
  return `${color}${parts.bar} ${parts.text}${colors.reset}${spend}`;
}

const WINDOW_KEYS = [['5h', 'five_hour'], ['wk', 'seven_day']];

// Claude Code's statusline stdin: rate_limits.{five_hour,seven_day} (percent + epoch-seconds reset),
// plus spend_limit.{used_usd,limit_usd,period} behind a Claude apps gateway. Windows Claude Code has
// already dropped are simply absent.
function usageFromStdin(data) {
  const limits = data && data.rate_limits;
  if (!limits) return null;
  const windows = [];
  for (const [label, key] of WINDOW_KEYS) {
    const window = limits[key];
    if (!window || typeof window.used_percentage !== 'number') continue;
    windows.push({
      label, pct: window.used_percentage,
      resetsAt: typeof window.resets_at === 'number' ? window.resets_at * 1000 : null,
    });
  }
  const spendLimit = limits.spend_limit;
  // The published dollars, printed as published: rounding a $12.50 limit to $13 would be a number
  // nobody sent.
  const spend = spendLimit && typeof spendLimit.used_usd === 'number'
    && typeof spendLimit.limit_usd === 'number' && spendLimit.limit_usd > 0
    ? `$${spendLimit.used_usd.toFixed(2)}/$${spendLimit.limit_usd}${spendLimit.period ? ` ${spendLimit.period[0]}` : ''}`
    : null;
  return windows.length || spend ? { windows, spend } : null;
}

// The OAuth usage API's body, same shape but with the model-scoped weekly windows Claude Code does
// not send on stdin; `extra_usage` is the only money a subscription plan publishes there.
const API_WINDOW_KEYS = [['5h', 'five_hour'], ['wk', 'seven_day'],
                         ['opus wk', 'seven_day_opus'], ['sonnet wk', 'seven_day_sonnet']];

function usageFromApi(body) {
  const windows = [];
  for (const [label, key] of API_WINDOW_KEYS) {
    const window = body[key];
    if (!window || typeof window.utilization !== 'number') continue;
    const resetsAt = window.resets_at ? Date.parse(window.resets_at) : NaN;
    windows.push({ label, pct: window.utilization, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null });
  }
  const extra = body.extra_usage || {};
  const spend = extra.is_enabled && typeof extra.used_credits === 'number'
    && typeof extra.monthly_limit === 'number'
    ? `${extra.used_credits.toFixed(2)}/${extra.monthly_limit.toFixed(2)} ${extra.currency || 'USD'}`
    : null;
  return windows.length || spend ? { windows, spend } : null;
}

function readCache() {
  try {
    const cache = JSON.parse(fs.readFileSync(USAGE_CACHE_FILE, 'utf8'));
    return cache && typeof cache === 'object' ? cache : {};
  } catch (e) {
    return {};
  }
}

// Merge fields into the cache. Write to a temp file and rename, because
// several sessions read and write this file concurrently.
function writeCache(fields) {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    const next = { ...readCache(), ...fields };
    const tmp = `${USAGE_CACHE_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(next), 'utf8');
    fs.renameSync(tmp, USAGE_CACHE_FILE);
  } catch (e) {
    // Silently fail
  }
}

function parseRetryAfter(header) {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return secs * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

// Calls back with {windows, spend} on success or {error, retryAfterMs} on failure.
function fetchUsageFromApi(callback) {
  let done = false;
  const finish = (result) => {
    if (done) return;
    done = true;
    callback(result);
  };

  try {
    // Read credentials
    const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
    if (!fs.existsSync(credsPath)) {
      return finish({ error: 'no-credentials' });
    }

    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    const accessToken = creds.claudeAiOauth?.accessToken;

    if (!accessToken) {
      return finish({ error: 'no-token' });
    }

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/api/oauth/usage',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20'
      },
      timeout: 1200
    }, (res) => {
      let data = '';

      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return finish({
            error: `http-${res.statusCode}`,
            retryAfterMs: parseRetryAfter(res.headers['retry-after'])
          });
        }
        try {
          const parsed = usageFromApi(JSON.parse(data));
          if (!parsed) {
            return finish({ error: 'no-windows' });
          }
          finish(parsed);
        } catch (e) {
          finish({ error: 'bad-json' });
        }
      });
    });

    req.on('error', () => finish({ error: 'network' }));
    req.on('timeout', () => {
      req.destroy();
      finish({ error: 'timeout' });
    });

    req.end();
  } catch (e) {
    finish({ error: 'exception' });
  }
}

// Resolve the usage segment from the best available source (see header comment).
function resolveUsage(data, callback) {
  const now = Date.now();

  // 1. Claude Code passes the live rate limits on stdin for subscribers
  const fromStdin = usageFromStdin(data);
  if (fromStdin) {
    writeCache({ windows: fromStdin.windows, spend: fromStdin.spend, fetchedAt: now, backoffUntil: 0 });
    return callback(renderUsage(fromStdin, now));
  }

  const cache = readCache();
  const cached = Array.isArray(cache.windows) && typeof cache.fetchedAt === 'number'
    ? { windows: cache.windows, spend: cache.spend || null }
    : null;
  const hasLive = cached ? usageParts(cached.windows, now) !== null : false;

  // 2. Fresh shared cache
  if (hasLive && now - cache.fetchedAt < CACHE_FRESH_MS) {
    return callback(renderUsage(cached, now));
  }

  // 4. Stale cache, dimmed with its age; hidden once every window has reset
  const fallback = () => callback(hasLive
    ? renderUsage({ ...cached, staleAgeMs: now - cache.fetchedAt }, now)
    : null);

  // 3. API, unless using an API key or backing off after a failure
  if (IS_API_KEY || (cache.backoffUntil && cache.backoffUntil > now)) {
    return fallback();
  }

  fetchUsageFromApi((result) => {
    if (result.error) {
      writeCache({ backoffUntil: Date.now() + (result.retryAfterMs || BACKOFF_DEFAULT_MS) });
      return fallback();
    }
    writeCache({ windows: result.windows, spend: result.spend, fetchedAt: Date.now(), backoffUntil: 0 });
    callback(renderUsage(result, Date.now()));
  });
}

function getCurrentTask(sessionId) {
  if (!sessionId) return '';

  const homeDir = os.homedir();
  const todosDir = path.join(homeDir, '.claude', 'todos');

  if (!fs.existsSync(todosDir)) return '';

  try {
    const files = fs.readdirSync(todosDir)
      .filter(f => f.startsWith(sessionId) && f.includes('-agent-') && f.endsWith('.json'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(todosDir, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length > 0) {
      const todos = JSON.parse(fs.readFileSync(path.join(todosDir, files[0].name), 'utf8'));
      const inProgress = todos.find(t => t.status === 'in_progress');
      if (inProgress) return inProgress.activeForm || '';
    }
  } catch (e) {}

  return '';
}

function getEffort(data) {
  if (data?.effort?.level) return data.effort.level;
  if (process.env.CLAUDE_CODE_EFFORT_LEVEL) return process.env.CLAUDE_CODE_EFFORT_LEVEL;
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
    if (settings.effortLevel) return settings.effortLevel;
  } catch (e) {}
  return '';
}

// Main
function outputStatus(data, usageText) {
  try {
    const model = data?.model?.display_name || 'Claude';
    const dir = data?.workspace?.current_dir || process.cwd();
    const dirname = path.basename(dir);
    const sessionId = data?.session_id || '';
    const remaining = data?.context_window?.remaining_percentage;

    const contextBar = getContextBar(remaining);
    const task = getCurrentTask(sessionId);
    const parts = [];
    parts.push(dirname);
    parts.push(model);
    const effort = getEffort(data);
    if (effort) parts.push(`${colors.dim}${effort}${colors.reset}`);
    parts.push(`context: ${contextBar}`);

    if (usageText) {
      parts.push(`usage: ${usageText}`);
    }

    if (task) parts.push(`${colors.dim}${task}${colors.reset}`);
    process.stdout.write(parts.join(' │ '));
  } catch (e) {
    process.stdout.write('Status unavailable');
  }
}

function outputFallback(usageText) {
  const contextBar = getContextBar(undefined);
  const parts = ['~', 'Claude', `context: ${contextBar}`];
  if (usageText) parts.push(`usage: ${usageText}`);
  process.stdout.write(parts.join(' │ '));
}

// Parse stdin first (usage may come from it), then resolve usage and print
function render(input) {
  let data = null;
  try {
    data = input.length > 0 ? JSON.parse(input) : null;
  } catch (e) {}

  resolveUsage(data, (usageText) => {
    if (data) {
      outputStatus(data, usageText);
    } else {
      outputFallback(usageText);
    }
    process.exit(0);
  });
}

// Process with timeout. `require.main` guard: the pure helpers above are unit-tested by requiring
// this file, and only a real invocation (Claude Code piping session JSON) may touch stdin.
if (require.main === module) {
  if (process.stdin.isTTY) {
    render('');
  } else {
    let input = '';
    let rendered = false;

    const timeout = setTimeout(() => {
      rendered = true;
      render(input);
    }, IS_API_KEY ? 500 : 1300);

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => {
      if (rendered) return;
      rendered = true;
      clearTimeout(timeout);
      render(input);
    });
  }
}

module.exports = { formatDuration, formatWindowPercent, usageParts, renderUsage, usageFromApi, usageFromStdin };
