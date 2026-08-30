// End-to-end test of bin/memory-server.mjs, driven over real MCP stdio.
//
//   npm test                  — runs against a generated fixture (safe anywhere)
//   npm test -- /path/to/copy — runs against a COPY of a real store
//
// Never point this at a live store: it writes.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'bin', 'memory-server.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};
const md5 = f => execFileSync('md5', ['-q', f]).toString().trim();

// ─── Fixture ─────────────────────────────────────────────────────────────────
// A synthetic store with one deliberately oversized entity — the shape that
// broke the upstream server.

const BIG = 'Oversized_Project';
const BIG_N = 900;

function buildFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-test-'));
  const obs = [];
  for (let i = 0; i < BIG_N; i++) {
    obs.push(i % 7 === 0
      ? `NEEDLE ${i}: a decision worth finding again, recorded on day ${i}.`
      : `Routine status line ${i} — ${'filler '.repeat(20)}`);
  }
  const lines = [
    JSON.stringify({ type: '_aim', source: 'mcp-knowledge-graph' }),
    JSON.stringify({ type: 'entity', name: BIG, entityType: 'project', observations: obs }),
    JSON.stringify({ type: 'entity', name: 'Small_Thing', entityType: 'concept', observations: ['just the one fact'] }),
    JSON.stringify({ type: 'relation', from: BIG, to: 'Small_Thing', relationType: 'depends on' }),
  ];
  fs.writeFileSync(path.join(dir, 'memory.jsonl'), lines.join('\n'));
  // A restricted-permission store, to prove the mode is preserved.
  fs.writeFileSync(path.join(dir, 'memory-private.jsonl'),
    [lines[0], JSON.stringify({ type: 'entity', name: 'Secret', entityType: 'note', observations: ['sensitive'] })].join('\n'),
    { mode: 0o600 });
  return dir;
}

const STORE = process.argv[2] || buildFixture();
const usingFixture = !process.argv[2];
const bigName = usingFixture ? BIG : 'Content_Strategy_App';
const privateDb = usingFixture ? 'private' : 'family';
console.log(`store: ${STORE}${usingFixture ? ' (generated fixture)' : ' (supplied copy)'}`);

// ─── Connect ─────────────────────────────────────────────────────────────────

const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
await client.connect(new StdioClientTransport({ command: 'node', args: [SERVER, '--memory-path', STORE] }));
const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text;

console.log('\n=== 1. Tool surface is a drop-in for mcp-knowledge-graph ===');
const tools = (await client.listTools()).tools.map(t => t.name).sort();
const expected = ['aim_memory_add_facts', 'aim_memory_forget', 'aim_memory_get', 'aim_memory_link',
  'aim_memory_list_stores', 'aim_memory_read_all', 'aim_memory_remove_facts', 'aim_memory_search',
  'aim_memory_store', 'aim_memory_unlink'];
ok('all 10 upstream tool names present', JSON.stringify(tools) === JSON.stringify(expected), `\n     got: ${tools}`);

console.log('\n=== 2. A full save cycle round-trips BYTE-IDENTICALLY ===');
const before = md5(path.join(STORE, 'memory.jsonl'));
await call('aim_memory_store', { entities: [{ name: bigName, entityType: 'project', observations: [] }] });
ok('untouched entities are not reformatted', before === md5(path.join(STORE, 'memory.jsonl')));

console.log('\n=== 3. File mode is preserved (0600 must not become 0644) ===');
const modeBefore = fs.statSync(path.join(STORE, `memory-${privateDb}.jsonl`)).mode & 0o777;
await call('aim_memory_store', { context: privateDb, entities: [{ name: '__probe__', entityType: 'test', observations: [] }] });
const modeAfter = fs.statSync(path.join(STORE, `memory-${privateDb}.jsonl`)).mode & 0o777;
ok(`mode stays ${modeBefore.toString(8)}`, modeBefore === modeAfter, `got ${modeAfter.toString(8)}`);
await call('aim_memory_forget', { context: privateDb, entityNames: ['__probe__'] });

console.log('\n=== 4. THE FIX: search returns matching observations, not whole entities ===');
const needle = usingFixture ? 'NEEDLE' : bigName;
const searchOut = await call('aim_memory_search', { query: needle });
const parsed = JSON.parse(searchOut);
const big = parsed.matches.find(m => m.name === bigName);
ok('response is bounded', searchOut.length < 25000, `got ${searchOut.length} chars`);
ok('reports the entity\'s true size', big && big.total_observations > 400, `total=${big?.total_observations}`);
ok('returns only a slice of matches', big && big.returned_observations <= 10, `returned=${big?.returned_observations}`);
const withheld = parsed.entities_matched > parsed.entities_returned
  || parsed.matches.some(m => m.returned_observations < m.matching_observations);
ok('truncated flag matches whether anything was actually withheld', parsed.truncated === withheld,
   `truncated=${parsed.truncated} withheld=${withheld}`);
console.log(`     ${bigName}: ${big?.total_observations} observations, ${big?.returned_observations} returned, ${searchOut.length} chars`);

console.log('\n=== 5. Versus what the OLD server would have returned ===');
let oldSize = 0;
for (const line of fs.readFileSync(path.join(STORE, 'memory.jsonl'), 'utf8').split('\n').filter(Boolean).slice(1)) {
  const item = JSON.parse(line);
  if (item.type !== 'entity') continue;
  const q = needle.toLowerCase();
  if (item.name.toLowerCase().includes(q) || (item.entityType || '').toLowerCase().includes(q)
      || item.observations.some(o => o.toLowerCase().includes(q))) oldSize += JSON.stringify(item).length;
}
console.log(`     old: ~${oldSize.toLocaleString()} chars  →  new: ${searchOut.length.toLocaleString()} chars`);
ok('at least 10x smaller', searchOut.length < oldSize / 10, `${searchOut.length} vs ${oldSize}`);

console.log('\n=== 6. get is bounded, and says what it withheld ===');
const g = JSON.parse(await call('aim_memory_get', { names: [bigName] }));
ok('reports total_observations', g.entities[0].total_observations > 400);
ok('reports omitted_older', g.entities[0].omitted_older > 0, `omitted=${g.entities[0].omitted_older}`);
ok('note explains how to get the rest', typeof g.note === 'string' && g.note.includes('full:true'));
console.log(`     returned ${g.entities[0].returned_observations} of ${g.entities[0].total_observations}`);

console.log('\n=== 7. Escape hatches still work ===');
const f = JSON.parse(await call('aim_memory_get', { names: [bigName], full: true }));
ok('full:true returns everything', f.entities[0].observations.length === f.entities[0].total_observations,
   `${f.entities[0].observations.length}/${f.entities[0].total_observations}`);
const r5 = JSON.parse(await call('aim_memory_get', { names: [bigName], recent: 5 }));
ok('recent:N is honoured', r5.entities[0].returned_observations === 5, `got ${r5.entities[0].returned_observations}`);
const capped = await call('aim_memory_get', { names: [bigName], max_chars: 2000 });
ok('max_chars is respected', capped.length <= 2000, `${capped.length} chars`);
ok('...and the result is still valid JSON', (() => { try { JSON.parse(capped); return true; } catch { return false; } })());
ok('...and says it was reduced', JSON.parse(capped).budget_truncated === true);
const bounded = await call('aim_memory_get', { names: [bigName], full: true, max_chars: 3000 });
ok('full + max_chars stays bounded', bounded.length <= 3000, `${bounded.length} chars`);

console.log('\n=== 8. Small entities are unaffected ===');
// Find an entity genuinely under the default slice rather than assuming one by name —
// in a live store any given entity may have grown past it.
const GET_RECENT = 30;
let smallName = null;
for (const line of fs.readFileSync(path.join(STORE, 'memory.jsonl'), 'utf8').split('\n').filter(Boolean).slice(1)) {
  const it = JSON.parse(line);
  if (it.type === 'entity' && it.observations.length > 0 && it.observations.length <= GET_RECENT) { smallName = it.name; break; }
}
ok('found a small entity to check', smallName !== null);
const small = JSON.parse(await call('aim_memory_get', { names: [smallName] }));
ok(`no observations omitted for a small entity (${smallName})`, small.entities[0].omitted_older === 0,
   `omitted=${small.entities[0].omitted_older}`);
ok('returns all of its observations', small.entities[0].returned_observations === small.entities[0].total_observations);
const pretty = await call('aim_memory_get', { names: [smallName], format: 'pretty' });
ok('pretty format renders', pretty.includes(smallName) && pretty.includes('database'));

console.log('\n=== 9. Write semantics match upstream ===');
await call('aim_memory_store', { entities: [{ name: '__T__', entityType: 'test', observations: ['alpha'] }] });
await call('aim_memory_add_facts', { observations: [{ entityName: '__T__', contents: ['beta', 'alpha'] }] });
const t1 = JSON.parse(await call('aim_memory_get', { names: ['__T__'] }));
ok('duplicate observations are ignored', t1.entities[0].observations.length === 2, JSON.stringify(t1.entities[0].observations));
await call('aim_memory_link', { relations: [{ from: '__T__', to: smallName, relationType: 'tests' }] });
const linked = JSON.parse(await call('aim_memory_get', { names: ['__T__', smallName] }));
ok('relations are returned between requested entities', linked.relations.some(r => r.from === '__T__'));
await call('aim_memory_remove_facts', { deletions: [{ entityName: '__T__', observations: ['alpha'] }] });
const t2 = JSON.parse(await call('aim_memory_get', { names: ['__T__'] }));
ok('remove_facts drops just that observation', t2.entities[0].observations.length === 1);
await call('aim_memory_forget', { entityNames: ['__T__'] });
ok('forget removes the entity', JSON.parse(await call('aim_memory_get', { names: ['__T__'] })).entities.length === 0);

console.log('\n=== 10. A malformed store is refused, not overwritten ===');
const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-bad-'));
fs.writeFileSync(path.join(badDir, 'memory.jsonl'), '{"type":"entity","name":"NotOurs"}');
const badClient = new Client({ name: 't2', version: '1' }, { capabilities: {} });
await badClient.connect(new StdioClientTransport({ command: 'node', args: [SERVER, '--memory-path', badDir] }));
let refused = false;
try { await badClient.callTool({ name: 'aim_memory_read_all', arguments: {} }); }
catch { refused = true; }
ok('file without the _aim marker is rejected', refused);
ok('and was left untouched', fs.readFileSync(path.join(badDir, 'memory.jsonl'), 'utf8') === '{"type":"entity","name":"NotOurs"}');
await badClient.close();
fs.rmSync(badDir, { recursive: true, force: true });

console.log('\n=== 11. No temp files left behind ===');
ok('no .tmp- strays', fs.readdirSync(STORE).filter(f => f.includes('.tmp-')).length === 0);

await client.close();
if (usingFixture) fs.rmSync(STORE, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
