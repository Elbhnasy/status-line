#!/usr/bin/env node
// Stand-in for the `hermes` CLI: --version and config get/set/unset, backed by a JSON file.
const fs = require('fs');

const [cmd, sub, key, value] = process.argv.slice(2);
const store = process.env.FAKE_HERMES_CONFIG;
const load = () => (fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : {});

if (cmd === '--version') {
  console.log(`Hermes Agent v0.0.0 (fake)\nInstall directory: ${process.env.FAKE_HERMES_DIR}\nInstall method: git`);
} else if (cmd === 'config' && sub === 'get') {
  const config = load();
  if (!(key in config)) {
    console.log(`Config key not set: ${key}`);
    process.exit(1);
  }
  console.log(config[key]);
} else if (cmd === 'config' && sub === 'set') {
  fs.writeFileSync(store, JSON.stringify({ ...load(), [key]: value }));
} else if (cmd === 'config' && sub === 'unset') {
  const config = load();
  delete config[key];
  fs.writeFileSync(store, JSON.stringify(config));
} else {
  process.exit(2);
}
