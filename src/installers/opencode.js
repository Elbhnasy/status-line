// OpenCode loads TUI plugins listed under "plugin" in <config>/opencode/tui.json; the
// statusline plugin renders into the app_bottom slot.
const os = require('os');
const path = require('path');
const { exists, tildify } = require('../lib/fsutil');
const { run, onPath } = require('../lib/proc');
const { copyFile, addToJsonArray } = require('../lib/plan');

// The plugin API version statusline.tsx was written against.
const MIN_VERSION = '1.18.30';
const PLUGIN_REF = './plugins/statusline.tsx';

function paths() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const dir = path.join(base, 'opencode');
  return { dir, plugin: path.join(dir, 'plugins', 'statusline.tsx'), tui: path.join(dir, 'tui.json') };
}

function olderThan(version, min) {
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < b.length; i++) {
    if ((a[i] || 0) !== b[i]) return (a[i] || 0) < b[i];
  }
  return false;
}

module.exports = {
  name: 'opencode',
  label: 'OpenCode',
  mechanism: 'TUI plugin listed in ~/.config/opencode/tui.json -> plugins/statusline.tsx',
  restartHint: 'Restart OpenCode to pick it up.',

  check() {
    const { dir } = paths();
    const bin = process.env.STATUS_LINE_OPENCODE_BIN || 'opencode';
    const installed = onPath(bin);
    const problems = installed || exists(dir) ? [] : [`OpenCode not found (no \`${bin}\` on PATH and no ${tildify(dir)}).`];
    const warnings = [];
    if (installed) {
      const version = (run(bin, ['--version']).stdout.match(/\d+\.\d+\.\d+/) || [])[0];
      if (version && olderThan(version, MIN_VERSION)) {
        warnings.push(`OpenCode ${version} is older than ${MIN_VERSION}; the TUI plugin API may differ.`);
      }
    }
    return { problems, warnings };
  },

  actions(pkgRoot) {
    const p = paths();
    return [
      copyFile({ src: path.join(pkgRoot, 'statuslines/opencode/statusline.tsx'), dest: p.plugin }),
      addToJsonArray({ file: p.tui, key: 'plugin', value: PLUGIN_REF, seed: { $schema: 'https://opencode.ai/tui.json' } }),
    ];
  },
};
