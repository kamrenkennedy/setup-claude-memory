#!/usr/bin/env node
// Kam Memory — Aligned Memory sync
// Part of setup-claude-memory
//
//   aim-aligned-sync intake|refresh|run [--config <file>]
//
// Keeps the cloud copy and the Mac's store in step, with the store as the only source
// of truth:
//
//   intake   Writes made from the phone wait in D1's `pending` table. Each is applied
//            to the store through the same MCP servers Claude uses, never by editing
//            files, then marked applied. A write the server refuses is marked failed
//            and shown on screen once, not retried forever.
//   refresh  Exports the scope again and uploads only what changed since the last
//            upload (see diffSql in memory-export.mjs). Anything with a write still
//            waiting for intake is left alone until it has been taken in.
//   run      intake, then refresh. The background sync calls intake before its git
//            commit and refresh after its push, so both see every Mac's writes.
//
// Config, ~/.aligned-memory/config.json (outside any repo; ids are not secrets):
//   { "memory_path", "scope_file", "account_id", "database_id",
//     "manifest"?, "keychain_service"?, "memory_server"?, "deep_server"? }
// The Cloudflare API token (D1 edit only) is read from the login keychain, item
// "aligned-memory-d1" unless keychain_service says otherwise, or from
// ALIGNED_D1_TOKEN. It is never written to a file.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execFileSync } from 'child_process';
import { SCHEMA, loadScope, buildSnapshot, diffSql, sourceCommitOf } from './memory-export.mjs';

const HOME = os.homedir();
const DEFAULT_CONFIG = path.join(HOME, '.aligned-memory', 'config.json');
const REQUEST_BYTES = 800 * 1024;
const TOOL_TIMEOUT_MS = 180000;
const npxServer = (bin, store) => ['npx', '-y', '--package=setup-claude-memory@latest', bin, '--memory-path', store];

function loadConfig(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const expand = p => (typeof p === 'string' ? p.replace(/^~(?=$|\/)/, HOME) : p);
  for (const k of ['memory_path', 'scope_file']) {
    if (typeof raw[k] !== 'string') throw new Error(`${file} needs "${k}"`);
  }
  if (!raw.sqlite && (typeof raw.account_id !== 'string' || typeof raw.database_id !== 'string')) {
    throw new Error(`${file} needs "account_id" and "database_id"`);
  }
  const memoryPath = expand(raw.memory_path);
  return {
    memoryPath,
    scopeFile: expand(raw.scope_file),
    manifest: expand(raw.manifest) || path.join(path.dirname(file), 'work-manifest.json'),
    failures: path.join(path.dirname(file), 'aligned.failures'),
    accountId: raw.account_id,
    databaseId: raw.database_id,
    keychainService: raw.keychain_service || 'aligned-memory-d1',
    memoryServer: raw.memory_server || npxServer('aim-memory-server', memoryPath),
    deepServer: raw.deep_server || npxServer('aim-deep-context-server', memoryPath),
    sqlite: expand(raw.sqlite),  // tests only: a local D1 file in place of the HTTP API
  };
}

// ─── D1 ──────────────────────────────────────────────────────────────────────

function token(cfg) {
  if (process.env.ALIGNED_D1_TOKEN) return process.env.ALIGNED_D1_TOKEN;
  try {
    return execFileSync('security', ['find-generic-password', '-s', cfg.keychainService, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error(`No Cloudflare token in the keychain under "${cfg.keychainService}". See docs/ALIGNED-MEMORY.md, auto-refresh setup.`);
  }
}

async function d1(cfg) {
  if (cfg.sqlite) {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(cfg.sqlite);
    return { all: (sql, params = []) => db.prepare(sql).all(...params), run: async stmts => { for (const s of stmts) db.exec(s); }, close: () => db.close() };
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/d1/database/${cfg.databaseId}/query`;
  const auth = `Bearer ${token(cfg)}`;
  const post = async (sql, params) => {
    const res = await fetch(url, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, params }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.success) {
      throw new Error(`D1 ${res.status}: ${(body.errors || []).map(e => e.message).join('; ') || res.statusText}`);
    }
    return body.result;
  };
  return {
    all: async (sql, params = []) => (await post(sql, params.map(String))).at(-1)?.results ?? [],
    // Statements go up in order, several to a request. A request that fails leaves the
    // ones before it applied; every unit diffSql writes repairs itself on the next run.
    run: async stmts => {
      let batch = [];
      let bytes = 0;
      for (const s of stmts) {
        const size = Buffer.byteLength(s);
        if (batch.length && bytes + size > REQUEST_BYTES) { await post(batch.join('\n')); batch = []; bytes = 0; }
        batch.push(s); bytes += size;
      }
      if (batch.length) await post(batch.join('\n'));
    },
    close: () => {},
  };
}

// ─── MCP over stdio ──────────────────────────────────────────────────────────

// The server answered and said no (a tool error, or a JSON-RPC error to tools/call).
// Anything else, such as a crash or a timeout, means it never answered.
class ToolRefused extends Error {}
class RpcError extends Error {}

function mcpServer(cmd) {
  const child = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = new Map();
  let nextId = 1;
  let buf = '';
  const failAll = err => { for (const w of waiting.values()) w.reject(err); waiting.clear(); };
  child.on('error', err => failAll(new Error(`could not start ${cmd[0]}: ${err.message}`)));
  child.on('exit', code => failAll(new Error(`${cmd.slice(-3, -2)[0] || cmd[0]} exited (${code})`)));
  child.stdout.on('data', d => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      const w = waiting.get(m.id);
      if (!w) continue;
      waiting.delete(m.id);
      if (m.error) w.reject(new RpcError(m.error.message)); else w.resolve(m.result);
    }
  });
  const send = msg => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method} timed out`)); }, TOOL_TIMEOUT_MS);
    waiting.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    send({ id, method, params });
  });
  const ready = request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'aligned-sync', version: '1' } })
    .then(() => send({ method: 'notifications/initialized' }));
  return {
    async call(name, args) {
      await ready;
      let r;
      try { r = await request('tools/call', { name, arguments: args }); }
      catch (err) { throw err instanceof RpcError ? new ToolRefused(err.message) : err; }
      if (r.isError) throw new ToolRefused(r.content?.[0]?.text || 'refused');
      return r;
    },
    close() { child.stdin.end(); child.kill(); },
  };
}

// ─── Commands ────────────────────────────────────────────────────────────────

const log = msg => process.stdout.write(`${new Date().toISOString().replace(/\.\d+Z$/, 'Z')} aligned: ${msg}\n`);

function notify(message) {
  try {
    if (process.env.AIM_SYNC_NOTIFY) execFileSync(process.env.AIM_SYNC_NOTIFY, [message], { stdio: 'ignore' });
    else execFileSync('osascript', ['-e', `display notification ${JSON.stringify(message)} with title "Aligned Memory"`], { stdio: 'ignore' });
  } catch { /* no GUI session */ }
}

export async function intake(cfg, db) {
  const rows = await db.all("SELECT id, tool, target, payload FROM pending WHERE status = 'pending' ORDER BY id LIMIT 200");
  if (!rows.length) return { applied: 0, failed: 0 };
  const servers = {};
  const server = tool => (servers[tool] ??= mcpServer(tool === 'aim_deep_store' ? cfg.deepServer : cfg.memoryServer));
  let applied = 0;
  const failed = [];
  try {
    for (const row of rows) {
      const payload = JSON.parse(row.payload);
      const args = row.tool === 'aim_memory_add_facts' ? { observations: [payload] } : payload;
      const now = new Date().toISOString();
      try {
        if (row.tool !== 'aim_memory_add_facts' && row.tool !== 'aim_deep_store') throw new ToolRefused(`unknown tool ${row.tool}`);
        await server(row.tool).call(row.tool, args);
        await db.run([`UPDATE pending SET status = 'applied', applied_at = '${now}' WHERE id = ${Number(row.id)};`]);
        applied++;
      } catch (err) {
        if (!(err instanceof ToolRefused)) throw err;  // the server never answered: try again next run
        const msg = String(err.message).slice(0, 500).replace(/'/g, "''");
        await db.run([`UPDATE pending SET status = 'failed', applied_at = '${now}', error = '${msg}' WHERE id = ${Number(row.id)};`]);
        failed.push(`${row.target}: ${err.message}`);
      }
    }
  } finally {
    for (const s of Object.values(servers)) s.close();
  }
  if (applied) log(`took in ${applied} write(s) from the cloud`);
  if (failed.length) {
    log(`FAILED ${failed.length} write(s): ${failed.join(' | ')}`);
    notify(`${failed.length} write(s) from your phone could not be saved. Details are in sync.log.`);
  }
  return { applied, failed: failed.length };
}

export async function refresh(cfg, db) {
  const [current] = await db.all("SELECT value FROM meta WHERE key = 'current_snap'");
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(cfg.manifest, 'utf8')); } catch { /* none yet */ }
  if (!current || !previous || previous.snap !== current.value) {
    throw new Error('The cloud copy is not the last one this Mac uploaded, so a change-only upload could be wrong. '
      + 'Run a full upload (docs/ALIGNED-MEMORY.md, step 5) with --manifest, then this resumes.');
  }
  const snap = current.value;
  const snapshot = buildSnapshot(path.resolve(cfg.memoryPath), loadScope(cfg.scopeFile));
  const [ents, docs, waiting] = await Promise.all([
    db.all('SELECT name, ord, entity_type, obs_count FROM entities WHERE snap = ?', [snap]),
    db.all('SELECT id, ord FROM docs WHERE snap = ?', [snap]),
    db.all("SELECT tool, target FROM pending WHERE status = 'pending'"),
  ]);
  const cloud = {
    entities: new Map(ents.map(e => [e.name, { ord: Number(e.ord), entity_type: e.entity_type, obs_count: Number(e.obs_count) }])),
    docs: new Map(docs.map(d => [d.id, Number(d.ord)])),
  };
  const skip = {
    entities: new Set(waiting.filter(w => w.tool === 'aim_memory_add_facts').map(w => w.target)),
    docs: new Set(waiting.filter(w => w.tool === 'aim_deep_store').map(w => w.target)),
  };
  const { sql, manifest } = diffSql(snapshot, previous, cloud,
    { snap, exportedAt: new Date().toISOString(), sourceCommit: sourceCommitOf(cfg.memoryPath), skip });
  if (!sql.length) return { statements: 0 };
  await db.run(sql);
  const tmp = `${cfg.manifest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, cfg.manifest);
  log(`uploaded ${sql.length} change statement(s)`);
  return { statements: sql.length };
}

// Same alerting as sync.sh: say so on screen at the third failure in a row, then every
// 24th, because a sync that fails quietly looks exactly like one that works.
function recordOutcome(cfg, err) {
  let n = 0;
  try { n = parseInt(fs.readFileSync(cfg.failures, 'utf8'), 10) || 0; } catch { /* none */ }
  if (!err) {
    if (n) { fs.rmSync(cfg.failures, { force: true }); log(`OK again after ${n} failure(s)`); if (n >= 3) notify('Aligned Memory is syncing again.'); }
    return;
  }
  n++;
  fs.writeFileSync(cfg.failures, `${n}\n`);
  log(`FAIL ${err.message}`);
  if (n === 3 || n % 24 === 0) notify(`Aligned Memory has failed to sync ${n} times in a row. Details are in sync.log.`);
}

export async function main(argv) {
  const cmd = argv[0];
  if (!['intake', 'refresh', 'run'].includes(cmd)) {
    process.stderr.write('Usage: aim-aligned-sync intake|refresh|run [--config <file>]\n');
    return 2;
  }
  const i = argv.indexOf('--config');
  const file = i !== -1 ? argv[i + 1] : DEFAULT_CONFIG;
  if (!fs.existsSync(file)) return 0;  // Aligned Memory is not set up on this Mac
  const cfg = loadConfig(file);
  let db;
  try {
    db = await d1(cfg);
    await db.run(SCHEMA.split(/;\s*\n/).map(s => s.replace(/;?\s*$/, ';')));
    if (cmd !== 'refresh') await intake(cfg, db);
    if (cmd !== 'intake') await refresh(cfg, db);
    recordOutcome(cfg, null);
    return 0;
  } catch (err) {
    recordOutcome(cfg, err);
    return 1;
  } finally {
    db?.close();
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(code => process.exit(code), err => {
    process.stderr.write(`aim-aligned-sync: ${err.message}\n`);
    process.exit(1);
  });
}
