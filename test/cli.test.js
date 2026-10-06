const test = require('node:test');
const assert = require('node:assert');
const { tmpHome } = require('./helpers/run');
const { cli, treeHash } = require('./helpers/cli');
const { version } = require('../package.json');

test('no arguments: usage on stderr, exit 2', () => {
  const r = cli(tmpHome(), []);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /missing <cli> argument/);
  assert.match(r.stderr, /Supported CLIs: claude, agy, hermes, opencode/);
  assert.strictEqual(r.stdout, '');
});

test('help, -h and --help: usage on stdout, exit 0', () => {
  for (const args of [['help'], ['-h'], ['--help'], ['claude', '--help']]) {
    const r = cli(tmpHome(), args);
    assert.strictEqual(r.status, 0, args.join(' '));
    assert.match(r.stdout, /^Usage: status-line <cli>/);
  }
});

test('--version prints the package version', () => {
  const r = cli(tmpHome(), ['--version']);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), version);
});

test('unknown CLI: error, supported list and suggestion, exit 2, nothing written', () => {
  const home = tmpHome({ '.claude/settings.json': '{}' });
  const before = treeHash(home);
  const r = cli(home, ['cladue']);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /unknown CLI "cladue"\. Supported: claude, agy, hermes, opencode/);
  assert.match(r.stderr, /Did you mean "claude"\?/);
  assert.deepStrictEqual(treeHash(home), before);
});

test('unknown option and extra arguments exit 2', () => {
  assert.strictEqual(cli(tmpHome(), ['claude', '--force']).status, 2);
  assert.strictEqual(cli(tmpHome(), ['claude', 'agy']).status, 2);
});

test('CLI names are case-insensitive', () => {
  const r = cli(tmpHome({ '.claude/x': '' }), ['Claude', '--dry-run']);
  assert.strictEqual(r.status, 0, r.stderr);
});

test('list names every CLI and its mechanism', () => {
  const r = cli(tmpHome(), ['list']);
  assert.strictEqual(r.status, 0);
  for (const name of ['claude', 'agy', 'hermes', 'opencode']) assert.match(r.stdout, new RegExp(`^${name} `, 'm'));
});

test('--uninstall with nothing installed is a no-op', () => {
  const r = cli(tmpHome(), ['claude', '--uninstall']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /no record of installing/);
});
