// Antigravity CLI runs `statusLine.command` from ~/.gemini/antigravity-cli/settings.json.
const os = require('os');
const path = require('path');
const { exists, nodeCommand, tildify } = require('../lib/fsutil');
const { onPath } = require('../lib/proc');
const { copyFile, setJsonKey } = require('../lib/plan');

function paths() {
  const dir = path.join(os.homedir(), '.gemini', 'antigravity-cli');
  return { dir, script: path.join(dir, 'hooks', 'statusline.js'), settings: path.join(dir, 'settings.json') };
}

module.exports = {
  name: 'agy',
  label: 'Antigravity CLI (agy)',
  mechanism: 'statusLine command in ~/.gemini/antigravity-cli/settings.json -> hooks/statusline.js',
  restartHint: 'Restart agy to pick it up. The usage bar appears after the first background quota refresh (a few seconds).',

  check() {
    const { dir } = paths();
    const problems = exists(dir) ? [] : [`${tildify(dir)} not found. Run agy once first.`];
    const warnings = onPath(process.env.STATUS_LINE_AGY_BIN || 'agy') ? []
      : ['`agy` is not on PATH, so the usage bar cannot refresh (set STATUS_LINE_AGY_BIN to its path).'];
    return { problems, warnings };
  },

  actions(pkgRoot) {
    const p = paths();
    return [
      copyFile({ src: path.join(pkgRoot, 'statuslines/agy/statusline.js'), dest: p.script, mode: 0o755 }),
      setJsonKey({
        file: p.settings, key: 'statusLine',
        value: { type: 'command', command: nodeCommand(p.script), enabled: true }, merge: true,
      }),
    ];
  },
};
