#!/usr/bin/env node
// Claude Code Enhanced Statusline
// Shows: directory | model | context usage | API usage (5-hour limit) | current task
// Auto-detects API key vs subscription usage
// https://github.com/TahaSabir0/claude-statusline
//
// Usage source order: stdin rate_limits (from Claude Code) -> fresh shared cache
// -> OAuth usage API (with 429 backoff) -> stale cache shown dimmed with its age.

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const IS_API_KEY = !!process.env.ANTHROPIC_API_KEY;

// Cache configuration (shared across all sessions)
const CACHE_DIR = path.join(os.homedir(), '.claude', 'cache');
const USAGE_CACHE_FILE = path.join(CACHE_DIR, 'usage-cache-v2.json');
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

function formatDuration(ms) {
  const totalMins = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  return hours > 0 ? `${hours}h${mins}m` : `${mins}m`;
}

// Build the usage bar. The reset countdown is computed now, so a cached value
// never shows a frozen time. staleAgeMs marks a value we could not refresh.
function formatUsageBar(pct, resetsAtMs, staleAgeMs) {
  const percentage = Math.max(0, Math.min(100, Math.round(pct)));
  const barWidth = 10;
  const filledWidth = Math.round((percentage / 100) * barWidth);
  const bar = '█'.repeat(filledWidth) + '░'.repeat(barWidth - filledWidth);
  const timeStr = resetsAtMs ? ` (${formatDuration(resetsAtMs - Date.now())})` : '';

  if (staleAgeMs !== undefined) {
    return `${colors.dim}${bar} ${percentage}%${timeStr} · ${formatDuration(staleAgeMs)} ago${colors.reset}`;
  }
  const color = getUsageColor(percentage);
  return `${color}${bar} ${percentage}%${colors.reset}${colors.dim}${timeStr}${colors.reset}`;
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

// Calls back with {pct, resetsAt} on success or {error, retryAfterMs} on failure.
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
          const fiveHour = JSON.parse(data).five_hour;
          if (!fiveHour || typeof fiveHour.utilization !== 'number') {
            return finish({ error: 'no-five-hour' });
          }
          const resetsAt = fiveHour.resets_at ? Date.parse(fiveHour.resets_at) : null;
          finish({ pct: fiveHour.utilization, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null });
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

// Resolve the usage bar from the best available source (see header comment).
function resolveUsage(data, callback) {
  const now = Date.now();

  // 1. Claude Code passes rate limits on stdin for subscribers
  const fiveHour = data?.rate_limits?.five_hour;
  if (fiveHour && typeof fiveHour.used_percentage === 'number') {
    const resetsAt = typeof fiveHour.resets_at === 'number' ? fiveHour.resets_at * 1000 : null;
    writeCache({ pct: fiveHour.used_percentage, resetsAt, fetchedAt: now, source: 'stdin' });
    return callback(formatUsageBar(fiveHour.used_percentage, resetsAt));
  }

  const cache = readCache();
  const hasCached = typeof cache.pct === 'number' && typeof cache.fetchedAt === 'number';
  const windowOpen = hasCached && (!cache.resetsAt || cache.resetsAt > now);

  // 2. Fresh shared cache
  if (windowOpen && now - cache.fetchedAt < CACHE_FRESH_MS) {
    return callback(formatUsageBar(cache.pct, cache.resetsAt));
  }

  // 4. Stale cache, dimmed with its age; hidden once its window has reset
  const fallback = () => callback(windowOpen ? formatUsageBar(cache.pct, cache.resetsAt, now - cache.fetchedAt) : null);

  // 3. API, unless using an API key or backing off after a failure
  if (IS_API_KEY || (cache.backoffUntil && cache.backoffUntil > now)) {
    return fallback();
  }

  fetchUsageFromApi((result) => {
    if (result.error) {
      writeCache({ backoffUntil: Date.now() + (result.retryAfterMs || BACKOFF_DEFAULT_MS) });
      return fallback();
    }
    writeCache({ pct: result.pct, resetsAt: result.resetsAt, fetchedAt: Date.now(), source: 'api', backoffUntil: 0 });
    callback(formatUsageBar(result.pct, result.resetsAt));
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
function outputStatus(data, usageBar) {
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

    if (usageBar) {
      parts.push(`usage: ${usageBar}`);
    }

    if (task) parts.push(`${colors.dim}${task}${colors.reset}`);
    process.stdout.write(parts.join(' │ '));
  } catch (e) {
    process.stdout.write('Status unavailable');
  }
}

function outputFallback(usageBar) {
  const contextBar = getContextBar(undefined);
  const parts = ['~', 'Claude', `context: ${contextBar}`];
  if (usageBar) parts.push(`usage: ${usageBar}`);
  process.stdout.write(parts.join(' │ '));
}

// Parse stdin first (usage may come from it), then resolve usage and print
function render(input) {
  let data = null;
  try {
    data = input.length > 0 ? JSON.parse(input) : null;
  } catch (e) {}

  resolveUsage(data, (usageBar) => {
    if (data) {
      outputStatus(data, usageBar);
    } else {
      outputFallback(usageBar);
    }
    process.exit(0);
  });
}

// Process with timeout
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
