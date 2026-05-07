# setup-claude-memory — Working on This Repo

Project CLAUDE.md. Read this alongside Kam's global CLAUDE.md at `~/.claude/CLAUDE.md`.

## Project Overview

`kamrenkennedy/setup-claude-memory` — the interactive CLI that bootstraps Kam's entire Claude persistent memory stack:

1. **Kam-Memory MCP** (AIM knowledge graph via `mcp-knowledge-graph`) — quick facts, project status, entity relationships
2. **Kam-Deep-Context MCP** (`aim-deep-context-server`, shipped inside this package) — long-form session archive with semantic search, entity extraction, and graph traversal
3. **iCloud sync** — memory files live in `~/Library/Mobile Documents/com~apple~CloudDocs/Claude Memory/` so all Macs share state
4. **Multi-user support** — Tiera (Kam's wife) runs the same CLI, gets her own personalized `Tiera-Memory` / `Tiera-Deep-Context` servers on her own iCloud account
5. **Family memory layer** (v1.5.0+) — shared memory in `Kennedy Family Docs/Claude/Family Memory/` that both their Claudes read for family topics

Published to npm as [`setup-claude-memory`](https://www.npmjs.com/package/setup-claude-memory). Users run `npx setup-claude-memory` — no install needed.

## Tool Catalog

### Kam-Memory MCP (`mcp-knowledge-graph` — invoked via `npx -y mcp-knowledge-graph --memory-path <path>`)

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

**Personal memory syncs automatically via iCloud.** Add a Mac → run `npx setup-claude-memory` → it detects the existing `config.json` on iCloud (reads `first_name`), skips the full setup, and registers the MCP servers in Claude Desktop's config on the new machine. iCloud folder is pinned to disk via `xattr -w com.apple.LaunchServices.OpenWithAppBundleIdentifier ... -r` (Keep Downloaded) so it stays available offline.

**Fort Abode handles version updates.** `FortAbodeUtilityCentral/Resources/component-registry.json` has `setup-claude-memory` wired to `npm_registry` as the update source. Fort Abode checks npm on a schedule and offers one-click updates. No bundled files — pure npx, so no drift risk unlike weekly-rhythm.

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

- **Fort Abode Utility Central** (`kamrenkennedy/FortAbodeUtilityCentral`) — SwiftUI macOS app that manages updates to this CLI + other Claude components. Installed on Kam's and Tiera's Macs. Detects new `setup-claude-memory` versions via npm and offers update.
- **Weekly Rhythm Engine** (`kamrenkennedy/weekly-rhythm`) — sibling skill/engine. Same deployment pattern (iCloud templates → family folder). Reference model for how Fort Abode ships skills.
- **mcp-knowledge-graph** — npm package providing the AIM knowledge graph MCP server. We invoke via `npx -y mcp-knowledge-graph --memory-path <path>`. Not maintained by us.

## Shipping through Fort Abode

This package ships through Fort Abode Utility Central as a managed component. Fort Abode auto-detects new npm versions and offers one-click updates.

**What Fort Abode's component-registry.json knows about this package:**

| Field | Value |
|---|---|
| `version_source` | `npx_cache` → `npm_registry` |
| `update_source` | `npm_registry` (package: `setup-claude-memory`) |
| `update_command` | `npx_install` |
| `min_app_version` | unset — any Fort Abode version can install |
| Bundled files | none (pure npx) — no drift risk |

**Update Fort Abode's marketplace copy (`user_description` + `usage_instructions`) when:** the new version adds user-visible behavior (new flags, new prompts, new memory features). Skip for mechanical bumps.

**Cross-repo ship checklist (distilled from past failures — see deep context `fort-abode-v361-weekly-rhythm-v170-patch-2026-04-13` and `fort-abode-v3.7.0-dashboard-v2.0.0-planning-2026-04-14`):**

1. npm ↔ GitHub parity: `npm view setup-claude-memory version` matches `git describe --tags`
2. Both Fort Abode appcast files agree — **#1 historical failure mode** (N/A for setup-claude-memory; critical for weekly-rhythm)
3. Bundled artifacts match canonical — N/A here (pure npx), but the trap for any repo with bundled files
4. Canonical version headers bumped, not just copied forward
5. Upstream repo hygiene: CHANGELOG updated, releases/ folder populated, clean `git status`, tag pushed
6. Never `git add -A` — always explicit filenames (avoids accidentally committing `.env`, `.tgz`, etc.)
7. Update Fort Abode's `user_description` / `usage_instructions` in component-registry for user-visible features
8. Add a user-facing entry to `FortAbodeUtilityCentral/Resources/whats-new.json` so users see the change in Fort Abode's WHAT'S NEW panel after auto-update
9. `aim_memory_add_facts` on `Fort_Abode_Utility_Central` entity after shipping

**Before touching the Fort Abode repo itself:** read `FortAbodeUtilityCentral/CLAUDE.md` — don't assume Memory System protocol applies there.

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
9. Update Fort Abode memory entity (`aim_memory_add_facts` on `Fort_Abode_Utility_Central`) so Fort Abode coordination notes stay current

## Conventions

- **Never clobber user-edited files.** The installer deploys templates only when they're missing. `FAMILY_MEMORY.md`, `changelog.md`, `config.json` — once written, never overwritten.
- **Templates are authoritative here, deployed there.** Edit in `templates/` within the repo; the CLI copies them to iCloud at install time.
- **Version tracking via file headers.** Templates that are app-managed (not user-editable) carry a version comment in the first few lines so the CLI / Fort Abode can detect when to refresh.
- **Idempotent routing-block inserts.** Appending to `~/.claude/CLAUDE.md` always uses magic marker comments (`<!-- family-memory-routing v1 -->` ... `<!-- /family-memory-routing -->`) so repeated runs don't duplicate.
- **Imperative commit messages, explain the why.** See global CLAUDE.md.

## Known limitations / future work

**Memory MCP is append-only with no consolidation or tiering.** After 50+ sessions on a project, entities like `Fort_Abode_Utility_Central` grow to 900+ observations and overflow `aim_memory_get` / `aim_memory_search`. Root cause: convention drift — sessions wrote multi-paragraph narrative observations instead of short pointer-style entries.

**Workaround (in handoff skill):** RECEIVE step uses tail-by-default — `jq -r '.[0].text' "$saved" | tail -c 15000`. Full context: deep context doc `handoff-skill-worktree-banner-and-memory-tail-fix-2026-04-30`.

**Planned MCP-side improvements (filed for a future session):**
- Add `tail_chars` / `recent_n` param to `aim_memory_get` for native pagination (no jq dance)
- New `aim_memory_consolidate(name)` op — summarize oldest observations into a single "pre-YYYY-MM consolidated" entry. Pattern: Mem0 async summary, Letta hot/warm/cold tiering.
- Convention enforcement: tighten global CLAUDE.md to mandate short pointer-style observations. Long-form narratives belong in Deep Context.

## Current state (update at end of each session)

- **Local + GitHub:** v1.5.0 (commit `5a2d982 Ship family memory (v1.5.0)`, clean)
- **npm latest:** v1.5.0 (matches)
- **Tag:** v1.5.0 pushed
- **In progress:** none — CLAUDE.md refresh + memory cleanup session (2026-05-06)
- **Open follow-ups (no urgency):** Fort Abode component-registry `user_description` / `usage_instructions` still doesn't mention `--family` flag (logged 2026-04-14, defer to next Fort Abode bump). MCP-side memory improvements above filed for a dedicated session.
- **Last shipped:** v1.5.0 family memory feature on 2026-04-14 — Fort Abode v3.7.1 paired same day.
