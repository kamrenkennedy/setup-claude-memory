// Tests for bin/git-migrate.js — the --git migration's safety logic.
//
//   npm run test:git
//
// The location checks are the ones that matter most: putting a git repo inside a sync
// folder corrupts it silently, so a false "safe" here is unrecoverable rather than
// merely annoying.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawnSync } from 'child_process';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const M = require(path.join(__dirname, '..', 'bin', 'git-migrate.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};
const HOME = os.homedir();

// ─── 1. Sync folders are refused ─────────────────────────────────────────────
console.log('\n=== 1. A repo must never land in a sync folder ===');
{
  const cases = [
    ['iCloud Drive',        path.join(HOME, 'Library/Mobile Documents/com~apple~CloudDocs/Claude Memory'), /iCloud/i],
    ['Dropbox (branded)',   path.join(HOME, 'Library/CloudStorage/Dropbox-KamStudios,LLC/Aligned/mem'),    /Dropbox|CloudStorage/i],
    ['Dropbox (plain)',     path.join(HOME, 'Dropbox/mem'),                                                /Dropbox/i],
    ['CloudStorage (any)',  path.join(HOME, 'Library/CloudStorage/GoogleDrive-x/mem'),                     /CloudStorage|Dropbox/i],
  ];
  for (const [label, p, expect] of cases) {
    const r = M.unsafeRepoLocation(p, { syncedDesktopDocs: false });
    ok(`${label} → refused`, typeof r === 'string' && expect.test(r), `got: ${r}`);
  }
}

// ─── 2. The trap: Desktop & Documents iCloud sync ────────────────────────────
console.log('\n=== 2. ~/Documents is only unsafe when Desktop & Documents sync is ON ===');
{
  const docs = path.join(HOME, 'Documents', 'ClaudeMemory');
  const desk = path.join(HOME, 'Desktop', 'ClaudeMemory');

  ok('~/Documents refused when sync is on',
     /sync/i.test(M.unsafeRepoLocation(docs, { syncedDesktopDocs: true }) || ''));
  ok('~/Desktop refused when sync is on',
     /sync/i.test(M.unsafeRepoLocation(desk, { syncedDesktopDocs: true }) || ''));
  ok('~/Documents allowed when sync is off',
     M.unsafeRepoLocation(docs, { syncedDesktopDocs: false }) === null);
  // The whole point: nothing in the PATH reveals this. Only the probe does.
  ok('the difference is invisible from the path alone',
     M.unsafeRepoLocation(docs, { syncedDesktopDocs: true }) !== M.unsafeRepoLocation(docs, { syncedDesktopDocs: false }));
}

// ─── 3. Safe locations are allowed ───────────────────────────────────────────
console.log('\n=== 3. Safe locations pass ===');
{
  for (const p of [path.join(HOME, 'Developer/claude-memory'), path.join(HOME, 'ClaudeMemory')]) {
    ok(`${p.replace(HOME, '~')} → allowed`, M.unsafeRepoLocation(p, { syncedDesktopDocs: true }) === null,
       `${M.unsafeRepoLocation(p, { syncedDesktopDocs: true })}`);
  }
  ok('home directory itself → refused', typeof M.unsafeRepoLocation(HOME, {}) === 'string');
  ok('relative path → refused', typeof M.unsafeRepoLocation('some/where', {}) === 'string');
  ok('empty → refused', typeof M.unsafeRepoLocation('', {}) === 'string');
}

// ─── 4. Non-empty existing folders are refused ───────────────────────────────
console.log('\n=== 4. Will not adopt a non-empty folder ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-loc-'));
  ok('empty folder → allowed', M.unsafeRepoLocation(dir, { syncedDesktopDocs: false }) === null);
  fs.writeFileSync(path.join(dir, 'something.txt'), 'x');
  ok('non-empty folder → refused', /not empty/i.test(M.unsafeRepoLocation(dir, { syncedDesktopDocs: false }) || ''));
  fs.mkdirSync(path.join(dir, '.git'));
  ok('but an existing repo → allowed (re-run)', M.unsafeRepoLocation(dir, { syncedDesktopDocs: false }) === null);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── 5. Default location avoids the synced folders ───────────────────────────
console.log('\n=== 5. The default is itself safe ===');
{
  const d = M.defaultRepoLocation();
  ok(`default (${d.replace(HOME, '~')}) is a safe location`,
     M.unsafeRepoLocation(d, { syncedDesktopDocs: true }) === null || /not empty/.test(M.unsafeRepoLocation(d, {}) || ''),
     `${M.unsafeRepoLocation(d, { syncedDesktopDocs: true })}`);
}

// ─── 6. Copy integrity ───────────────────────────────────────────────────────
console.log('\n=== 6. The copy is verified byte-for-byte, not assumed ===');
{
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-src-'));
  fs.writeFileSync(path.join(src, 'memory.jsonl'), '{"type":"_aim","source":"mcp-knowledge-graph"}');
  fs.mkdirSync(path.join(src, 'deep'));
  fs.writeFileSync(path.join(src, 'deep', 'a.md'), 'hello');
  fs.writeFileSync(path.join(src, 'private.jsonl'), 'secret', { mode: 0o600 });

  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-dst-'));
  const hashes = M.fileHashes(src);
  M.copyTree(src, dest);

  const v = M.verifyCopy(hashes, dest);
  ok('every file matches', v.mismatched.length === 0 && v.checked === 3, JSON.stringify(v));
  ok('0600 mode is preserved', (fs.statSync(path.join(dest, 'private.jsonl')).mode & 0o777) === 0o600);

  // Corrupt one file and confirm verification actually catches it.
  fs.writeFileSync(path.join(dest, 'deep', 'a.md'), 'tampered');
  ok('a corrupted copy is detected', M.verifyCopy(hashes, dest).mismatched.includes('deep/a.md'));

  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(dest, { recursive: true, force: true });
}

// ─── 7. Merge driver registration survives a path with spaces ────────────────
console.log('\n=== 7. Merge driver is registered so a spaced path still works ===');
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-repo-'));
  const spaced = path.join(repo, 'dir with spaces');
  fs.mkdirSync(spaced);
  const driver = path.join(__dirname, '..', 'bin', 'memory-merge-driver.mjs');

  M.git(repo, ['init', '-q']);
  M.registerMergeDriver(repo, driver);
  const configured = M.git(repo, ['config', 'merge.aim-memory.driver']).trim();
  ok('driver path is quoted', configured.includes(`'${driver}'`), configured);

  // Prove it end-to-end: a real merge in a repo whose driver path contains a space.
  M.git(repo, ['config', 'user.email', 't@test']);
  M.git(repo, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(repo, '.gitattributes'), M.GITATTRIBUTES);
  const MK = '{"type":"_aim","source":"mcp-knowledge-graph"}';
  const ent = o => JSON.stringify({ type: 'entity', name: 'P', entityType: 'x', observations: o });
  const write = obs => fs.writeFileSync(path.join(repo, 'memory.jsonl'), [MK, ent(obs)].join('\n'));

  write(['base']);
  M.git(repo, ['add', '-A']); M.git(repo, ['commit', '-qm', 'base']);
  M.git(repo, ['checkout', '-qb', 'other']);
  write(['base', 'theirs']); M.git(repo, ['commit', '-qam', 'theirs']);
  M.git(repo, ['checkout', '-q', 'main'], { stdio: 'ignore' });
  write(['base', 'ours']); M.git(repo, ['commit', '-qam', 'ours']);

  const merged = spawnSync('git', ['-C', repo, 'merge', 'other', '-m', 'm'], { encoding: 'utf8' });
  ok('a real merge resolves cleanly', merged.status === 0, merged.stdout + merged.stderr);
  const text = fs.readFileSync(path.join(repo, 'memory.jsonl'), 'utf8');
  ok('both sides survived', text.includes('ours') && text.includes('theirs'));
  ok('no conflict markers', !text.includes('<<<<<<<'));

  fs.rmSync(repo, { recursive: true, force: true });
}

// ─── 8. gitignore excludes the backups that carry old secrets ────────────────
console.log('\n=== 8. Backups are excluded from the repo ===');
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-ig-'));
  M.git(repo, ['init', '-q']);
  fs.writeFileSync(path.join(repo, '.gitignore'), M.GITIGNORE);
  for (const f of ['memory.jsonl', 'memory.jsonl.bak-2026-01-01', 'memory.jsonl.backup-20260101T0000', '.DS_Store']) {
    fs.writeFileSync(path.join(repo, f), 'x');
  }
  const listed = M.git(repo, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
  ok('memory.jsonl is tracked', listed.includes('memory.jsonl'), JSON.stringify(listed));
  ok('.bak- backup excluded', !listed.some(f => f.includes('.bak-')), JSON.stringify(listed));
  ok('.backup- backup excluded', !listed.some(f => f.includes('.backup-')), JSON.stringify(listed));
  ok('.DS_Store excluded', !listed.includes('.DS_Store'));
  fs.rmSync(repo, { recursive: true, force: true });
}

// ─── 9. The bridge is a DIRECTORY symlink ────────────────────────────────────
console.log('\n=== 9. The cutover bridge ===');
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-bridge-'));
  const oldPath = path.join(base, 'Claude Memory');
  const newPath = path.join(base, 'repo');
  fs.mkdirSync(oldPath); fs.mkdirSync(newPath);
  fs.writeFileSync(path.join(oldPath, 'memory.jsonl'), 'old');
  fs.writeFileSync(path.join(newPath, 'memory.jsonl'), 'new');

  const parked = M.createBridge(oldPath, newPath);
  ok('original is parked, not deleted', fs.existsSync(parked) && fs.readFileSync(path.join(parked, 'memory.jsonl'), 'utf8') === 'old');
  ok('old path is now a symlink', fs.lstatSync(oldPath).isSymbolicLink());
  ok('reads through the bridge hit the repo', fs.readFileSync(path.join(oldPath, 'memory.jsonl'), 'utf8') === 'new');

  // A write through the bridge must land in the repo and leave the symlink intact —
  // this is what lets old-path and new-path sessions coexist during the cutover.
  fs.writeFileSync(path.join(oldPath, 'memory.jsonl'), 'written-through');
  ok('writes land in the repo', fs.readFileSync(path.join(newPath, 'memory.jsonl'), 'utf8') === 'written-through');
  ok('symlink not clobbered by the write', fs.lstatSync(oldPath).isSymbolicLink());

  fs.rmSync(base, { recursive: true, force: true });
}

// ─── 10. Background sync, end to end against a real remote ───────────────────
console.log('\n=== 10. Unattended sync survives a genuine concurrent edit ===');
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-sync-'));
  const bare = path.join(base, 'remote.git');
  const A = path.join(base, 'macA');
  const B = path.join(base, 'macB');
  const driver = path.join(__dirname, '..', 'bin', 'memory-merge-driver.mjs');
  const MK = '{"type":"_aim","source":"mcp-knowledge-graph"}';
  const ent = o => JSON.stringify({ type: 'entity', name: 'Proj', entityType: 'p', observations: o });

  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);  // match the branch A pushes

  const setup = (dir) => {
    M.git(dir, ['config', 'user.email', 't@test']);
    M.git(dir, ['config', 'user.name', 'T']);
    M.git(dir, ['config', 'pull.rebase', 'true']);
    M.registerMergeDriver(dir, driver);
  };

  // Machine A creates the store and pushes.
  fs.mkdirSync(A);
  M.git(A, ['init', '-q', '-b', 'main']);
  setup(A);
  fs.writeFileSync(path.join(A, '.gitattributes'), M.GITATTRIBUTES);
  fs.writeFileSync(path.join(A, 'memory.jsonl'), [MK, ent(['shared-base'])].join('\n'));
  M.git(A, ['add', '-A']); M.git(A, ['commit', '-qm', 'base']);
  M.git(A, ['remote', 'add', 'origin', bare]); M.git(A, ['push', '-qu', 'origin', 'main']);

  // Machine B clones.
  execFileSync('git', ['clone', '-q', bare, B]);
  setup(B);

  // Both write at once — the real scenario this whole system exists for.
  fs.writeFileSync(path.join(A, 'memory.jsonl'), [MK, ent(['shared-base', 'from-kam'])].join('\n'));
  fs.writeFileSync(path.join(B, 'memory.jsonl'), [MK, ent(['shared-base', 'from-tiera'])].join('\n'));

  // Scripts live OUTSIDE the repo, as they do in a real install — otherwise each
  // machine commits its own sync log and they conflict on files that are not memory.
  const runSync = (dir, tag) => {
    const script = path.join(base, `sync-${tag}.sh`);
    const log = path.join(base, `sync-${tag}.log`);
    fs.writeFileSync(script, M.syncScript(dir, log), { mode: 0o755 });
    const r = spawnSync('/bin/sh', [script], { encoding: 'utf8' });
    return { ...r, logText: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
  };

  const rA = runSync(A, 'A');
  ok('machine A syncs cleanly', rA.status === 0, rA.stderr);
  const rB = runSync(B, 'B');   // B must rebase over A's push, driver resolves
  ok('machine B syncs over A without a conflict', rB.status === 0,
     (rB.stderr || '') + rB.logText);

  // A pulls B's work back down.
  runSync(A, 'A');
  const finalA = fs.readFileSync(path.join(A, 'memory.jsonl'), 'utf8');
  ok('BOTH machines\' facts survived', finalA.includes('from-kam') && finalA.includes('from-tiera'), finalA);
  const entities = finalA.split('\n').filter(Boolean).slice(1).map(JSON.parse).filter(x => x.type === 'entity');
  ok('still exactly one entity line', entities.length === 1, JSON.stringify(entities.map(e => e.name)));
  ok('no conflict markers anywhere', !finalA.includes('<<<<<<<'));

  // A malformed store must stop the sync, not push damage.
  runSync(B, 'B');                  // bring B up to date first
  fs.writeFileSync(path.join(B, 'memory.jsonl'), '{"garbage":true}');
  M.git(B, ['add', '-A']); M.git(B, ['commit', '-qm', 'corrupt']); M.git(B, ['push', '-q']);
  fs.writeFileSync(path.join(A, 'memory.jsonl'), [MK, ent(['shared-base', 'from-kam', 'later'])].join('\n'));
  const rBad = runSync(A, 'A');
  ok('a malformed remote stops the sync instead of forcing', rBad.status !== 0, `status=${rBad.status}`);
  ok('and it says why in the log', /FAIL/.test(rBad.logText), rBad.logText);
  ok('local work is not lost', fs.readFileSync(path.join(A, 'memory.jsonl'), 'utf8').includes('later'));

  fs.rmSync(base, { recursive: true, force: true });
}

// ─── 11. Second machine: what a clone does NOT bring ─────────────────────────
console.log('\n=== 11. A clone does not carry the merge driver — the join must install it ===');
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-join-'));
  const bare = path.join(base, 'remote.git');
  const mac1 = path.join(base, 'mac1');
  const mac2 = path.join(base, 'mac2');
  const driver = path.join(__dirname, '..', 'bin', 'memory-merge-driver.mjs');
  const MK = '{"type":"_aim","source":"mcp-knowledge-graph"}';
  const ent = (n, o) => JSON.stringify({ type: 'entity', name: n, entityType: 'p', observations: o });

  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  fs.mkdirSync(mac1);
  M.git(mac1, ['init', '-q', '-b', 'main']);
  M.git(mac1, ['config', 'user.email', 't@t']); M.git(mac1, ['config', 'user.name', 'T']);
  M.registerMergeDriver(mac1, driver);
  fs.writeFileSync(path.join(mac1, '.gitattributes'), M.GITATTRIBUTES);
  fs.writeFileSync(path.join(mac1, 'memory.jsonl'), [MK, ent('P', ['base'])].join('\n'));
  M.git(mac1, ['add', '-A']); M.git(mac1, ['commit', '-qm', 'base']);
  M.git(mac1, ['remote', 'add', 'origin', bare]); M.git(mac1, ['push', '-qu', 'origin', 'main']);

  execFileSync('git', ['clone', '-q', bare, mac2]);
  const driverAfterClone = spawnSync('git', ['-C', mac2, 'config', 'merge.aim-memory.driver'], { encoding: 'utf8' });
  ok('.gitattributes DOES come with the clone', fs.existsSync(path.join(mac2, '.gitattributes')));
  ok('but the merge driver does NOT', driverAfterClone.status !== 0,
     'driver was unexpectedly present — the join step would be unnecessary');

  // What the join step does.
  M.registerMergeDriver(mac2, driver);
  ok('registering it on the second machine fixes that',
     spawnSync('git', ['-C', mac2, 'config', 'merge.aim-memory.driver'], { encoding: 'utf8' }).status === 0);

  // And now a real concurrent merge between the two machines resolves.
  M.git(mac2, ['config', 'user.email', 't@t']); M.git(mac2, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(mac1, 'memory.jsonl'), [MK, ent('P', ['base', 'from-mac1'])].join('\n'));
  M.git(mac1, ['commit', '-qam', 'mac1']); M.git(mac1, ['push', '-q']);
  fs.writeFileSync(path.join(mac2, 'memory.jsonl'), [MK, ent('P', ['base', 'from-mac2'])].join('\n'));
  M.git(mac2, ['commit', '-qam', 'mac2']);
  const pulled = spawnSync('git', ['-C', mac2, 'pull', '--rebase', '--autostash'], { encoding: 'utf8' });
  ok('the two machines then merge cleanly', pulled.status === 0, pulled.stdout + pulled.stderr);
  const text = fs.readFileSync(path.join(mac2, 'memory.jsonl'), 'utf8');
  ok('both machines\' facts survive', text.includes('from-mac1') && text.includes('from-mac2'));

  fs.rmSync(base, { recursive: true, force: true });
}

// ─── 12. The join reports memory the second Mac had but the repo did not ─────
console.log('\n=== 12. Unsynced local memory is reported, not silently parked ===');
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-div-'));
  const local = path.join(base, 'local');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(local); fs.mkdirSync(repo);
  const MK = '{"type":"_aim","source":"mcp-knowledge-graph"}';
  const ent = (n, o) => JSON.stringify({ type: 'entity', name: n, entityType: 'p', observations: o });

  fs.writeFileSync(path.join(local, 'memory.jsonl'),
    [MK, ent('Shared', ['a', 'b', 'only-on-this-mac']), ent('LocalOnly', ['x', 'y'])].join('\n'));
  fs.writeFileSync(path.join(repo, 'memory.jsonl'),
    [MK, ent('Shared', ['a', 'b'])].join('\n'));

  const d = M.observationsMissingFromRepo(local, repo);
  ok('divergence is detected', d.comparable && d.total === 3, JSON.stringify(d));
  ok('names the entity holding unsynced work', d.entities.some(e => e.name === 'LocalOnly' && e.missing === 2),
     JSON.stringify(d.entities));
  ok('and the partially-diverged one', d.entities.some(e => e.name === 'Shared' && e.missing === 1),
     JSON.stringify(d.entities));

  // A clean join reports nothing.
  fs.writeFileSync(path.join(local, 'memory.jsonl'), [MK, ent('Shared', ['a', 'b'])].join('\n'));
  ok('an in-sync Mac reports zero', M.observationsMissingFromRepo(local, repo).total === 0);

  fs.rmSync(base, { recursive: true, force: true });
}

// ─── 13. The dangling bridge a second Mac inherits ───────────────────────────
console.log('\n=== 13. A bridge symlink synced from another Mac is replaced, not parked ===');
{
  // Real case, 2026-09-06: Kam's Macs have DIFFERENT usernames (kamren vs kamrenkennedy),
  // so the bridge symlink left in iCloud by the first Mac names an absolute path that
  // cannot exist on the second. iCloud syncs it, and it dangles there.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-inherit-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'memory.jsonl'), '{"type":"_aim","source":"mcp-knowledge-graph"}');
  const oldPath = path.join(base, 'Claude Memory');
  fs.symlinkSync('/Users/adifferentuser/Developer/claude-memory', oldPath);

  ok('the inherited link dangles', !fs.existsSync(oldPath) && fs.lstatSync(oldPath).isSymbolicLink());
  ok('so a divergence check finds nothing to compare',
     M.observationsMissingFromRepo(oldPath, repo).comparable === false);

  const parked = M.createBridge(oldPath, repo);
  ok('nothing is parked — a broken link is not data', parked === null, String(parked));
  ok('and the path now resolves to this Mac\'s repo',
     fs.existsSync(oldPath) && fs.readlinkSync(oldPath) === repo);

  // A REAL folder must still be parked, not clobbered.
  const realPath = path.join(base, 'Real Memory');
  fs.mkdirSync(realPath);
  fs.writeFileSync(path.join(realPath, 'memory.jsonl'), 'irreplaceable');
  const parked2 = M.createBridge(realPath, repo);
  ok('a real folder IS parked', typeof parked2 === 'string' && fs.existsSync(parked2));
  ok('and its contents survive', fs.readFileSync(path.join(parked2, 'memory.jsonl'), 'utf8') === 'irreplaceable');

  // Nothing there at all is fine too.
  const fresh = path.join(base, 'Nothing Here');
  ok('a missing path just gets linked', M.createBridge(fresh, repo) === null && fs.existsSync(fresh));

  fs.rmSync(base, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
