// Hermes installer: the status-bar patch itself needs a hermes-agent git checkout, but the config
// edits are exercised here against the fake `hermes` binary (no checkout, no Hermes venv).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpHome } = require('./helpers/run');
const { hermesConfigUnset } = require('../src/lib/plan');

const FAKE = path.join(__dirname, 'helpers', 'fake-hermes.js');
const ROOT = path.join(__dirname, '..');
const KEY = 'display.status_bar.usage_budget';

// Point the installer's `hermes` at the fake, backed by `home`'s config store, for one test.
function withFakeHermes(home, run) {
  const dir = path.join(home, 'hermes-agent');
  fs.mkdirSync(dir, { recursive: true });
  const store = path.join(home, 'hermes-config.json');
  const saved = { ...process.env };
  Object.assign(process.env, {
    STATUS_LINE_HERMES_BIN: FAKE, STATUS_LINE_HERMES_DIR: dir,
    FAKE_HERMES_DIR: dir, FAKE_HERMES_CONFIG: store,
  });
  try {
    return run(store);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test('hermes: the installer retires display.status_bar.usage_budget instead of setting it', () => {
  const home = tmpHome();
  withFakeHermes(home, (store) => {
    fs.writeFileSync(store, JSON.stringify({ [KEY]: 1000000 }));
    const actions = require('../src/installers/hermes').actions(ROOT);
    const described = actions.map((a) => a.describe());

    assert.ok(!/usage_budget 1000000/.test(described.join('\n')), described.join('\n'));
    assert.ok(described.includes(`hermes config unset ${KEY}`), described.join('\n'));
    assert.ok(described.includes('hermes config set display.status_bar.style claude'), described.join('\n'));

    const unset = actions.find((a) => a.describe() === `hermes config unset ${KEY}`);
    assert.strictEqual(unset.isSatisfied(), false, 'a config that still carries the key is not satisfied');
    unset.apply();
    assert.strictEqual(unset.isSatisfied(), true);
    assert.ok(!(KEY in JSON.parse(fs.readFileSync(store, 'utf8'))), 'key survived the unset');
  });
});

test('hermes: an already-retired budget key is a no-op', () => {
  const home = tmpHome();
  withFakeHermes(home, (store) => {
    fs.writeFileSync(store, JSON.stringify({ 'display.status_bar.style': 'claude' }));
    const action = hermesConfigUnset({ bin: FAKE, key: KEY });
    assert.strictEqual(action.isSatisfied(), true);
  });
});
