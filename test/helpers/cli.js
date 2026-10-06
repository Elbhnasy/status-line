const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', '..', 'bin', 'status-line.js');

// Run the real bin with HOME pointed at a temp dir and external CLIs stubbed out.
function cli(home, args, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      STATUS_LINE_AGY_BIN: '/nonexistent/agy',
      STATUS_LINE_OPENCODE_BIN: '/nonexistent/opencode',
      STATUS_LINE_HERMES_BIN: '/nonexistent/hermes',
      ...env,
    },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// relpath -> sha256 for every file under dir, to prove a run changed nothing.
function treeHash(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

module.exports = { BIN, cli, treeHash };
