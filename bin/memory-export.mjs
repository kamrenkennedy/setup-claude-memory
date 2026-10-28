#!/usr/bin/env node
// Kam Memory — Aligned Memory scope exporter
// Part of setup-claude-memory
//
//   aim-memory-export --memory-path <store> --scope <scope.json> --out <snapshot.sql> [--manifest <file>] [--json]
//
// Builds the ONLY copy of memory that reaches the cloud: a SQL snapshot for the
// Aligned Memory Worker's D1 database. Everything about what leaves the Mac is
// decided here, before upload, so that excluded data is not hidden by the server —
// it is absent from Cloudflare entirely.
//
// HOW A SCOPE FAILS CLOSED
//
//   1. Deny by default. The scope file names entities and deep-doc projects EXACTLY.
//      Nothing else is exported, including every entity created after the list was
//      written. No patterns: "persona" also matches "Personal Self-Discovery".
//   2. Only memory.jsonl and deep/ are ever opened. The other scope files
//      (memory-family.jsonl, memory-personal.jsonl, ...) are refused by name, so no
//      allowlist mistake can pull one in.
//   3. Credentials are redacted (the patterns the pre-push scan blocks on), and so are
//      phone numbers and email addresses. Observations or docs matching one of the
//      scope's deny_patterns are dropped whole.
//   4. Embeddings stay home. Deep docs go up as metadata + markdown.
//
// The snapshot also carries a short profile (the owner's name and the topics the
// scope covers) that the Worker writes into its tool descriptions, so each user's
// Claude can tell when to reach for their memory. Topics come from the scope file's
// "topics", or else from the exported projects and entities, and pass the same deny
// and redaction rules as everything else.
//
// The summary it prints reports counts, never content, so it is safe to paste.
//
// --manifest records what the snapshot holds (hashes, never content). bin/aligned-sync.mjs
// compares the next export against it and uploads only what changed, because D1's free
// plan allows 100,000 written rows a day and a full snapshot is about 32,000.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { BLOCK_PATTERNS, REVIEW_PATTERNS } from '../lib/secret-patterns.mjs';

// Personal data redacted from the cloud copy. UUIDs stay: in a work store they are
// record ids, and without them half the engineering notes stop making sense.
const REDACT_REVIEW = new Set(['Phone number', 'Email address']);

// D1 refuses any single statement over 100 KB. Rows are batched under this, and doc
// bodies are split into chunks well inside it (a char can be 4 bytes of UTF-8).
const STATEMENT_BYTES = 60000;
const CHUNK_CHARS = 12000;

const MAX_TOPICS = 12;
export const DOC_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[A-Za-z0-9+/=\s]*)/g;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entities (snap TEXT NOT NULL, ord INTEGER NOT NULL, name TEXT NOT NULL, entity_type TEXT, obs_count INTEGER NOT NULL, PRIMARY KEY (snap, name));
CREATE TABLE IF NOT EXISTS observations (snap TEXT NOT NULL, entity TEXT NOT NULL, idx INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (snap, entity, idx));
CREATE TABLE IF NOT EXISTS relations (snap TEXT NOT NULL, ord INTEGER NOT NULL, from_name TEXT NOT NULL, to_name TEXT NOT NULL, relation_type TEXT NOT NULL, PRIMARY KEY (snap, ord));
CREATE TABLE IF NOT EXISTS docs (snap TEXT NOT NULL, ord INTEGER NOT NULL, id TEXT NOT NULL, project TEXT, client TEXT, type TEXT, date TEXT, summary TEXT, tags TEXT NOT NULL, meta TEXT NOT NULL, chunks INTEGER NOT NULL, PRIMARY KEY (snap, id));
CREATE TABLE IF NOT EXISTS doc_chunks (snap TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (snap, id, seq));
CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, user_id TEXT, client_id TEXT, method TEXT, tool TEXT, args TEXT, outcome TEXT NOT NULL, result_chars INTEGER, ip TEXT, country TEXT);
CREATE INDEX IF NOT EXISTS audit_log_ts ON audit_log (ts);
CREATE TABLE IF NOT EXISTS pending (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, user_id TEXT, tool TEXT NOT NULL, target TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', applied_at TEXT, error TEXT);
CREATE INDEX IF NOT EXISTS pending_status ON pending (status, id);
`.trim();

const SNAPSHOT_TABLES = ['entities', 'observations', 'relations', 'docs', 'doc_chunks'];

// ─── Sources ─────────────────────────────────────────────────────────────────

// The store's other files are other scopes. This is the one place a file gets
// opened, and it only ever opens these. Checked on the resolved path as well, so a
// memory.jsonl that is a symlink to memory-family.jsonl is refused too.
function assertExportable(store, file) {
  const allowed = rel => rel === 'memory.jsonl' || rel === path.join('deep', 'index.json')
    || (path.dirname(rel) === 'deep' && rel.endsWith('.md'));
  const rel = path.relative(store, file);
  const realRel = path.relative(fs.realpathSync(store), fs.realpathSync(file));
  if (!allowed(rel) || !allowed(realRel)) {
    throw new Error(`refusing to read ${rel}: only memory.jsonl and deep/ are exportable`);
  }
}

function readSource(store, file) {
  assertExportable(store, file);
  return fs.readFileSync(file, 'utf8');
}

export function loadScope(file) {
  const scope = JSON.parse(fs.readFileSync(file, 'utf8'));
  const strings = a => Array.isArray(a) && a.every(x => typeof x === 'string');
  if (typeof scope.scope !== 'string' || !/^[a-z][a-z0-9-]*$/.test(scope.scope)) {
    throw new Error('scope file needs a "scope" name, e.g. "work"');
  }
  if (!strings(scope.entities) || !strings(scope.deep_projects)) {
    throw new Error('scope file needs "entities" and "deep_projects" arrays of exact names');
  }
  if (scope.deny_patterns !== undefined && !strings(scope.deny_patterns)) {
    throw new Error('"deny_patterns" must be an array of regular expressions');
  }
  if (scope.owner !== undefined && typeof scope.owner !== 'string') throw new Error('"owner" must be a string');
  if (scope.topics !== undefined && !strings(scope.topics)) throw new Error('"topics" must be an array of strings');
  return {
    scope: scope.scope,
    owner: scope.owner?.trim() || null,
    topics: scope.topics,
    entities: new Set(scope.entities),
    deepProjects: new Set(scope.deep_projects),
    deny: (scope.deny_patterns || []).map(p => new RegExp(p, 'i')),
  };
}

function loadGraph(store) {
  const file = path.join(store, 'memory.jsonl');
  const lines = readSource(store, file).split('\n').filter(l => l.trim());
  const first = lines.length ? JSON.parse(lines[0]) : null;
  if (!first || first.type !== '_aim' || first.source !== 'mcp-knowledge-graph') {
    throw new Error('memory.jsonl is missing its _aim marker; refusing to export it');
  }
  const graph = { entities: [], relations: [] };
  for (const line of lines.slice(1)) {
    const item = JSON.parse(line);
    if (item.type === 'entity') graph.entities.push(item);
    if (item.type === 'relation') graph.relations.push(item);
  }
  return graph;
}

// Same rule as the deep-context server's parseFrontmatter, so aim_deep_get returns the
// same body from either server.
function splitFrontmatter(raw) {
  const m = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return m ? m[1].trim() : raw;
}

// ─── Redaction ───────────────────────────────────────────────────────────────

function makeRedactor(counts) {
  const patterns = [
    ...BLOCK_PATTERNS,
    ...REVIEW_PATTERNS.filter(([label]) => REDACT_REVIEW.has(label)),
  ];
  return text => {
    // The scan pattern matches only a key's BEGIN line, which is enough to block a
    // push. Redaction has to take the key material after it as well.
    let out = text.replace(PRIVATE_KEY_BLOCK, () => {
      counts['Private key block'] = (counts['Private key block'] || 0) + 1;
      return '[redacted: private key block]';
    });
    for (const [label, re] of patterns) {
      out = out.replace(re, () => {
        counts[label] = (counts[label] || 0) + 1;
        return `[redacted: ${label.toLowerCase()}]`;
      });
    }
    return out;
  };
}

// ─── Build ───────────────────────────────────────────────────────────────────

// Without explicit topics: projects with the most docs first, then entity names,
// with near-duplicates ("Persona — Studio" / "persona-studio") folded together.
function deriveTopics(entities, docs) {
  const byDocs = Object.entries(docs.reduce((m, d) => ({ ...m, [d.meta.project]: (m[d.meta.project] || 0) + 1 }), {}))
    .sort((a, b) => b[1] - a[1]).map(([p]) => p);
  return [...byDocs, ...entities.map(e => e.name.replace(/_/g, ' '))];
}

function topicList(candidates, keep) {
  const seen = new Set();
  const out = [];
  for (const t of candidates) {
    const key = t.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!key || seen.has(key) || !keep(t)) continue;
    seen.add(key);
    out.push(t.trim());
    if (out.length === MAX_TOPICS) break;
  }
  return out;
}

export function buildSnapshot(store, scope) {
  const redactions = {};
  const redact = makeRedactor(redactions);
  const denied = t => scope.deny.some(re => re.test(t));
  const dropped = { observations: 0, docs: 0 };

  const graph = loadGraph(store);
  const entities = [];
  for (const e of graph.entities) {
    if (!scope.entities.has(e.name)) continue;
    const observations = [];
    for (const o of e.observations) {
      if (denied(o)) { dropped.observations++; continue; }
      observations.push(redact(o));
    }
    entities.push({ name: e.name, entityType: e.entityType, observations });
  }
  const kept = new Set(entities.map(e => e.name));
  const relations = graph.relations.filter(r => kept.has(r.from) && kept.has(r.to));

  const deepDir = path.join(store, 'deep');
  const indexFile = path.join(deepDir, 'index.json');
  const index = fs.existsSync(indexFile) ? JSON.parse(readSource(store, indexFile)) : [];
  const docs = [];
  for (const entry of index) {
    if (!scope.deepProjects.has(entry.project)) continue;
    if (!DOC_ID.test(entry.id || '')) continue;
    const file = path.join(deepDir, `${entry.id}.md`);
    if (!fs.existsSync(file)) continue;
    const content = splitFrontmatter(readSource(store, file));
    const tags = Array.isArray(entry.tags) ? entry.tags : [];
    if ([content, entry.summary || '', entry.client || '', ...tags].some(denied)) { dropped.docs++; continue; }
    const meta = {
      id: entry.id,
      project: entry.project,
      ...(entry.client && { client: entry.client }),
      tags: tags.map(redact),
      type: entry.type,
      date: entry.date,
      summary: redact(entry.summary || ''),
    };
    docs.push({ meta, content: redact(content) });
  }

  const topics = topicList(scope.topics || deriveTopics(entities, docs), t => !denied(t)).map(redact);
  const profile = { owner: scope.owner && redact(scope.owner), topics };
  // What a cloud write may touch: any exported entity, and docs in these projects.
  const writable = { deep_projects: [...scope.deepProjects] };

  return {
    scope: scope.scope,
    entities,
    relations,
    docs,
    profile,
    writable,
    report: {
      scope: scope.scope,
      entities_exported: entities.length,
      entities_left_home: graph.entities.length - entities.length,
      allowlisted_but_missing: [...scope.entities].filter(n => !graph.entities.some(e => e.name === n)),
      observations_exported: entities.reduce((n, e) => n + e.observations.length, 0),
      relations_exported: relations.length,
      docs_exported: docs.length,
      docs_left_home: index.length - docs.length - dropped.docs,
      docs_by_project: docs.reduce((m, d) => ({ ...m, [d.meta.project]: (m[d.meta.project] || 0) + 1 }), {}),
      allowlisted_projects_with_no_docs: [...scope.deepProjects].filter(p => !docs.some(d => d.meta.project === p)),
      dropped_by_deny_patterns: dropped,
      described_as: profile,
      redactions,
    },
  };
}

// ─── SQL ─────────────────────────────────────────────────────────────────────

export const lit = v => (v === null || v === undefined ? 'NULL'
  : typeof v === 'number' ? String(v)
  : `'${String(v).replace(/'/g, "''")}'`);

export function inserts(table, columns, rows) {
  const out = [];
  const head = `INSERT INTO ${table} (${columns.join(', ')}) VALUES `;
  let batch = [];
  let bytes = 0;
  for (const row of rows) {
    const tuple = `(${row.map(lit).join(', ')})`;
    const size = Buffer.byteLength(tuple);
    if (batch.length && bytes + size > STATEMENT_BYTES) {
      out.push(head + batch.join(', ') + ';');
      batch = []; bytes = 0;
    }
    batch.push(tuple); bytes += size;
  }
  if (batch.length) out.push(head + batch.join(', ') + ';');
  return out;
}

export function chunk(text) {
  const parts = [];
  for (let i = 0; i < text.length; i += CHUNK_CHARS) parts.push(text.slice(i, i + CHUNK_CHARS));
  return parts.length ? parts : [''];
}

// Rows are written under a fresh snapshot id and only become visible when
// meta.current_snap flips at the end. An import that dies halfway leaves the previous
// snapshot serving, and its strays are swept by the next export.
export function toSql(snapshot, { snap, exportedAt, sourceCommit }) {
  const s = snap;
  const sql = [SCHEMA];
  sql.push(...inserts('entities', ['snap', 'ord', 'name', 'entity_type', 'obs_count'],
    snapshot.entities.map((e, i) => [s, i, e.name, e.entityType ?? null, e.observations.length])));
  sql.push(...inserts('observations', ['snap', 'entity', 'idx', 'text'],
    snapshot.entities.flatMap(e => e.observations.map((o, i) => [s, e.name, i, o]))));
  sql.push(...inserts('relations', ['snap', 'ord', 'from_name', 'to_name', 'relation_type'],
    snapshot.relations.map((r, i) => [s, i, r.from, r.to, r.relationType])));
  const chunked = snapshot.docs.map(d => ({ ...d, parts: chunk(d.content) }));
  sql.push(...inserts('docs', ['snap', 'ord', 'id', 'project', 'client', 'type', 'date', 'summary', 'tags', 'meta', 'chunks'],
    chunked.map((d, i) => [s, i, d.meta.id, d.meta.project ?? null, d.meta.client ?? null, d.meta.type ?? null,
      d.meta.date ?? null, d.meta.summary, JSON.stringify(d.meta.tags), JSON.stringify(d.meta), d.parts.length])));
  sql.push(...inserts('doc_chunks', ['snap', 'id', 'seq', 'text'],
    chunked.flatMap(d => d.parts.map((p, i) => [s, d.meta.id, i, p]))));
  sql.push(...inserts('meta', ['key', 'value'], metaRows(snapshot, { snap: s, exportedAt, sourceCommit })).map(q => q.replace('INSERT INTO', 'INSERT OR REPLACE INTO')));
  for (const t of SNAPSHOT_TABLES) sql.push(`DELETE FROM ${t} WHERE snap <> ${lit(s)};`);
  return sql.join('\n') + '\n';
}

// ─── Incremental ─────────────────────────────────────────────────────────────

const sha = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);

export function metaRows(snapshot, { snap, exportedAt, sourceCommit }) {
  return [
    ['current_snap', snap], ['scope', snapshot.scope], ['exported_at', exportedAt], ['source_commit', sourceCommit || ''],
    ['profile', JSON.stringify(snapshot.profile || { owner: null, topics: [] })],
    ['writable', JSON.stringify(snapshot.writable || { deep_projects: [] })],
  ];
}

// What the cloud holds after this snapshot lands, as hashes. Never content.
export function manifestOf(snapshot, snap) {
  return {
    snap,
    entities: Object.fromEntries(snapshot.entities.map(e => [e.name, { count: e.observations.length, hash: sha(e.observations) }])),
    relations: sha(snapshot.relations),
    docs: Object.fromEntries(snapshot.docs.map(d => [d.meta.id, sha([d.meta, d.content])])),
    meta: sha([snapshot.scope, snapshot.profile, snapshot.writable]),
  };
}

// The statements that turn what the cloud holds into this snapshot. `cloud` is read from
// D1 just before (entity counts and order, doc ids and order), because the cloud can hold
// rows the manifest never saw: writes from the phone. `skip` holds entities and doc ids
// with a cloud write the Mac has not taken in yet; they are left exactly as they are
// until it has. Every unit starts by deleting what it rewrites, so a run that dies
// partway is repaired by the next. Returns the statements and the manifest to save.
export function diffSql(snapshot, previous, cloud, { snap, exportedAt, sourceCommit, skip = { entities: new Set(), docs: new Set() } }) {
  const S = lit(snap);
  const sql = [];
  const next = manifestOf(snapshot, snap);
  const keep = (map, key) => { if (previous[map]?.[key] !== undefined) next[map][key] = previous[map][key]; else delete next[map][key]; };

  const wanted = new Set();
  snapshot.entities.forEach((e, ord) => {
    wanted.add(e.name);
    if (skip.entities.has(e.name)) return keep('entities', e.name);
    const was = previous.entities?.[e.name];
    const there = cloud.entities.get(e.name);
    const obs = e.observations;
    let from;
    if (!was || !there || there.obs_count < was.count) from = 0;
    else if (there.obs_count === obs.length && was.count === obs.length && was.hash === sha(obs)) from = null;
    else if (obs.length >= was.count && sha(obs.slice(0, was.count)) === was.hash) from = was.count;
    else from = 0;

    if (from === null) {
      if (there.ord !== ord || (there.entity_type ?? null) !== (e.entityType ?? null)) {
        sql.push(`UPDATE entities SET ord = ${ord}, entity_type = ${lit(e.entityType ?? null)} WHERE snap = ${S} AND name = ${lit(e.name)};`);
      }
      return;
    }
    sql.push(`DELETE FROM observations WHERE snap = ${S} AND entity = ${lit(e.name)} AND idx >= ${from};`);
    sql.push(...inserts('observations', ['snap', 'entity', 'idx', 'text'],
      obs.slice(from).map((o, i) => [snap, e.name, from + i, o])).map(q => q.replace('INSERT INTO', 'INSERT OR REPLACE INTO')));
    sql.push(`INSERT OR REPLACE INTO entities (snap, ord, name, entity_type, obs_count) VALUES (${S}, ${ord}, ${lit(e.name)}, ${lit(e.entityType ?? null)}, ${obs.length});`);
  });
  for (const name of cloud.entities.keys()) {
    if (wanted.has(name) || skip.entities.has(name)) continue;
    sql.push(`DELETE FROM observations WHERE snap = ${S} AND entity = ${lit(name)};`, `DELETE FROM entities WHERE snap = ${S} AND name = ${lit(name)};`);
  }

  if (previous.relations !== next.relations) {
    sql.push(`DELETE FROM relations WHERE snap = ${S};`);
    sql.push(...inserts('relations', ['snap', 'ord', 'from_name', 'to_name', 'relation_type'],
      snapshot.relations.map((r, i) => [snap, i, r.from, r.to, r.relationType])));
  }

  const docIds = new Set();
  snapshot.docs.forEach((d, ord) => {
    const id = d.meta.id;
    docIds.add(id);
    if (skip.docs.has(id)) return keep('docs', id);
    const there = cloud.docs.get(id);
    if (there !== undefined && previous.docs?.[id] === next.docs[id]) {
      if (there !== ord) sql.push(`UPDATE docs SET ord = ${ord} WHERE snap = ${S} AND id = ${lit(id)};`);
      return;
    }
    const parts = chunk(d.content);
    sql.push(`DELETE FROM doc_chunks WHERE snap = ${S} AND id = ${lit(id)};`);
    sql.push(`INSERT OR REPLACE INTO docs (snap, ord, id, project, client, type, date, summary, tags, meta, chunks) VALUES (${[snap, ord, id,
      d.meta.project ?? null, d.meta.client ?? null, d.meta.type ?? null, d.meta.date ?? null, d.meta.summary,
      JSON.stringify(d.meta.tags), JSON.stringify(d.meta), parts.length].map(lit).join(', ')});`);
    sql.push(...inserts('doc_chunks', ['snap', 'id', 'seq', 'text'], parts.map((p, i) => [snap, id, i, p])));
  });
  for (const id of cloud.docs.keys()) {
    if (docIds.has(id) || skip.docs.has(id)) continue;
    sql.push(`DELETE FROM doc_chunks WHERE snap = ${S} AND id = ${lit(id)};`, `DELETE FROM docs WHERE snap = ${S} AND id = ${lit(id)};`);
  }

  if (sql.length || previous.meta !== next.meta) {
    sql.push(...inserts('meta', ['key', 'value'], metaRows(snapshot, { snap, exportedAt, sourceCommit }))
      .map(q => q.replace('INSERT INTO', 'INSERT OR REPLACE INTO')));
  }
  return { sql, manifest: next };
}

// ─── Main ────────────────────────────────────────────────────────────────────

export function sourceCommitOf(store) {
  try {
    return execFileSync('git', ['-C', store, 'rev-parse', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; /* not a git store */ }
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}

function main(argv) {
  const store = arg(argv, '--memory-path');
  const scopeFile = arg(argv, '--scope');
  const out = arg(argv, '--out');
  if (!store || !scopeFile || !out) {
    process.stderr.write('Usage: aim-memory-export --memory-path <store> --scope <scope.json> --out <snapshot.sql> [--manifest <file>] [--json]\n');
    return 2;
  }
  if (!fs.existsSync(store) || !fs.statSync(store).isDirectory()) {
    process.stderr.write(`aim-memory-export: --memory-path must be the store directory, not a file: ${store}\n`);
    return 2;
  }

  const snapshot = buildSnapshot(path.resolve(store), loadScope(scopeFile));
  const sourceCommit = sourceCommitOf(store);
  const exportedAt = new Date().toISOString();
  const snap = `${exportedAt.replace(/[^0-9]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(out, toSql(snapshot, { snap, exportedAt, sourceCommit }), { mode: 0o600 });
  // Written beside the snapshot, and only describes it: aligned-sync trusts it once the
  // cloud's current_snap matches, which happens only when this snapshot is uploaded.
  const manifestFile = arg(argv, '--manifest');
  if (manifestFile) fs.writeFileSync(manifestFile, JSON.stringify(manifestOf(snapshot, snap)) + '\n', { mode: 0o600 });

  const report = { ...snapshot.report, snapshot: snap, source_commit: sourceCommit, out };
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return 0;
  }
  const r = report;
  const lines = [
    `Scope "${r.scope}" → ${out}`,
    `  entities      ${r.entities_exported} exported, ${r.entities_left_home} left home`,
    `  observations  ${r.observations_exported}   relations ${r.relations_exported}`,
    `  deep docs     ${r.docs_exported} exported, ${r.docs_left_home} left home`,
    ...Object.entries(r.docs_by_project).sort((a, b) => b[1] - a[1]).map(([p, n]) => `      ${String(n).padStart(5)}  ${p}`),
    `  dropped       ${r.dropped_by_deny_patterns.observations} observations, ${r.dropped_by_deny_patterns.docs} docs (deny_patterns)`,
    `  described as  ${r.described_as.owner ? `${r.described_as.owner}'s memory: ` : ''}${r.described_as.topics.join(', ') || '(no topics)'}`,
    `  redacted      ${Object.entries(r.redactions).map(([l, n]) => `${n} ${l}`).join(', ') || 'nothing'}`,
  ];
  if (r.allowlisted_but_missing.length) lines.push(`  ⚠ allowlisted entities not in the store: ${r.allowlisted_but_missing.join(', ')}`);
  if (r.allowlisted_projects_with_no_docs.length) lines.push(`  ⚠ allowlisted projects with no docs: ${r.allowlisted_projects_with_no_docs.join(', ')}`);
  lines.push('', 'Nothing has been uploaded. Review the counts above, then load it with:',
    `  npx wrangler d1 execute aligned-memory --remote --file ${out}`);
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`aim-memory-export: ${err.message}\n`);
    process.exit(1);
  }
}
