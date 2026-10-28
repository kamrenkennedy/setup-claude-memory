// Test of Aligned Memory writes and sync: the Worker's write code, bin/aligned-sync.mjs
// and the change-only upload in bin/memory-export.mjs.
//
//   npm run test:aligned
//
// The "cloud" is a SQLite file loaded from a real full export. The Worker's own store.js
// writes into it through a small D1 shim, so the phone side runs the code that ships.
// Intake goes through the real local memory and deep-context servers over stdio. The
// test that matters most is the last: after phone writes, Mac edits, a refused write and
// a denied fact, the cloud ends up identical to a fresh full export of the store.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { DatabaseSync } from 'node:sqlite';
import * as store from '../worker/src/store.js';
import { main as alignedSync } from '../bin/aligned-sync.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const EXPORT = path.join(ROOT, 'bin', 'memory-export.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};
const rejects = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(e.message); } };

// ─── Fixture ─────────────────────────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-aligned-'));
const mem = path.join(tmp, 'store');
fs.mkdirSync(path.join(mem, 'deep'), { recursive: true });
const ent = (name, observations) => JSON.stringify({ type: 'entity', name, entityType: 'project', observations });
fs.writeFileSync(path.join(mem, 'memory.jsonl'), [
  JSON.stringify({ type: '_aim', source: 'mcp-knowledge-graph' }),
  ent('Boardroom', ['b1', 'b2', 'b3']),
  ent('Spec', ['s1', 's2']),
  ent('Health_Plan', ['FAMILY-ONLY fact']),
  JSON.stringify({ type: 'relation', from: 'Spec', to: 'Boardroom', relationType: 'runs' }),
].join('\n') + '\n');
fs.writeFileSync(path.join(mem, 'config.json'), JSON.stringify({ embedding_engine: 'none' }));
const docs = [];
const writeDoc = (id, body) => {
  fs.writeFileSync(path.join(mem, 'deep', `${id}.md`), `---\nid: ${id}\nproject: Boardroom\n---\n\n${body}`);
  const i = docs.findIndex(d => d.id === id);
  const meta = { id, project: 'Boardroom', tags: ['t'], type: 'session-summary', date: '2026-10-28', summary: `summary of ${id}` };
  if (i === -1) docs.push(meta); else docs[i] = meta;
  fs.writeFileSync(path.join(mem, 'deep', 'index.json'), JSON.stringify(docs, null, 2));
};
writeDoc('boardroom-a', 'first doc');
writeDoc('boardroom-b', 'second doc');

const scope = path.join(tmp, 'work.json');
fs.writeFileSync(scope, JSON.stringify({ scope: 'work', owner: 'Pat', entities: ['Boardroom', 'Spec'], deep_projects: ['Boardroom'], deny_patterns: ['invite code'] }));

const exportTo = (sqlFile, manifest) => {
  const r = spawnSync('node', [EXPORT, '--memory-path', mem, '--scope', scope, '--out', sqlFile, ...(manifest ? ['--manifest', manifest] : []), '--json'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
};
const loadInto = (dbFile, sqlFile) => { const db = new DatabaseSync(dbFile); db.exec(fs.readFileSync(sqlFile, 'utf8')); return db; };

const manifest = path.join(tmp, 'work-manifest.json');
exportTo(path.join(tmp, 'first.sql'), manifest);
const cloudFile = path.join(tmp, 'cloud.sqlite');
const cloud = loadInto(cloudFile, path.join(tmp, 'first.sql'));

// The Worker's store.js expects D1's API. This is the part of it the write path uses.
function d1(db) {
  const exec = (sql, args) => {
    const p = db.prepare(sql);
    return /^\s*(SELECT|WITH)/i.test(sql) ? { results: p.all(...args) } : (p.run(...args), { results: [] });
  };
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    all: async () => exec(sql, args),
    first: async () => exec(sql, args).results[0] ?? null,
    _run: () => exec(sql, args),
  });
  return {
    prepare: sql => stmt(sql),
    batch: async stmts => {
      db.exec('BEGIN');
      try { const r = stmts.map(s => s._run()); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
const phone = d1(cloud);

const notices = path.join(tmp, 'notices.txt');
const notifier = path.join(tmp, 'notify.sh');
fs.writeFileSync(notifier, `#!/bin/sh\necho "$1" >> ${JSON.stringify(notices)}\n`, { mode: 0o755 });
process.env.AIM_SYNC_NOTIFY = notifier;

const config = path.join(tmp, 'config.json');
fs.writeFileSync(config, JSON.stringify({
  memory_path: mem, scope_file: scope, manifest, sqlite: cloudFile,
  memory_server: ['node', path.join(ROOT, 'bin', 'memory-server.mjs'), '--memory-path', mem],
  deep_server: ['node', path.join(ROOT, 'bin', 'deep-context-server.mjs'), '--memory-path', mem],
}));
const sync = cmd => alignedSync([cmd, '--config', config]);
const cloudObs = name => cloud.prepare('SELECT text FROM observations WHERE entity = ? ORDER BY idx').all(name).map(r => r.text);
const localObs = name => fs.readFileSync(path.join(mem, 'memory.jsonl'), 'utf8').split('\n').filter(Boolean)
  .map(l => JSON.parse(l)).find(e => e.name === name)?.observations || [];
const rowsWritten = () => cloud.prepare('SELECT total_changes() AS n').get().n;

// ─── 1. Phone writes ─────────────────────────────────────────────────────────

console.log('\n=== 1. The Worker writes only add, inside the scope ===');
const added = await store.addFacts(phone, [{ entityName: 'Boardroom', contents: ['phone fact', 'b1', 'phone fact'] }], 'github-1');
ok('new facts are added, duplicates ignored', JSON.stringify(added[0].addedObservations) === '["phone fact"]', JSON.stringify(added));
ok('the next read sees the write', cloudObs('Boardroom').at(-1) === 'phone fact');
ok('the entity count follows', cloud.prepare("SELECT obs_count FROM entities WHERE name = 'Boardroom'").get().obs_count === 4);
ok('the write waits for the Mac', cloud.prepare("SELECT count(*) n FROM pending WHERE status = 'pending'").get().n === 1);
ok('an entity outside the scope is refused', await rejects(() => store.addFacts(phone, [{ entityName: 'Health_Plan', contents: ['x'] }]), /not found/));
ok('an over-long fact is refused', await rejects(() => store.addFacts(phone, [{ entityName: 'Spec', contents: ['x'.repeat(store.LIMITS.factChars + 1)] }]), /at most/));
ok('a refused call writes nothing', cloud.prepare('SELECT count(*) n FROM pending').get().n === 1);

await store.storeDoc(phone, { id: 'boardroom-phone', project: 'Boardroom', tags: ['p'], type: 'decision-log', date: '2026-10-28', summary: 'from the phone', content: 'phone doc body' }, 'github-1');
ok('a new doc is readable at once', (await store.getDoc(phone, { id: 'boardroom-phone' })).content === 'phone doc body');
ok('an existing doc cannot be overwritten', await rejects(() => store.storeDoc(phone, { id: 'boardroom-a', project: 'Boardroom', tags: [], type: 'research', date: 'd', summary: 's', content: 'c' }), /already exists/));
ok('a project outside the scope is refused', await rejects(() => store.storeDoc(phone, { id: 'x1', project: 'Kennedy Family Docs', tags: [], type: 'research', date: 'd', summary: 's', content: 'c' }), /not a project/));

await store.addFacts(phone, [{ entityName: 'Spec', contents: ['the staging invite code is 1234'] }], 'github-1');

// ─── 2. Refresh leaves waiting writes alone ──────────────────────────────────

console.log('\n=== 2. Refresh before intake leaves waiting writes alone ===');
fs.appendFileSync(path.join(mem, 'deep', 'boardroom-a.md'), '\nedited on the Mac');
writeDoc('boardroom-c', 'new on the Mac');
ok('refresh runs', await sync('refresh') === 0);
ok('a doc changed on the Mac is uploaded', (await store.getDoc(phone, { id: 'boardroom-a' })).content.endsWith('edited on the Mac'));
ok('a doc added on the Mac is uploaded', (await store.getDoc(phone, { id: 'boardroom-c' })).content === 'new on the Mac');
ok('the phone fact is still readable', cloudObs('Boardroom').includes('phone fact'));
ok('the phone doc is still readable', (await store.getDoc(phone, { id: 'boardroom-phone' })).content === 'phone doc body');

const before = rowsWritten();
ok('a refresh with nothing new runs', await sync('refresh') === 0);
ok('and writes nothing', rowsWritten() === before, `${rowsWritten() - before} rows`);

// ─── 3. Intake, then the cloud matches a full export ─────────────────────────

console.log('\n=== 3. Intake applies writes through the local servers ===');
cloud.prepare("INSERT INTO pending (ts, tool, target, payload) VALUES ('2026-10-28T00:00:00Z', 'aim_memory_add_facts', 'Gone', ?)")
  .run(JSON.stringify({ entityName: 'Gone', contents: ['for an entity the Mac does not have'] }));
const lines = [];
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = s => { lines.push(String(s)); return true; };
const code = await sync('run');
process.stdout.write = write;
ok('run succeeds', code === 0, lines.join(''));
ok('the phone fact is in the store', localObs('Boardroom').includes('phone fact'));
ok('the phone doc is in the store', fs.existsSync(path.join(mem, 'deep', 'boardroom-phone.md'))
  && JSON.parse(fs.readFileSync(path.join(mem, 'deep', 'index.json'), 'utf8')).some(d => d.id === 'boardroom-phone'));
ok('a denied fact still reaches the store, where it belongs', localObs('Spec').includes('the staging invite code is 1234'));
ok('but it leaves the cloud', !cloudObs('Spec').some(t => t.includes('invite code')));
const status = Object.fromEntries(cloud.prepare('SELECT status, count(*) n FROM pending GROUP BY status').all().map(r => [r.status, r.n]));
ok('every write is applied or failed, none left waiting', status.applied === 3 && status.failed === 1 && !status.pending, JSON.stringify(status));
ok('the refused write is recorded with its reason', /not found/.test(cloud.prepare("SELECT error FROM pending WHERE status = 'failed'").get().error));
ok('and shown on screen once', /could not be saved/.test(fs.readFileSync(notices, 'utf8')));

const fresh = loadInto(path.join(tmp, 'fresh.sqlite'), (exportTo(path.join(tmp, 'fresh.sql')), path.join(tmp, 'fresh.sql')));
const dump = db => JSON.stringify({
  entities: db.prepare('SELECT ord, name, entity_type, obs_count FROM entities ORDER BY name').all(),
  observations: db.prepare('SELECT entity, idx, text FROM observations ORDER BY entity, idx').all(),
  relations: db.prepare('SELECT ord, from_name, to_name, relation_type FROM relations ORDER BY ord').all(),
  docs: db.prepare('SELECT ord, id, project, client, type, date, summary, tags, meta, chunks FROM docs ORDER BY id').all(),
  chunks: db.prepare('SELECT id, seq, text FROM doc_chunks ORDER BY id, seq').all(),
  meta: db.prepare("SELECT key, value FROM meta WHERE key IN ('scope', 'profile', 'writable') ORDER BY key").all(),
});
ok('the cloud is now identical to a fresh full export', dump(cloud) === dump(fresh), `\n     cloud ${dump(cloud).slice(0, 400)}\n     fresh ${dump(fresh).slice(0, 400)}`);

// ─── 4. It fails loudly, not quietly ─────────────────────────────────────────

console.log('\n=== 4. A cloud this Mac did not upload is refused, loudly ===');
const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
fs.writeFileSync(manifest, JSON.stringify({ ...m, snap: 'someone-elses' }));
fs.rmSync(notices, { force: true });
process.stdout.write = s => { lines.push(String(s)); return true; };
const codes = [await sync('refresh'), await sync('refresh'), await sync('refresh')];
process.stdout.write = write;
ok('refresh refuses a snapshot it did not upload', codes.every(c => c === 1));
ok('the reason names the fix', lines.some(l => l.includes('Run a full upload')));
ok('the third failure in a row is shown on screen', /failed to sync 3 times/.test(fs.readFileSync(notices, 'utf8')));
fs.writeFileSync(manifest, JSON.stringify(m));
process.stdout.write = s => { lines.push(String(s)); return true; };
await sync('refresh');
process.stdout.write = write;
ok('recovery clears the count', !fs.existsSync(path.join(tmp, 'aligned.failures')));

ok('no config means nothing to do', await alignedSync(['run', '--config', path.join(tmp, 'missing.json')]) === 0);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail ? 'FAILED' : 'ALL PASS'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
