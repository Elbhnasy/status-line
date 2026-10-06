// ~/.status-line/manifest.json: what each install changed, so --uninstall can undo it.
const os = require('os');
const path = require('path');
const { readJsonFile, writeJsonFile } = require('./fsutil');

function manifestPath() {
  return path.join(os.homedir(), '.status-line', 'manifest.json');
}

function load() {
  const m = readJsonFile(manifestPath()).data || {};
  if (!m.clis || typeof m.clis !== 'object') m.clis = {};
  return m;
}

function save(m) {
  writeJsonFile(manifestPath(), m);
}

function get(cli) {
  return load().clis[cli] || null;
}

// Keep the FIRST record per target: it holds the state from before status-line touched it.
function addSteps(cli, steps, version) {
  if (steps.length === 0) return;
  const m = load();
  const entry = m.clis[cli] || { steps: [] };
  for (const step of steps) {
    if (!entry.steps.some(s => s.id === step.id)) entry.steps.push(step);
  }
  entry.version = version;
  entry.updatedAt = new Date().toISOString();
  m.clis[cli] = entry;
  save(m);
}

function remove(cli) {
  const m = load();
  delete m.clis[cli];
  save(m);
}

module.exports = { manifestPath, get, addSteps, remove };
