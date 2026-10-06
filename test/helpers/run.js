const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const FREEZE = path.join(__dirname, 'freeze-time.js');
const NOW = 1790000000000;

// Write `files` ({relPath: string|object}) under `root`; objects are JSON-encoded.
function seed(root, files = {}) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
}

function tmpHome(files) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-home-'));
  seed(home, files);
  return home;
}

// Run a statusline script the way a CLI does: JSON on stdin, one line on stdout.
// The environment is rebuilt from scratch so the caller's CLAUDE_CODE_EFFORT_LEVEL,
// ANTHROPIC_API_KEY, etc. never leak into a case.
function runStatusline(script, { stdin = '', env = {}, files = {}, args = [], now = NOW } = {}) {
  const home = tmpHome(files);
  const started = Date.now();
  const r = spawnSync(process.execPath, ['--require', FREEZE, script, ...args], {
    input: stdin,
    encoding: 'utf8',
    timeout: 10000,
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, FREEZE_NOW: String(now), ...env },
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status, home, ms: Date.now() - started };
}

module.exports = { NOW, FREEZE, seed, tmpHome, runStatusline };
