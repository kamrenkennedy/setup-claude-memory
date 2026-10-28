// End-to-end test of the Aligned Memory Worker (worker/), over real HTTP.
//
//   npm run test:worker      (needs `npm install` in worker/ first)
//
// Exports a fixture store with bin/memory-export.mjs, loads it into a LOCAL D1, runs
// the Worker under `wrangler dev`, and drives it the way Claude does: discovery from a
// 401, dynamic client registration, PKCE, consent, a GitHub sign-in (a fake GitHub on
// localhost), the token exchange, then MCP over Streamable HTTP. Nothing touches
// Cloudflare's network or the real GitHub.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'fs';
import os from 'os';
import net from 'net';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const WORKER = path.join(ROOT, 'worker');
const WRANGLER = path.join(WORKER, 'node_modules', '.bin', 'wrangler');

if (!fs.existsSync(WRANGLER)) {
  console.log('skipped: run `npm install` in worker/ first');
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

const freePort = () => new Promise(resolve => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ─── Fixture ─────────────────────────────────────────────────────────────────

const OWNER_ID = '424242';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aligned-worker-'));
const store = path.join(tmp, 'store');
fs.mkdirSync(path.join(store, 'deep'), { recursive: true });

const marker = JSON.stringify({ type: '_aim', source: 'mcp-knowledge-graph' });
const ent = (name, entityType, observations) => JSON.stringify({ type: 'entity', name, entityType, observations });
const boardroomObs = [];
for (let i = 0; i < 260; i++) boardroomObs.push(i % 9 === 0 ? `NEEDLE ${i}: Boardroom decision ${i}.` : `Boardroom status line ${i} ${'filler '.repeat(12)}`);
fs.writeFileSync(path.join(store, 'memory.jsonl'), [
  marker,
  ent('Boardroom', 'project', boardroomObs),
  ent('Health_Plan', 'insurance', ['FAMILY-ONLY deductible fact']),
  ent('Persona', 'project', ['Persona plans posts.', 'NEEDLE in persona too']),
  ent('Spec', 'agent', ['Spec manages Dash.']),
  JSON.stringify({ type: 'relation', from: 'Boardroom', to: 'Persona', relationType: 'pairs with' }),
  JSON.stringify({ type: 'relation', from: 'Boardroom', to: 'Health_Plan', relationType: 'LEAK' }),
].join('\n'));
fs.writeFileSync(path.join(store, 'memory-family.jsonl'), [marker, ent('Boardroom', 'project', ['FAMILY-FILE'])].join('\n'));

const docs = [
  ['boardroom-native-2026-10-20', 'Boardroom', 'decision-log', '2026-10-20', 'Native app decision', 'Native SwiftUI app.'],
  ['boardroom-bus-2026-10-01', 'Boardroom', 'session-summary', '2026-10-01', 'board-bus worker shipped', 'x'.repeat(120000)],
  ['persona-2026-09-01', 'Persona', 'research', '2026-09-01', 'Persona research', 'Persona body.'],
  ['family-2026-09-02', 'Kennedy Family Docs', 'session-summary', '2026-09-02', 'FAMILY-DOC', 'FAMILY-DOC body'],
];
fs.writeFileSync(path.join(store, 'deep', 'index.json'), JSON.stringify(docs.map(([id, project, type, date, summary, body]) => {
  fs.writeFileSync(path.join(store, 'deep', `${id}.md`), `---\nid: ${id}\n---\n\n${body}`);
  return { id, project, tags: [project.toLowerCase()], type, date, summary, embedding: [0.5] };
})));
const scope = path.join(tmp, 'work.json');
fs.writeFileSync(scope, JSON.stringify({ scope: 'work', owner: 'Pat', entities: ['Boardroom', 'Persona', 'Spec'], deep_projects: ['Boardroom', 'Persona'] }));
const snapshot = path.join(tmp, 'snapshot.sql');
const exp = spawnSync('node', [path.join(ROOT, 'bin', 'memory-export.mjs'), '--memory-path', store, '--scope', scope, '--out', snapshot, '--json'], { encoding: 'utf8' });
if (exp.status !== 0) { console.log(exp.stderr); process.exit(1); }

// ─── Fake GitHub ─────────────────────────────────────────────────────────────

let githubUserId = OWNER_ID;
const githubCodes = new Map(); // code -> verifier seen at authorize time is not needed; we check presence
const github = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
      const p = new URLSearchParams(body);
      const good = p.get('client_secret') === 'test-secret' && p.get('code_verifier') && githubCodes.has(p.get('code'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(good ? { access_token: 'gho_test', token_type: 'bearer' } : { error: 'bad_verification_code' }));
    }
    if (req.method === 'GET' && url.pathname === '/user') {
      const authed = req.headers.authorization === 'Bearer gho_test';
      res.writeHead(authed ? 200 : 401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(authed ? { id: Number(githubUserId), login: `user${githubUserId}` } : {}));
    }
    res.writeHead(404); res.end();
  });
});
const githubPort = await freePort();
await new Promise(r => github.listen(githubPort, '127.0.0.1', r));

// ─── Worker ──────────────────────────────────────────────────────────────────

const port = await freePort();
const ORIGIN = `http://127.0.0.1:${port}`;
const persist = path.join(tmp, 'wrangler-state');
const load = spawnSync(WRANGLER, ['d1', 'execute', 'aligned-memory', '--local', '--persist-to', persist, '--file', snapshot],
  { cwd: WORKER, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
if (load.status !== 0) { console.log(load.stdout, load.stderr); process.exit(1); }

const vars = {
  PUBLIC_ORIGIN: ORIGIN, ALLOWED_GITHUB_ID: OWNER_ID, GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret',
  GITHUB_OAUTH_BASE: `http://127.0.0.1:${githubPort}`, GITHUB_API_BASE: `http://127.0.0.1:${githubPort}`,
};
const dev = spawn(WRANGLER, ['dev', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', persist,
  '--show-interactive-dev-session=false', '--log-level', 'warn', '--test-scheduled',
  ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])],
  { cwd: WORKER, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
let devLog = '';
dev.stdout.on('data', d => { devLog += d; });
dev.stderr.on('data', d => { devLog += d; });

const cleanup = () => { dev.kill('SIGTERM'); github.close(); };
process.on('exit', () => { try { dev.kill('SIGKILL'); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); });

for (let i = 0; ; i++) {
  try { if ((await fetch(`${ORIGIN}/`)).ok) break; } catch {}
  if (i > 120) { console.log('wrangler dev did not start:\n', devLog); cleanup(); process.exit(1); }
  await new Promise(r => setTimeout(r, 500));
}

const d1 = sql => JSON.parse(spawnSync(WRANGLER, ['d1', 'execute', 'aligned-memory', '--local', '--persist-to', persist, '--json', '--command', sql],
  { cwd: WORKER, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } }).stdout)[0].results;

// ─── 1. Discovery ────────────────────────────────────────────────────────────

console.log('\n=== 1. An unauthenticated client is pointed at the authorization server ===');
const unauth = await fetch(`${ORIGIN}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
const challenge = unauth.headers.get('www-authenticate') || '';
ok('401 on /mcp without a token', unauth.status === 401, unauth.status);
ok('challenge carries resource_metadata', /resource_metadata="[^"]+"/.test(challenge), challenge);
const prmUrl = challenge.match(/resource_metadata="([^"]+)"/)?.[1];
const prm = await (await fetch(prmUrl)).json();
ok('resource matches the /mcp URL exactly', prm.resource === `${ORIGIN}/mcp`, prm.resource);
ok('first authorization server is this origin', prm.authorization_servers?.[0] === ORIGIN);
ok('resource requires mcp:read', JSON.stringify(prm.scopes_supported) === '["mcp:read"]', prm.scopes_supported);
const asMeta = await (await fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).json();
ok('S256 PKCE advertised', asMeta.code_challenge_methods_supported?.includes('S256'));
ok('DCR endpoint advertised', !!asMeta.registration_endpoint);
ok('CIMD advertised with public clients', asMeta.client_id_metadata_document_supported === true && asMeta.token_endpoint_auth_methods_supported?.includes('none'));
const bogus = await fetch(`${ORIGIN}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer not-a-token', 'Content-Type': 'application/json' }, body: '{}' });
ok('a made-up token is refused', bogus.status === 401, bogus.status);

// ─── 2. Sign-in ──────────────────────────────────────────────────────────────

const cookieHeader = res => (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
const REDIRECT = 'http://127.0.0.1:33418/callback';

async function signIn() {
  const reg = await (await fetch(asMeta.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test Client', redirect_uris: ['http://127.0.0.1/callback'], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) })).json();
  const verifier = b64url(crypto.randomBytes(32));
  const challengeS = b64url(crypto.createHash('sha256').update(verifier).digest());
  const auth = new URL(asMeta.authorization_endpoint);
  Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, scope: 'mcp:read offline_access',
    state: 'client-state', code_challenge: challengeS, code_challenge_method: 'S256', resource: `${ORIGIN}/mcp` })
    .forEach(([k, v]) => auth.searchParams.set(k, v));

  const consent = await fetch(auth, { redirect: 'manual' });
  const html = await consent.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  const approve = await fetch(`${ORIGIN}/authorize`, { method: 'POST', redirect: 'manual',
    headers: { Cookie: cookieHeader(consent), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ handle, decision: 'approve' }) });
  const toGithub = new URL(approve.headers.get('location'));

  // The browser would now sign in at GitHub and come back with a code.
  const code = crypto.randomUUID();
  githubCodes.set(code, true);
  const back = await fetch(`${ORIGIN}/callback?code=${code}&state=${toGithub.searchParams.get('state')}`,
    { redirect: 'manual', headers: { Cookie: cookieHeader(approve) } });
  const toClient = new URL(back.headers.get('location'));
  return { reg, verifier, consent, html, handle, approve, toGithub, toClient };
}

console.log('\n=== 2. The owner signs in through consent, GitHub and PKCE ===');
const s = await signIn();
ok('consent page shows the client and the redirect host', s.html.includes('Test Client') && s.html.includes('127.0.0.1'));
ok('consent page warns about a local app', s.html.includes('an app on this computer'));
ok('consent page cannot be framed', (s.consent.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'"));
ok('approval goes to GitHub with PKCE', s.toGithub.pathname === '/login/oauth/authorize' && s.toGithub.searchParams.get('code_challenge_method') === 'S256');
ok('GitHub is asked for no scopes', !s.toGithub.searchParams.get('scope'));
ok('back to the client with a code and its state', !!s.toClient.searchParams.get('code') && s.toClient.searchParams.get('state') === 'client-state', s.toClient);
const tokenRes = await fetch(asMeta.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code: s.toClient.searchParams.get('code'), redirect_uri: REDIRECT,
    client_id: s.reg.client_id, code_verifier: s.verifier, resource: `${ORIGIN}/mcp` }) });
const tokens = await tokenRes.json();
ok('token exchange succeeds', !!tokens.access_token, JSON.stringify(tokens));
ok('a refresh token is issued', !!tokens.refresh_token);
ok('token carries mcp:read only', tokens.scope === 'mcp:read', tokens.scope);

console.log('\n=== 3. Anyone else is refused at sign-in ===');
const evil = await (await fetch(asMeta.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://evil.example/cb'], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'], response_types: ['code'] }) })).json();
const evilAuth = new URL(asMeta.authorization_endpoint);
Object.entries({ response_type: 'code', client_id: evil.client_id, redirect_uri: 'https://evil.example/cb', scope: 'mcp:read',
  state: 's', code_challenge: b64url(crypto.randomBytes(32)), code_challenge_method: 'S256' }).forEach(([k, v]) => evilAuth.searchParams.set(k, v));
const evilPage = await fetch(evilAuth, { redirect: 'manual' });
const evilHtml = await evilPage.text();
ok('a client that sends tokens anywhere but Claude gets no consent page', evilPage.status === 400 && !evilHtml.includes('name="handle"'));

githubUserId = '999';
const stranger = await signIn();
ok('a different GitHub account gets access_denied', stranger.toClient.searchParams.get('error') === 'access_denied', stranger.toClient);
ok('and no code', !stranger.toClient.searchParams.get('code'));
githubUserId = OWNER_ID;

// ─── 3. MCP ──────────────────────────────────────────────────────────────────

const remote = new Client({ name: 'test', version: '1' }, { capabilities: {} });
await remote.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`),
  { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
const local = new Client({ name: 'test', version: '1' }, { capabilities: {} });
await local.connect(new StdioClientTransport({ command: 'node', args: [path.join(ROOT, 'bin', 'memory-server.mjs'), '--memory-path', store], stderr: 'ignore' }));
const rcall = async (name, args = {}) => (await remote.callTool({ name, arguments: args })).content[0].text;
const lcall = async (name, args = {}) => (await local.callTool({ name, arguments: args })).content[0].text;

console.log('\n=== 4. Only read tools exist ===');
const tools = (await remote.listTools()).tools.map(t => t.name).sort();
ok('exactly the five read tools', JSON.stringify(tools) === JSON.stringify(['aim_deep_get', 'aim_deep_list', 'aim_deep_search', 'aim_memory_get', 'aim_memory_search']), tools);
const listed = (await remote.listTools()).tools;
ok('descriptions name the owner and their topics', listed.every(t => t.description.startsWith("Pat's") && t.description.includes('Covers: Boardroom, Persona')),
  listed.map(t => t.description.split('\n')[0]));
ok('server instructions say when to use it', /Pat's long-term memory.*check here first/s.test(remote.getInstructions() || ''));
const write = await remote.callTool({ name: 'aim_memory_add_facts', arguments: { observations: [] } });
ok('calling a write tool fails', write.isError === true);

console.log('\n=== 5. Results match the local server exactly ===');
for (const [name, args] of [
  ['aim_memory_search', { query: 'needle' }],
  ['aim_memory_search', { query: 'boardroom', per_entity: 3 }],
  ['aim_memory_search', { query: 'agent' }],
  ['aim_memory_search', { query: 'status', max_chars: 4000 }],
  ['aim_memory_search', { query: 'persona', format: 'pretty' }],
  ['aim_memory_get', { names: ['Boardroom', 'Spec'] }],
  ['aim_memory_get', { names: ['Boardroom'], recent: 5 }],
  ['aim_memory_get', { names: ['Boardroom'], full: true }],
  ['aim_memory_get', { names: ['Boardroom'], recent: 250, max_chars: 6000 }],
]) {
  const [r, l] = [await rcall(name, args), await lcall(name, args)];
  ok(`${name} ${JSON.stringify(args)}`, r === l, `\n     remote ${r.slice(0, 200)}\n     local  ${l.slice(0, 200)}`);
}

console.log('\n=== 6. Nothing outside the work scope is reachable ===');
ok('a family entity is not there', JSON.parse(await rcall('aim_memory_get', { names: ['Health_Plan'] })).entities.length === 0);
ok('searching for family-only text finds nothing', JSON.parse(await rcall('aim_memory_search', { query: 'FAMILY' })).matches.length === 0);
ok('the relation to a family entity is gone', !(await rcall('aim_memory_get', { names: ['Boardroom'] })).includes('LEAK'));
const ctx = await remote.callTool({ name: 'aim_memory_search', arguments: { query: 'x', context: 'family' } });
ok('asking for another scope is an error', ctx.isError && ctx.content[0].text.includes('work scope only'));
ok('family deep docs are not there', JSON.parse(await rcall('aim_deep_search', { query: 'family' })).count === 0);

console.log('\n=== 7. Deep context reads ===');
const list = JSON.parse(await rcall('aim_deep_list'));
ok('list is newest first and scoped', list.count === 3 && list.documents[0].id === 'boardroom-native-2026-10-20', JSON.stringify(list).slice(0, 200));
ok('no embeddings in results', !JSON.stringify(list).includes('embedding'));
ok('search by project', JSON.parse(await rcall('aim_deep_search', { project: 'persona' })).count === 1);
ok('search by keyword and type', JSON.parse(await rcall('aim_deep_search', { query: 'native', type: 'decision-log' })).count === 1);
ok('search by tag', JSON.parse(await rcall('aim_deep_search', { tags: ['boardroom'] })).count === 2);
const page1 = JSON.parse(await rcall('aim_deep_get', { id: 'boardroom-bus-2026-10-01' }));
ok('a long doc comes back in windows', page1.content.length === 50000 && page1.next_offset === 50000 && page1.total_chars === 120000);
const page3 = JSON.parse(await rcall('aim_deep_get', { id: 'boardroom-bus-2026-10-01', offset: 100000 }));
ok('the last window ends the doc', page3.content.length === 20000 && page3.next_offset === undefined);
const deepLocal = new Client({ name: 'test', version: '1' }, { capabilities: {} });
await deepLocal.connect(new StdioClientTransport({ command: 'node', args: [path.join(ROOT, 'bin', 'deep-context-server.mjs'), '--memory-path', store], stderr: 'ignore' }));
const localDoc = JSON.parse((await deepLocal.callTool({ name: 'aim_deep_get', arguments: { id: 'boardroom-native-2026-10-20' } })).content[0].text);
await deepLocal.close();
ok('a doc body matches the local deep-context server', JSON.parse(await rcall('aim_deep_get', { id: 'boardroom-native-2026-10-20' })).content === localDoc.content);
const missing = await remote.callTool({ name: 'aim_deep_get', arguments: { id: 'family-2026-09-02' } });
ok('an out-of-scope doc id is not found', missing.isError === true);

console.log('\n=== 8. Every call is in the audit log ===');
await new Promise(r => setTimeout(r, 500));
const rows = d1('SELECT method, tool, outcome, user_id FROM audit_log ORDER BY id');
ok('tool calls logged with the owner', rows.some(r => r.tool === 'aim_memory_search' && r.user_id === `github-${OWNER_ID}` && r.outcome === 'ok'));
ok('the refused sign-in is logged', rows.some(r => r.method === 'sign_in' && r.outcome === 'forbidden_user' && r.user_id === 'github-999'));
ok('the refused redirect is logged', rows.some(r => r.method === 'sign_in' && r.outcome === 'redirect_refused'));
ok('tool errors are logged as such', rows.some(r => r.tool === 'aim_memory_add_facts' && r.outcome === 'tool_error'));
ok('tokens are never logged', !JSON.stringify(d1('SELECT * FROM audit_log')).includes(tokens.access_token));

console.log('\n=== 9. The audit log keeps 90 days ===');
d1("INSERT INTO audit_log (ts, outcome) VALUES ('2020-01-01T00:00:00.000Z', 'ancient')");
await fetch(`${ORIGIN}/__scheduled?cron=17+4+*+*+*`);
const after = d1('SELECT outcome FROM audit_log');
ok('rows older than 90 days are swept, recent ones kept', !after.some(r => r.outcome === 'ancient') && after.some(r => r.outcome === 'ok'));

console.log('\n=== 10. Sign-in is rate limited ===');
let limited = false;
for (let i = 0; i < 15 && !limited; i++) limited = (await fetch(`${ORIGIN}/authorize`)).status === 429;
ok('too many sign-in attempts get 429', limited);

await remote.close();
await local.close();
cleanup();
console.log(`\n${fail ? 'FAILED' : 'ALL PASS'} — ${pass} passed, ${fail} failed`);
if (fail) console.log('\nwrangler log tail:\n' + devLog.slice(-3000));
process.exit(fail ? 1 : 0);
