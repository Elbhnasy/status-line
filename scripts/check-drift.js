#!/usr/bin/env node
// Dev-only: compare the packaged statuslines with the live ones on this machine, so an edit
// made in place (e.g. to ~/.claude/hooks/statusline.js) is noticed before it gets overwritten.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { sha256 } = require('../src/lib/fsutil');

const ROOT = path.join(__dirname, '..');
const HOME = os.homedir();
const pkg = (rel) => path.join(ROOT, rel);
let drift = 0;

function report(name, ok, detail) {
  console.log(`${ok ? 'ok   ' : 'DRIFT'} ${name}: ${detail}`);
  if (!ok) drift++;
}

function same(name, live, packaged, alternatives = []) {
  if (!fs.existsSync(live)) return report(name, true, `${live} not present; skipped`);
  const hash = sha256(live);
  if (hash === sha256(packaged)) return report(name, true, 'live file matches the package');
  for (const [label, file] of alternatives) {
    if (hash === sha256(file)) return report(name, true, `live file is the ${label}`);
  }
  report(name, false, `${live} differs from ${path.relative(ROOT, packaged)}`);
}

same('claude', path.join(HOME, '.claude/hooks/statusline.js'), pkg('statuslines/claude/statusline.js'));
same('opencode', path.join(HOME, '.config/opencode/plugins/statusline.tsx'), pkg('statuslines/opencode/statusline.tsx'));
same('agy', path.join(HOME, '.gemini/antigravity-cli/hooks/statusline.js'), pkg('statuslines/agy/statusline.js'),
  [['original (pre-usage) script', pkg('test/fixtures/original/agy-statusline.js')]]);

const checkout = process.env.HERMES_CHECKOUT || path.join(HOME, '.hermes/hermes-agent');
if (!fs.existsSync(path.join(checkout, '.git'))) {
  report('hermes', true, `${checkout} not present; skipped`);
} else {
  const base = fs.readFileSync(pkg('statuslines/hermes/BASE'), 'utf8').trim();
  const head = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  try {
    execFileSync('git', ['-C', checkout, 'apply', '--reverse', '--check', pkg('statuslines/hermes/statusbar-claude.patch')],
      { stdio: 'pipe' });
    report('hermes', true, `patch is applied${head === base ? '' : ` (HEAD ${head.slice(0, 11)}, patch base ${base.slice(0, 11)})`}`);
  } catch (e) {
    report('hermes', false, `live checkout does not carry exactly the packaged patch (HEAD ${head.slice(0, 11)})`);
  }
}

process.exit(drift ? 1 : 0);
