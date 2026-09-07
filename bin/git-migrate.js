// Kam Memory — `npx setup-claude-memory@latest --git`
// Part of setup-claude-memory
//
// Moves the memory store out of a sync folder into a PRIVATE git repo, and wires up
// everything that makes that safe to run unattended afterwards:
//
//   • a repo location that is genuinely not synced (this is where it goes wrong)
//   • a credential scan that gates the FIRST push, because git history is permanent
//   • a semantic merge driver, so a conflict never reaches a person
//   • a directory-symlink bridge, so the cutover is gradual instead of a big bang
//
// It runs for whoever runs it, against their own GitHub account. Nobody types a git
// command — that is the whole design constraint, since this ships to someone who
// should never have to clear a merge conflict.

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

// ─── Location safety ─────────────────────────────────────────────────────────
//
// A git repo inside a sync folder corrupts itself. iCloud mangles .git internals;
// Dropbox rewrites mtimes. Both fail SILENTLY, which is why this refuses rather than
// warns.
//
// The trap that makes a naive check wrong: ~/Documents and ~/Desktop are iCloud-synced
// whenever macOS "Desktop & Documents Folders" is enabled. That is a common default —
// verified ON for Kam — and nothing about the path reveals it. Detect it by checking
// whether iCloud Drive actually holds a Documents/Desktop mirror.

const ICLOUD_BASE = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');

function desktopDocumentsSynced() {
  return fs.existsSync(path.join(ICLOUD_BASE, 'Documents'))
      || fs.existsSync(path.join(ICLOUD_BASE, 'Desktop'));
}

// Returns null when safe, or a human explanation of why not.
function unsafeRepoLocation(candidate, { syncedDesktopDocs = desktopDocumentsSynced() } = {}) {
  if (!candidate || !path.isAbsolute(candidate)) return 'Path must be absolute.';

  const home = os.homedir();
  const p = path.resolve(candidate);
  const within = (parent) => p === parent || p.startsWith(parent + path.sep);

  if (within(path.join(home, 'Library', 'Mobile Documents'))) {
    return 'That is inside iCloud Drive. iCloud corrupts git\'s internal files while syncing, and it fails silently.';
  }
  if (/\/(Dropbox|Dropbox-[^/]+)(\/|$)/.test(p) || within(path.join(home, 'Dropbox'))) {
    return 'That is inside Dropbox. Dropbox rewrites file timestamps, which silently breaks git and build tooling.';
  }
  if (within(path.join(home, 'Library', 'CloudStorage'))) {
    return 'That is inside a cloud-storage provider folder (CloudStorage). Sync and git do not mix.';
  }
  if (syncedDesktopDocs && (within(path.join(home, 'Documents')) || within(path.join(home, 'Desktop')))) {
    return 'Your Desktop & Documents folders sync to iCloud, so that location is iCloud-backed even though the path does not say so.';
  }
  if (p === home) return 'Pick a folder inside your home directory, not the home directory itself.';
  if (fs.existsSync(p) && fs.readdirSync(p).length > 0 && !fs.existsSync(path.join(p, '.git'))) {
    return 'That folder already exists and is not empty.';
  }
  return null;
}

// ~/Developer for someone who already keeps repos there; a plain, findable home folder
// otherwise. Home root itself is never synced by Desktop & Documents.
function defaultRepoLocation() {
  const dev = path.join(os.homedir(), 'Developer');
  return fs.existsSync(dev)
    ? path.join(dev, 'claude-memory')
    : path.join(os.homedir(), 'ClaudeMemory');
}

// ─── Prerequisites ───────────────────────────────────────────────────────────

function which(cmd) {
  const r = spawnSync('command', ['-v', cmd], { shell: true, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function checkGitPrereqs() {
  const git = which('git');
  const gh = which('gh');
  let ghAuthed = false;
  let ghUser = null;
  if (gh) {
    const r = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' });
    ghAuthed = r.status === 0;
    const m = (r.stderr + r.stdout).match(/account (\S+)/);
    if (m) ghUser = m[1];
  }
  return { git, gh, ghAuthed, ghUser };
}

// ─── File generation ─────────────────────────────────────────────────────────

const GITIGNORE = `# Loose backups — these are copies of the whole store and they carry
# every secret it has ever held. Never commit them.
memory.jsonl.bak-*
memory.jsonl.backup-*
*.bak-*

.DS_Store
.Trash/
node_modules/

# Fort Abode's error log — machine-local noise, not memory.
Fort Abode Logs/

# Sync artifacts, if anyone ever puts them in the repo. Machine-local by nature:
# committing them makes two machines conflict on files that are not memory at all.
.sync.sh
.sync.log
`;

// The driver path is quoted because git runs the merge command through a SHELL.
// Unquoted, a directory containing a space breaks the merge silently and hands the
// user conflict markers they cannot resolve — and the default install locations
// ("Memory System", "Application Support") contain spaces.
const GITATTRIBUTES = `# Memory stores merge semantically — see bin/memory-merge-driver.mjs.
# Git's text merge would leave conflict markers (unparseable), and merge=union would
# duplicate entity lines (corrupt graph). Neither is acceptable unattended.
memory.jsonl merge=aim-memory
memory-*.jsonl merge=aim-memory

# Deep-context docs are write-once with unique ids, so they cannot truly conflict.
deep/index.json merge=union
`;

function repoReadme(displayName) {
  return `# ${displayName} — Claude memory

Private store for Claude's persistent memory. **This repo must stay private.** It contains
personal data by design: contacts, project detail, and anything worth remembering.

## What is here

- \`memory.jsonl\` — the knowledge graph (master database)
- \`memory-<context>.jsonl\` — named databases (work, family, personal, …)
- \`deep/\` — long-form session documents + \`index.json\`
- \`config.json\` — preferences

## Do not edit these by hand

Claude writes them through its memory tools. Hand-editing while a session is live loses
whichever write lands second.

## Conflicts resolve themselves

A semantic merge driver merges by meaning — entities by name, observations as a proper
three-way set — so two machines writing at once do not produce a conflict. If you ever
DO see one, the driver refused because a file was malformed; do not resolve it by hand,
ask Claude.

## Before pushing anything new

\`\`\`
npx setup-claude-memory@latest --scan
\`\`\`

Credentials must never be committed: git history is permanent, and removing a secret in
a later commit does not make it unreachable.
`;
}

// ─── Integrity ───────────────────────────────────────────────────────────────

function fileHashes(root) {
  const out = new Map();
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (name === '.git') continue;
      const full = path.join(dir, name);
      const st = fs.lstatSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) {
        out.set(path.relative(root, full), crypto.createHash('md5').update(fs.readFileSync(full)).digest('hex'));
      }
    }
  })(root);
  return out;
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const st = fs.lstatSync(from);
    if (st.isDirectory()) copyTree(from, to);
    else if (st.isFile()) { fs.copyFileSync(from, to); fs.chmodSync(to, st.mode & 0o777); }
  }
}

// Compare every file that exists in BOTH trees. Files excluded by .gitignore are
// deliberately not copied, so a missing-in-dest file is expected; a DIFFERING file
// never is.
function verifyCopy(srcHashes, destRoot) {
  const dest = fileHashes(destRoot);
  const mismatched = [];
  let checked = 0;
  for (const [rel, hash] of srcHashes) {
    if (!dest.has(rel)) continue;
    checked++;
    if (dest.get(rel) !== hash) mismatched.push(rel);
  }
  return { checked, mismatched };
}

// ─── Git wiring ──────────────────────────────────────────────────────────────

function git(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', ...opts });
}

function registerMergeDriver(repo, driverPath) {
  git(repo, ['config', 'merge.aim-memory.name', 'AIM knowledge graph semantic merge']);
  // Single-quoted: git passes this to a shell, and the path can contain spaces.
  git(repo, ['config', 'merge.aim-memory.driver', `node '${driverPath}' %O %A %B %P`]);
}

// A DIRECTORY symlink, never a file symlink: a directory symlink survives any write
// style, including a future temp-file-plus-rename, because the rename then happens
// inside the real target directory.
function createBridge(oldPath, newPath) {
  // The old path may already BE a bridge symlink synced here from another Mac — and on
  // a machine with a different username it dangles, since it names an absolute path that
  // cannot exist. Replace it rather than parking a broken link as if it were data.
  let existing = null;
  try { existing = fs.lstatSync(oldPath); } catch { /* nothing there at all */ }

  if (existing && existing.isSymbolicLink()) {
    fs.unlinkSync(oldPath);
    fs.symlinkSync(newPath, oldPath);
    return null;  // nothing was parked, because nothing real was there
  }

  if (!existing) {
    fs.symlinkSync(newPath, oldPath);
    return null;
  }

  const parked = `${oldPath}.migrated-${new Date().toISOString().slice(0, 10)}`;
  fs.renameSync(oldPath, parked);
  fs.symlinkSync(newPath, oldPath);
  return parked;
}

// ─── Background sync ─────────────────────────────────────────────────────────
//
// Runs unattended, so it must never end in a state a person has to unpick. It stages,
// commits, then pulls with rebase and autostash before pushing — the semantic merge
// driver resolves overlapping edits during the rebase. On any failure it stops and
// leaves a log rather than forcing anything.

function syncScript(repo, logPath) {
  const nodeDir = path.dirname(process.execPath);
  return `#!/bin/sh
# Claude memory background sync — installed by setup-claude-memory --git.
# Safe to run at any time, including while Claude is writing.
set -u

# launchd runs this with a minimal PATH that excludes Homebrew and other non-system
# node installs. The merge driver is invoked by git as a bare \`node ...\` command, so
# without this, any real merge silently falls back to git's text merge and leaves
# conflict markers in memory.jsonl instead of resolving automatically.
export PATH=${JSON.stringify(nodeDir)}:/opt/homebrew/bin:/usr/local/bin:"$PATH"

REPO=${JSON.stringify(repo)}
LOG=${JSON.stringify(logPath)}

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG"; }

cd "$REPO" 2>/dev/null || { log "FAIL repo missing"; exit 1; }

git add -A
if ! git diff --cached --quiet; then
  git commit -q -m "memory: $(date -u +%Y-%m-%dT%H:%MZ)" || { log "FAIL commit"; exit 1; }
fi

# --autostash so an in-flight write by a live session does not block the rebase.
if ! git pull --rebase --autostash -q 2>>"$LOG"; then
  # Name the files that actually conflicted. The merge driver only handles memory
  # stores, so anything else landing here is a different problem — saying "the driver
  # refused" when it did not is how a five-minute fix becomes an afternoon.
  CONFLICTED=$(git diff --name-only --diff-filter=U 2>/dev/null | tr '\n' ' ')
  if [ -n "$CONFLICTED" ]; then
    log "FAIL rebase — unresolved conflict in: $CONFLICTED"
    log "     (the memory stores merge automatically; a conflict here means some OTHER file diverged)"
  else
    log "FAIL pull/rebase — see the git output above."
  fi
  git rebase --abort 2>/dev/null
  exit 1
fi

if ! git push -q; then
  log "FAIL push (offline or auth expired) — commits are safe locally, will retry next run."
  exit 1
fi
`;
}

function launchAgentPlist(label, scriptPath, intervalSeconds) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${label}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/bin/sh</string>
\t\t<string>${scriptPath}</string>
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>StartInterval</key>
\t<integer>${intervalSeconds}</integer>
</dict>
</plist>
`;
}

// ─── Joining an existing repo (second machine) ───────────────────────────────
//
// A clone is NOT enough. `.gitattributes` is tracked and comes down with the clone, but
// the merge driver lives in .git/config, which does not — so a freshly cloned machine
// sees `merge=aim-memory`, finds no such driver, and silently falls back to git's text
// merge. That produces conflict markers in memory.jsonl in precisely the two-machine
// case this system exists to make safe. Verified 2026-09-06.

function repoExistsOnAccount(name) {
  return spawnSync('gh', ['repo', 'view', name, '--json', 'name'], { encoding: 'utf8' }).status === 0;
}

function cloneMemoryRepo(name, dest) {
  const r = spawnSync('gh', ['repo', 'clone', name, dest], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`clone failed: ${(r.stderr || '').trim().split('\n')[0]}`);
}

// A second Mac may have been writing to its own local store. Report anything it holds
// that the repo does not, rather than parking it silently and calling that a migration.
function observationsMissingFromRepo(localStoreDir, repoDir) {
  const read = (dir) => {
    const f = path.join(dir, 'memory.jsonl');
    // existsSync follows symlinks, so a dangling bridge reads as absent — which is
    // exactly right: there is no local memory here to compare.
    if (!fs.existsSync(f)) return null;
    const map = new Map();
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'entity') map.set(o.name, new Set(o.observations || []));
    }
    return map;
  };
  const local = read(localStoreDir);
  const repo = read(repoDir);
  if (!local || !repo) return { comparable: false, entities: [], total: 0 };

  const entities = [];
  let total = 0;
  for (const [name, obs] of local) {
    const there = repo.get(name) || new Set();
    const missing = [...obs].filter(o => !there.has(o));
    if (missing.length) { entities.push({ name, missing: missing.length }); total += missing.length; }
  }
  entities.sort((a, b) => b.missing - a.missing);
  return { comparable: true, entities, total };
}

module.exports = {
  repoExistsOnAccount,
  cloneMemoryRepo,
  observationsMissingFromRepo,
  syncScript,
  launchAgentPlist,
  unsafeRepoLocation,
  defaultRepoLocation,
  desktopDocumentsSynced,
  checkGitPrereqs,
  GITIGNORE,
  GITATTRIBUTES,
  repoReadme,
  fileHashes,
  copyTree,
  verifyCopy,
  git,
  registerMergeDriver,
  createBridge,
  which,
};
