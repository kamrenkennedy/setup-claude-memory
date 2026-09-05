// Tests for bin/memory-merge-driver.mjs — the semantic merge for memory JSONL.
//
//   npm run test:merge
//
// Half of these drive the driver directly; the rest run REAL `git merge` in a
// throwaway repo with the driver registered, because "the function returns the
// right array" and "git actually resolves the conflict" are different claims.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.join(__dirname, '..', 'bin', 'memory-merge-driver.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

const MARKER = '{"type":"_aim","source":"mcp-knowledge-graph"}';
const ent = (name, observations, entityType = 'project') =>
  JSON.stringify({ type: 'entity', name, entityType, observations });
const rel = (from, to, relationType) =>
  JSON.stringify({ type: 'relation', from, to, relationType });
const store = (...lines) => [MARKER, ...lines].join('\n');

function runDriver(base, ours, theirs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-merge-'));
  const p = n => path.join(dir, n);
  if (base !== null) fs.writeFileSync(p('base'), base);
  fs.writeFileSync(p('ours'), ours);
  fs.writeFileSync(p('theirs'), theirs);
  const r = spawnSync('node', [DRIVER, p('base'), p('ours'), p('theirs'), 'memory.jsonl'], { encoding: 'utf8' });
  const result = fs.existsSync(p('ours')) ? fs.readFileSync(p('ours'), 'utf8') : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: result, stderr: r.stderr };
}

const parse = text => text.split('\n').filter(Boolean).slice(1).map(JSON.parse);
const entityNamed = (text, name) => parse(text).find(x => x.type === 'entity' && x.name === name);

// ─── 1. Both sides add observations to the same entity ───────────────────────
console.log('\n=== 1. Concurrent additions to one entity — the common case ===');
{
  const base   = store(ent('Proj', ['a']));
  const ours   = store(ent('Proj', ['a', 'from-kam']));
  const theirs = store(ent('Proj', ['a', 'from-tiera']));
  const { code, out } = runDriver(base, ours, theirs);
  const e = entityNamed(out, 'Proj');
  ok('exits 0', code === 0, `code=${code}`);
  ok('keeps both additions', JSON.stringify(e.observations) === JSON.stringify(['a', 'from-kam', 'from-tiera']),
     JSON.stringify(e.observations));
  ok('produces exactly ONE line for the entity', parse(out).filter(x => x.name === 'Proj').length === 1);
}

// ─── 2. This is what union merge gets wrong ──────────────────────────────────
console.log('\n=== 2. Union merge would duplicate the entity — we must not ===');
{
  const base   = store(ent('Proj', ['a']));
  const ours   = store(ent('Proj', ['a', 'x']));
  const theirs = store(ent('Proj', ['a', 'y']));
  const { out } = runDriver(base, ours, theirs);
  const names = parse(out).filter(x => x.type === 'entity').map(x => x.name);
  ok('one entity line, not two', names.length === 1, JSON.stringify(names));
  ok('and no observation lost', entityNamed(out, 'Proj').observations.length === 3);
}

// ─── 3. Deliberate removals are honoured, not resurrected ────────────────────
console.log('\n=== 3. A removal on one side is honoured ===');
{
  const base   = store(ent('Proj', ['keep', 'stale']));
  const ours   = store(ent('Proj', ['keep']));               // we pruned 'stale'
  const theirs = store(ent('Proj', ['keep', 'stale', 'new'])); // they only added
  const { out } = runDriver(base, ours, theirs);
  const obs = entityNamed(out, 'Proj').observations;
  ok('removed observation stays removed', !obs.includes('stale'), JSON.stringify(obs));
  ok('their new observation still arrives', obs.includes('new'));
}

// ─── 4. The archival move — the pattern this project actually uses ───────────
console.log('\n=== 4. An archival move survives (remove from A, add to B) ===');
{
  const base   = store(ent('Proj', ['durable', 'dated-status']), ent('Proj_Archive', []));
  const ours   = store(ent('Proj', ['durable']), ent('Proj_Archive', ['dated-status']));
  const theirs = store(ent('Proj', ['durable', 'dated-status', 'live-note']), ent('Proj_Archive', []));
  const { out } = runDriver(base, ours, theirs);
  const proj = entityNamed(out, 'Proj').observations;
  const arch = entityNamed(out, 'Proj_Archive').observations;
  ok('moved observation is gone from the source', !proj.includes('dated-status'), JSON.stringify(proj));
  ok('and present in the archive', arch.includes('dated-status'), JSON.stringify(arch));
  ok('concurrent live note is preserved', proj.includes('live-note'));
}

// ─── 5. Entity add / delete ──────────────────────────────────────────────────
console.log('\n=== 5. Entity-level add and delete ===');
{
  const base   = store(ent('A', ['1']));
  const ours   = store(ent('A', ['1']), ent('B', ['new-on-ours']));
  const theirs = store(ent('A', ['1']), ent('C', ['new-on-theirs']));
  const { out } = runDriver(base, ours, theirs);
  const names = parse(out).filter(x => x.type === 'entity').map(x => x.name);
  ok('both new entities survive', names.includes('B') && names.includes('C'), JSON.stringify(names));
}
{
  const base   = store(ent('A', ['1']), ent('Gone', ['x']));
  const ours   = store(ent('A', ['1']));                       // we deleted Gone
  const theirs = store(ent('A', ['1', 'more']), ent('Gone', ['x']));
  const { out } = runDriver(base, ours, theirs);
  const names = parse(out).filter(x => x.type === 'entity').map(x => x.name);
  ok('a deleted entity is not resurrected', !names.includes('Gone'), JSON.stringify(names));
  ok('unrelated concurrent edit still lands', entityNamed(out, 'A').observations.includes('more'));
}

// ─── 6. Identical edits on both sides must not duplicate ─────────────────────
console.log('\n=== 6. The same observation added on both sides appears once ===');
{
  const base   = store(ent('Proj', ['a']));
  const same   = store(ent('Proj', ['a', 'same-text']));
  const { out } = runDriver(base, same, same);
  ok('deduped', entityNamed(out, 'Proj').observations.filter(o => o === 'same-text').length === 1);
}

// ─── 7. Relations ────────────────────────────────────────────────────────────
console.log('\n=== 7. Relations merge by triple ===');
{
  const base   = store(ent('A', []), ent('B', []), rel('A', 'B', 'uses'));
  const ours   = store(ent('A', []), ent('B', []), rel('A', 'B', 'uses'), rel('A', 'B', 'owns'));
  const theirs = store(ent('A', []), ent('B', []), rel('A', 'B', 'uses'), rel('B', 'A', 'feeds'));
  const { out } = runDriver(base, ours, theirs);
  const rels = parse(out).filter(x => x.type === 'relation');
  ok('both new relations survive', rels.length === 3, JSON.stringify(rels.map(r => r.relationType)));
}

// ─── 8. Output format must match the server's serializer ─────────────────────
console.log('\n=== 8. Output is a valid store the server can load ===');
{
  const base = store(ent('Proj', ['a']));
  const { out } = runDriver(base, store(ent('Proj', ['a', 'x'])), store(ent('Proj', ['a', 'y'])));
  ok('first line is the _aim marker', out.split('\n')[0] === MARKER);
  ok('no trailing newline (matches the server)', !out.endsWith('\n'));
  ok('every line parses', out.split('\n').filter(Boolean).every(l => { try { JSON.parse(l); return true; } catch { return false; } }));
  const keys = Object.keys(JSON.parse(out.split('\n')[1]));
  ok('entity key order matches the server', JSON.stringify(keys) === JSON.stringify(['type', 'name', 'entityType', 'observations']),
     JSON.stringify(keys));
}

// ─── 9. Refuses rather than corrupts ─────────────────────────────────────────
console.log('\n=== 9. Refuses to merge anything that is not a memory store ===');
{
  const good = store(ent('Proj', ['a']));
  const bad  = '{"type":"entity","name":"NoMarker"}';
  const r = runDriver(good, bad, good);
  ok('exits non-zero on a missing _aim marker', r.code !== 0, `code=${r.code}`);
  ok('leaves the file untouched', r.out === bad);
  const r2 = runDriver(good, store('{not json'), good);
  ok('exits non-zero on malformed JSON', r2.code !== 0, `code=${r2.code}`);
}

// ─── 10. Missing base (both branches created the file) ───────────────────────
console.log('\n=== 10. Both sides created the file independently ===');
{
  const r = runDriver(null, store(ent('A', ['ours'])), store(ent('B', ['theirs'])));
  ok('still merges', r.code === 0, `code=${r.code} ${r.stderr}`);
  const names = parse(r.out).filter(x => x.type === 'entity').map(x => x.name);
  ok('keeps both entities', names.includes('A') && names.includes('B'), JSON.stringify(names));
}

// ─── 11. REAL git merge, driver registered ───────────────────────────────────
console.log('\n=== 11. A real `git merge` resolves with no conflict ===');
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-git-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  const write = text => fs.writeFileSync(path.join(repo, 'memory.jsonl'), text);

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@test');
  git('config', 'user.name', 'Test');
  git('config', 'merge.aim-memory.name', 'AIM semantic merge');
  git('config', 'merge.aim-memory.driver', `node '${DRIVER}' %O %A %B %P`); // quoted — the path can contain spaces
  fs.writeFileSync(path.join(repo, '.gitattributes'), 'memory*.jsonl merge=aim-memory\n');

  write(store(ent('Proj', ['base-fact'])));
  git('add', '-A'); git('commit', '-qm', 'base');

  git('checkout', '-qb', 'other');
  write(store(ent('Proj', ['base-fact', 'tiera-fact'])));
  git('commit', '-qam', 'tiera writes');

  git('checkout', '-q', 'main');
  write(store(ent('Proj', ['base-fact', 'kam-fact'])));
  git('commit', '-qam', 'kam writes');

  const merge = spawnSync('git', ['-C', repo, 'merge', 'other', '-m', 'merge'], { encoding: 'utf8' });
  const text = fs.readFileSync(path.join(repo, 'memory.jsonl'), 'utf8');

  ok('git merge exits 0', merge.status === 0, `${merge.stdout}${merge.stderr}`);
  ok('no conflict markers in the file', !text.includes('<<<<<<<') && !text.includes('>>>>>>>'));
  const obs = entityNamed(text, 'Proj').observations;
  ok('both machines\' facts survived', obs.includes('kam-fact') && obs.includes('tiera-fact'), JSON.stringify(obs));
  ok('still one entity line', parse(text).filter(x => x.type === 'entity').length === 1);
  ok('working tree is clean after merge', git('status', '--porcelain').trim() === '');

  fs.rmSync(repo, { recursive: true, force: true });
}

// ─── 12. Real git merge that SHOULD refuse ───────────────────────────────────
console.log('\n=== 12. A corrupt side leaves a real conflict rather than silent damage ===');
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-git-bad-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  const write = text => fs.writeFileSync(path.join(repo, 'memory.jsonl'), text);

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@test');
  git('config', 'user.name', 'Test');
  git('config', 'merge.aim-memory.name', 'AIM semantic merge');
  git('config', 'merge.aim-memory.driver', `node '${DRIVER}' %O %A %B %P`); // quoted — the path can contain spaces
  fs.writeFileSync(path.join(repo, '.gitattributes'), 'memory*.jsonl merge=aim-memory\n');

  write(store(ent('Proj', ['base'])));
  git('add', '-A'); git('commit', '-qm', 'base');

  git('checkout', '-qb', 'other');
  write('{"garbage": true}');                    // someone corrupted the store
  git('commit', '-qam', 'corrupt');

  git('checkout', '-q', 'main');
  write(store(ent('Proj', ['base', 'kam'])));
  git('commit', '-qam', 'kam writes');

  const merge = spawnSync('git', ['-C', repo, 'merge', 'other', '-m', 'merge'], { encoding: 'utf8' });
  const output = merge.stdout + merge.stderr;
  ok('git reports the conflict instead of merging', merge.status !== 0, `status=${merge.status}`);
  ok('and says which file', /memory\.jsonl/.test(output));
  // Assert it failed for the RIGHT reason. An earlier version of this test passed
  // because the driver could not even launch (unquoted path with a space), which
  // looks identical from git's side but proves nothing about the refusal logic.
  ok('the driver itself refused, rather than failing to launch',
     /refusing to merge/.test(output) && !/MODULE_NOT_FOUND|Cannot find module/.test(output),
     output.split('\n').slice(0, 3).join(' | '));

  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
