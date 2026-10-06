// Claude, agy and opencode installers against a temp HOME seeded like the real configs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpHome } = require('./helpers/run');
const { cli, treeHash } = require('./helpers/cli');
const { sha256 } = require('../src/lib/fsutil');

const ROOT = path.join(__dirname, '..');
const read = (home, rel) => fs.readFileSync(path.join(home, rel), 'utf8');
const json = (home, rel) => JSON.parse(read(home, rel));

// Shape of the real ~/.claude/settings.json, secrets and org details stripped.
const CLAUDE_SETTINGS = `{
  "model": "opus",
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/stop-hook",
            "timeout": 5
          }
        ]
      }
    ]
  },
  "statusLine": {
    "type": "command",
    "command": "node /path/to/old-statusline.js"
  },
  "theme": "dark"
}
`;

test('claude: install, idempotent re-run, uninstall restores originals byte-for-byte', () => {
  const home = tmpHome({ '.claude/settings.json': CLAUDE_SETTINGS, '.claude/hooks/statusline.js': '// old\n' });
  const before = treeHash(home);

  const r = cli(home, ['claude']);
  assert.strictEqual(r.status, 0, r.stderr);
  const script = path.join(home, '.claude/hooks/statusline.js');
  assert.strictEqual(sha256(script), sha256(path.join(ROOT, 'statuslines/claude/statusline.js')));
  assert.strictEqual(fs.statSync(script).mode & 0o777, 0o755);
  const settings = json(home, '.claude/settings.json');
  assert.deepStrictEqual(settings.statusLine, { type: 'command', command: `node ${script}` });
  assert.deepStrictEqual(Object.keys(settings), ['model', 'hooks', 'statusLine', 'theme']);
  assert.deepStrictEqual(settings.hooks, JSON.parse(CLAUDE_SETTINGS).hooks);
  assert.ok(fs.readdirSync(path.join(home, '.claude')).some(f => f.startsWith('settings.json.status-line-backup-')));
  assert.match(r.stdout, /Restart Claude Code/);

  const again = cli(home, ['claude']);
  assert.strictEqual(again.status, 0);
  assert.match(again.stdout, /Already installed; nothing changed\./);

  const u = cli(home, ['claude', '--uninstall']);
  assert.strictEqual(u.status, 0, u.stderr);
  assert.strictEqual(read(home, '.claude/settings.json'), CLAUDE_SETTINGS);
  assert.strictEqual(read(home, '.claude/hooks/statusline.js'), '// old\n');
  const after = treeHash(home);
  for (const [file, hash] of Object.entries(before)) assert.strictEqual(after[file], hash, file);
  assert.deepStrictEqual(json(home, '.status-line/manifest.json').clis, {});
});

test('claude: fresh setup creates files and uninstall removes them', () => {
  const home = tmpHome({ '.claude/.keep': '' });
  assert.strictEqual(cli(home, ['claude']).status, 0);
  assert.ok(fs.existsSync(path.join(home, '.claude/hooks/statusline.js')));
  assert.strictEqual(cli(home, ['claude', '--uninstall']).status, 0);
  assert.ok(!fs.existsSync(path.join(home, '.claude/hooks/statusline.js')));
  assert.ok(!fs.existsSync(path.join(home, '.claude/settings.json')));
});

test('claude: --dry-run lists the plan and changes nothing', () => {
  const home = tmpHome({ '.claude/settings.json': CLAUDE_SETTINGS });
  const before = treeHash(home);
  const r = cli(home, ['claude', '--dry-run']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /would do: +copy statusline\.js/);
  assert.match(r.stdout, /Dry run: nothing was changed\./);
  assert.deepStrictEqual(treeHash(home), before);
});

test('claude: missing ~/.claude is a prerequisite error', () => {
  const home = tmpHome();
  const r = cli(home, ['claude']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /~\/\.claude not found/);
  assert.deepStrictEqual(treeHash(home), {});
});

test('claude: invalid settings.json aborts without touching it', () => {
  const home = tmpHome({ '.claude/settings.json': '{ broken' });
  const r = cli(home, ['claude']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /settings\.json is not valid JSON/);
  assert.strictEqual(read(home, '.claude/settings.json'), '{ broken');
});

test('agy: keeps model, trustedWorkspaces and stack_with_default', () => {
  const original = {
    model: 'Gemini 3.8 Flash (High)',
    statusLine: { type: 'command', command: 'node /old.js', enabled: false, stack_with_default: true },
    trustedWorkspaces: ['/path/to/proj'],
  };
  const text = JSON.stringify(original, null, 2) + '\n';
  const home = tmpHome({ '.gemini/antigravity-cli/settings.json': text });
  const r = cli(home, ['agy']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /warning: `agy` is not on PATH/);
  const script = path.join(home, '.gemini/antigravity-cli/hooks/statusline.js');
  assert.strictEqual(sha256(script), sha256(path.join(ROOT, 'statuslines/agy/statusline.js')));
  const settings = json(home, '.gemini/antigravity-cli/settings.json');
  assert.deepStrictEqual(settings, {
    ...original,
    statusLine: { type: 'command', command: `node ${script}`, enabled: true, stack_with_default: true },
  });

  assert.strictEqual(cli(home, ['agy', '--uninstall']).status, 0);
  assert.strictEqual(read(home, '.gemini/antigravity-cli/settings.json'), text);
  assert.ok(!fs.existsSync(script));
});

test('config file permissions survive install, backup and uninstall', () => {
  const rel = '.gemini/antigravity-cli/settings.json';
  const home = tmpHome({ [rel]: '{\n  "model": "m"\n}\n' });
  const file = path.join(home, rel);
  fs.chmodSync(file, 0o600);
  const mode = () => fs.statSync(file).mode & 0o777;

  assert.strictEqual(cli(home, ['agy']).status, 0);
  assert.strictEqual(mode(), 0o600);
  const backups = fs.readdirSync(path.dirname(file)).filter(f => f.startsWith('settings.json.status-line-backup-'));
  assert.strictEqual(backups.length, 1);
  assert.strictEqual(fs.statSync(path.join(path.dirname(file), backups[0])).mode & 0o777, 0o600);

  assert.strictEqual(cli(home, ['agy', '--uninstall']).status, 0);
  assert.strictEqual(mode(), 0o600);
});

test('opencode: appends to an existing plugin list and keeps $schema', () => {
  const text = '{\n  "$schema": "https://opencode.ai/tui.json",\n  "plugin": ["./plugins/other.tsx"]\n}\n';
  const home = tmpHome({ '.config/opencode/tui.json': text });
  const r = cli(home, ['opencode']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(json(home, '.config/opencode/tui.json'), {
    $schema: 'https://opencode.ai/tui.json', plugin: ['./plugins/other.tsx', './plugins/statusline.tsx'],
  });
  assert.strictEqual(sha256(path.join(home, '.config/opencode/plugins/statusline.tsx')),
    sha256(path.join(ROOT, 'statuslines/opencode/statusline.tsx')));

  assert.match(cli(home, ['opencode']).stdout, /Already installed/);
  assert.strictEqual(cli(home, ['opencode', '--uninstall']).status, 0);
  assert.deepStrictEqual(json(home, '.config/opencode/tui.json'),
    { $schema: 'https://opencode.ai/tui.json', plugin: ['./plugins/other.tsx'] });
});

test('opencode: creates tui.json when missing, honours XDG_CONFIG_HOME, uninstall removes it', () => {
  const home = tmpHome({ 'xdg/opencode/.keep': '' });
  const env = { XDG_CONFIG_HOME: path.join(home, 'xdg') };
  assert.strictEqual(cli(home, ['opencode'], env).status, 0);
  assert.deepStrictEqual(json(home, 'xdg/opencode/tui.json'),
    { $schema: 'https://opencode.ai/tui.json', plugin: ['./plugins/statusline.tsx'] });
  assert.strictEqual(cli(home, ['opencode', '--uninstall'], env).status, 0);
  assert.ok(!fs.existsSync(path.join(home, 'xdg/opencode/tui.json')));
  assert.ok(!fs.existsSync(path.join(home, 'xdg/opencode/plugins/statusline.tsx')));
});

test('opencode: not installed at all is a prerequisite error', () => {
  const r = cli(tmpHome(), ['opencode']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /OpenCode not found/);
});
