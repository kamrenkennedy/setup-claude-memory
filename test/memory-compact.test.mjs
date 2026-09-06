// Tests for bin/memory-compact.js — the staged archive pass.
//
//   npm run test:compact
//
// The governing constraint: nothing is ever deleted, and no observation leaves its
// entity unless it is provably present in the archive. A bug here loses memory
// permanently, which is worse than an entity being too big.

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const C = require(path.join(__dirname, '..', 'bin', 'memory-compact.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

const graphOf = (obs, archiveObs = null) => ({
  entities: [
    { name: 'Proj', entityType: 'project', observations: [...obs] },
    ...(archiveObs ? [{ name: 'Proj_Archive', entityType: 'project', observations: [...archiveObs] }] : []),
  ],
  relations: [],
});

// ─── 1. Which rules fire ─────────────────────────────────────────────────────
console.log('\n=== 1. Rules match finished work, and only that ===');
{
  const obs = [
    'CP4 VERIFIED AND FEATURE COMPLETE 2026-08-29 (#112) — recommended for merge.',
    'PR #86 poll fix MERGED — returns on the isInitialized value.',
    'STEP 2 OF 4 rollout: enabled the flag for internal testers.',
    'This behaviour is SUPERSEDED by the new gate added in August.',
    'Session wrap 2026-08-30 — narrative in deep context `some-doc`.',
    // Durable facts that must NOT be proposed:
    'Kam ruled that five events is the cap, and rejected the ten-event variant.',
    'The reclaim endpoint returns 401 when the flag is off, not 503.',
    'Testers are alex@example.com and sam@example.com.',
  ];
  const p = C.proposeCompaction(graphOf(obs), 'Proj');
  const proposed = new Set(p.candidates.map(c => c.text));

  ok('checkpoint status proposed', proposed.has(obs[0]));
  ok('merged PR status proposed', proposed.has(obs[1]));
  ok('rollout log proposed', proposed.has(obs[2]));
  ok('explicitly superseded proposed', proposed.has(obs[3]));
  ok('session-wrap pointer proposed', proposed.has(obs[4]));

  ok('a ruling is NOT proposed', !proposed.has(obs[5]));
  ok('a code fact is NOT proposed', !proposed.has(obs[6]));
  ok('identifiers are NOT proposed', !proposed.has(obs[7]));
  ok('total proposed = 5', p.candidates.length === 5, `${p.candidates.length}`);
}

// ─── 2. "Has a date" is deliberately NOT a rule ──────────────────────────────
console.log('\n=== 2. A date alone never makes something archivable ===');
{
  const obs = [
    '2026-08-30: Kam ruled the archive entity keeps everything, nothing is deleted.',
    '2026-08-29: the iOS build needs the entitlement or the share sheet silently fails.',
  ];
  const p = C.proposeCompaction(graphOf(obs), 'Proj');
  ok('dated durable facts are left alone', p.candidates.length === 0,
     JSON.stringify(p.candidates.map(c => c.rule)));
}

// ─── 3. The orphan check ─────────────────────────────────────────────────────
console.log('\n=== 3. Last copy of a distinctive token is flagged for review ===');
{
  // The status line is the ONLY place ConflictQuarantine.swift appears.
  const lonely = 'CP2 VERIFIED 2026-08-01 — added `ConflictQuarantine.swift` and its repair path.';
  const p1 = C.proposeCompaction(graphOf([lonely, 'Unrelated durable fact about pricing.']), 'Proj');
  ok('flagged when its token appears nowhere else', p1.candidates[0].needsReview === true,
     JSON.stringify(p1.candidates[0].orphanTokens));
  ok('and names the orphaned token', p1.candidates[0].orphanTokens.some(t => /ConflictQuarantine/.test(t)),
     JSON.stringify(p1.candidates[0].orphanTokens));

  // Same line, but the identifier survives in a durable observation.
  const p2 = C.proposeCompaction(graphOf([
    lonely,
    'Conflicts are quarantined by `ConflictQuarantine.swift`, which repairs on next boot.',
  ]), 'Proj');
  ok('not flagged once the token survives elsewhere', p2.candidates[0].needsReview === false,
     JSON.stringify(p2.candidates[0].orphanTokens));
}

// ─── 4. Verbatim duplicates of the archive ───────────────────────────────────
console.log('\n=== 4. Something already in the archive is safe to drop from the source ===');
{
  const dupe = 'Some finished note that was already archived last month.';
  const p = C.proposeCompaction(graphOf([dupe, 'A live fact.'], [dupe]), 'Proj');
  ok('proposed under archived-already', p.candidates.some(c => c.rule === 'archived-already'),
     JSON.stringify(p.candidates.map(c => c.rule)));
}

// ─── 5. Applying: nothing is ever lost ───────────────────────────────────────
console.log('\n=== 5. Apply moves, never deletes ===');
{
  const keep = 'Kam ruled X. Durable.';
  const move1 = 'CP1 MERGED 2026-08-01 — done.';
  const move2 = 'STEP 1 OF 3 rollout note.';
  const g = graphOf([keep, move1, move2]);

  const before = g.entities[0].observations.length;
  const r = C.applyCompaction(g, 'Proj', [move1, move2]);
  const src = g.entities.find(e => e.name === 'Proj');
  const arc = g.entities.find(e => e.name === 'Proj_Archive');

  ok('reports what it moved', r.moved === 2, `${r.moved}`);
  ok('source shrank by exactly that', src.observations.length === before - 2);
  ok('durable fact untouched', src.observations.includes(keep));
  ok('archive entity created', !!arc);
  ok('both moved items are IN the archive', arc.observations.includes(move1) && arc.observations.includes(move2));
  ok('nothing vanished overall',
     src.observations.length + arc.observations.length === before,
     `${src.observations.length}+${arc.observations.length} vs ${before}`);
}

// ─── 6. Re-running is safe ───────────────────────────────────────────────────
console.log('\n=== 6. Running twice does not duplicate or lose ===');
{
  const move = 'PR #12 SHIPPED — complete.';
  const g = graphOf(['Durable.', move]);
  C.applyCompaction(g, 'Proj', [move]);
  const arcAfter1 = g.entities.find(e => e.name === 'Proj_Archive').observations.length;
  C.applyCompaction(g, 'Proj', [move]);   // already gone from source
  const arc = g.entities.find(e => e.name === 'Proj_Archive');
  ok('archive not double-written', arc.observations.length === arcAfter1, `${arc.observations.length}`);
  ok('archive holds it exactly once', arc.observations.filter(o => o === move).length === 1);
}

// ─── 7. Approving something that is not a candidate still moves safely ───────
console.log('\n=== 7. Approval is authoritative, and still safe ===');
{
  const durable = 'A durable fact Kam chose to archive anyway.';
  const g = graphOf([durable, 'Another.']);
  C.applyCompaction(g, 'Proj', [durable]);
  const arc = g.entities.find(e => e.name === 'Proj_Archive');
  ok('a manually approved item is archived, not dropped', arc.observations.includes(durable));
  ok('and removed from the source', !g.entities[0].observations.includes(durable));
}

// ─── 8. Grouping for bulk approval ───────────────────────────────────────────
console.log('\n=== 8. Candidates group by rule so 169 items stay reviewable ===');
{
  const obs = [
    'CP1 MERGED — done.', 'CP2 MERGED — done.', 'PR #3 SHIPPED — done.',
    'STEP 1 OF 2 rollout.', 'Durable ruling from Kam.',
  ];
  const p = C.proposeCompaction(graphOf(obs), 'Proj');
  ok('groups are returned', p.groups.length >= 2, JSON.stringify(p.groups.map(g => g.rule)));
  ok('groups carry a char total', p.groups.every(g => typeof g.chars === 'number'));
  ok('every candidate belongs to a group',
     p.groups.reduce((n, g) => n + g.items.length, 0) === p.candidates.length);
  ok('each group explains itself', p.groups.every(g => typeof g.why === 'string' && g.why.length > 10));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
