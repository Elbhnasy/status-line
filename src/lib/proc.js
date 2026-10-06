const { spawnSync } = require('child_process');

// Run a command synchronously; never throws for a missing binary (status is null then).
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60000, ...opts });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

function onPath(cmd) {
  return run(process.platform === 'win32' ? 'where' : 'which', [cmd]).status === 0;
}

module.exports = { run, onPath };
