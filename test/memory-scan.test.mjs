// Tests for bin/memory-scan.mjs — the pre-push credential gate.
//
//   npm run test:scan
//
// The fixture keys below are FAKE, assembled at runtime from fragments so this
// file never contains a string that looks like a live credential to another
// scanner (including this one, and GitHub's own push protection).

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCANNER = path.join(__dirname, '..', 'bin', 'memory-scan.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

const A = 'A'.repeat(20);
const FAKE = {
  google:   'AIza' + 'b'.repeat(35),
  aws:      'AKIA' + 'B'.repeat(16),
  github:   'gh' + 'p_' + 'c'.repeat(36),
  openai:   'sk-' + 'd'.repeat(40),
  stripe:   'sk' + '_live_' + 'e'.repeat(24),
  jwt:      'eyJ' + 'f'.repeat(20) + '.eyJ' + 'g'.repeat(20) + '.' + 'h'.repeat(20),
  privkey:  '-----BEGIN RSA PRIVATE KEY-----',
};

const MARKER = '{"type":"_aim","source":"mcp-knowledge-graph"}';
const ent = (name, observations) => JSON.stringify({ type: 'entity', name, entityType: 'project', observations });

function runScan(files, extraArgs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-scan-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  const r = spawnSync('node', [SCANNER, dir, ...extraArgs], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const runJson = (files, extra = []) => {
  const r = runScan(files, ['--json', ...extra]);
  return { ...r, data: JSON.parse(r.out) };
};

// ─── 1. Credentials block ────────────────────────────────────────────────────
console.log('\n=== 1. Real credential shapes block the push ===');
for (const [label, value] of Object.entries(FAKE)) {
  const { code, data } = runJson({ 'memory.jsonl': [MARKER, ent('P', [`the key is ${value} ok`])].join('\n') });
  ok(`${label} → blocks`, code === 1 && data.blocking >= 1, `code=${code} blocking=${data.blocking}`);
}

// ─── 2. The false-positive class found in the real store ─────────────────────
console.log('\n=== 2. Slugs containing "sk-" must NOT be flagged ===');
{
  // These are the exact shapes that tripped an unanchored pattern against Kam's
  // real store: `sk-` sitting inside an ordinary kebab-case word.
  const slugs = [
    'Deep Context invoice-desk-reconciliation-2026-08-30 covers it',
    'see martha-risk-review-notes-and-the-rest-of-this-slug',
    'deploy-task-scheduling-followup-item-recorded-elsewhere',
  ];
  const { code, data } = runJson({ 'memory.jsonl': [MARKER, ent('P', slugs)].join('\n') });
  ok('no blocking findings', data.blocking === 0, JSON.stringify(data.findings.filter(f => f.tier === 'block').map(f => f.label)));
  ok('exits 0', code === 0, `code=${code}`);
}

// ─── 3. Personal data reviews, never blocks ──────────────────────────────────
console.log('\n=== 3. Personal data is reported but does not block ===');
{
  const obs = [
    'call Alex on 615-555-0134 about the shoot',
    'invoice went to someone@example.com last week',
    'user_id 3b74d07d-a8b7-45f9-a9e6-ee9942413166 hit the bug',
  ];
  const { code, data } = runJson({ 'memory.jsonl': [MARKER, ent('P', obs)].join('\n') });
  ok('does not block', code === 0, `code=${code}`);
  ok('finds phone, email and UUID', data.review === 3, `review=${data.review}`);
  const labels = data.findings.map(f => f.label).sort();
  ok('all three labelled', JSON.stringify(labels) === JSON.stringify(['Email address', 'Phone number', 'UUID / user id']),
     JSON.stringify(labels));
}

// ─── 4. Never prints the secret ──────────────────────────────────────────────
console.log('\n=== 4. Findings are redacted — the scanner must not leak what it finds ===');
{
  const { out, data } = runScan({ 'memory.jsonl': [MARKER, ent('P', [`key ${FAKE.google} here`])].join('\n') });
  ok('full secret absent from human output', !out.includes(FAKE.google), 'LEAKED');
  const j = runJson({ 'memory.jsonl': [MARKER, ent('P', [`key ${FAKE.google} here`])].join('\n') });
  ok('full secret absent from JSON output', !JSON.stringify(j.data).includes(FAKE.google), 'LEAKED');
  ok('preview is truncated', j.data.findings[0].preview.includes('***'));
}

// ─── 5. Locates the finding by entity, not line number ───────────────────────
console.log('\n=== 5. Reports WHERE in the store, by entity ===');
{
  const store = [MARKER,
    ent('Innocent', ['nothing here', 'nor here']),
    ent('Culprit', ['fine', `token ${FAKE.aws} oops`, 'also fine']),
  ].join('\n');
  const { data } = runJson({ 'memory.jsonl': store });
  const f = data.findings.find(x => x.tier === 'block');
  ok('names the right entity', /Culprit/.test(f.where), f.where);
  ok('names the right observation index', /#1/.test(f.where), f.where);
}

// ─── 6. Allowlist by fingerprint ─────────────────────────────────────────────
console.log('\n=== 6. A confirmed false positive can be allowed — by hash, not by value ===');
{
  const store = [MARKER, ent('P', [`key ${FAKE.google} here`])].join('\n');
  const first = runJson({ 'memory.jsonl': store });
  const fp = first.data.findings[0].fingerprint;
  ok('blocks before allowing', first.code === 1);

  const after = runJson({ 'memory.jsonl': store, '.aim-scan-allow': `# known false positive\n${fp}\n` });
  ok('clean after allowing', after.code === 0 && after.data.blocking === 0, `blocking=${after.data.blocking}`);
  ok('the allowlist file does not contain the secret', !fp.includes(FAKE.google.slice(4, 20)));
}

// ─── 7. Scope and hygiene ────────────────────────────────────────────────────
console.log('\n=== 7. Scope ===');
{
  const clean = runJson({ 'memory.jsonl': [MARKER, ent('P', ['entirely ordinary text'])].join('\n') });
  ok('a clean store exits 0', clean.code === 0 && clean.data.blocking === 0);
  ok('says it is safe to push', runScan({ 'memory.jsonl': [MARKER, ent('P', ['ordinary'])].join('\n') }).out.includes('Safe to push'));

  const nonStore = runJson({ 'notes.md': `deploy with ${FAKE.github} today` });
  ok('scans non-jsonl files too', nonStore.data.blocking === 1, `blocking=${nonStore.data.blocking}`);
  ok('and locates them by line', /line \d+/.test(nonStore.data.findings[0].where), nonStore.data.findings[0].where);
}
{
  const r = spawnSync('node', [SCANNER], { encoding: 'utf8' });
  ok('no argument → usage, exit 2', r.status === 2 && /Usage/.test(r.stderr), `code=${r.status}`);
  const missing = spawnSync('node', [SCANNER, '/nope/does/not/exist'], { encoding: 'utf8' });
  ok('missing path → exit 2', missing.status === 2, `code=${missing.status}`);
}

// ─── 8. Inside a repo, only what git would commit is scanned ─────────────────
console.log('\n=== 8. Gitignored files are not scanned ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-scan-git-'));
  const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'memory.jsonl.bak-*\n');
  fs.writeFileSync(path.join(dir, 'memory.jsonl'), [MARKER, ent('P', ['clean'])].join('\n'));
  // A backup carrying a credential — real shape, but it can never be committed.
  fs.writeFileSync(path.join(dir, 'memory.jsonl.bak-old'), [MARKER, ent('P', [`key ${FAKE.google}`])].join('\n'));

  const r = spawnSync('node', [SCANNER, dir, '--json'], { encoding: 'utf8' });
  const data = JSON.parse(r.stdout);
  ok('ignored backup is skipped', data.blocking === 0, `blocking=${data.blocking}`);
  ok('so the gate passes', r.status === 0, `code=${r.status}`);

  // Un-ignore it and the same file must now block.
  fs.writeFileSync(path.join(dir, '.gitignore'), '');
  const r2 = spawnSync('node', [SCANNER, dir, '--json'], { encoding: 'utf8' });
  ok('un-ignoring it blocks again', JSON.parse(r2.stdout).blocking === 1, r2.stdout.slice(0, 120));

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
