#!/usr/bin/env node
// Antigravity CLI statusline (adapted from ~/.claude/hooks/statusline.js)
// Shows: directory | model | context usage | API usage (5-hour limit) | current task
// Auto-detects API key vs subscription usage
// https://github.com/TahaSabir0/claude-statusline
//
// Usage bar (status-line package): the 5-hour quota of the active model's group, from
// `agy -p "/usage" --output-format json`. That call takes ~5s, so the bar only reads a cache
// that a detached `statusline.js --refresh-usage` keeps fresh in the background.

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
const AGY_STALE_MS = 600000;  // Dim the bar and show its age once older than 10 min

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

function formatDuration(ms) {
  const totalMins = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  return hours > 0 ? `${hours}h${mins}m` : `${mins}m`;
}

// Same bar as the usage bar above. staleAgeMs marks a value we could not refresh.
function formatAgyUsageBar(pct, resetsAtMs, staleAgeMs) {
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

// Resolve the agy usage bar from the cache; hidden until the first refresh lands.
function getAgyUsage(data, callback) {
  const now = Date.now();
  const cache = readAgyUsageCache();
  maybeRefreshAgyUsage(cache, now);

  if (!Array.isArray(cache.groups) || typeof cache.fetchedAt !== 'number') return callback(null);
  const group = findAgyQuotaGroup(cache.groups, getAgyModelName(data));
  const bucket = group?.buckets?.find(b => b?.window === '5h');
  if (!bucket) return callback(null);

  const resetsAt = Date.parse(bucket.reset_time);
  if (Number.isFinite(resetsAt) && resetsAt <= now) return callback(null); // window reset since
  // remaining_fraction is omitted (proto3 omitempty) when nothing is left.
  const remaining = typeof bucket.remaining_fraction === 'number' ? bucket.remaining_fraction : 0;
  const age = now - cache.fetchedAt;
  callback(formatAgyUsageBar((1 - remaining) * 100, Number.isFinite(resetsAt) ? resetsAt : null,
    age > AGY_STALE_MS ? age : undefined));
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
    const cw = data?.context_window;
    const remaining = cw && cw.context_window_size > 0 ? cw.remaining_percentage : undefined;

    const contextBar = getContextBar(remaining);
    const parts = [];
    parts.push(dirname);
    parts.push(model);
    parts.push(`context: ${contextBar}`);

    if (usageBar) {
      parts.push(`usage: ${usageBar}`);
    }

    process.stdout.write(parts.join(' \u2502 '));
  } catch (e) {
    process.stdout.write('Status unavailable');
  }
}

function outputFallback(usageBar) {
  const contextBar = getContextBar(undefined);
  const parts = ['~', 'Claude', `context: ${contextBar}`];
  if (usageBar) parts.push(`usage: ${usageBar}`);
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
  getUsage('', (usageBar) => {
    outputFallback(usageBar);
    process.exit(0);
  });
} else {
  let input = '';
  let timeoutReached = false;

  const overallTimeout = IS_API_KEY ? 500 : (fs.existsSync(USAGE_CACHE_FILE) ? 1300 : 1600);

  const timeout = setTimeout(() => {
    timeoutReached = true;
    getUsage(input, (usageBar) => {
      if (input.length > 0) {
        try {
          const data = JSON.parse(input);
          outputStatus(data, usageBar);
        } catch (e) {
          outputFallback(usageBar);
        }
      } else {
        outputFallback(usageBar);
      }
      process.exit(0);
    });
  }, overallTimeout);

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    if (timeoutReached) return;
    clearTimeout(timeout);

    getUsage(input, (usageBar) => {
      try {
        const data = JSON.parse(input);
        outputStatus(data, usageBar);
      } catch (e) {
        outputFallback(usageBar);
      }
      process.exit(0);
    });
  });
}
