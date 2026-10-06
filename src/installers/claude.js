// Claude Code runs `statusLine.command` from ~/.claude/settings.json and pipes session JSON to it.
const os = require('os');
const path = require('path');
const { exists, tildify } = require('../lib/fsutil');
const { copyFile, setJsonKey } = require('../lib/plan');

function paths() {
  const dir = path.join(os.homedir(), '.claude');
  return { dir, script: path.join(dir, 'hooks', 'statusline.js'), settings: path.join(dir, 'settings.json') };
}

module.exports = {
  name: 'claude',
  label: 'Claude Code',
  mechanism: 'statusLine command in ~/.claude/settings.json -> ~/.claude/hooks/statusline.js',
  restartHint: 'Restart Claude Code (or start a new session) to pick it up.',

  check() {
    const { dir } = paths();
    return exists(dir) ? { problems: [], warnings: [] }
      : { problems: [`${tildify(dir)} not found. Run Claude Code once first.`], warnings: [] };
  },

  actions(pkgRoot) {
    const p = paths();
    return [
      copyFile({ src: path.join(pkgRoot, 'statuslines/claude/statusline.js'), dest: p.script, mode: 0o755 }),
      setJsonKey({ file: p.settings, key: 'statusLine', value: { type: 'command', command: `node ${p.script}` }, merge: true }),
    ];
  },
};
