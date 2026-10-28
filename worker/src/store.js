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
