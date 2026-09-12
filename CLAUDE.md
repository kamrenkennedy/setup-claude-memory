# setup-claude-memory — Working on This Repo

Project CLAUDE.md. Read this alongside Kam's global CLAUDE.md at `~/.claude/CLAUDE.md`.

## Project Overview

`kamrenkennedy/setup-claude-memory` — the interactive CLI that bootstraps Kam's entire Claude persistent memory stack:

1. **Kam-Memory MCP** (`aim-memory-server`, shipped inside this package since v1.6.0 — search-first reads, drop-in replacement for the third-party `mcp-knowledge-graph`) — quick facts, project status, entity relationships
2. **Kam-Deep-Context MCP** (`aim-deep-context-server`, shipped inside this package) — long-form session archive with semantic search, entity extraction, and graph traversal
3. **iCloud sync** — memory files live in `~/Library/Mobile Documents/com~apple~CloudDocs/Claude Memory/` so all Macs share state
4. **Multi-user support** — Tiera (Kam's wife) runs the same CLI, gets her own personalized `Tiera-Memory` / `Tiera-Deep-Context` servers on her own iCloud account
5. **Family memory layer** (v1.5.0+) — shared memory in `Kennedy Family Docs/Claude/Family Memory/` that both their Claudes read for family topics

Published to npm as [`setup-claude-memory`](https://www.npmjs.com/package/setup-claude-memory). Users run `npx setup-claude-memory@latest` — no install needed. **The `@latest` is not optional; see the npx-cache trap below.**

## Tool Catalog

### Kam-Memory MCP (`aim-memory-server`, shipped in this package since v1.6.0 — invoked via `npx -y --package=setup-claude-memory@latest aim-memory-server --memory-path <path>`; drop-in replacement for the third-party `mcp-knowledge-graph`)

| Tool | Purpose |
|---|---|
| `aim_memory_store` | Create a new entity with initial observations |
| `aim_memory_get` | Retrieve specific entities by exact name |
| `aim_memory_search` | Keyword search across names, types, and observations |
| `aim_memory_read_all` | Dump all entities in a database (JSON or pretty) |
| `aim_memory_list_stores` | List available databases (default, brand, family, etc.) |
| `aim_memory_add_facts` | Append observations to an existing entity |
| `aim_memory_remove_facts` | Delete specific observations from an entity |
| `aim_memory_forget` | Delete an entity entirely |
| `aim_memory_link` | Create a relation between two entities |
| `aim_memory_unlink` | Remove a relation |

### Kam-Deep-Context MCP (`aim-deep-context-server` — `bin/deep-context-server.mjs` in this repo)

| Tool | Purpose |
|---|---|
| `aim_deep_store` | Store a long-form markdown document (session summaries, narratives, decision logs) |
| `aim_deep_search` | Keyword / tag / date-range search across document index |
| `aim_deep_semantic_search` | Vector similarity search (meaning-based, not keyword) |
| `aim_deep_get` | Retrieve full content of a specific document by ID |
| `aim_deep_list` | List all documents sorted by date descending |
| `aim_deep_delete` | Delete a document by ID |
| `aim_deep_extract_entities` | Pull entity facts from a document into the knowledge graph |
| `aim_deep_graph_search` | Graph traversal across entity relations |
| `aim_deep_reindex` | Rebuild vector embeddings for all documents |

## Authentication Model

**Local file-based, no authentication.** All data lives in iCloud files on the local machine. File system permissions only — no tokens, no OAuth, no env vars.

Multi-user model: each user's Claude memory writes to their own iCloud account (`~/Library/Mobile Documents/com~apple~CloudDocs/Claude Memory/`). Family memory is a shared iCloud folder (`Kennedy Family Docs/Claude/Family Memory/`) that both Kam's and Tiera's Claudes can write to — conflict avoidance is by convention (changelog is append-only; `FAMILY_MEMORY.md` edits are section-by-section, never whole-file rewrites).

## Cross-Machine Considerations

**Personal memory syncs automatically via iCloud.** Add a Mac → run `npx setup-claude-memory@latest` → it detects the existing `config.json` on iCloud (reads `first_name`), skips the full setup, and registers the MCP servers in Claude Desktop's config on the new machine. iCloud folder is pinned to disk via `xattr -w com.apple.LaunchServices.OpenWithAppBundleIdentifier ... -r` (Keep Downloaded) so it stays available offline.

**Updates are plain npx.** Users upgrade by running `npx setup-claude-memory@latest` — nothing else distributes this package. There are no bundled copies anywhere, so there is no drift risk.

**Family memory is a shared iCloud folder.** `Kennedy Family Docs/Claude/Family Memory/` lives under the shared Kennedy Family Docs iCloud path. Both Kam and Tiera's Claudes read/write it. The routing block installed in `~/.claude/CLAUDE.md` by this CLI triggers family memory reads on any family-related topic.

**Template edits flow from this repo to iCloud.** `templates/family-memory/` is the canonical source of family memory file templates. `bin/setup.js` deploys them at install time (never clobbers existing user edits). Sessions working on this repo may modify templates that will affect the deployed iCloud copy — verify with `diff templates/family-memory/<file> ~/Library/Mobile\ Documents/com~apple~CloudDocs/Kennedy\ Family\ Docs/Claude/Family\ Memory/<file>` before committing.

## Local Dev Setup

1. Clone and install: `git clone https://github.com/kamrenkennedy/setup-claude-memory && cd setup-claude-memory && npm install`
2. Pack the tarball: `npm pack` (produces `setup-claude-memory-X.Y.Z.tgz`)
3. Install into a scratch project (direct `npx /path/to.tgz` fails with "Permission denied" on Node 25+ — use this workaround): `mkdir /tmp/scm-test && cd /tmp/scm-test && npm install /path/to/setup-claude-memory-X.Y.Z.tgz`
4. Run in the scratch project: `node node_modules/setup-claude-memory/bin/setup.js [--family]`
5. Smoke test idempotency: run twice, confirm `~/.claude/CLAUDE.md` md5 is unchanged across runs and template files aren't clobbered
6. Clean up: `rm -rf /tmp/scm-test setup-claude-memory-X.Y.Z.tgz`

## Memory layout (where files live)

> **Slated to move.** The memory durability track (below) will relocate the store out of iCloud
> into a private git repo. Until that cutover happens, the iCloud paths here are live truth.

**Personal memory (per iCloud account):** `~/Library/Mobile Documents/com~apple~CloudDocs/Claude Memory/`
- `memory.jsonl` — AIM knowledge graph (master default database)
- `memory-<context>.jsonl` — named databases (brand, family, personal, gifts)
- `deep/` — deep context documents + `index.json`
- `config.json` — user prefs (first_name, notion_enabled, gcal_enabled, reminders_enabled)

**Family memory (shared iCloud folder):** `~/Library/Mobile Documents/com~apple~CloudDocs/Kennedy Family Docs/Claude/Family Memory/`
- `FAMILY_MEMORY.md`, `changelog.md`, `facts.json`, `facts.schema.json`, `pdf-index.md`, `pdf-cache/`, `ROUTING.md`

**Note:** Family memory is active in any Claude session (including this repo's sessions) via the routing block installed at `~/.claude/CLAUDE.md` lines 105–129. This repo IS the source of the templates (`templates/family-memory/`) deployed to the above iCloud path at install time.

## Key files

- `bin/setup.js` — main interactive CLI. Detects 3 scenarios (fresh / upgrade / new-Mac-joining) + (v1.5.0+) family memory deploy step
- `bin/deep-context-server.mjs` — MCP server for the deep context layer (see Tool Catalog above)
- `bin/apple-embed.swift` — fallback embedding engine using Apple NaturalLanguage framework (when `@huggingface/transformers` is unavailable)
- `templates/family-memory/` — canonical source for family memory file templates. Edited here, deployed by the CLI at install time (never clobbers existing user edits)
- `docs/` — architecture + design docs. Read these before making structural changes

## Related systems (not in this repo)

- **Weekly Rhythm Engine** (`kamrenkennedy/weekly-rhythm`) — sibling skill/engine, same iCloud-templates deployment pattern.
- **mcp-knowledge-graph** — the third-party server `aim-memory-server` replaced (v1.6.0+). A fresh install never touches it now. A Mac whose Kam-Memory config entry still names it directly (`args` containing `'mcp-knowledge-graph'` with no `--package=setup-claude-memory`) is running the pre-v1.6.0 legacy entry — run `npx setup-claude-memory@latest` with **no flags** to upgrade it. See Known limitations: the `--git`/`--scan`/`--compact` fast paths do NOT perform this upgrade.

## Memory durability track (opened 2026-08-30 — SHIPPED v1.7.0–v1.10.1, 2026-09-05/06)

**Status: all three parts below are built and released.** Search-first reads shipped in v1.6.0
(technically slightly before this track opened — it's the reason the track exists). The `--git`
migration flow, join-an-existing-repo, the semantic merge driver, and staged compaction (`--compact`)
shipped 2026-09-05/06. See README's "Keep memory in git" and "Search-first reads" sections for the
user-facing behavior, and Known limitations below for gaps found running it for real on 2026-09-07.
Before touching any of it, read Deep Context `content-strategy-app-memory-hand-triage-executed-2026-08-30`
for the original measurements/reconnaissance — do not re-derive them.

**Why it exists.** Manual pruning measurably fails: Content_Strategy_App regained 23K chars within
5.5 hours of a 150-observation hand triage; four manual passes in six weeks (08-14, 08-21, 08-27,
08-30). And the overflow is a READ-path problem — `mcp-knowledge-graph`'s `searchNodes` matches
entities, then returns every matching entity WHOLE (all observations; see its `dist/index.js`). Fix
the read path and entity size stops mattering permanently.

**The three parts, in order:**
1. **Private git repo as source of truth.** GitHub is the sync between machines; a local working
   copy lives outside iCloud/Dropbox (both corrupt git internals / mtimes — documented traps).
   Location call is Kam's, not yet made.
2. **Search-first reads.** A memory MCP server of our own, shipped from this package the way
   `aim-deep-context-server` already is, that returns matching observations — never a whole entity.
3. **Scheduled compaction.** Staged for Kam's per-item approval, plaud-triage style. Never a heroic
   manual pass.

**Non-negotiables for this track:**
- **The store carries secrets** (phone numbers, live prod invite codes, emails, UUIDs — scanned
  2026-08-30). Any repo must be PRIVATE, with a pre-push secret scan before the first push ever
  happens. `memory-family.jsonl` sits in the same folder.
- The loose `memory.jsonl.bak-*` / `backup-*` files (6 files, ~8.6MB as of 2026-08-30) get
  gitignored or moved out before any repo exists.
- **Nothing is ever deleted.** Moves go to an archive entity and stay recoverable.
- Notion and Obsidian were evaluated and rejected for memory storage (2026-08-30). Do not reopen.

**Config surfaces for any path cutover.** Exactly one `--memory-path` value is in use. On this Mac
it appears in FOUR live files: `~/.claude.json`, `claude_desktop_config.json`,
`~/.codex/config.toml`, and `App Projects/Persona — Content Studio/.codex/config.toml`. A cutover
updates all of them on every Mac, and leaves a tripwire at the old path (hard-fail sentinel, e.g. a
directory named `memory.jsonl`) so a machine left behind breaks loudly instead of diverging silently.

**⚠️ THE NPX CACHE TRAP — bit us for real on 2026-08-30.** A bare `npx setup-claude-memory` records
a `^X.Y.0` range on FIRST run and reuses that cached copy indefinitely, because the installed version
still satisfies the range. Kam's cache was seeded 2026-04-04 at `^1.4.0`; running the bare command
after v1.6.0 shipped silently executed the **April v1.4.0 installer**, which rewrote his config back
to `mcp-knowledge-graph` and looked like a successful install. Diagnosed by reading the cached copy's
own `kgEntry()` on disk at `~/.npm/_npx/46805c36bffd607b/`. **Always `@latest`** — in docs, in
instructions to Kam or Tiera, and in every `--package=` spec. When an install "doesn't take", check the cache version BEFORE theorising.

**Touching the live store (`memory.jsonl`) directly — mandatory discipline.** Every live session on
every Mac writes this one file; concurrent writes bit twice in one day on 2026-08-30:
- Snapshot first, and verify the snapshot (md5) before trusting it.
- Verify targets BY CONTENT immediately before writing — indices shift under concurrent writes.
- Prove the serializer round-trips the whole file byte-identically before writing anything.
- One atomic write: `mkstemp` + `os.replace`, then `chmod 0644` (mkstemp leaves 0600).
- Afterwards, verify that concurrent sessions' writes survived.

## 🟢 Go ahead — no need to ask

Docs, templates, README, CLI code changes (smoke-tested via tarball), reading any memory file,
memory/deep-context writes through the normal MCP tools.

## 🟡 Careful — allowed, but say so

Editing files in the live iCloud store outside the MCP tools; adding files to the store folder;
version bumps not yet published; changes to `bin/deep-context-server.mjs` tool contracts.

## 🔴 Stop and ask Kam — do not decide these yourself

`npm publish`; the store relocation/cutover itself; deleting or rewriting observations (condensing
the Content_Strategy_App durable core is DEFERRED and needs his explicit go-ahead); anything on
Tiera's side of the system.

## Releasing

**Fort Abode is OUT OF THE LOOP for this package (Kam's call, 2026-09-04).** That app is stalled and
due a full rework; do not add Fort Abode steps to any release here, and do not touch that repo from
this project. Distribution is plain npx and nothing else.

1. npm ↔ GitHub parity: `npm view setup-claude-memory version` matches `git describe --tags`
2. Version bumped in `package.json`, and **verify the bump actually landed in the commit** — a bump
   chained behind a failing command silently does not run, and a passing test suite afterwards makes
   the step look fine (bit us on 1.6.2)
3. `npm test` green
4. Tarball smoke test — `npm pack`, install into a scratch project, run the binary
5. README updated if user-facing behavior changed
6. Clean `git status`, tag pushed
7. Never `git add -A` — always explicit filenames
8. After publishing, verify the PUBLISHED artifact: install `setup-claude-memory@<version>` fresh from
   npm and confirm the server starts. Publishing is not proof it works.

## Session protocol

### Start
1. Global CLAUDE.md protocol (check memory + deep context, ask what to work on)
2. Read `docs/ARCHITECTURE.md` if touching the memory system's shape
3. Check `git status` and `git log --oneline -5` to know where we are
4. Verify npm version matches local: `npm view setup-claude-memory version` vs `cat package.json | grep version`

### End (session wrap)
Standard global wrap (Kam-Memory + Kam-Deep-Context), plus:
- If this session changed templates: note in deep context which templates were touched so the v1.x bump captures them
- If this session shipped a release: confirm `npm view setup-claude-memory version` shows the new version AND `git tag` has the version tag pushed

## Versioning + release process

1. Make changes
2. Bump `package.json` version (semver — minor for features, patch for fixes)
3. Update `README.md` if user-facing behavior changed
4. Commit with imperative message explaining the "why" + `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`
5. Test locally: pack + install in scratch project (see Local Dev Setup)
6. `npm publish` from repo root
7. `git tag vX.Y.Z && git push && git push --tags`
8. Verify: `npm view setup-claude-memory version`

## Conventions

- **Never clobber user-edited files.** The installer deploys templates only when they're missing. `FAMILY_MEMORY.md`, `changelog.md`, `config.json` — once written, never overwritten.
- **Templates are authoritative here, deployed there.** Edit in `templates/` within the repo; the CLI copies them to iCloud at install time.
- **Version tracking via file headers.** Templates that are app-managed (not user-editable) carry a version comment in the first few lines so the CLI can detect when to refresh.
- **Idempotent routing-block inserts.** Appending to `~/.claude/CLAUDE.md` always uses magic marker comments (`<!-- family-memory-routing v1 -->` ... `<!-- /family-memory-routing -->`) so repeated runs don't duplicate.
- **Imperative commit messages, explain the why.** See global CLAUDE.md.

## Known limitations / future work

**Memory MCP is append-only with no consolidation or tiering.** After 50+ sessions on a project, entities like `Fort_Abode_Utility_Central` grow to 900+ observations and overflow `aim_memory_get` / `aim_memory_search`. Root cause: convention drift — sessions wrote multi-paragraph narrative observations instead of short pointer-style entries.

**Workaround (in handoff skill):** RECEIVE step uses tail-by-default — `jq -r '.[0].text' "$saved" | tail -c 15000`. Full context: deep context doc `handoff-skill-worktree-banner-and-memory-tail-fix-2026-04-30`.

**Superseded 2026-08-30 by the Memory durability track (above).** Search-first reads replace the
pagination workaround; scheduled compaction replaces `aim_memory_consolidate`; the short-pointer
observation convention already landed in global CLAUDE.md.

**`--git`/`--scan`/`--compact` skip the legacy-entry upgrade (found 2026-09-07).** `main()`'s fast
path for these three flags (`bin/setup.js` ~line 191) calls `detectFromClaudeConfig` and hands
whatever it finds straight to the flag's handler — it never runs the unconditional
`config.mcpServers[serverName] = kgEntry(memoryPath)` rewrite that the plain "Scenario 1" upgrade
path (~line 267) does. Concretely: a Mac whose Kam-Memory entry was still the pre-v1.6.0 legacy
`mcp-knowledge-graph` form, that migrates straight via `--git`, keeps the legacy entry — `--git`
only relocates the store; it doesn't touch `config.mcpServers`. Symptom: `aim_memory_search` /
`aim_memory_get` return whole unbounded entities (hundreds of thousands of chars) instead of
bounded, search-first results, because the connected server actually is the old third-party one.
Fix for an affected Mac: run `npx setup-claude-memory@latest` with **no flags** — that's the only
path that performs the rewrite. Not yet fixed upstream (would mean teaching the three fast-path
branches to also check `isLegacyMemoryEntry` and rewrite before dispatching) — flag for a future
session rather than assume it's been patched.

**Background git-sync fails under launchd's minimal PATH (found + fixed 2026-09-07).** The
15-minute LaunchAgent (`com.kamstudios.claude-memory-sync`) runs `sync.sh` via `/bin/sh`, which
inherits launchd's PATH — `/opt/homebrew/bin` is not on it. `sync.sh` invokes `git pull --rebase`,
which for a genuine divergence must run the registered merge driver, itself a bare `node ...`
command — `node` isn't found, the driver silently fails to run, git falls back to text merge,
memory.jsonl gets conflict markers, and the script correctly detects the conflict and safely
`rebase --abort`s. Net effect: sync silently no-ops (not corrupts) every time there's a real
two-sided merge to do, which is exactly the case this whole system exists for. First fixed in
`0067447` (2026-09-07) but never published, and only the Mac Studio was hand-patched. Kam's MacBook
Pro failed silently 330 times until 2026-09-12 (Deep Context
`memory-sync-macbook-pro-recovered-2026-09-12`). **v1.11.0 closes the whole class:**
- `syncScript()` PATH lists every dir holding `node` on the installer's PATH, plus
  `dirname(process.execPath)` and the Homebrew prefixes. execPath alone resolves symlinks, which
  missed `~/.local/bin` on the MacBook Pro.
- sync.sh fails up front when node is missing, names the real cause of a conflict, and shows a Mac
  notification after 3 consecutive failures, then every 24 (`sync.failures` next to `sync.log`).
- Drivers are copied to `~/Library/Application Support/claude-memory-sync/`, not referenced in the
  npx cache.
- **A published fix still reaches a syncing Mac only when `npx setup-claude-memory@latest` (no
  flags) runs on it.** That run is what refreshes sync.sh and the drivers (`refreshGitSync()` in
  `bin/setup.js`). Every release that touches sync needs that run on every Mac.

**`deep/index.json` was `merge=union`, and union CORRUPTS it (found 2026-09-12, fixed v1.11.0).**
The index is a pretty-printed JSON array. Two machines adding a doc before syncing interleaved into
invalid JSON, and `readIndex()` swallowed the parse error, so the next store rewrote the index with
one entry. **Confirmed in store history:** 1,953 entries → invalid at `05ce351` → reset to 2 at
`31b4812` (2026-09-08), then again → 1 at `ccf7f44`. The `.md` files survived. v1.11.0 ships
`bin/deep-index-merge-driver.mjs` (`merge=aim-index`, id-keyed 3-way, refuses on conflict), upgrades
old `.gitattributes` in place, and makes `readIndex()` throw on invalid JSON instead of returning
`[]` (a 🟡 tool-contract change: tools now error visibly on a corrupt index). A Mac that has not
upgraded yet has no `aim-index` driver. Git then falls back to a text merge, which conflicts and
aborts the sync rather than corrupting anything (verified).

## Current state (update at end of each session)

- **Local + GitHub:** v1.11.0, main `4113881`, tagged `v1.11.0`. **npm latest:** v1.11.0 (shasum
  `474226b4…`). Parity confirmed 2026-09-12, and the published artifact was verified by a fresh npm
  install + handshake. Tags v1.10.0/v1.10.1 were added retroactively the same day.
- **Memory durability track:** all three parts shipped (v1.7.0–v1.10.1, 2026-09-05/06). See the
  durability-track section above.
- **This session (2026-09-07), on Kamren's Mac Studio:** Kam reported "the memory says it's not
  updated." Root cause was two independent bugs, both found live on this Mac and fixed locally
  (see Known limitations above for full detail):
  1. Kam-Memory's Desktop-config entry was still the pre-v1.6.0 legacy `mcp-knowledge-graph` form
     (never upgraded — this Mac's `--git` migration on 2026-09-06 used the fast path that skips
     the rewrite). Kam-Deep-Context was also missing its `@latest` pin. Both hand-fixed in
     `claude_desktop_config.json` to match `kgEntry()`/`deepEntry()` exactly — **needs Claude
     Desktop fully quit (Cmd+Q) and relaunched to take effect**, not yet confirmed done.
  2. The 15-min background sync LaunchAgent had been silently failing on any real merge since
     today's `node: command not found` (launchd PATH lacks `/opt/homebrew/bin`) — safely
     `rebase --abort`ed each time, so no data was lost, but this Mac had stopped receiving new
     commits from elsewhere. Fixed live (`sync.sh` patched by hand + manual sync run, confirmed
     `HEAD` == `origin/main`), and fixed upstream in `bin/git-migrate.js`'s `syncScript()`.
  3. The `git-migrate.js` fix was committed as `0067447`. It is still **unpublished**, so every
     Mac's installed `sync.sh` has the bug until it ships or gets hand-patched.
  - Also ran `/skills-sync`: all 22 MANIFEST skills correct, no drift. One external-tool gap
    (`codebase-memory-mcp` not installed here) — flagged, install deferred to Kam (per-item
    approval rule; a Systems reminder is open). Closed two stale Systems reminders this session's
    fixes resolved: the skill-drift "3 issue(s)" reminder (0 skill drift found) and the 🔴
    "Kam Memory MCP reading EMPTY" reminder from the 2026-09-06 migration night (verified
    `Lawn_Management_System` and 185 other lines present and intact in `memory.jsonl`).
- **2026-09-12, on Kam's MacBook Pro:** recovered the 168/14 divergence with nothing lost. Shipped
  v1.11.0 (sync hardening, see Known limitations); Kam did the npm OTP himself. Ran
  `npx -y setup-claude-memory@latest` here, which refreshed sync.sh and the drivers; Desktop config
  unchanged. Temporary recovery driver removed. **Restored the deep index** from 454 to 2,550
  entries (every doc, all embedded). Backups are in `~/Developer/claude-memory-backups/`
  (`sync-recovery-*`, `index-restore-*`, `pre-1.11.0-refresh-*`). Deep Context
  `memory-sync-macbook-pro-recovered-2026-09-12`.
  - **Mac Studio NOT yet upgraded.** Kam must run `npx setup-claude-memory@latest` there. Until
    then its sync has no alert, and a two-sided deep-index change aborts its sync (safely).
  - The deep index is now ~28MB (pretty-printed embeddings, ~11KB/doc) and is committed on every
    change. At current doc growth it nears GitHub's 100MB file limit within months. Needs a design
    call.
  - This Mac still runs the legacy `mcp-knowledge-graph` server from `~/.claude.json` and both Codex
    configs (the `--git` fast-path issue above).
- **Open follow-ups:** Tiera family-memory handoff still pending (manual in-person step). Tiera's
  side of the durability track ("Set Tiera up on the new memory system" reminder) also still open —
  Kam's side only. `AGENTS.md` (Codex twin of this file, flagged broken 2026-08-30) not rechecked
  this session.
- **Last shipped:** v1.11.0, 2026-09-12 (PR #6). Rollout: MacBook Pro done, Mac Studio pending.
