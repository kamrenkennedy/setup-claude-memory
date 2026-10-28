// Aligned Memory — D1 reads
//
// The snapshot that bin/memory-export.mjs writes, read back as the shapes
// lib/read-core.mjs expects. Every query pins the current snapshot, so a half-loaded
// import is never visible. There is no write path here.
//
// One known difference from the local server: SQLite's lower() folds ASCII only, so a
// query that differs from the stored text only in non-ASCII case (É vs é) can miss.

import { DEFAULTS, clampNumber } from '../../lib/read-core.mjs';

const SNAP = "(SELECT value FROM meta WHERE key = 'current_snap')";

const relationRow = r => ({ type: 'relation', from: r.from_name, to: r.to_name, relationType: r.relation_type });

export async function snapshotInfo(db) {
  const { results } = await db.prepare("SELECT key, value FROM meta WHERE key IN ('current_snap', 'scope', 'exported_at')").all();
  return Object.fromEntries(results.map(r => [r.key, r.value]));
}

// The owner's name and topics, written by the exporter for the tool descriptions.
export async function profile(db) {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'profile'").first();
  try {
    const p = row ? JSON.parse(row.value) : {};
    return { owner: typeof p.owner === 'string' ? p.owner : null, topics: Array.isArray(p.topics) ? p.topics.map(String) : [] };
  } catch {
    return { owner: null, topics: [] };
  }
}

export async function relations(db) {
  const { results } = await db.prepare(
    `SELECT from_name, to_name, relation_type FROM relations WHERE snap = ${SNAP} ORDER BY ord`
  ).all();
  return results.map(relationRow);
}

// Candidates for shapeSearch(): one per entity whose name, type or observations match,
// in store order, carrying at least `perEntity` hits or tail observations.
export async function searchCandidates(db, query, opts = {}) {
  const q = String(query).toLowerCase();
  // The budget loop can fall back to the default per-entity count, so never fetch less.
  const n = Math.max(clampNumber(opts.per_entity, DEFAULTS.searchPerEntity), DEFAULTS.searchPerEntity);

  const [entities, hits] = await db.batch([
    db.prepare(`SELECT name, entity_type, obs_count FROM entities WHERE snap = ${SNAP} ORDER BY ord`),
    db.prepare(
      `SELECT entity, idx, text, cnt FROM (
         SELECT entity, idx, text,
                row_number() OVER (PARTITION BY entity ORDER BY idx) AS rn,
                count(*) OVER (PARTITION BY entity) AS cnt
           FROM observations
          WHERE snap = ${SNAP} AND instr(lower(text), ?1) > 0
       ) WHERE rn <= ?2 ORDER BY entity, idx`
    ).bind(q, n),
  ]);

  const byEntity = new Map();
  for (const h of hits.results) {
    if (!byEntity.has(h.entity)) byEntity.set(h.entity, { count: h.cnt, hits: [] });
    byEntity.get(h.entity).hits.push({ index: h.idx, text: h.text });
  }

  const candidates = [];
  const needTail = [];
  for (const e of entities.results) {
    const nameHit = e.name.toLowerCase().includes(q);
    const typeHit = (e.entity_type || '').toLowerCase().includes(q);
    const found = byEntity.get(e.name);
    if (!nameHit && !typeHit && !found) continue;
    const c = {
      name: e.name,
      entityType: e.entity_type,
      total: e.obs_count,
      nameHit,
      typeHit,
      hitCount: found ? found.count : 0,
      hits: found ? found.hits : [],
      tailRows: [],
      tail: k => c.tailRows.slice(-k),
    };
    if (!found) needTail.push(c);
    candidates.push(c);
  }

  if (needTail.length) {
    const tails = await db.batch(needTail.map(c => db.prepare(
      `SELECT idx, text FROM observations WHERE snap = ${SNAP} AND entity = ?1 AND idx >= ?2 ORDER BY idx`
    ).bind(c.name, c.total - n)));
    needTail.forEach((c, i) => { c.tailRows = tails[i].results.map(r => ({ index: r.idx, text: r.text })); });
  }
  return candidates;
}

// Entities for shapeGet(), in store order. Without `full`, only the newest slice comes
// back: enough for `recent`, and for the budget loop's largest rung.
export async function getEntities(db, names, opts = {}) {
  const wanted = [...new Set((names || []).map(String))];
  if (!wanted.length) return [];
  const full = opts.full === true || opts.full === 'true';
  const keep = Math.max(clampNumber(opts.recent, DEFAULTS.getRecent), 200);

  const { results: rows } = await db.prepare(
    `SELECT name, entity_type, obs_count FROM entities
      WHERE snap = ${SNAP} AND name IN (SELECT value FROM json_each(?1)) ORDER BY ord`
  ).bind(JSON.stringify(wanted)).all();
  if (!rows.length) return [];

  const obs = await db.batch(rows.map(e => db.prepare(
    `SELECT text FROM observations WHERE snap = ${SNAP} AND entity = ?1 AND idx >= ?2 ORDER BY idx`
  ).bind(e.name, full ? 0 : Math.max(0, e.obs_count - keep))));

  return rows.map((e, i) => ({
    type: 'entity',
    name: e.name,
    entityType: e.entity_type,
    observations: obs[i].results.map(r => r.text),
    total: e.obs_count,
  }));
}

// ─── Deep context ────────────────────────────────────────────────────────────

const docMeta = row => JSON.parse(row.meta);

export async function searchDocs(db, input = {}) {
  const { query, project, tags, type, date_from, date_to } = input;
  const limit = Math.min(clampNumber(input.limit, 25), 100);
  const where = [`snap = ${SNAP}`];
  const binds = [];
  const bind = v => { binds.push(v); return `?${binds.length}`; };

  if (project) where.push(`instr(lower(project), ${bind(String(project).toLowerCase())}) > 0`);
  if (type) where.push(`type = ${bind(String(type))}`);
  if (Array.isArray(tags) && tags.length) {
    where.push(`EXISTS (SELECT 1 FROM json_each(docs.tags) WHERE value IN (SELECT value FROM json_each(${bind(JSON.stringify(tags.map(String)))})))`);
  }
  if (date_from) where.push(`date >= ${bind(String(date_from))}`);
  if (date_to) where.push(`date <= ${bind(String(date_to))}`);
  if (query) {
    const q = bind(String(query).toLowerCase());
    where.push(`(instr(lower(summary), ${q}) > 0 OR instr(lower(project), ${q}) > 0 OR instr(lower(client), ${q}) > 0
      OR EXISTS (SELECT 1 FROM json_each(docs.tags) WHERE instr(lower(value), ${q}) > 0))`);
  }

  const clause = where.join(' AND ');
  const [count, rows] = await db.batch([
    db.prepare(`SELECT count(*) AS n FROM docs WHERE ${clause}`).bind(...binds),
    db.prepare(`SELECT meta FROM docs WHERE ${clause} ORDER BY ord LIMIT ${limit}`).bind(...binds),
  ]);
  const results = rows.results.map(docMeta);
  const total = count.results[0].n;
  return {
    results,
    count: total,
    returned: results.length,
    ...(total > results.length && { note: `${total - results.length} more match. Narrow the search or raise limit (max 100).` }),
  };
}

export async function listDocs(db, input = {}) {
  const limit = Math.min(clampNumber(input.limit, 20), 100);
  const binds = [];
  let clause = `snap = ${SNAP}`;
  if (input.project) {
    binds.push(String(input.project).toLowerCase());
    clause += ' AND instr(lower(project), ?1) > 0';
  }
  const [count, rows] = await db.batch([
    db.prepare(`SELECT count(*) AS n FROM docs WHERE ${clause}`).bind(...binds),
    db.prepare(`SELECT meta FROM docs WHERE ${clause} ORDER BY date DESC, ord LIMIT ${limit}`).bind(...binds),
  ]);
  return { documents: rows.results.map(docMeta), count: count.results[0].n };
}

// A doc can be hundreds of KB, so it comes back a window at a time.
export async function getDoc(db, input = {}) {
  const id = String(input.id || '');
  if (!id) throw new Error('Missing required field: id');
  const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
  const maxChars = Math.min(clampNumber(input.max_chars, 50000), 200000);

  const [doc, chunks] = await db.batch([
    db.prepare(`SELECT meta FROM docs WHERE snap = ${SNAP} AND id = ?1`).bind(id),
    db.prepare(`SELECT text FROM doc_chunks WHERE snap = ${SNAP} AND id = ?1 ORDER BY seq`).bind(id),
  ]);
  if (!doc.results.length) throw new Error(`Document not found: ${id}`);
  const content = chunks.results.map(r => r.text).join('');
  const slice = content.slice(offset, offset + maxChars);
  const end = offset + slice.length;
  return {
    id,
    meta: docMeta(doc.results[0]),
    content: slice,
    total_chars: content.length,
    ...(offset > 0 && { offset }),
    ...(end < content.length && { next_offset: end, note: `Document continues. Call again with offset: ${end}.` }),
  };
}

// ─── Writes ──────────────────────────────────────────────────────────────────
//
// A write lands twice in one transaction: in the live tables, so the next read sees it,
// and in `pending`, which the Mac drains into the real store (bin/aligned-sync.mjs).
// Writes only add. They cannot touch an entity outside the scope, overwrite a doc, or
// delete anything, so a stolen token can add noise but cannot erase memory.

export const LIMITS = { factChars: 2000, factsPerCall: 20, docChars: 200000, summaryChars: 1000, writesPerDay: 200 };
const DOC_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DOC_TYPES = ['session-summary', 'creative-brief', 'research', 'decision-log', 'project-narrative'];
const CHUNK_CHARS = 12000;

async function underDailyCap(db, adding) {
  const today = new Date().toISOString().slice(0, 10);
  const row = await db.prepare('SELECT count(*) AS n FROM pending WHERE ts >= ?1').bind(today).first();
  if (row.n + adding > LIMITS.writesPerDay) {
    throw new Error(`Daily write limit reached (${LIMITS.writesPerDay}). Writes reopen at 00:00 UTC.`);
  }
}

export async function addFacts(db, observations, userId) {
  if (!Array.isArray(observations) || !observations.length) throw new Error('observations is required');
  const items = observations.map(o => ({
    name: String(o?.entityName ?? ''),
    contents: (Array.isArray(o?.contents) ? o.contents : []).map(String),
  }));
  const all = items.flatMap(i => i.contents);
  if (all.length > LIMITS.factsPerCall) throw new Error(`At most ${LIMITS.factsPerCall} observations per call.`);
  if (all.some(c => !c.trim() || c.length > LIMITS.factChars)) {
    throw new Error(`Each observation must be non-empty and at most ${LIMITS.factChars} characters.`);
  }
  await underDailyCap(db, items.length);

  const names = [...new Set(items.map(i => i.name))];
  const [ents, dupes] = await db.batch([
    db.prepare(`SELECT name, obs_count FROM entities WHERE snap = ${SNAP} AND name IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(names)),
    db.prepare(`SELECT entity, text FROM observations WHERE snap = ${SNAP} AND entity IN (SELECT value FROM json_each(?1))
                AND text IN (SELECT value FROM json_each(?2))`).bind(JSON.stringify(names), JSON.stringify(all)),
  ]);
  const count = new Map(ents.results.map(e => [e.name, e.obs_count]));
  const missing = names.filter(n => !count.has(n));
  if (missing.length) throw new Error(`Entity with name ${missing[0]} not found in this memory's work scope.`);
  const seen = new Map(names.map(n => [n, new Set()]));
  for (const d of dupes.results) seen.get(d.entity).add(d.text);

  const ts = new Date().toISOString();
  const stmts = [];
  const results = items.map(({ name, contents }) => {
    const added = contents.filter(c => !seen.get(name).has(c) && seen.get(name).add(c));
    for (const text of added) {
      const idx = count.get(name);
      count.set(name, idx + 1);
      stmts.push(db.prepare(`INSERT INTO observations (snap, entity, idx, text) VALUES (${SNAP}, ?1, ?2, ?3)`).bind(name, idx, text));
    }
    if (added.length) {
      stmts.push(db.prepare("INSERT INTO pending (ts, user_id, tool, target, payload) VALUES (?1, ?2, 'aim_memory_add_facts', ?3, ?4)")
        .bind(ts, userId ?? null, name, JSON.stringify({ entityName: name, contents: added })));
    }
    return { entityName: name, addedObservations: added };
  });
  for (const name of names) {
    stmts.push(db.prepare(`UPDATE entities SET obs_count = ?1 WHERE snap = ${SNAP} AND name = ?2`).bind(count.get(name), name));
  }
  if (results.some(r => r.addedObservations.length)) await db.batch(stmts);
  return results;
}

export async function storeDoc(db, input = {}, userId) {
  for (const f of ['id', 'project', 'tags', 'type', 'date', 'summary', 'content']) {
    if (!input[f]) throw new Error(`Missing required field: ${f}`);
  }
  const { id, project, client, tags, type, date, summary, content } = input;
  if (!DOC_ID.test(String(id))) throw new Error('id must be kebab-case letters, numbers, dots, dashes or underscores.');
  if (!DOC_TYPES.includes(type)) throw new Error(`type must be one of: ${DOC_TYPES.join(', ')}`);
  if (!Array.isArray(tags) || tags.some(t => typeof t !== 'string')) throw new Error('tags must be an array of strings');
  if (String(summary).length > LIMITS.summaryChars) throw new Error(`summary is limited to ${LIMITS.summaryChars} characters.`);
  if (String(content).length > LIMITS.docChars) throw new Error(`content is limited to ${LIMITS.docChars} characters.`);

  const [writable, existing] = await db.batch([
    db.prepare("SELECT value FROM meta WHERE key = 'writable'"),
    db.prepare(`SELECT 1 FROM docs WHERE snap = ${SNAP} AND id = ?1`).bind(String(id)),
  ]);
  let projects = [];
  try { projects = JSON.parse(writable.results[0]?.value || '{}').deep_projects || []; } catch { /* none */ }
  if (!projects.includes(project)) {
    throw new Error(`"${project}" is not a project in this memory's work scope. Use one of: ${projects.join(', ')}`);
  }
  if (existing.results.length) throw new Error(`A document with id "${id}" already exists. Writes here only add; pick a new id.`);
  await underDailyCap(db, 1);

  const meta = { id: String(id), project, ...(client && { client: String(client) }), tags, type, date: String(date), summary: String(summary) };
  const text = String(content);
  const parts = [];
  for (let i = 0; i < text.length; i += CHUNK_CHARS) parts.push(text.slice(i, i + CHUNK_CHARS));
  await db.batch([
    db.prepare(`INSERT INTO docs (snap, ord, id, project, client, type, date, summary, tags, meta, chunks)
                VALUES (${SNAP}, (SELECT coalesce(max(ord), -1) + 1 FROM docs WHERE snap = ${SNAP}), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`)
      .bind(meta.id, project, meta.client ?? null, type, meta.date, meta.summary, JSON.stringify(tags), JSON.stringify(meta), parts.length),
    ...parts.map((p, seq) => db.prepare(`INSERT INTO doc_chunks (snap, id, seq, text) VALUES (${SNAP}, ?1, ?2, ?3)`).bind(meta.id, seq, p)),
    db.prepare("INSERT INTO pending (ts, user_id, tool, target, payload) VALUES (?1, ?2, 'aim_deep_store', ?3, ?4)")
      .bind(new Date().toISOString(), userId ?? null, meta.id, JSON.stringify({ ...meta, content: text })),
  ]);
  return { success: true, id: meta.id, note: 'Saved. It reaches your Macs on their next memory sync (about 15 minutes).' };
}
