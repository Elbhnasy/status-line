const path = require('path');
const registry = require('./registry');
const manifest = require('./lib/manifest');
const { UNDO } = require('./lib/plan');

const PKG_ROOT = path.join(__dirname, '..');
const { version: VERSION } = require('../package.json');
const NAMES = Object.keys(registry);

const USAGE = `Usage: status-line <cli> [--dry-run]     install the existing statusline for <cli>
       status-line <cli> --uninstall     revert what status-line installed for <cli>
       status-line all [--dry-run]       install for every supported CLI found on this device
       status-line all --uninstall       revert everything status-line installed
       status-line list                  supported CLIs and how each is wired up
       status-line help | --help         this message
       status-line --version

Supported CLIs: ${NAMES.join(', ')}

Examples:
  npx @ktarek/status-line all
  npx @ktarek/status-line claude
  npx @ktarek/status-line agy --dry-run
`;

function suggest(input) {
  const lower = input.toLowerCase();
  return NAMES.find(n => n.startsWith(lower.slice(0, 2)) || lower.startsWith(n)) || null;
}

function parse(argv) {
  const opts = { dryRun: false, uninstall: false, help: false, version: false, positional: [], unknown: [] };
  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '-n') opts.dryRun = true;
    else if (arg === '--uninstall') opts.uninstall = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--version' || arg === '-v') opts.version = true;
    else if (arg.startsWith('-')) opts.unknown.push(arg);
    else opts.positional.push(arg);
  }
  return opts;
}

function install(inst, { dryRun }, io) {
  const { problems, warnings } = inst.check();
  if (problems.length) {
    for (const p of problems) io.err(`error: ${p}`);
    io.err('Nothing was changed.');
    return 1;
  }
  for (const w of warnings) io.out(`warning: ${w}`);

  const actions = inst.actions(PKG_ROOT);
  io.out(`${inst.label}: ${inst.mechanism}`);

  if (dryRun) {
    for (const a of actions) io.out(`  ${a.isSatisfied() ? 'already done:' : 'would do:    '} ${a.describe()}`);
    io.out('Dry run: nothing was changed.');
    return 0;
  }

  const records = [];
  let failure = null;
  for (const a of actions) {
    if (a.isSatisfied()) {
      io.out(`  already done: ${a.describe()}`);
      continue;
    }
    try {
      const rec = a.apply();
      records.push(rec);
      io.out(`  done:        ${a.describe()}${rec.backup ? ` (backup: ${path.basename(rec.backup)})` : ''}`);
    } catch (e) {
      failure = e;
      break;
    }
  }
  // Record even a partial install so --uninstall can revert it.
  manifest.addSteps(inst.name, records, VERSION);

  if (failure) {
    io.err(`error: ${failure.message}`);
    if (records.length) io.err(`Some steps were applied; run \`status-line ${inst.name} --uninstall\` to revert them.`);
    return 1;
  }
  io.out(records.length ? inst.restartHint : 'Already installed; nothing changed.');
  return 0;
}

function uninstall(inst, { dryRun }, io) {
  const entry = manifest.get(inst.name);
  if (!entry || entry.steps.length === 0) {
    io.out(`status-line has no record of installing the ${inst.name} statusline; nothing to undo.`);
    return 0;
  }
  const steps = [...entry.steps].reverse();
  if (dryRun) {
    for (const s of steps) io.out(`  would undo: ${s.id}`);
    io.out('Dry run: nothing was changed.');
    return 0;
  }
  for (let i = 0; i < steps.length; i++) {
    try {
      io.out(`  ${UNDO[steps[i].kind](steps[i])}`);
    } catch (e) {
      // Keep the steps that were not undone so a re-run can finish the job.
      manifest.remove(inst.name);
      manifest.addSteps(inst.name, steps.slice(i).reverse(), entry.version);
      io.err(`error: ${e.message}`);
      return 1;
    }
  }
  manifest.remove(inst.name);
  io.out(`Uninstalled the ${inst.name} statusline. ${inst.restartHint.split('.')[0]}.`);
  return 0;
}

// Every CLI whose prerequisites are met on this device; the rest are skipped, not errors.
function all(opts, io) {
  let found = 0;
  let failed = 0;
  for (const inst of Object.values(registry)) {
    let code;
    if (opts.uninstall) {
      if (!manifest.get(inst.name)) continue;
      io.out(`${inst.label}:`);
      code = uninstall(inst, opts, io);
    } else {
      const { problems } = inst.check();
      if (problems.length) {
        io.out(`${inst.label}: skipped (${problems[0]})\n`);
        continue;
      }
      code = install(inst, opts, io);
    }
    found++;
    if (code !== 0) failed++;
    io.out('');
  }
  if (found === 0) {
    io.out(opts.uninstall ? 'status-line has nothing installed on this device.'
      : `None of the supported CLIs (${NAMES.join(', ')}) were found on this device.`);
    return opts.uninstall ? 0 : 1;
  }
  if (failed) io.err(`${failed} of ${found} failed; see the errors above.`);
  return failed ? 1 : 0;
}

function main(argv, io) {
  const opts = parse(argv);
  if (opts.version) {
    io.out(VERSION);
    return 0;
  }
  if (opts.help || opts.positional[0] === 'help') {
    io.out(USAGE);
    return 0;
  }
  if (opts.unknown.length) {
    io.err(`error: unknown option ${opts.unknown[0]}\n\n${USAGE}`);
    return 2;
  }
  const [cmd, ...extra] = opts.positional;
  if (!cmd) {
    io.err(`error: missing <cli> argument\n\n${USAGE}`);
    return 2;
  }
  if (cmd === 'list') {
    for (const inst of Object.values(registry)) io.out(`${inst.name.padEnd(9)} ${inst.label}: ${inst.mechanism}`);
    return 0;
  }
  if (cmd.toLowerCase() === 'all') {
    if (extra.length) {
      io.err(`error: unexpected argument "${extra[0]}"\n\n${USAGE}`);
      return 2;
    }
    return all(opts, io);
  }
  const inst = registry[cmd.toLowerCase()];
  if (!inst) {
    const hint = suggest(cmd);
    io.err(`error: unknown CLI "${cmd}". Supported: ${NAMES.join(', ')}${hint ? `\nDid you mean "${hint}"?` : ''}`);
    return 2;
  }
  if (extra.length) {
    io.err(`error: unexpected argument "${extra[0]}"\n\n${USAGE}`);
    return 2;
  }
  return opts.uninstall ? uninstall(inst, opts, io) : install(inst, opts, io);
}

module.exports = { main, USAGE };
