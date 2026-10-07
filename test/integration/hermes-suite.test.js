// Opt-in (STATUS_LINE_INTEGRATION=1): export the full hermes-agent tree at BASE, install the
// patch through the real CLI, and run Hermes's own status bar test suites against it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { tmpHome } = require('../helpers/run');
const { cli } = require('../helpers/cli');

const ROOT = path.join(__dirname, '..', '..');
const CHECKOUT = process.env.HERMES_CHECKOUT || path.join(os.homedir(), '.hermes', 'hermes-agent');
const BASE = fs.readFileSync(path.join(ROOT, 'statuslines/hermes/BASE'), 'utf8').trim();
const FAKE = path.join(__dirname, '..', 'helpers', 'fake-hermes.js');

// Hermes test interpreters differ per install, so resolve one that can actually import pytest:
// an explicit override, a classic .venv, a PEP-582 .hermes env, the pm-managed test environment
// under ~/.hermes/installs/*/test-environment/*/venv, or the checkout's own run-in-hermes-env
// runner (which syncs on first use). Nothing is guessed — every candidate is asked to import
// pytest before it is used, and the suite refuses to pass by silently skipping.
function interpreterCandidates() {
  const list = [];
  if (process.env.STATUS_LINE_HERMES_PYTHON) list.push([process.env.STATUS_LINE_HERMES_PYTHON, []]);
  for (const rel of ['.venv/bin/python', '.hermes/bin/python']) {
    const p = path.join(CHECKOUT, rel);
    if (fs.existsSync(p)) list.push([p, []]);
  }
  const installs = path.join(os.homedir(), '.hermes', 'installs');
  if (fs.existsSync(installs)) {
    for (const install of fs.readdirSync(installs)) {
      const envs = path.join(installs, install, 'test-environment');
      if (!fs.existsSync(envs)) continue;
      for (const gen of fs.readdirSync(envs)) {
        const p = path.join(envs, gen, 'venv', 'bin', 'python');
        if (fs.existsSync(p)) list.push([p, []]);
      }
    }
  }
  const runner = path.join(CHECKOUT, 'scripts', 'run-in-hermes-env');
  if (fs.existsSync(runner)) list.push([runner, ['python']]);
  return list;
}

function hasPytest([cmd, prefix]) {
  try {
    return spawnSync(cmd, [...prefix, '-c', 'import pytest'], { encoding: 'utf8', timeout: 120000 }).status === 0;
  } catch (e) {
    return false;
  }
}

// Resolved once, and only when this opt-in suite was actually requested: probing candidates can
// itself sync an environment (the run-in-hermes-env fallback installs on first use), and running
// `npm test` must never touch the real Hermes install.
let pytestCommand;
function pytestRunner() {
  if (pytestCommand === undefined) {
    pytestCommand = process.env.STATUS_LINE_INTEGRATION === '1'
      ? interpreterCandidates().find(hasPytest) || null
      : null;
  }
  return pytestCommand;
}

const PYTEST = pytestRunner();
const run = (args, options) => {
  const cmd = PYTEST;
  return execFileSync(cmd[0], [...cmd[1], ...args], options);
};

const skip = process.env.STATUS_LINE_INTEGRATION !== '1' ? 'set STATUS_LINE_INTEGRATION=1'
  : !PYTEST ? 'no Hermes interpreter with pytest: set STATUS_LINE_HERMES_PYTHON' : false;

test('hermes: an interpreter with pytest was found when the suite was requested', {
  skip: process.env.STATUS_LINE_INTEGRATION !== '1',
}, () => {
  assert.ok(PYTEST, 'no interpreter with pytest found — set STATUS_LINE_HERMES_PYTHON');
});

test('hermes: patched BASE passes Hermes status bar test suites', { skip, timeout: 600000 }, () => {
  const home = tmpHome();
  const repo = path.join(home, 'hermes-agent');
  fs.mkdirSync(repo);
  const tarball = path.join(home, 'base.tar');
  execFileSync('git', ['-C', CHECKOUT, 'archive', '--format=tar', '-o', tarball, BASE]);
  execFileSync('tar', ['-xf', tarball, '-C', repo]);
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');

  fs.chmodSync(FAKE, 0o755);
  const r = cli(home, ['hermes'], {
    STATUS_LINE_HERMES_BIN: FAKE, FAKE_HERMES_DIR: repo, FAKE_HERMES_CONFIG: path.join(home, 'c.json'),
  });
  assert.strictEqual(r.status, 0, r.stderr);

  // `python -m` puts cwd first on sys.path, ahead of the venv's editable install of CHECKOUT.
  const where = run(['-c', 'import hermes_cli; print(hermes_cli.__file__)'], { cwd: repo, encoding: 'utf8' });
  assert.ok(where.startsWith(repo), `imported Hermes from ${where}`);

  // The suites must never touch the real Hermes home, and this harness may itself be running inside
  // a Hermes session: drop every inherited HERMES_* variable and point HERMES_HOME at the temp home
  // (tests/hermes_cli/test_cli_status_bar.py asserts exactly this isolation).
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('HERMES_')) delete childEnv[key];
  }
  Object.assign(childEnv, { HOME: home, HERMES_HOME: path.join(home, '.hermes') });

  const out = run(['-m', 'pytest', '-q', '-p', 'no:cacheprovider',
    'tests/hermes_cli/test_status_bar_claude.py', 'tests/hermes_cli/test_cli_status_bar.py',
    'tests/agent/test_account_usage_pool_fetch.py'],
  { cwd: repo, encoding: 'utf8', env: childEnv });
  assert.match(out, /\d+ passed/);
  fs.rmSync(home, { recursive: true, force: true });
});
