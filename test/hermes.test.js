// Hermes installer against a small git repo holding the BASE versions of the patched files.
// Needs a local hermes-agent checkout that has the BASE commit (HERMES_CHECKOUT, default
// ~/.hermes/hermes-agent); skipped otherwise.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { tmpHome } = require('./helpers/run');
const { cli } = require('./helpers/cli');

const ROOT = path.join(__dirname, '..');
const CHECKOUT = process.env.HERMES_CHECKOUT || path.join(os.homedir(), '.hermes', 'hermes-agent');
const BASE = fs.readFileSync(path.join(ROOT, 'statuslines/hermes/BASE'), 'utf8').trim();
const PATCH = path.join(ROOT, 'statuslines/hermes/statusbar-claude.patch');
const FAKE = path.join(__dirname, 'helpers/fake-hermes.js');
const MODIFIED = [
  'hermes_cli/cli_status_bar_mixin.py',
  'hermes_cli/config_defaults.py',
  'locales/en.yaml',
  'tests/hermes_cli/test_cli_status_bar.py',
];

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });

function hasBase() {
  try {
    git(CHECKOUT, 'cat-file', '-e', `${BASE}^{commit}`);
    return true;
  } catch (e) {
    return false;
  }
}

function setup() {
  const home = tmpHome();
  const repo = path.join(home, 'hermes-agent');
  for (const file of MODIFIED) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), git(CHECKOUT, 'show', `${BASE}:${file}`));
  }
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  fs.chmodSync(FAKE, 0o755);
  const config = path.join(home, 'hermes-config.json');
  const env = { STATUS_LINE_HERMES_BIN: FAKE, FAKE_HERMES_DIR: repo, FAKE_HERMES_CONFIG: config };
  return { home, repo, env, config: () => (fs.existsSync(config) ? JSON.parse(fs.readFileSync(config, 'utf8')) : {}) };
}

const skip = hasBase() ? false : `no hermes-agent checkout with ${BASE.slice(0, 11)} at ${CHECKOUT}`;

test('hermes: applies the patch, sets config, is idempotent, and uninstalls cleanly', { skip }, () => {
  const { home, repo, env, config } = setup();

  const r = cli(home, ['hermes'], env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(repo, 'hermes_cli/status_bar_claude.py')));
  assert.match(fs.readFileSync(path.join(repo, 'hermes_cli/config_defaults.py'), 'utf8'), /"style": "default"/);
  assert.deepStrictEqual(config(), { 'display.status_bar.style': 'claude' });
  // The patch touches only the working tree, like the original uncommitted change.
  assert.strictEqual(git(repo, 'diff', '--cached', '--name-only'), '');
  assert.ok(fs.existsSync(path.join(home, '.status-line/hermes-statusbar-claude.patch')));

  assert.match(cli(home, ['hermes'], env).stdout, /Already installed/);

  const u = cli(home, ['hermes', '--uninstall'], env);
  assert.strictEqual(u.status, 0, u.stderr);
  assert.strictEqual(git(repo, 'status', '--porcelain'), '');
  assert.deepStrictEqual(config(), {});
});

test('hermes: a checkout the patch cannot apply to is refused and left untouched', { skip }, () => {
  const { home, repo, env, config } = setup();
  fs.writeFileSync(path.join(repo, 'hermes_cli/cli_status_bar_mixin.py'), '# rewritten upstream\n');
  git(repo, 'commit', '-q', '-am', 'drift');

  const r = cli(home, ['hermes'], env);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, new RegExp(`does not apply .*cut against ${BASE.slice(0, 11)}`));
  assert.strictEqual(git(repo, 'status', '--porcelain'), '');
  assert.deepStrictEqual(config(), {});
});

test('hermes: upstream drift near a hunk is merged with --3way and still uninstalls', { skip }, () => {
  const { home, repo, env } = setup();
  const file = path.join(repo, 'hermes_cli/config_defaults.py');
  const text = fs.readFileSync(file, 'utf8');
  const drifted = text.replace('# context_detail/prompt_elapsed/idle_since.', '# context_detail/prompt_elapsed/idle_since (upstream).');
  assert.notStrictEqual(drifted, text, 'context line moved; update this test');
  fs.writeFileSync(file, drifted);
  git(repo, 'commit', '-q', '-am', 'drift');

  const r = cli(home, ['hermes'], env);
  assert.strictEqual(r.status, 0, r.stderr);
  const patched = fs.readFileSync(file, 'utf8');
  assert.match(patched, /idle_since \(upstream\)\./);
  assert.match(patched, /"style": "default"/);

  const u = cli(home, ['hermes', '--uninstall'], env);
  assert.strictEqual(u.status, 0, u.stderr);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), drifted);
  assert.ok(!fs.existsSync(path.join(repo, 'hermes_cli/status_bar_claude.py')));
});

test('hermes: missing git checkout is a prerequisite error', () => {
  const home = tmpHome({ 'not-git/.keep': '' });
  fs.chmodSync(FAKE, 0o755);
  const r = cli(home, ['hermes'], {
    STATUS_LINE_HERMES_BIN: FAKE, FAKE_HERMES_DIR: path.join(home, 'not-git'), FAKE_HERMES_CONFIG: path.join(home, 'c.json'),
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /is not a git checkout/);
});

test('hermes: no hermes binary is a prerequisite error', () => {
  const r = cli(tmpHome(), ['hermes']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /`\/nonexistent\/hermes` not found/);
});

test('hermes: the packaged patch matches the live checkout', { skip }, () => {
  // Reverse-applies cleanly only while the live checkout carries exactly this change.
  // Read-only: --check never writes.
  if (git(CHECKOUT, 'rev-parse', 'HEAD').trim() !== BASE) return;
  execFileSync('git', ['-C', CHECKOUT, 'apply', '--reverse', '--check', PATCH]);
});
