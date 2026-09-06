// Kam Memory — `npx setup-claude-memory@latest --compact`
// Part of setup-claude-memory
//
// Proposes observations to ARCHIVE, never to delete. Moves go to `<Entity>_Archive`
// and stay searchable; with the store in git, every pass is also a revertable commit.
//
// WHAT THIS IS AND IS NOT
//
// This does not solve growth. Measured 2026-09-06: conservative rules find ~76K of
// archivable material in Content_Strategy_App, which grew 523K in the preceding seven
// days. Compaction reclaims roughly 15% of one week — the same race four manual passes
// already lost. The write-path feedback in the memory server is the actual fix; this
// improves SIGNAL, by getting finished status noise out of the way of durable facts.
//
// WHY THE RULES ARE NARROW
//
// The 2026-08-30 hand triage measured a 44% false-move rate when ruling on 150-char
// prefixes, and found only 35% of a dated block genuinely disposable. So "it has a date
// on it" is NOT a rule here. Each rule below names a specific, checkable shape of
// finished work, and every candidate is shown in full before anything moves.

const ARCHIVE_SUFFIX = '_Archive';

// Each rule: a finished unit of work whose outcome is recorded elsewhere or is inert.
const RULES = [
  {
    id: 'superseded',
    label: 'Explicitly superseded or obsolete',
    why: 'The observation says so itself.',
    test: o => /\b(SUPERSEDED|OBSOLETE|NO LONGER (TRUE|ACCURATE|APPLIES)|now moot|STALE —)\b/i.test(o),
  },
  {
    id: 'pr-status',
    label: 'Per-PR / per-checkpoint status reaching a final state',
    why: 'A unit of work that reached a state on a date. The durable outcome is the code.',
    test: o => /^(CP\d|PR #?\d|#\d+\b).{0,60}\b(REVIEWED|VERIFIED|MERGED|SHIPPED|DONE|COMPLETE|PUSHED|LANDED)\b/i.test(o),
  },
  {
    id: 'rollout-log',
    label: 'Step-by-step rollout log',
    why: 'Progress through a sequence that has since finished.',
    test: o => /\bSTEP \d+ OF \d+\b/i.test(o),
  },
  {
    id: 'wrap-pointer',
    label: 'Session-wrap pointer whose narrative lives in a deep-context doc',
    why: 'The narrative is in the archive doc it names; this is a duplicate index entry.',
    test: o => /(session (wrap|summary)\b)/i.test(o) && /deep context/i.test(o),
  },
  {
    id: 'archived-already',
    label: 'Verbatim duplicate of something already in the archive entity',
    why: 'Already preserved. Removing the source copy loses nothing.',
    test: () => false, // handled specially — needs the archive entity
  },
];

// Distinctive tokens worth not losing: identifiers, paths, shas, quoted names.
function distinctiveTokens(text) {
  const out = new Set();
  const patterns = [
    /`([^`]{3,60})`/g,                       // backticked identifiers and paths
    /\b([A-Za-z0-9_-]+\.(?:swift|ts|tsx|js|mjs|json|md|toml|yml))\b/g,
    /\b([0-9a-f]{7,40})\b/g,                 // commit shas
    /\b([A-Z][A-Za-z0-9]*(?:_[A-Z][A-Za-z0-9]*)+)\b/g, // SCREAMING_SNAKE / Mixed_Snake
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const t = m[1].trim();
      // Pure dates and tiny tokens are not distinctive.
      if (t.length >= 5 && !/^\d{4}-\d{2}-\d{2}$/.test(t)) out.add(t);
    }
  }
  return [...out];
}

// The check that earned its keep in the hand triage: it flipped 5 of 38 "orphans" back
// to KEEP. A candidate whose distinctive tokens appear NOWHERE else is the last copy of
// something, whatever a rule thinks.
function findOrphanTokens(candidateText, survivingTexts) {
  const tokens = distinctiveTokens(candidateText);
  if (!tokens.length) return [];
  const haystack = survivingTexts.join('\n');
  return tokens.filter(t => !haystack.includes(t));
}

function proposeCompaction(graph, entityName) {
  const entity = graph.entities.find(e => e.name === entityName);
  if (!entity) throw new Error(`Entity not found: ${entityName}`);
  const archive = graph.entities.find(e => e.name === entityName + ARCHIVE_SUFFIX);
  const archived = new Set(archive ? archive.observations : []);

  const matchedBy = new Map(); // observation -> rule
  for (const obs of entity.observations) {
    if (archived.has(obs)) { matchedBy.set(obs, RULES.find(r => r.id === 'archived-already')); continue; }
    const rule = RULES.find(r => r.test(obs));
    if (rule) matchedBy.set(obs, rule);
  }

  // What would remain if every candidate moved — the orphan check runs against that.
  const surviving = entity.observations.filter(o => !matchedBy.has(o));
  const survivingPlusArchive = surviving.concat([...archived]);

  const candidates = [];
  for (const [obs, rule] of matchedBy) {
    const orphans = findOrphanTokens(obs, survivingPlusArchive);
    candidates.push({
      text: obs,
      rule: rule.id,
      ruleLabel: rule.label,
      why: rule.why,
      chars: obs.length,
      orphanTokens: orphans,
      // Anything holding the last copy of a distinctive token needs a human look,
      // regardless of which rule matched it.
      needsReview: orphans.length > 0,
    });
  }

  const groups = {};
  for (const c of candidates) {
    (groups[c.rule] = groups[c.rule] || { rule: c.rule, label: c.ruleLabel, why: c.why, items: [], chars: 0 });
    groups[c.rule].items.push(c);
    groups[c.rule].chars += c.chars;
  }

  return {
    entity: entityName,
    archiveEntity: entityName + ARCHIVE_SUFFIX,
    totalObservations: entity.observations.length,
    totalChars: entity.observations.reduce((n, o) => n + o.length, 0),
    candidates,
    groups: Object.values(groups).sort((a, b) => b.chars - a.chars),
    proposedChars: candidates.reduce((n, c) => n + c.chars, 0),
    needsReviewCount: candidates.filter(c => c.needsReview).length,
  };
}

// Move approved observations into the archive entity. Nothing is deleted: an approved
// text leaves the source ONLY once it is present in the archive.
function applyCompaction(graph, entityName, approvedTexts) {
  const entity = graph.entities.find(e => e.name === entityName);
  if (!entity) throw new Error(`Entity not found: ${entityName}`);
  const archiveName = entityName + ARCHIVE_SUFFIX;
  let archive = graph.entities.find(e => e.name === archiveName);
  if (!archive) {
    archive = { name: archiveName, entityType: entity.entityType, observations: [] };
    graph.entities.push(archive);
  }

  const approved = new Set(approvedTexts);
  const present = new Set(archive.observations);
  let moved = 0;

  for (const text of entity.observations) {
    if (!approved.has(text)) continue;
    if (!present.has(text)) { archive.observations.push(text); present.add(text); }
    moved++;
  }
  entity.observations = entity.observations.filter(o => !approved.has(o));

  // Refuse to hand back a graph that lost anything.
  for (const text of approved) {
    if (!present.has(text)) throw new Error('an approved observation is missing from the archive — aborting');
  }
  return { moved, archiveEntity: archiveName, archiveTotal: archive.observations.length };
}

module.exports = { RULES, ARCHIVE_SUFFIX, distinctiveTokens, findOrphanTokens, proposeCompaction, applyCompaction };
