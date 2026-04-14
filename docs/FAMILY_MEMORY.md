# Family Memory — Design Doc

_The rationale, shape, and non-goals for the family memory layer added in setup-claude-memory v1.5.0._

## The problem

Kam and Tiera both run personalized Claude memory stacks. Each has their own `Kam-Memory` / `Tiera-Memory` knowledge graph and their own deep context archive, bootstrapped by `setup-claude-memory` and managed through Fort Abode. But everything is siloed per-person. When either of them asks Claude a family question — "what's our 2026 health insurance deductible?", "when's the house inspection?", "what's our vet's phone?" — neither of their individual memories has the answer, and Claude has to ask every time.

At the same time, they already have a shared iCloud folder (`Kennedy Family Docs`) that both their Macs see. It's where shared docs live — insurance, house records, wedding planning, etc. The gap is that nothing in that folder is structured for Claude to read; there's no protocol telling Claude "go here for family stuff."

## The goal

A single, authoritative family memory layer that both Kam's and Tiera's Claude sessions read and write, regardless of which machine or which user is asking. Must:

1. Live in the existing shared iCloud folder so sync is free
2. Be markdown-first so it's readable from Cowork, Claude.ai, Claude Desktop, and Claude Code interchangeably
3. Handle concurrent edits safely (iCloud doesn't merge)
4. Index the PDFs already in the family folder (starting with 2026 health insurance) without duplicating them
5. Route automatically — Kam and Tiera shouldn't have to tell Claude where to look
6. Ship via `setup-claude-memory` so Tiera gets it on her Macs via the same update flow she already uses

## The shape

Seven files inside `Kennedy Family Docs/Claude/Family Memory/`:

| File | Purpose | Edit pattern |
|---|---|---|
| `FAMILY_MEMORY.md` | Main narrative, section-organized (Household, Insurance, House, Vehicles, Finances, Contacts, Travel, ...) | Surgical per-section |
| `changelog.md` | Append-only log of changes with ISO timestamps + initials (KK/TK) | Append-only |
| `facts.json` | Structured quick-lookup facts validated by `facts.schema.json` | Whole-key replace, then update `last_modified` |
| `facts.schema.json` | JSON schema for facts.json — prevents key drift between sessions | Rare updates |
| `pdf-index.md` | One-line summary per PDF in the family folder + absolute path to the source | Append |
| `pdf-cache/*.txt` | Cached extracted text per PDF (created first time a PDF is parsed) | Append-only (per-file) |
| `ROUTING.md` | Canonical routing protocol — same block gets appended to `~/.claude/CLAUDE.md` | Template-managed |

Plus `changelog-archive/YYYY-MM.md` for rolled-off old changelog entries.

## The routing mechanism

Claude discovers family memory via a block inserted into each user's `~/.claude/CLAUDE.md`. The block says: "For family topics, read these markdown files in this order. Session wrap: append to changelog and update the relevant section."

The block is marked by HTML comment bookends (`<!-- family-memory-routing v1 -->` / `<!-- /family-memory-routing -->`) so the CLI can append idempotently — re-runs find the marker and skip. A future version can rewrite the block in place by finding the bookends and replacing between them.

## Why markdown, not an AIM context

Considered four designs:

| Design | Verdict |
|---|---|
| New AIM context `family` in shared folder | ❌ AIM MCP only supports `project` or `global` locations, not arbitrary iCloud paths. Would require changes to `mcp-knowledge-graph` which we don't maintain. |
| Symlink `family` AIM memory to shared folder | ❌ Flaky under iCloud, breaks on machine transitions, hard for Tiera to set up. |
| Plain markdown + CLAUDE.md routing | ✅ Zero MCP changes, works in Cowork, readable from any client, concurrent-edit safe with simple discipline. |
| Hybrid (markdown + structured JSON for facts) | ✅ Adopted. Narrative in markdown, lookups in `facts.json` with a schema. |

The hybrid keeps narrative prose where Claude writes well (markdown) and structured lookups where precision matters (`facts.json` with schema validation).

## Why not just one big markdown file

Considered consolidating everything into a single `FAMILY_MEMORY.md`. Rejected because:

- **Concurrent-edit safety** gets worse when every change rewrites the whole file
- **Session-wrap discipline** benefits from a dedicated append-only changelog — impossible if everything is in one file
- **PDF handling** needs its own index so Claude can decide which PDF to open without parsing all of them
- **Structured lookups** (deductibles, phone numbers) are best served by JSON not prose

Seven files is the sweet spot: each has one job, each has a clear edit pattern, concurrent-edit risk is contained to the append-only changelog.

## Why ship via setup-claude-memory, not as a separate Fort Abode module

Considered building a new `FamilyMemoryService.swift` in Fort Abode (modeled on `WeeklyRhythmService.swift`). Rejected for v1 because:

- `setup-claude-memory` is already the tool both users run to manage their memory stack
- Adding family deploy to the CLI keeps the personal + family setup in one place
- Fort Abode already detects new `setup-claude-memory` versions via npm and offers update — so Tiera still gets the v1.5.0 update through her normal Fort Abode flow, she just runs the CLI one more time to activate the family side
- Avoids growing Fort Abode's surface area for a feature that only needs file deployment
- Can still be Fort-Abodeified later if friction demands it (the templates in this repo will be bundle-ready)

## Non-goals

- **Real-time sync semantics.** iCloud is eventually consistent. Family memory is for things that change on the order of days to months, not minutes.
- **Versioned history of every fact.** The changelog captures what changed; deep diffs are available via Dropbox/iCloud file versioning if needed. Not building our own.
- **Multi-family support.** This is for Kam + Tiera specifically. The folder name and routing paths hardcode `Kennedy Family Docs`. If we ever ship this broader, the install flow would parametrize the folder.
- **Access control / per-fact privacy.** Everything in the shared folder is visible to both users. If one of them wants private notes, those go in their personal memory, not family memory.
- **Automatic PDF monitoring.** When new PDFs land in the family folder, they're not auto-indexed. A Phase 3 enhancement could add this via a `chokidar` watcher or a periodic scan, but v1 requires explicit "index this PDF" steps.

## Phase 1 vs Phase 2

**Phase 1 (this session):**
- Hand-deploy all the template files to `Kennedy Family Docs/Claude/Family Memory/` on Kam's Mac
- Append the routing block to Kam's `~/.claude/CLAUDE.md` manually
- Index the 2026 health insurance PDFs
- Update AIM with the bridge entity
- Fix the "Tiera = sister" memory error
- Nothing happens on Tiera's side yet

**Phase 2 (next session):**
- Modify `bin/setup.js` to add the family memory deploy flow (both interactive detection and `--family` flag)
- Bump to v1.5.0, publish to npm, tag and push
- Tiera updates Fort Abode, runs `npx setup-claude-memory --family` on her Mac, gets the routing block and the shared folder contents

See `pure-sparking-grove.md` in `~/.claude/plans/` for the full execution plan.
