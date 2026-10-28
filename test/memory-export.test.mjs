// Test of bin/memory-export.mjs — what is allowed to leave the Mac.
//
//   npm run test:export
//
// Runs the real CLI against a fixture store that contains exactly the things that
// must never reach the cloud: a family scope file, personal entities sitting in the
// master store next to work ones, a "Personal ..." deep-doc project that a loose
// pattern would sweep in, credentials, and contact details. The snapshot is then
// loaded into a real SQLite database to prove D1 will accept it.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORT = path.join(__dirname, '..', 'bin', 'memory-export.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

// Built at runtime so this file never trips the repo's own secret scanning.
const FAKE_GH_TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const PHONE = '615-555-' + '0142';
const EMAIL = 'someone' + '@example.com';
const BIG = 'x'.repeat(30000) + 'é'.repeat(30000); // > one chunk, multibyte

function buildFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-export-'));
  const marker = JSON.stringify({ type: '_aim', source: 'mcp-knowledge-graph' });
  const ent = (name, entityType, observations) => JSON.stringify({ type: 'entity', name, entityType, observations });
  fs.writeFileSync(path.join(dir, 'memory.jsonl'), [
    marker,
    ent('Boardroom', 'project', [
      'Boardroom ships the native app next.',
      `deploy token was ${FAKE_GH_TOKEN} (rotated)`,
      `call the vendor at ${PHONE} or ${EMAIL}`,
      `key: -----BEGIN ${'PRIVATE'} KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nKEYBODYLINE2xyz==\n-----END ${'PRIVATE'} KEY----- then more text`,
      `unterminated -----BEGIN EC ${'PRIVATE'} KEY-----\nMHcCAQEEIORPHANBODY== `,
      "Kam's note: don't forget the 'quoted' bit",
      'the staging invite code is ABC123',
    ]),
    ent('Health_Plan', 'insurance', ['FAMILY-ONLY deductible fact']),
    ent('Personal_Journal', 'personal', ['PERSONAL-ONLY reflection']),
    ent('persona-cloud', 'project', ['persona-cloud runs on Workers']),
    JSON.stringify({ type: 'relation', from: 'Boardroom', to: 'persona-cloud', relationType: 'pairs with' }),
    JSON.stringify({ type: 'relation', from: 'Boardroom', to: 'Health_Plan', relationType: 'LEAK-RELATION' }),
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'memory-family.jsonl'),
    [marker, ent('Boardroom', 'project', ['FAMILY-FILE fact under a work name'])].join('\n'));

  const deep = path.join(dir, 'deep');
  fs.mkdirSync(deep);
  const doc = (id, project, body, extra = {}) => {
    fs.writeFileSync(path.join(deep, `${id}.md`), `---\nid: ${id}\nproject: ${project}\n---\n\n${body}`);
    return { id, project, tags: ['t'], type: 'session-summary', date: '2026-10-27', summary: `summary of ${id}`,
      embedding: [0.1, 0.2], embedding_model: 'm', embedding_dim: 2, ...extra };
  };
  fs.writeFileSync(path.join(deep, 'index.json'), JSON.stringify([
    doc('boardroom-plan', 'Boardroom', `The plan. Reach me at ${EMAIL}.`),
    doc('boardroom-big', 'Boardroom', BIG),
    doc('persona-notes', 'Persona', 'Persona notes.'),
    doc('personal-doc', 'Personal Self-Discovery', 'PERSONAL-DOC body'),
    doc('family-doc', 'Kennedy Family Docs', 'FAMILY-DOC body'),
    doc('boardroom-secret', 'Boardroom', 'mentions the staging invite code'),
    doc('boardroom-tagged', 'Boardroom', 'clean body', { tags: ['invite code'] }),
    doc('boardroom-client', 'Boardroom', 'clean body', { client: 'invite code client' }),
    doc('../escape', 'Boardroom', 'path trick'),
  ]));
  return dir;
}

const store = buildFixture();
const scopeFile = path.join(store, '..', `scope-${path.basename(store)}.json`);
fs.writeFileSync(scopeFile, JSON.stringify({
  scope: 'work',
  entities: ['Boardroom', 'persona-cloud', 'Typo_Entity'],
  deep_projects: ['Boardroom', 'Persona'],
  deny_patterns: ['invite code'],
}));
const out = path.join(store, '..', `snap-${path.basename(store)}.sql`);

const run = (args) => spawnSync('node', [EXPORT, ...args], { encoding: 'utf8' });

console.log('\n=== 1. Export runs and reports ===');
const r = run(['--memory-path', store, '--scope', scopeFile, '--out', out, '--json']);
ok('exit 0', r.status === 0, r.stderr);
const report = JSON.parse(r.stdout || '{}');
ok('two entities exported', report.entities_exported === 2, JSON.stringify(report));
ok('typo in allowlist is reported, not silently ignored', report.allowlisted_but_missing?.includes('Typo_Entity'));
ok('report carries counts, not content', !r.stdout.includes('Boardroom ships'));
const sql = fs.readFileSync(out, 'utf8');
ok('snapshot file is 0600', (fs.statSync(out).mode & 0o777) === 0o600);

console.log('\n=== 2. Nothing outside the scope reaches the snapshot ===');
for (const needle of ['FAMILY-ONLY', 'PERSONAL-ONLY', 'FAMILY-FILE', 'PERSONAL-DOC', 'FAMILY-DOC', 'LEAK-RELATION', 'Health_Plan', 'path trick']) {
  ok(`absent: ${needle}`, !sql.includes(needle));
}
ok('embeddings stay home', !sql.includes('embedding_model') && !sql.includes('0.1, 0.2'));

console.log('\n=== 3. Credentials and contact details are redacted ===');
ok('token redacted', !sql.includes(FAKE_GH_TOKEN) && sql.includes('[redacted: github token]'));
ok('phone redacted', !sql.includes(PHONE));
ok('a private key is redacted with its body', !sql.includes('KEYBODYLINE2') && !sql.includes('MIIEvQ') && sql.includes('then more text'));
ok('an unterminated key loses its body too', !sql.includes('ORPHANBODY'));
ok('email redacted in observations and docs', !sql.includes(EMAIL));
ok('redactions counted', report.redactions?.['GitHub token'] === 1 && report.redactions?.['Email address'] === 2);

console.log('\n=== 4. deny_patterns drop whole observations and docs ===');
ok('observation dropped', !sql.includes('ABC123') && report.dropped_by_deny_patterns?.observations === 1);
ok('doc dropped', !sql.includes('boardroom-secret'));
ok('a match in tags or client drops the doc too', !sql.includes('boardroom-tagged') && !sql.includes('boardroom-client'));
ok('dropped docs counted', report.dropped_by_deny_patterns?.docs === 3);

console.log('\n=== 4b. The profile describes this user\'s scope, from their own data ===');
ok('topics derived from docs then entities, folded', JSON.stringify(report.described_as?.topics) === JSON.stringify(['Boardroom', 'Persona', 'persona-cloud']), JSON.stringify(report.described_as));
ok('no owner unless the scope names one', report.described_as?.owner === null);
ok('profile is written to meta', sql.includes("'profile'"));
const scope2 = scopeFile.replace('.json', '-2.json');
fs.writeFileSync(scope2, JSON.stringify({ scope: 'work', owner: 'Pat', entities: ['Boardroom'], deep_projects: [],
  deny_patterns: ['invite code'], topics: ['Boardroom', 'boardroom', 'the invite code project', 'Boardroom app'] }));
const p2 = JSON.parse(run(['--memory-path', store, '--scope', scope2, '--out', out, '--json']).stdout || '{}').described_as || {};
ok('explicit topics win, deduped, deny_patterns apply', JSON.stringify(p2.topics) === JSON.stringify(['Boardroom', 'Boardroom app']), JSON.stringify(p2));
ok('owner comes from the scope file', p2.owner === 'Pat');
run(['--memory-path', store, '--scope', scopeFile, '--out', out, '--json']);

console.log('\n=== 5. The snapshot loads into SQLite, and reads back correctly ===');
let sqlite;
try { sqlite = await import('node:sqlite'); } catch { /* Node < 22.5 */ }
if (!sqlite) console.log('  - skipped: node:sqlite unavailable');
else {
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(sql);
  const snap = db.prepare("SELECT value FROM meta WHERE key = 'current_snap'").get().value;
  ok('current_snap set', snap === report.snapshot);
  const names = db.prepare('SELECT name FROM entities ORDER BY ord').all().map(x => x.name);
  ok('entities in store order', JSON.stringify(names) === JSON.stringify(['Boardroom', 'persona-cloud']), names);
  const obs = db.prepare("SELECT text FROM observations WHERE entity = 'Boardroom' ORDER BY idx").all().map(x => x.text);
  ok('quotes survive the round trip', obs.includes("Kam's note: don't forget the 'quoted' bit"));
  ok('obs_count matches kept observations', db.prepare("SELECT obs_count FROM entities WHERE name = 'Boardroom'").get().obs_count === obs.length);
  const big = db.prepare("SELECT text FROM doc_chunks WHERE id = 'boardroom-big' ORDER BY seq").all().map(x => x.text).join('');
  ok('a large multibyte doc reassembles exactly', big.trim() === BIG);
  const longest = Math.max(...sql.split('\n').map(l => Buffer.byteLength(l)));
  ok('every statement fits D1\'s 100 KB limit', longest < 100 * 1024, `longest ${longest}`);
  ok('one relation, both ends in scope', db.prepare('SELECT count(*) n FROM relations').get().n === 1);

  // A second export replaces the first without touching the audit log.
  db.exec("INSERT INTO audit_log (ts, outcome) VALUES ('t', 'ok')");
  const r2 = run(['--memory-path', store, '--scope', scopeFile, '--out', out, '--json']);
  db.exec(fs.readFileSync(out, 'utf8'));
  const snap2 = JSON.parse(r2.stdout).snapshot;
  ok('re-export flips to the new snapshot', db.prepare("SELECT value FROM meta WHERE key = 'current_snap'").get().value === snap2 && snap2 !== snap);
  ok('old snapshot rows are swept', db.prepare('SELECT count(DISTINCT snap) n FROM observations').get().n === 1);
  ok('audit log survives a re-export', db.prepare('SELECT count(*) n FROM audit_log').get().n === 1);
}

console.log('\n=== 6. Other scope files are refused ===');
const bad = run(['--memory-path', path.join(store, 'memory-family.jsonl'), '--scope', scopeFile, '--out', out]);
ok('pointing at memory-family.jsonl fails', bad.status !== 0);
const { buildSnapshot, loadScope } = await import(EXPORT);
const realStore = fs.realpathSync(store);
const swap = (target) => {
  fs.renameSync(path.join(store, 'memory.jsonl'), path.join(store, 'memory.real'));
  fs.symlinkSync(target, path.join(store, 'memory.jsonl'));
};
const restore = () => {
  fs.rmSync(path.join(store, 'memory.jsonl'));
  fs.renameSync(path.join(store, 'memory.real'), path.join(store, 'memory.jsonl'));
};
const refuses = () => { try { buildSnapshot(realStore, loadScope(scopeFile)); return false; } catch { return true; } };
swap('memory-family.jsonl');
ok('memory.jsonl symlinked to the family file is refused', refuses());
restore();
swap('memory.real');
ok('…while an ordinary symlink to a non-scope name is refused too', refuses());
restore();
ok('the plain store still exports after the checks', !refuses());

console.log('\n=== 7. A bad scope file is refused ===');
const badScope = path.join(store, '..', `badscope-${path.basename(store)}.json`);
fs.writeFileSync(badScope, JSON.stringify({ scope: 'work', entities: 'Boardroom' }));
ok('non-array allowlist fails', run(['--memory-path', store, '--scope', badScope, '--out', out]).status !== 0);

fs.rmSync(store, { recursive: true, force: true });
for (const f of [scopeFile, out, badScope]) fs.rmSync(f, { force: true });

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
