const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function exists(file) {
  return fs.existsSync(file);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Write via temp file + rename so a CLI reading the file never sees half of it. Without an
// explicit mode, an existing file keeps its permissions (e.g. agy's 0600 settings.json).
function atomicWrite(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const finalMode = mode ?? (exists(file) ? fs.statSync(file).mode & 0o777 : 0o644);
  const tmp = `${file}.tmp.${process.pid}`;
  fs.rmSync(tmp, { force: true });
  // Created owner-only and exclusively, then widened to the final mode just before the rename.
  fs.writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(tmp, finalMode);
  fs.renameSync(tmp, file);
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// Copy `file` next to itself as <file>.status-line-backup-<ts> and return that path.
function backupFile(file) {
  let backup = `${file}.status-line-backup-${timestamp()}`;
  for (let i = 1; exists(backup); i++) backup = `${file}.status-line-backup-${timestamp()}-${i}`;
  fs.copyFileSync(file, backup);
  return backup;
}

// JSON config files are edited in place, so keep the file's own indent and trailing newline.
function readJsonFile(file) {
  if (!exists(file)) return { exists: false, data: undefined, indent: 2, newline: true };
  const text = fs.readFileSync(file, 'utf8');
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${tildify(file)} is not valid JSON (${e.message}); fix it by hand and re-run`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${tildify(file)} does not contain a JSON object`);
  }
  const indentMatch = text.match(/^[ \t]+(?=")/m);
  return { exists: true, data, indent: indentMatch ? indentMatch[0] : 2, newline: text.endsWith('\n') };
}

function writeJsonFile(file, data, { indent = 2, newline = true } = {}) {
  atomicWrite(file, JSON.stringify(data, null, indent) + (newline ? '\n' : ''));
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function tildify(p) {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

module.exports = { exists, sha256, atomicWrite, backupFile, readJsonFile, writeJsonFile, deepEqual, tildify };
