// Opt-in (STATUS_LINE_INTEGRATION=1): export the full hermes-agent tree at BASE, install the
// patch through the real CLI, and run Hermes's own status bar test suites against it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { tmpHome } = require('../helpers/run');
const { cli } = require('../helpers/cli');

const ROOT = path.join(__dirname, '..', '..');
const CHECKOUT = process.env.HERMES_CHECKOUT || path.join(os.homedir(), '.hermes', 'hermes-agent');
const PYTHON = path.join(CHECKOUT, '.venv', 'bin', 'python');
const BASE = fs.readFileSync(path.join(ROOT, 'statuslines/hermes/BASE'), 'utf8').trim();
const FAKE = path.join(__dirname, '..', 'helpers', 'fake-hermes.js');

const skip = process.env.STATUS_LINE_INTEGRATION !== '1' ? 'set STATUS_LINE_INTEGRATION=1'
  : !fs.existsSync(PYTHON) ? `no Hermes venv at ${PYTHON}` : false;

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
  const where = execFileSync(PYTHON, ['-c', 'import hermes_cli; print(hermes_cli.__file__)'], { cwd: repo, encoding: 'utf8' });
  assert.ok(where.startsWith(repo), `imported Hermes from ${where}`);
  const out = execFileSync(PYTHON, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider',
    'tests/hermes_cli/test_status_bar_claude.py', 'tests/hermes_cli/test_cli_status_bar.py'],
  { cwd: repo, encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.match(out, /\d+ passed/);
  fs.rmSync(home, { recursive: true, force: true });
});
