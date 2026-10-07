// Hermes has no external statusline hook: the Claude-style bar is a source patch to the
// hermes-agent git checkout, switched on by display.status_bar.style in config.yaml.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exists, tildify } = require('../lib/fsutil');
const { run } = require('../lib/proc');
const { gitApply, hermesConfigSet, hermesConfigUnset } = require('../lib/plan');

const PATCH_NAME = 'hermes-statusbar-claude.patch';

function bin() {
  return process.env.STATUS_LINE_HERMES_BIN || 'hermes';
}

// `hermes --version` prints "Install directory: <dir>" and "Install method: git".
function locate() {
  const r = run(bin(), ['--version']);
  if (r.status !== 0) return { error: `\`${bin()}\` not found or failed to run.` };
  const dir = process.env.STATUS_LINE_HERMES_DIR
    || (r.stdout.match(/^Install directory:\s*(.+)$/m) || [])[1]?.trim()
    || path.join(os.homedir(), '.hermes', 'hermes-agent');
  const method = (r.stdout.match(/^Install method:\s*(\S+)/m) || [])[1];
  return { dir, method };
}

module.exports = {
  name: 'hermes',
  label: 'Hermes Agent',
  mechanism: 'source patch to the hermes-agent git checkout + display.status_bar.style: claude',
  restartHint: 'Restart Hermes to pick it up. `hermes update` autostashes and re-applies the patch; if that fails, re-run this command.',

  check() {
    const loc = locate();
    if (loc.error) return { problems: [loc.error], warnings: [] };
    const problems = [];
    if (loc.method && loc.method !== 'git' && !process.env.STATUS_LINE_HERMES_DIR) {
      problems.push(`Hermes install method is "${loc.method}"; the status bar patch needs a git install.`);
    } else if (!exists(path.join(loc.dir, '.git'))) {
      problems.push(`${tildify(loc.dir)} is not a git checkout; the status bar patch needs a git install.`);
    }
    return { problems, warnings: [] };
  },

  actions(pkgRoot) {
    const { dir } = locate();
    const base = fs.readFileSync(path.join(pkgRoot, 'statuslines/hermes/BASE'), 'utf8').trim();
    return [
      gitApply({ repo: dir, patch: path.join(pkgRoot, 'statuslines/hermes/statusbar-claude.patch'), label: PATCH_NAME, base }),
      hermesConfigSet({ bin: bin(), key: 'display.status_bar.style', value: 'claude' }),
      // The claude-style usage segment reports the provider's real windows, so the retired token
      // budget must not linger in a config that a previous version wrote.
      hermesConfigUnset({ bin: bin(), key: 'display.status_bar.usage_budget' }),
    ];
  },
};
