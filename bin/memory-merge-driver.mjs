#!/usr/bin/env node
// Kam Memory — git merge driver for AIM knowledge-graph JSONL stores
// Part of setup-claude-memory
//
// Registered via .gitattributes so git calls it instead of its own text merge:
//
//     memory*.jsonl merge=aim-memory
//
//   git config merge.aim-memory.name   "AIM knowledge graph semantic merge"
//   git config merge.aim-memory.driver "aim-memory-merge %O %A %B %P"
//
// ⚠️ Git runs the driver command through a SHELL. If it is registered as a path
// rather than a name on PATH, that path MUST be quoted, or a directory containing
// a space silently breaks the merge — git falls back to a plain conflict and the
// user is handed markers they cannot resolve. Register it as:
//
//   git config merge.aim-memory.driver "node '/path/with spaces/memory-merge-driver.mjs' %O %A %B %P"
//
// WHY THIS EXISTS
//
// The store is one JSON object per line, and the whole point of moving memory into
// git is that two machines (or two live sessions) can write it at once. Git's own
// options are both wrong here:
//
//   - The default text merge conflicts on any two edits near each other and leaves
//     conflict markers in the file, which makes the store unparseable and demands a
//     human who can read a diff.
//   - `merge=union` concatenates both sides, so two edits to the SAME entity produce
//     TWO LINES WITH THE SAME ENTITY NAME — a silently corrupted graph.
//
// Memory is append-mostly and its unit of meaning is the observation, not the line.
// So merge semantically: entities by name, relations by triple, observations by
// proper 3-way set logic. A conflict then resolves correctly without a person, which
// is the precondition for handing git to someone who should never have to clear one.
//
// Exit 0 = merged, result written to %A. Exit 1 = refused; git keeps the conflict.
// It refuses rather than guesses whenever an input is not a well-formed store.

import fs from 'fs';

const FILE_MARKER = { type: '_aim', source: 'mcp-knowledge-graph' };

// ─── Parse / serialize (must match bin/memory-server.mjs byte for byte) ──────

function parseStore(filePath, { allowMissing = false } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (allowMissing && err.code === 'ENOENT') return { entities: [], relations: [] };
    throw new Error(`cannot read ${filePath}: ${err.message}`);
  }

  const lines = raw.split('\n').filter(l => l.trim() !== '');
  // An empty side is legitimate: the file was created on one branch only.
  if (lines.length === 0) return { entities: [], relations: [] };

  let first;
  try {
    first = JSON.parse(lines[0]);
  } catch {
    throw new Error(`${filePath}: first line is not JSON — not an AIM store`);
  }
  if (first.type !== '_aim' || first.source !== 'mcp-knowledge-graph') {
    throw new Error(`${filePath}: missing the _aim marker — refusing to merge a file that may not be a memory store`);
  }

  const entities = [];
  const relations = [];
  lines.slice(1).forEach((line, i) => {
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      throw new Error(`${filePath}: line ${i + 2} is not valid JSON`);
    }
    if (item.type === 'entity') entities.push(item);
    else if (item.type === 'relation') relations.push(item);
    // Unknown types are dropped, exactly as the server's loader drops them.
  });
  return { entities, relations };
}

function serialize(graph) {
  return [
    JSON.stringify(FILE_MARKER),
    ...graph.entities.map(e => JSON.stringify({ type: 'entity', ...e })),
    ...graph.relations.map(r => JSON.stringify({ type: 'relation', ...r })),
  ].join('\n');
}

// ─── 3-way set merge ─────────────────────────────────────────────────────────
//
// Union both sides, then drop anything that was in the base and deliberately
// removed on either side. Union alone would resurrect deletions; intersection
// would lose additions. This is also what makes an ARCHIVAL MOVE survive — the
// remove-from-A and add-to-B halves are each honoured independently.
//
// Order is ours-first, then whatever theirs added, which keeps the rough
// chronology of an append-mostly log.

function mergeKeyed(baseItems, oursItems, theirsItems, keyOf) {
  const keys = items => new Set(items.map(keyOf));
  const baseKeys = keys(baseItems);
  const oursKeys = keys(oursItems);
  const theirsKeys = keys(theirsItems);

  const removed = new Set();
  for (const k of baseKeys) {
    if (!oursKeys.has(k) || !theirsKeys.has(k)) removed.add(k);
  }

  const out = [];
  const seen = new Set();
  for (const item of oursItems) {
    const k = keyOf(item);
    if (removed.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  for (const item of theirsItems) {
    const k = keyOf(item);
    if (removed.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

const identity = x => x;
const relationKey = r => JSON.stringify([r.from, r.to, r.relationType]);

function mergeEntity(base, ours, theirs) {
  return {
    name: ours.name,
    // entityType is a label and diverging edits to it are vanishingly rare; take
    // ours deterministically rather than manufacturing a conflict a person would
    // have to resolve.
    entityType: ours.entityType !== undefined ? ours.entityType : theirs.entityType,
    observations: mergeKeyed(
      base ? base.observations || [] : [],
      ours.observations || [],
      theirs.observations || [],
      identity
    ),
  };
}

function mergeGraphs(base, ours, theirs) {
  const index = list => new Map(list.map(e => [e.name, e]));
  const baseE = index(base.entities);
  const oursE = index(ours.entities);
  const theirsE = index(theirs.entities);

  const order = [];
  const seen = new Set();
  for (const e of [...ours.entities, ...theirs.entities]) {
    if (!seen.has(e.name)) { seen.add(e.name); order.push(e.name); }
  }

  const entities = [];
  for (const name of order) {
    const o = oursE.get(name);
    const t = theirsE.get(name);
    const b = baseE.get(name);

    if (o && t) { entities.push(mergeEntity(b, o, t)); continue; }
    // Present on one side only: an entity that existed in the base was deliberately
    // deleted by the other side, so honour that. One that did not is a new addition.
    const only = o || t;
    if (!b) entities.push({ name: only.name, entityType: only.entityType, observations: only.observations || [] });
  }

  const relations = mergeKeyed(base.relations, ours.relations, theirs.relations, relationKey)
    .map(r => ({ from: r.from, to: r.to, relationType: r.relationType }));

  return { entities, relations };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

function main(argv) {
  const [basePath, oursPath, theirsPath, pathName] = argv;
  if (!basePath || !oursPath || !theirsPath) {
    process.stderr.write('Usage: aim-memory-merge <base> <ours> <theirs> [path]\n');
    return 2;
  }

  let merged;
  try {
    // %O is empty when both sides added the file independently.
    const base = parseStore(basePath, { allowMissing: true });
    const ours = parseStore(oursPath);
    const theirs = parseStore(theirsPath);
    merged = mergeGraphs(base, ours, theirs);
  } catch (err) {
    process.stderr.write(`aim-memory-merge: ${err.message}\n`);
    process.stderr.write('aim-memory-merge: refusing to merge; git will leave the conflict in place.\n');
    return 1;
  }

  try {
    fs.writeFileSync(oursPath, serialize(merged));
  } catch (err) {
    process.stderr.write(`aim-memory-merge: could not write ${oursPath}: ${err.message}\n`);
    return 1;
  }

  const label = pathName || oursPath;
  process.stderr.write(
    `aim-memory-merge: merged ${label} — ${merged.entities.length} entities, ${merged.relations.length} relations\n`
  );
  return 0;
}

process.exit(main(process.argv.slice(2)));
