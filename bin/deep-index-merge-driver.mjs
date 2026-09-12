#!/usr/bin/env node
// Kam Memory — git merge driver for the deep-context index (deep/index.json)
// Part of setup-claude-memory
//
// Registered via .gitattributes alongside the memory-store driver:
//
//     deep/index.json merge=aim-index
//
//   git config merge.aim-index.driver "node '/path/deep-index-merge-driver.mjs' %O %A %B %P"
//
// WHY THIS EXISTS
//
// Until v1.11.0 the index was `merge=union`, on the theory that deep docs are write-once
// with unique ids and so cannot conflict. The DOCS cannot. The INDEX can: it is one
// pretty-printed JSON array, and when two machines each add a doc before syncing, union
// interleaves both sides' lines into invalid JSON. Nothing refused it. The deep-context
// server then read the broken file as an empty index and the next store rewrote it with a
// single entry. It happened twice on 2026-09-08 and dropped 1,953 entries.
//
// Entries are keyed by `id`, so merge them as a 3-way set: drop ids either side removed,
// keep ours in order, append ids only theirs added. An id changed differently on both
// sides is a real conflict, and we refuse rather than pick one.
//
// Exit 0 = merged, result written to %A. Exit 1 = refused; git keeps the conflict and the
// background sync aborts the rebase, which loses nothing.

import fs from 'fs';

function load(filePath, { allowEmpty = false } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (allowEmpty && err.code === 'ENOENT') return [];
    throw new Error(`cannot read ${filePath}: ${err.message}`);
  }
  if (allowEmpty && raw.trim() === '') return [];
  let index;
  try {
    index = JSON.parse(raw);
  } catch {
    throw new Error(`${filePath}: not valid JSON`);
  }
  if (!Array.isArray(index)) throw new Error(`${filePath}: not a JSON array`);
  const ids = new Set(index.map(e => e && e.id));
  if (ids.has(undefined) || ids.size !== index.length) throw new Error(`${filePath}: missing or duplicate ids`);
  return index;
}

function mergeIndexes(base, ours, theirs) {
  const byId = list => new Map(list.map(e => [e.id, e]));
  const b = byId(base), o = byId(ours), t = byId(theirs);
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const removed = new Set([...b.keys()].filter(id => !o.has(id) || !t.has(id)));

  const out = [];
  for (const entry of ours) {
    if (removed.has(entry.id)) continue;
    const theirsEntry = t.get(entry.id);
    const baseEntry = b.get(entry.id);
    if (theirsEntry && !same(theirsEntry, entry)) {
      if (baseEntry && same(entry, baseEntry)) { out.push(theirsEntry); continue; }
      if (!(baseEntry && same(theirsEntry, baseEntry))) {
        throw new Error(`id "${entry.id}" was changed differently on both sides`);
      }
    }
    out.push(entry);
  }
  for (const entry of theirs) {
    if (!o.has(entry.id) && !removed.has(entry.id)) out.push(entry);
  }
  return out;
}

function main(argv) {
  const [basePath, oursPath, theirsPath, pathName] = argv;
  if (!basePath || !oursPath || !theirsPath) {
    process.stderr.write('Usage: deep-index-merge-driver <base> <ours> <theirs> [path]\n');
    return 2;
  }

  let merged;
  try {
    merged = mergeIndexes(load(basePath, { allowEmpty: true }), load(oursPath), load(theirsPath));
  } catch (err) {
    process.stderr.write(`aim-index-merge: ${err.message}\n`);
    process.stderr.write('aim-index-merge: refusing to merge; git will leave the conflict in place.\n');
    return 1;
  }

  try {
    // Same shape the deep-context server writes: JSON.stringify(index, null, 2).
    fs.writeFileSync(oursPath, JSON.stringify(merged, null, 2), 'utf8');
  } catch (err) {
    process.stderr.write(`aim-index-merge: could not write ${oursPath}: ${err.message}\n`);
    return 1;
  }

  process.stderr.write(`aim-index-merge: merged ${pathName || oursPath} — ${merged.length} entries\n`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
