#!/usr/bin/env node
const { main } = require('../src/cli');

process.exitCode = main(process.argv.slice(2), {
  out: (line) => process.stdout.write(line.endsWith('\n') ? line : line + '\n'),
  err: (line) => process.stderr.write(line.endsWith('\n') ? line : line + '\n'),
});
