# setup-claude-memory — Working on This Repo

Project CLAUDE.md. Read this alongside Kam's global CLAUDE.md at `~/.claude/CLAUDE.md`.

## What this repo is

`kamrenkennedy/setup-claude-memory` — the interactive CLI that bootstraps Kam's entire Claude persistent memory stack:

1. **Kam-Memory MCP** (AIM knowledge graph via `mcp-knowledge-graph`) — quick facts, project status, entity relationships
2. **Kam-Deep-Context MCP** (`aim-deep-context-server`, shipped inside this package) — long-form session archive with semantic search, entity extraction, and graph traversal
3. **iCloud sync** — memory files live in `~/Library/Mobile Documents/com~apple~CloudDocs/Claude Memory/` so all his Macs share state
4. **Multi-user support** — Tiera (Kam's wife) runs the same CLI, gets her own personalized `Tiera-Memory` / `Tiera-Deep-Context` servers on her own iCloud account
5. **Family memory layer** (v1.5.0 and later) — shared memory in `Kennedy Family Docs/Claude/Family Memory/` that both their Claudes read for family topics

Published to npm as [`setup-claude-memory`](https://www.npmjs.com/package/setup-claude-memory). Users run `npx setup-claude-memory` — no install needed.

## Where the actual memory lives

> **Slated to move.** The memory durability track (below) will relocate the store out of iCloud
> into a private git repo. Until that cutover happens, the iCloud paths here are live truth.

- **Personal memory (per iCloud account):** `~/Library/Mobile Documents/com~apple~CloudDocs/Claude Memory/`
  - `memory.jsonl` — AIM knowledge graph
  - `deep/` — deep context documents + `index.json`
  - `config.json` — user prefs (first_name, notion_enabled, gcal_enabled, reminders_enabled)
- **Family memory (shared iCloud folder):** `~/Library/Mobile Documents/com~apple~CloudDocs/Kennedy Family Docs/Claude/Family Memory/`
  - `FAMILY_MEMORY.md`, `changelog.md`, `facts.json`, `facts.schema.json`, `pdf-index.md`, `pdf-cache/`, `ROUTING.md`

## Key files

- `bin/setup.js` — main interactive CLI. Detects 3 scenarios (fresh / upgrade / new-Mac-joining) + (v1.5.0+) family memory deploy step
- `bin/deep-context-server.mjs` — MCP server for the deep context layer. Exposes `aim_deep_store`, `aim_deep_search`, `aim_deep_semantic_search`, `aim_deep_get`, `aim_deep_list`, `aim_deep_delete`, `aim_deep_extract_entities`, `aim_deep_graph_search`, `aim_deep_reindex`
- `bin/apple-embed.swift` — fallback embedding engine using Apple NaturalLanguage framework (when `@huggingface/transformers` is unavailable)
- `templates/family-memory/` — canonical source for family memory file templates. Edited here, deployed by the CLI at install time (never clobbers existing user edits)
- `docs/` — architecture + design docs. Read these before making structural changes

## Related systems (not in this repo)

- **Fort Abode Utility Central** (`kamrenkennedy/FortAbodeUtilityCentral`) — SwiftUI macOS app that manages updates to this CLI + other Claude components. Installed on Kam's and Tiera's Macs. Detects new `setup-claude-memory` versions via npm and offers update. v3.7.0 shipped 2026-04-14.
- **Weekly Rhythm Engine** (`kamrenkennedy/weekly-rhythm`) — sibling skill/engine. Same deployment pattern (iCloud templates → family folder). Reference model for how Fort Abode ships skills.
- **mcp-knowledge-graph** — npm package providing the AIM knowledge graph MCP server. We invoke via `npx -y mcp-knowledge-graph --memory-path <path>`. Not maintained by us.

## Memory durability track (opened 2026-08-30 — in flight, NOTHING BUILT YET)

The whole-store upgrade: memory out of iCloud into a private git repo, search-first reads, scheduled
compaction. Before touching any of it, read Deep Context
`content-strategy-app-memory-hand-triage-executed-2026-08-30` — it holds the measurements and
reconnaissance. Do not re-derive them.

**Why it exists.** Manual pruning measurably fails: Content_Strategy_App regained 23K chars within
5.5 hours of a 150-observation hand triage; four manual passes in six weeks (08-14, 08-21, 08-27,
08-30). And the overflow is a READ-path problem — `mcp-knowledge-graph`'s `searchNodes` matches
entities, then returns every matching entity WHOLE (all observations; see `dist/index.js`). Fix the
read path and entity size stops mattering permanently.

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

**Touching the live store (`memory.jsonl`) directly — mandatory discipline.** Every live session on
every Mac writes this one file; concurrent writes bit twice in one day on 2026-08-30:
- Snapshot first, and verify the snapshot (md5) before trusting it.
- Verify targets BY CONTENT immediately before writing — indices shift under concurrent writes.
- Prove the serializer round-trips the whole file byte-identically before writing anything.
- One atomic write: `mkstemp` + `os.replace`, then `chmod 0644` (mkstemp leaves 0600).
- Afterwards, verify that concurrent sessions' writes survived.

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
5. Test locally: `npm pack && npx ./setup-claude-memory-X.Y.Z.tgz` in a scratch folder
6. `npm publish` from repo root
7. `git tag vX.Y.Z && git push && git push --tags`
8. Verify: `npm view setup-claude-memory version`
9. Update Fort Abode memory entity (`aim_memory_add_facts` on `Fort_Abode_Utility_Central`) so Fort Abode coordination notes stay current

## Conventions

- **Never clobber user-edited files.** The installer deploys templates only when they're missing. `FAMILY_MEMORY.md`, `changelog.md`, `config.json` — once written, never overwritten.
- **Templates are authoritative here, deployed there.** Edit in `templates/` within the repo; the CLI copies them to iCloud at install time.
- **Version tracking via file headers.** Templates that are app-managed (not user-editable) carry a version comment in the first few lines so the CLI / Fort Abode can detect when to refresh.
- **Idempotent routing-block inserts.** Appending to `~/.claude/CLAUDE.md` always uses magic marker comments (`<!-- family-memory-routing v1 -->` ... `<!-- /family-memory-routing -->`) so repeated runs don't duplicate.
- **Imperative commit messages, explain the why.** See global CLAUDE.md.

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

## Shipping to Fort Abode (downstream distribution)

Fort Abode Utility Central is the distribution channel for `setup-claude-memory` to Kam and Tiera's Macs. When a new version lands on npm, Fort Abode's scheduled component check polls `npm view setup-claude-memory version` and surfaces the update in-app. **A routine version bump requires ZERO Fort Abode code changes** — but there are traps worth walking through before declaring "shipped".

### What Fort Abode already knows about this package

`FortAbodeUtilityCentral/Resources/component-registry.json` has a `setup-claude-memory` entry with:
- `version_source.npx_cache.package_name` → reads installed version from the local npx cache
- `update_source.npm_registry.package_name` → polls npm for new versions
- `update_command.npx_install.package_name` → runs `npx setup-claude-memory` on accept
- `user_description` + `usage_instructions` → marketplace card copy shown to users
- **No `min_app_version` pin** → any Fort Abode version can install the latest
- **No bundled files** → unlike `weekly-rhythm` (which Fort Abode bundles in `Resources/`), `setup-claude-memory` is pure npx. No drift risk from stale bundled artifacts.

### When the new version adds user-visible behavior

If the version adds a flag or feature Tiera would want to know about before updating (e.g., the v1.5.0 `--family` flag), **update the Fort Abode component-registry.json** `user_description` and/or `usage_instructions` so the marketplace card reflects the new capability. Mechanical updates (bug fixes, refactors, dependency bumps) do not need this.

That is a Fort Abode repo change — commit + push + schedule it into the next Fort Abode release, or let it ride the next natural Fort Abode bump. Do not bump Fort Abode's version just for a copy change unless it has been sitting for a while.

### Cross-repo ship checklist (lessons from past failures)

Before reporting "shipped" on any setup-claude-memory release, walk this checklist. Items 2, 3, 4, and 5 come from real cross-repo failures logged in deep context under `fort-abode-v361-weekly-rhythm-v170-patch-2026-04-13` and `fort-abode-v3.7.0-dashboard-v2.0.0-planning-2026-04-14` — they are not hypothetical:

1. **npm ↔ GitHub parity.** `npm view setup-claude-memory version` matches `git describe --tags`. If GitHub is ahead of npm, `npm publish` was skipped.
2. **Both Fort Abode appcast files agree.** Fort Abode has `appcast.xml` in TWO locations (repo root + subdirectory). Historical #1 failure: update one, forget the other. Only relevant if this ship also requires a Fort Abode re-release — but check.
3. **Bundled artifacts match canonical.** N/A for setup-claude-memory (no bundled files), but the trap exists for weekly-rhythm. v3.6.1 shipped the new engine-spec but left the bundled dashboard-template stale — don't repeat.
4. **Canonical version headers bumped, not just copied.** Any file with `version: vX.Y.Z` in its header must be bumped at the canonical source, not copied forward from a stale original. v1.7.0 shipped without bumping the iCloud dashboard header → Run Health pill couldn't detect drift.
5. **Upstream repo hygiene.** The source repo must have: CHANGELOG entry (if the repo uses one), `releases/` folder entry (if the repo uses one), clean `git status`, pushed commit, pushed tag. v1.7.0 shipped "without touching the Dropbox repo at all" → repo drifted entirely.
6. **Never `git add -A`.** Always stage explicit filenames. Both Fort Abode and this repo have untracked noise (preview HTML, scratch docs, large unrelated assets) that must not be committed.
7. **Component-registry user copy.** If the new version has user-visible features, update Fort Abode's `component-registry.json` `user_description` / `usage_instructions` (see above).
8. **Fort Abode memory entity update.** After shipping, `aim_memory_add_facts` on `Fort_Abode_Utility_Central` with a "saw setup-claude-memory vX.Y.Z ship on DATE" observation. Future Fort Abode sessions will know the npm state without having to poll.
9. **Fort Abode WHAT'S NEW entry.** If the release adds anything a user would notice (new flag, changed behavior, new MCP managed, family memory update), add an entry to `FortAbodeUtilityCentral/Resources/whats-new.json` for the Fort Abode release that will carry this version bump. Without it, users see a Fort Abode update card with no description of what their Memory component actually changed. Format: `{"version": "X.Y.Z", "notes": ["..."]}` at the top of the array. This goes in the Fort Abode repo — coordinate with its release cycle.

### Before touching the Fort Abode repo itself

Read `/Users/kamrenkennedy/Library/CloudStorage/Dropbox-KamStudios,LLC/Aligned/Projects/Fort Abode Utility Central/CLAUDE.md` first. It has its own handoff protocol, release pipeline, signing quirks, and non-negotiables section. Do not assume the Memory System protocol applies there.

## Current state (update at end of each session)

- **Local + GitHub:** v1.5.0, tag pushed. **npm latest:** v1.5.0 — parity re-verified 2026-08-30.
- **Fort Abode:** registry ready for v1.5.0, no code change needed. Marketplace copy still doesn't
  mention `--family`; open question unchanged (update copy vs ride the next natural release).
- **Memory durability track:** design + reconnaissance done 2026-08-30, nothing built. OPEN CALL for
  Kam: where the store's git working copy lives (git-init-in-place in iCloud is rejected as a
  corruption hazard). Then in order: gitignore/move backups → private repo + pre-push secret scan →
  search-first read server → scheduled compaction. Deep Context:
  `content-strategy-app-memory-hand-triage-executed-2026-08-30`.
- **Tiera handoff** for family memory: still pending (manual in-person step).
- **Last session (2026-08-30):** modernized this CLAUDE.md (durability track, store-touch
  discipline, config-surface map, 🟢🟡🔴 tiers) and committed April's until-then-uncommitted Fort
  Abode shipping section with it. NOTE: untracked `AGENTS.md` (Codex twin of this file) is a raw
  Claude→Codex find-replace with broken paths (`Codex Memory`, `setup-Codex-memory`) — fix before
  trusting or committing it.
