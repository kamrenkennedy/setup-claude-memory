// Kam Memory — bounded-read core
// Part of setup-claude-memory
//
// The read half of the search-first knowledge graph, with no filesystem in it. The
// local stdio server (bin/memory-server.mjs) and the remote Worker (worker/) both
// shape their responses here, so a client gets the same JSON from either one.
//
// The local server hands over a whole graph. The Worker cannot afford to load one
// per request, so it queries D1 for exactly the rows a response needs and hands over
// those. That is why search and get are split into "candidates" (where the rows came
// from) and "shape" (what the client sees).

// Every read path is bounded so no single entity can flood a context window. All are
// overridable per call.
export const DEFAULTS = {
  searchPerEntity: 10,     // matching observations returned per entity
  searchTotal: 60,         // matching observations returned overall
  getRecent: 30,           // observations returned by aim_memory_get, newest-last
  maxChars: 20000,         // hard character ceiling on any single response
};

export function clampNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Fit a response to a character budget by REDUCING THE DATA and re-rendering, never
// by cutting the rendered string — a JSON response sliced mid-string is unparseable,
// which is worse than the flood it was meant to prevent.
//
// `build(allowance)` returns the response object for a given per-entity observation
// allowance (Infinity = everything); `render` turns it into the wire format.
const ALLOWANCE_LADDER = [200, 100, 50, 30, 20, 10, 5, 3, 1, 0];

export function fitToBudget(build, render, maxChars, note) {
  let out = render(build(Infinity));
  if (out.length <= maxChars) return out;
  for (const allowance of ALLOWANCE_LADDER) {
    const obj = build(allowance);
    if (obj && typeof obj === 'object') {
      obj.budget_truncated = true;
      obj.budget_note = `Response exceeded ${maxChars} characters, so observations were reduced to ${allowance} per entity. ${note}`;
    }
    out = render(obj);
    if (out.length <= maxChars) return out;
  }
  return out; // even at zero observations — emit valid output rather than garbage
}

// Cap the observations on each entity of a plain graph, preserving the newest.
export function capGraph(graph, allowance) {
  if (allowance === Infinity) return graph;
  return {
    entities: graph.entities.map(e => {
      const take = allowance === 0 ? [] : e.observations.slice(-allowance);
      return {
        name: e.name,
        entityType: e.entityType,
        total_observations: e.observations.length,
        returned_observations: take.length,
        omitted_older: e.observations.length - take.length,
        observations: take,
      };
    }),
    relations: graph.relations,
  };
}

export function relationsAmong(relations, names) {
  const set = new Set(names);
  return relations.filter(r => set.has(r.from) && set.has(r.to));
}

// ─── Search ──────────────────────────────────────────────────────────────────

// One candidate per entity that matched, in store order:
//   { name, entityType, total, nameHit, typeHit, hitCount, hits, tail }
// `hits` holds at least the first per_entity matching observations as {index, text};
// `hitCount` is how many matched in all. `tail(n)` returns the newest n observations,
// used when only the name or type matched.
export function searchCandidates(graph, query) {
  const q = String(query).toLowerCase();
  const out = [];
  for (const e of graph.entities) {
    const nameHit = e.name.toLowerCase().includes(q);
    const typeHit = (e.entityType || '').toLowerCase().includes(q);
    const hits = [];
    e.observations.forEach((o, i) => {
      if (o.toLowerCase().includes(q)) hits.push({ index: i, text: o });
    });
    if (!nameHit && !typeHit && hits.length === 0) continue;
    const len = e.observations.length;
    out.push({
      name: e.name,
      entityType: e.entityType,
      total: len,
      nameHit,
      typeHit,
      hitCount: hits.length,
      hits,
      tail: n => e.observations.slice(-n).map((text, i) => ({ index: len - Math.min(n, len) + i, text })),
    });
  }
  return out;
}

// Search returns MATCHING OBSERVATIONS, never a whole entity. This is the fix.
export function shapeSearch(query, candidates, relations, opts = {}) {
  const perEntity = clampNumber(opts.per_entity, DEFAULTS.searchPerEntity);
  const total = clampNumber(opts.limit, DEFAULTS.searchTotal);

  const matches = [];
  let returned = 0;
  let entitiesWithMatches = 0;

  for (const c of candidates) {
    entitiesWithMatches++;
    const room = Math.max(0, total - returned);
    // A name/type hit with no matching observation still deserves a sample, so the
    // caller can see what the entity is without pulling all of it.
    const source = c.hitCount ? c.hits : c.tail(perEntity);
    const take = source.slice(0, Math.min(perEntity, room));
    returned += take.length;

    matches.push({
      name: c.name,
      entityType: c.entityType,
      matched_on: c.hitCount ? 'observations' : (c.nameHit ? 'name' : 'type'),
      total_observations: c.total,
      matching_observations: c.hitCount,
      returned_observations: take.length,
      observations: take,
    });
    if (returned >= total) break;
  }

  return {
    query,
    entities_matched: entitiesWithMatches,
    entities_returned: matches.length,
    observations_returned: returned,
    truncated: entitiesWithMatches > matches.length || matches.some(m => m.returned_observations < m.matching_observations),
    hint: 'Only matching observations are returned. Narrow the query, or use aim_memory_get with full:true for one entity.',
    matches,
    relations: relationsAmong(relations, matches.map(m => m.name)),
  };
}

// Takes an already-loaded graph so the budget loop can re-run it without re-reading.
export function searchNodes(graph, query, opts = {}) {
  return shapeSearch(query, searchCandidates(graph, query), graph.relations, opts);
}

// ─── Get ─────────────────────────────────────────────────────────────────────

// `found` entities carry their observations, newest last: all of them, or at least
// the newest `recent` when `total` says how many exist.
export function shapeGet(found, relations, opts = {}) {
  const full = opts.full === true || opts.full === 'true';
  const recent = clampNumber(opts.recent, DEFAULTS.getRecent);

  const entities = found.map(({ total, ...e }) => {
    const count = total ?? e.observations.length;
    if (full) return { ...e, total_observations: count, returned_observations: e.observations.length };
    const take = e.observations.slice(-recent);
    return {
      name: e.name,
      entityType: e.entityType,
      total_observations: count,
      returned_observations: take.length,
      omitted_older: Math.max(0, count - take.length),
      observations: take,
    };
  });

  const omitted = entities.reduce((n, e) => n + (e.omitted_older || 0), 0);
  return {
    entities,
    relations: relationsAmong(relations, found.map(e => e.name)),
    ...(omitted > 0 && {
      note: `${omitted} older observation(s) not shown. Use aim_memory_search to find specific ones, or full:true to load everything.`,
    }),
  };
}

// Get returns the most recent slice of an entity unless full is requested.
export function openNodes(graph, names, opts = {}) {
  const found = graph.entities.filter(e => (names || []).includes(e.name));
  return shapeGet(found, graph.relations, opts);
}

// ─── Pretty formats ──────────────────────────────────────────────────────────

export function formatGraphPretty(graph, context) {
  const lines = [`=== ${context || 'default'} database ===`, ''];
  if (!graph.entities.length) lines.push('ENTITIES: (none)');
  else {
    lines.push(`ENTITIES (${graph.entities.length}):`);
    for (const e of graph.entities) {
      const count = e.total_observations !== undefined
        ? ` — showing ${e.returned_observations}/${e.total_observations}` : '';
      lines.push(`  ${e.name} [${e.entityType}]${count}`);
      for (const o of e.observations) lines.push(`    - ${typeof o === 'string' ? o : o.text}`);
    }
  }
  lines.push('');
  if (!graph.relations.length) lines.push('RELATIONS: (none)');
  else {
    lines.push(`RELATIONS (${graph.relations.length}):`);
    for (const r of graph.relations) lines.push(`  ${r.from} --${r.relationType}--> ${r.to}`);
  }
  if (graph.note) lines.push('', graph.note);
  return lines.join('\n');
}

export function formatSearchPretty(result) {
  const lines = [`=== search: "${result.query}" ===`, ''];
  if (!result.matches.length) return lines.concat('No matches.').join('\n');
  lines.push(`${result.entities_matched} entit${result.entities_matched === 1 ? 'y' : 'ies'} matched; showing ${result.observations_returned} observation(s).`, '');
  for (const m of result.matches) {
    lines.push(`${m.name} [${m.entityType}] — ${m.returned_observations}/${m.matching_observations} matching of ${m.total_observations} total (matched on ${m.matched_on})`);
    for (const o of m.observations) lines.push(`    [${o.index}] ${o.text}`);
    lines.push('');
  }
  if (result.relations.length) {
    lines.push(`RELATIONS (${result.relations.length}):`);
    for (const r of result.relations) lines.push(`  ${r.from} --${r.relationType}--> ${r.to}`);
  }
  if (result.truncated) lines.push('', result.hint);
  return lines.join('\n');
}
