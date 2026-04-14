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

## Current state (update at end of each session)

- **Local + GitHub:** v1.4.0 (2026-04-14, clean)
- **npm latest:** v1.4.0
- **In progress:** v1.5.0 family memory feature — templates in `templates/family-memory/` created this session, `bin/setup.js` changes deferred to next session (Phase 2 of plan `pure-sparking-grove.md`)
- **Last session:** Initial Family Memory workspace setup — cloned repo to new Dropbox location (`Projects/Memory System`), archived old checkout, created templates + docs, hand-deployed family memory structure to iCloud on Kam's side
