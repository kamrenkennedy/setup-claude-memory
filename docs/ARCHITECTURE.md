# Memory System Architecture

_Design overview for the Kam + Tiera memory stack. Read before making structural changes._

## The stack at a glance

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Claude Desktop / Cowork                        │
│                                                                        │
│   Reads from:                                                         │
│   • ~/.claude/CLAUDE.md  (global protocol + routing block)            │
│   • AIM memory MCP server (knowledge graph)                           │
│   • Deep context MCP server (long-form, semantic search)             │
│   • Family Memory markdown files (on-demand, routed by CLAUDE.md)    │
└──────────────────────────────────────────────────────────────────────┘
                  │
                  ├──────────────────────────────────────┐
                  ▼                                        ▼
┌─────────────────────────────────┐     ┌──────────────────────────────────┐
│   Personal iCloud Memory        │     │   Shared iCloud Family Memory    │
│   (per user, per account)       │     │   (both users, shared folder)    │
│                                 │     │                                   │
│   ~/Library/Mobile Documents/   │     │   ~/Library/Mobile Documents/    │
│     .../Claude Memory/          │     │     .../Kennedy Family Docs/      │
│     ├── memory.jsonl            │     │       Claude/Family Memory/       │
│     ├── deep/                   │     │       ├── FAMILY_MEMORY.md       │
│     │   ├── index.json          │     │       ├── changelog.md            │
│     │   └── *.md                │     │       ├── facts.json              │
│     └── config.json             │     │       ├── facts.schema.json       │
│                                 │     │       ├── pdf-index.md            │
│   Kam's Macs share one copy     │     │       ├── pdf-cache/              │
│   via his iCloud account.       │     │       ├── changelog-archive/      │
│   Tiera's Macs share one copy   │     │       └── ROUTING.md              │
│   via her iCloud account.       │     │                                   │
│                                 │     │   iCloud "Share with Others"      │
│                                 │     │   makes both accounts see it.     │
└─────────────────────────────────┘     └──────────────────────────────────┘
                  ▲                                        ▲
                  │                                        │
                  └────────────┬───────────────────────────┘
                               │
          ┌────────────────────┴──────────────────┐
          │                                        │
          ▼                                        ▼
┌──────────────────────────┐    ┌───────────────────────────────────┐
│  setup-claude-memory     │    │  Fort Abode Utility Central       │
│  (this repo)             │    │  (kamrenkennedy/FortAbode...)     │
│                          │    │                                    │
│  CLI bootstraps the      │    │  SwiftUI macOS app that manages    │
│  MCP servers + iCloud    │    │  updates to this CLI + other      │
│  folders on both Kam's   │    │  Claude infrastructure components. │
│  and Tiera's Macs via    │    │  Detects new npm versions and     │
│  `npx setup-claude-      │    │  offers per-user updates.          │
│  memory`.                │    │                                    │
│                          │    │  Already handles:                  │
│  v1.5.0 adds family      │    │  • setup-claude-memory             │
│  memory deployment.      │    │  • Weekly Rhythm Engine            │
│                          │    │  • Per-user personalization        │
│                          │    │                                    │
│  Published to npm as:    │    │  v3.7.0 shipped 2026-04-14.        │
│  `setup-claude-memory`   │    │                                    │
└──────────────────────────┘    └───────────────────────────────────┘
```

## Components

### 1. AIM Memory MCP (knowledge graph)
- **Package:** `mcp-knowledge-graph` (third-party, not ours)
- **Invocation:** `npx -y mcp-knowledge-graph --memory-path <path>`
- **Storage:** `<memory-path>/memory.jsonl` (JSONL: one entity/relation per line)
- **Purpose:** Quick entity lookup, relation traversal, fact storage
- **Served as:** `{{DISPLAY_NAME}}-Memory` in Claude Desktop config (e.g. `Kam-Memory`, `Tiera-Memory`)

### 2. Deep Context MCP (`aim-deep-context-server`)
- **Package:** Shipped inside `setup-claude-memory` as a bin entry
- **Invocation:** `npx -y --package=setup-claude-memory@latest aim-deep-context-server --memory-path <path>`
- **Storage:** `<memory-path>/deep/index.json` + `<memory-path>/deep/*.md`
- **Features:** YAML frontmatter docs, vector embeddings (Transformers.js + Apple NL fallback), semantic search, entity extraction, graph traversal over AIM memory.jsonl
- **Served as:** `{{DISPLAY_NAME}}-Deep-Context` in Claude Desktop config

### 3. Family Memory (v1.5.0+)
- **Not an MCP.** Pure markdown files deployed to a shared iCloud folder, read by Claude via CLAUDE.md routing instructions.
- **Why not an MCP?** Markdown is readable from Cowork/Web Claude (MCPs aren't), handles concurrent edits better via append-only changelog, zero MCP server complexity to maintain.
- **Discoverable via AIM** through a single bridge entity `Family_Memory_System` that points to the markdown files but stores no actual data.

## Per-user vs shared: the key distinction

| | Personal memory | Family memory |
|---|---|---|
| **iCloud folder** | `Claude Memory/` (per account) | `Kennedy Family Docs/Claude/Family Memory/` (shared) |
| **Who can see it** | Only that user's machines | Both users' machines via shared iCloud folder |
| **Storage mechanism** | AIM MCP + Deep Context MCP (structured) | Markdown files (unstructured) |
| **Writes concurrent?** | No — one user at a time | Yes — mitigated via append-only changelog + section-based edits |
| **Bootstrapped by** | `setup-claude-memory` CLI | `setup-claude-memory` v1.5.0+ CLI (new step) |
| **Managed by** | Fort Abode update flow | Fort Abode + manual Phase 1 deploy |

## The three ways Claude learns family facts

1. **Routing block in `~/.claude/CLAUDE.md`** tells Claude "for family topics, read these markdown files." This is the primary path.
2. **AIM bridge entity** `Family_Memory_System` surfaces when a session searches AIM for "family" — gives Claude the pointer even if the routing block didn't load for some reason.
3. **Kennedy Family Docs root CLAUDE.md** catches the rare case of a Cowork session landing inside the family folder — minimal nav pointer that redirects to the real family memory path.

## Conflict handling

iCloud does NOT merge markdown — simultaneous edits create `.icloud` conflict copies. Mitigations baked into the routing protocol:

- **`changelog.md` is append-only.** Appends at different positions rarely collide. Safest file.
- **`FAMILY_MEMORY.md` edits are section-surgical.** One `## Heading` at a time. Different sections don't overlap.
- **`facts.json` has a `last_modified` field** that Claude checks before/after writes. If changed mid-session, Claude warns and re-reads.
- **Section locks (future enhancement).** Not needed yet — Kam and Tiera don't typically have Claude sessions running in parallel.

## Security posture

- **Apple iCloud 2FA** is the base layer. Kam accepts this as sufficient for v1.
- **No SSNs, driver license numbers, or full account numbers in the markdown files.** Plan details, deductibles, claim phones, and ID-card-surface info are fine. Written into the `ROUTING.md` write discipline.
- **Fort Abode-based locking** is a future enhancement Kam has floated — deferred.

## Versioning

- **`setup-claude-memory`** uses semver. Minor bumps for features (including family memory in v1.5.0), patch for fixes, major for breaking schema changes.
- **Template versioning** via header comments (`<!-- family-memory-template v1 -->`). Lets the CLI detect when bundled templates are newer than deployed and know whether a silent template update is safe.
- **`facts.json` schema** version field allows future migrations.

## See also

- `FAMILY_MEMORY.md` in this `docs/` folder — the design doc specifically for the family memory feature
- `fort-abode-integration.md` in this `docs/` folder — how the CLI interacts with Fort Abode's update flow
- Project CLAUDE.md in the repo root — session protocol for working on this repo
- Plan file: `~/.claude/plans/pure-sparking-grove.md` — the plan that scoped this architecture
