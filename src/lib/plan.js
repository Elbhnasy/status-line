// Install actions. Each action knows whether it is already satisfied, how to apply itself
// (returning a record of the prior state), and UNDO[record.kind] reverses that record.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exists, sha256, atomicWrite, backupFile, readJsonFile, writeJsonFile, deepEqual, tildify } = require('./fsutil');
const { run } = require('./proc');

function copyFile({ src, dest, mode = 0o644 }) {
  return {
    id: `copy:${dest}`,
    describe: () => `copy ${path.basename(src)} -> ${tildify(dest)}`,
    isSatisfied: () => exists(dest) && sha256(dest) === sha256(src),
    apply() {
      const existed = exists(dest);
      const record = { kind: 'copy', id: `copy:${dest}`, dest, existed };
      if (existed) record.backup = backupFile(dest);
      atomicWrite(dest, fs.readFileSync(src), mode);
      return record;
    },
  };
}

// Set top-level `key` of a JSON object file. With merge, `value`'s fields are laid over the
// existing object so unrelated sub-keys (e.g. agy's stack_with_default) survive.
function setJsonKey({ file, key, value, merge = false }) {
  const desired = () => {
    const current = readJsonFile(file).data?.[key];
    return merge && current && typeof current === 'object' && !Array.isArray(current)
      ? { ...current, ...value } : value;
  };
  return {
    id: `json-key:${file}#${key}`,
    describe: () => `set "${key}" in ${tildify(file)} to ${JSON.stringify(value)}`,
    isSatisfied: () => deepEqual(readJsonFile(file).data?.[key], desired()),
    apply() {
      const json = readJsonFile(file);
      const data = json.data || {};
      const record = {
        kind: 'json-key', id: `json-key:${file}#${key}`, file, key,
        fileExisted: json.exists, keyExisted: key in data, previous: data[key],
      };
      if (json.exists) record.backup = backupFile(file);
      data[key] = desired();
      writeJsonFile(file, data, json);
      return record;
    },
  };
}

// Append `value` to the array at top-level `key`, creating the file from `seed` if needed.
function addToJsonArray({ file, key, value, seed = {} }) {
  return {
    id: `json-array:${file}#${key}:${value}`,
    describe: () => `add ${JSON.stringify(value)} to "${key}" in ${tildify(file)}`,
    isSatisfied: () => {
      const arr = readJsonFile(file).data?.[key];
      return Array.isArray(arr) && arr.includes(value);
    },
    apply() {
      const json = readJsonFile(file);
      const data = json.data || { ...seed };
      if (data[key] !== undefined && !Array.isArray(data[key])) {
        throw new Error(`"${key}" in ${tildify(file)} is not an array; fix it by hand and re-run`);
      }
      const record = {
        kind: 'json-array', id: `json-array:${file}#${key}:${value}`, file, key, value,
        fileExisted: json.exists, keyExisted: key in data,
      };
      if (json.exists) record.backup = backupFile(file);
      data[key] = [...(data[key] || []), value];
      writeJsonFile(file, data, json);
      return record;
    },
  };
}

// Apply a patch to a git checkout's working tree. Tries a plain apply first (leaves the index
// alone) and falls back to --3way, which can absorb small upstream drift.
// Apply (or with reverse, revert) a patch so that it either lands whole or writes nothing.
// `git apply --3way --check` passes patches that then conflict, so the 3-way merge is first
// tried against a throwaway copy of the index (--cached never touches the working tree).
function applyPatch(repo, patch, { reverse = false } = {}) {
  const dir = reverse ? ['--reverse'] : [];
  const git = (args, env) => run('git', ['-C', repo, 'apply', ...dir, ...args, patch], env ? { env } : {});
  if (git(['--check']).status === 0) {
    const r = git([]);
    return r.status === 0 ? { ok: true, threeWay: false } : { ok: false, error: r.stderr.trim() };
  }
  const indexPath = path.resolve(repo, run('git', ['-C', repo, 'rev-parse', '--git-path', 'index']).stdout.trim());
  const trialIndex = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'status-line-')), 'index');
  try {
    if (exists(indexPath)) fs.copyFileSync(indexPath, trialIndex);
    const trial = git(['--3way', '--cached'], { ...process.env, GIT_INDEX_FILE: trialIndex });
    if (trial.status !== 0) return { ok: false, error: trial.stderr.trim() };
  } finally {
    fs.rmSync(path.dirname(trialIndex), { recursive: true, force: true });
  }
  const r = git(['--3way']);
  return r.status === 0 ? { ok: true, threeWay: true } : { ok: false, error: r.stderr.trim() };
}

function gitApply({ repo, patch, label, base }) {
  return {
    id: `git-apply:${repo}:${label}`,
    describe: () => `apply ${label} to ${tildify(repo)}`,
    isSatisfied: () => run('git', ['-C', repo, 'apply', '--reverse', '--check', patch]).status === 0,
    apply() {
      const result = applyPatch(repo, patch);
      if (!result.ok) {
        throw new Error(`${label} does not apply to ${tildify(repo)}`
          + `${base ? ` (it was cut against ${base.slice(0, 11)})` : ''}; nothing was changed:\n${result.error}`);
      }
      // Keep a copy of the exact patch applied so uninstall does not depend on the package.
      const kept = path.join(os.homedir(), '.status-line', label);
      atomicWrite(kept, fs.readFileSync(patch));
      return { kind: 'git-apply', id: `git-apply:${repo}:${label}`, repo, patch: kept, threeWay: result.threeWay };
    },
  };
}

// `hermes config set <key> <value>`; records the previous resolved value for uninstall.
function hermesConfigSet({ bin, key, value }) {
  const get = () => {
    const r = run(bin, ['config', 'get', key]);
    return r.status === 0 ? r.stdout.trim() : null;
  };
  return {
    id: `hermes-config:${key}`,
    describe: () => `hermes config set ${key} ${value}`,
    isSatisfied: () => get() === String(value),
    apply() {
      const previous = get();
      const r = run(bin, ['config', 'set', key, String(value)]);
      if (r.status !== 0) throw new Error(`hermes config set ${key} failed:\n${(r.stderr || r.stdout).trim()}`);
      return { kind: 'hermes-config', id: `hermes-config:${key}`, bin, key, previous };
    },
  };
}

// `hermes config unset <key>`: reverse of hermesConfigSet for keys the package stopped setting.
// The UNDO record is the same shape, so the existing `hermes-config` undo branch restores it.
function hermesConfigUnset({ bin, key }) {
  const get = () => {
    const r = run(bin, ['config', 'get', key]);
    return r.status === 0 ? r.stdout.trim() : null;
  };
  return {
    id: `hermes-config-unset:${key}`,
    describe: () => `hermes config unset ${key}`,
    isSatisfied: () => get() === null,
    apply() {
      const previous = get();
      const r = run(bin, ['config', 'unset', key]);
      if (r.status !== 0) throw new Error(`hermes config unset ${key} failed:\n${(r.stderr || r.stdout).trim()}`);
      return { kind: 'hermes-config', id: `hermes-config-unset:${key}`, bin, key, previous };
    },
  };
}

// Reverse a JSON edit: restore the prior value, and drop a file status-line created if empty.
function finishJsonUndo(rec, json, data) {
  if (!rec.fileExisted && Object.keys(data).length === 0) {
    fs.rmSync(rec.file, { force: true });
    return `removed ${tildify(rec.file)}`;
  }
  writeJsonFile(rec.file, data, json);
  return `restored "${rec.key}" in ${tildify(rec.file)}`;
}

const UNDO = {
  copy(rec) {
    if (rec.existed && rec.backup && exists(rec.backup)) {
      atomicWrite(rec.dest, fs.readFileSync(rec.backup), fs.statSync(rec.backup).mode & 0o777);
      return `restored ${tildify(rec.dest)} from backup`;
    }
    fs.rmSync(rec.dest, { force: true });
    return `removed ${tildify(rec.dest)}`;
  },
  'json-key'(rec) {
    const json = readJsonFile(rec.file);
    if (!json.exists) return `${tildify(rec.file)} is gone; nothing to restore`;
    const data = json.data;
    if (rec.keyExisted) data[rec.key] = rec.previous;
    else delete data[rec.key];
    return finishJsonUndo(rec, json, data);
  },
  'json-array'(rec) {
    const json = readJsonFile(rec.file);
    if (!json.exists) return `${tildify(rec.file)} is gone; nothing to restore`;
    const data = json.data;
    if (Array.isArray(data[rec.key])) {
      data[rec.key] = data[rec.key].filter(v => v !== rec.value);
      if (!rec.keyExisted && data[rec.key].length === 0) delete data[rec.key];
    }
    if (!rec.fileExisted && deepEqual(Object.keys(data), ['$schema'])) delete data.$schema;
    return finishJsonUndo(rec, json, data);
  },
  'git-apply'(rec) {
    const result = applyPatch(rec.repo, rec.patch, { reverse: true });
    if (!result.ok) {
      throw new Error(`could not revert the patch in ${tildify(rec.repo)}; nothing was changed:\n${result.error}`);
    }
    return `reverted patch in ${tildify(rec.repo)}`;
  },
  'hermes-config'(rec) {
    const args = rec.previous === null ? ['config', 'unset', rec.key] : ['config', 'set', rec.key, rec.previous];
    const r = run(rec.bin, args);
    if (r.status !== 0) throw new Error(`hermes ${args.join(' ')} failed:\n${(r.stderr || r.stdout).trim()}`);
    return `hermes ${args.join(' ')}`;
  },
};

module.exports = { copyFile, setJsonKey, addToJsonArray, gitApply, hermesConfigSet, hermesConfigUnset, UNDO };
