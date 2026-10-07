#!/usr/bin/env node
// Antigravity CLI statusline (adapted from ~/.claude/hooks/statusline.js)
// Shows: directory | model | context usage | API usage (quota windows) | current task
// Auto-detects API key vs subscription usage
// https://github.com/TahaSabir0/claude-statusline
//
// Usage segment (status-line package): both quota windows of the active model's group — the 5-hour
// and the weekly bucket — from `agy -p "/usage" --output-format json`. The payload carries no token
// or dollar magnitude anywhere, so the fraction it publishes is the real value and is shown at its
// own precision, never rounded to a whole percentage. That call takes ~5s, so the segment only reads
// a cache that a detached `statusline.js --refresh-usage` keeps fresh in the background.

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawn, execFile } = require('child_process');

const IS_API_KEY = true; // agy: no Claude usage bar (the agy usage bar is used instead)

// Cache configuration
const CACHE_DIR = path.join(os.homedir(), '.claude', 'cache');
const USAGE_CACHE_FILE = path.join(CACHE_DIR, 'usage-cache.json');
const CACHE_TTL_MS = 30000; // Cache valid for 30 seconds

// Agy usage cache configuration
const AGY_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli');
const AGY_USAGE_CACHE_FILE = path.join(AGY_DIR, 'cache', 'status-line-usage.json');
const AGY_BIN = process.env.STATUS_LINE_AGY_BIN || 'agy';
const AGY_REFRESH_MS = 60000; // Refresh in the background once the cache is older than 1 min
const AGY_STALE_MS = 600000;  // Dim the segment and show its age once older than 10 min

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
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);

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

// Read cached usage data
function getCachedUsage() {
  try {
    if (!fs.existsSync(USAGE_CACHE_FILE)) return null;

    const cache = JSON.parse(fs.readFileSync(USAGE_CACHE_FILE, 'utf8'));
    const age = Date.now() - cache.timestamp;

    // Return cached data if fresh enough
    if (age < CACHE_TTL_MS) {
      return cache.data;
    }

    return null;
  } catch (e) {
    return null;
  }
}

// Write usage data to cache (shared across all sessions)
function setCachedUsage(data) {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }

    const cache = {
      timestamp: Date.now(),
      data: data
    };

    fs.writeFileSync(USAGE_CACHE_FILE, JSON.stringify(cache), 'utf8');
  } catch (e) {
    // Silently fail
  }
}

function getApiUsage(callback) {
  try {
    // Read credentials
    const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
    if (!fs.existsSync(credsPath)) {
      return callback(null);
    }

    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    const accessToken = creds.claudeAiOauth?.accessToken;

    if (!accessToken) {
      return callback(null);
    }

    // Adaptive timeout: if cache exists, be faster (1200ms); if not, be patient (1500ms)
    // API typically takes ~850ms, so 1200ms gives reasonable headroom
    const hasCache = fs.existsSync(USAGE_CACHE_FILE);
    const timeout = hasCache ? 1200 : 1500;

    // Make API call with adaptive timeout
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/api/oauth/usage',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20'
      },
      timeout: timeout
    }, (res) => {
      let data = '';

      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const usage = JSON.parse(data);

          // Get 5-hour session usage
          if (usage.five_hour) {
            const percentage = Math.round(usage.five_hour.utilization);
            const resetsAt = usage.five_hour.resets_at;

            // Parse reset time
            let timeStr = '';
            if (resetsAt) {
              const resetDate = new Date(resetsAt);
              const now = new Date();
              const diffMs = resetDate - now;
              const diffMins = Math.floor(diffMs / 60000);
              const hours = Math.floor(diffMins / 60);
              const mins = diffMins % 60;

              if (hours > 0) {
                timeStr = `${hours}h${mins}m`;
              } else {
                timeStr = `${mins}m`;
              }
            }

            // Build bar
            const barWidth = 10;
            const filledWidth = Math.round((percentage / 100) * barWidth);
            const filled = '\u2588'.repeat(filledWidth);
            const empty = '\u2591'.repeat(barWidth - filledWidth);
            const color = getUsageColor(percentage);

            const bar = `${color}${filled}${empty} ${percentage}%${colors.reset}${colors.dim} (${timeStr})${colors.reset}`;

            // Cache the result for other sessions
            setCachedUsage(bar);

            callback(bar);
          } else {
            callback(null);
          }
        } catch (e) {
          callback(null);
        }
      });
    });

    req.on('error', () => callback(null));
    req.on('timeout', () => {
      req.destroy();
      callback(null);
    });

    req.end();
  } catch (e) {
    callback(null);
  }
}

// Get usage with cache fallback
function getUsageWithCache(callback) {
  // First, try to get fresh data from API
  getApiUsage((freshData) => {
    if (freshData) {
      // Got fresh data, use it
      callback(freshData);
    } else {
      // API failed or timed out, try cache
      const cachedData = getCachedUsage();
      callback(cachedData);
    }
  });
}

// 4d / 1d9h / 2h14m / 25m — zero components are dropped, days keep the weekly window readable.
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
// vendor published, never rounded away (1.5603% is not 2%). The *branch* comes from the value
// rounded to one decimal (so 9.96 and a `1 - 0.9` float artifact still print "10"), but the integer
// is rounded from the raw number: rounding twice would print 12.46% as "13". Capped at 100.
function formatWindowPercent(pct) {
  const value = Math.min(100, pct);
  const oneDecimal = Math.round(value * 10) / 10;
  return oneDecimal < 10 ? oneDecimal.toFixed(1) : String(Math.round(value));
}

const BAR_WIDTH = 10;
const WINDOW_ORDER = ['5h', 'wk'];

// The published windows, labelled: `5h 1.6% (4h33m) · wk 0.3% (6d23h)`. The bar comes from the
// binding window (the live one with the higher usage); a window whose reset_time has passed is
// dropped rather than shown stale. Every window keeps its label even when it is the only one, so
// the survivor can never be read as the other window. Returns null when nothing is live.
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
    bar: '\u2588'.repeat(filled) + '\u2591'.repeat(BAR_WIDTH - filled),
    text,
  };
}

// The full `usage:` value, dimmed with its age when the numbers could not be refreshed.
function renderUsage(state, now) {
  const parts = state && usageParts(state.windows, now);
  if (!parts) return null;
  if (state.staleAgeMs !== undefined) {
    return `${colors.dim}${parts.bar} ${parts.text} · ${formatDuration(state.staleAgeMs)} ago${colors.reset}`;
  }
  const color = getUsageColor(parts.pct);
  return `${color}${parts.bar} ${parts.text}${colors.reset}`;
}

function readAgyUsageCache() {
  try {
    const cache = JSON.parse(fs.readFileSync(AGY_USAGE_CACHE_FILE, 'utf8'));
    return cache && typeof cache === 'object' ? cache : {};
  } catch (e) {
    return {};
  }
}

// Merge fields into the cache via temp file + rename: several sessions share it.
function writeAgyUsageCache(fields) {
  try {
    fs.mkdirSync(path.dirname(AGY_USAGE_CACHE_FILE), { recursive: true });
    const next = { ...readAgyUsageCache(), ...fields };
    const tmp = `${AGY_USAGE_CACHE_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(next), 'utf8');
    fs.renameSync(tmp, AGY_USAGE_CACHE_FILE);
  } catch (e) {
    // Silently fail
  }
}

// `--refresh-usage` entry point: run `agy -p /usage` and store its quota groups.
function refreshAgyUsage() {
  execFile(AGY_BIN, ['-p', '/usage', '--output-format', 'json'], {
    cwd: os.tmpdir(),
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, STATUS_LINE_AGY_REFRESH: '1' }
  }, (err, stdout) => {
    if (!err) {
      // The JSON result is the last line that parses; ignore anything printed before it.
      const lines = String(stdout).trim().split('\n').reverse();
      for (const line of lines) {
        try {
          const groups = JSON.parse(line)?.command?.data?.groups;
          if (Array.isArray(groups)) {
            writeAgyUsageCache({ fetchedAt: Date.now(), groups });
            break;
          }
        } catch (e) {}
      }
    }
    process.exit(0);
  });
}

// Start a detached refresh unless the cache is fresh or one was started recently.
function maybeRefreshAgyUsage(cache, now) {
  if (process.env.STATUS_LINE_AGY_REFRESH) return;
  if (cache.fetchedAt && now - cache.fetchedAt < AGY_REFRESH_MS) return;
  if (cache.attemptedAt && now - cache.attemptedAt < AGY_REFRESH_MS) return;
  writeAgyUsageCache({ attemptedAt: now });
  try {
    spawn(process.execPath, [...process.execArgv, __filename, '--refresh-usage'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, STATUS_LINE_AGY_REFRESH: '1' }
    }).unref();
  } catch (e) {}
}

function getAgyModelName(data) {
  if (typeof data?.model === 'string') return data.model;
  if (data?.model?.display_name) return data.model.display_name;
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(AGY_DIR, 'settings.json'), 'utf8'));
    if (typeof settings.model === 'string') return settings.model;
  } catch (e) {}
  return '';
}

// Quota groups list their models ("Models within this group: Claude Opus, GPT-OSS"); pick
// the group naming the model's family, e.g. "Gemini" in "Gemini 3.8 Flash (High)".
function findAgyQuotaGroup(groups, modelName) {
  const words = (text) => String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const family = words(modelName)[0];
  if (!family) return null;
  return groups.find(g => words(String(g?.description || '').split(':').pop()).includes(family))
    || groups.find(g => words(g?.name).includes(family))
    || null;
}

// Both buckets of the group, as the vendor published them. The payload has no absolute magnitude
// for a quota window, so the fraction is the value.
const AGY_BUCKETS = [['5h', '5h'], ['wk', 'weekly']];

function groupWindows(group) {
  const windows = [];
  for (const [label, window] of AGY_BUCKETS) {
    const bucket = group?.buckets?.find(b => b?.window === window);
    if (!bucket) continue;
    // remaining_fraction is omitted (proto3 omitempty) when nothing is left.
    const remaining = typeof bucket.remaining_fraction === 'number' ? bucket.remaining_fraction : 0;
    const resetsAt = Date.parse(bucket.reset_time);
    windows.push({ label, pct: (1 - remaining) * 100, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null });
  }
  return windows;
}

// Resolve the agy usage segment from the cache; hidden until the first refresh lands.
function getAgyUsage(data, callback) {
  const now = Date.now();
  const cache = readAgyUsageCache();
  maybeRefreshAgyUsage(cache, now);

  if (!Array.isArray(cache.groups) || typeof cache.fetchedAt !== 'number') return callback(null);
  const group = findAgyQuotaGroup(cache.groups, getAgyModelName(data));
  const windows = groupWindows(group);
  if (!windows.length) return callback(null);
  const age = now - cache.fetchedAt;
  callback(renderUsage({ windows, staleAgeMs: age > AGY_STALE_MS ? age : undefined }, now));
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
    const cw = data?.context_window;
    const remaining = cw && cw.context_window_size > 0 ? cw.remaining_percentage : undefined;

    const contextBar = getContextBar(remaining);
    const parts = [];
    parts.push(dirname);
    parts.push(model);
    parts.push(`context: ${contextBar}`);

    if (usageText) {
      parts.push(`usage: ${usageText}`);
    }

    process.stdout.write(parts.join(' \u2502 '));
  } catch (e) {
    process.stdout.write('Status unavailable');
  }
}

function outputFallback(usageText) {
  const contextBar = getContextBar(undefined);
  const parts = ['~', 'Claude', `context: ${contextBar}`];
  if (usageText) parts.push(`usage: ${usageText}`);
  process.stdout.write(parts.join(' \u2502 '));
}

// Wrapper that skips the Claude usage fetch for API key users (agy uses its own quota)
function getUsage(input, callback) {
  if (IS_API_KEY) {
    let data = null;
    try {
      data = input ? JSON.parse(input) : null;
    } catch (e) {}
    getAgyUsage(data, callback);
  } else {
    getUsageWithCache(callback);
  }
}

// Process with timeout
if (process.argv[2] === '--refresh-usage') {
  refreshAgyUsage();
} else if (process.stdin.isTTY) {
  getUsage('', (usageText) => {
    outputFallback(usageText);
    process.exit(0);
  });
} else {
  let input = '';
  let timeoutReached = false;

  const overallTimeout = IS_API_KEY ? 500 : (fs.existsSync(USAGE_CACHE_FILE) ? 1300 : 1600);

  const timeout = setTimeout(() => {
    timeoutReached = true;
    getUsage(input, (usageText) => {
      if (input.length > 0) {
        try {
          const data = JSON.parse(input);
          outputStatus(data, usageText);
        } catch (e) {
          outputFallback(usageText);
        }
      } else {
        outputFallback(usageText);
      }
      process.exit(0);
    });
  }, overallTimeout);

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    if (timeoutReached) return;
    clearTimeout(timeout);

    getUsage(input, (usageText) => {
      try {
        const data = JSON.parse(input);
        outputStatus(data, usageText);
      } catch (e) {
        outputFallback(usageText);
      }
      process.exit(0);
    });
  });
}
