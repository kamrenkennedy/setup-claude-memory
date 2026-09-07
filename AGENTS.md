# AGENTS.md

Instructions for AI coding agents working in this repository. Humans should start with
[README.md](README.md).

## What this is

`setup-claude-memory` is an npm package that gives Claude persistent memory in plain files on
the user's Mac. One command installs it:

```bash
npx setup-claude-memory@latest
```

It registers two MCP servers with Claude Desktop and Claude Code. Both are in `bin/` and both
read and write one memory folder.

| Server | Binary | Purpose | Tools |
|---|---|---|---|
| Knowledge graph | `bin/memory-server.mjs` (`aim-memory-server`) | Facts, project status, entity relations. Search-first: a lookup returns matching observations, never a whole entity. | `aim_memory_store`, `aim_memory_get`, `aim_memory_search`, `aim_memory_read_all`, `aim_memory_list_stores`, `aim_memory_add_facts`, `aim_memory_remove_facts`, `aim_memory_forget`, `aim_memory_link`, `aim_memory_unlink` |
| Deep context | `bin/deep-context-server.mjs` (`aim-deep-context-server`) | Long-form archive: session summaries, decisions, research. Keyword and semantic search with embeddings computed locally. | `aim_deep_store`, `aim_deep_get`, `aim_deep_list`, `aim_deep_search`, `aim_deep_semantic_search`, `aim_deep_delete`, `aim_deep_extract_entities`, `aim_deep_graph_search`, `aim_deep_reindex` |

The knowledge graph server is a drop-in replacement for `mcp-knowledge-graph`: same tool
names, same `memory.jsonl` format, same write semantics.

## Where data lives

- Default: `~/Library/Mobile Documents/com~apple~CloudDocs/Claude Memory/`, synced by the
  user's own iCloud Drive.
- With `--git`: a folder outside iCloud (`~/Developer/claude-memory` if `~/Developer` exists,
  otherwise `~/ClaudeMemory`), backed by a **private** GitHub repo under the user's own login,
  synced every 15 minutes. A pre-push scan blocks credentials from ever leaving the machine.
- Optional family layer: `<shared iCloud folder>/Claude/Family Memory/`, deployed from
  `templates/family-memory/`. Existing user files are never overwritten.

Files in the memory folder: `memory.jsonl` (one JSON object per line), `memory-<context>.jsonl`
for named databases, `deep/` for long-form documents plus their index, `config.json`.

There is no server operated by the package author. Nothing is sent anywhere except to
Anthropic as part of the user's own Claude conversations.

## Commands

| Command | What it does |
|---|---|
| `npx setup-claude-memory@latest` | Install or upgrade. Detects fresh install, upgrade, or a second Mac joining. |
| `npx setup-claude-memory@latest --git` | Move memory into a private GitHub repo. On a second Mac, joins the existing repo and installs the merge driver. |
| `npx setup-claude-memory@latest --scan` | Scan memory for credentials. Secrets block a push; personal data is reported only. |
| `npx setup-claude-memory@latest --compact` | Propose finished observations to move to an archive entity. Every move needs the user's approval. Nothing is deleted. |
| `npx setup-claude-memory@latest --family` | Deploy the shared family memory templates and routing block. |
| `npm test` | Run the five test suites (server, merge driver, scanner, git migrate, compact). |

Always write `@latest`. A bare `npx setup-claude-memory` pins a cached version range and can
silently run an installer that is months old.

## Repository layout

- `bin/setup.js` interactive installer and CLI entry point
- `bin/memory-server.mjs` knowledge graph MCP server
- `bin/deep-context-server.mjs` deep context MCP server
- `bin/memory-merge-driver.mjs` semantic three-way merge for `memory.jsonl` under git
- `bin/memory-scan.mjs` credential and personal data scanner
- `bin/git-migrate.js` the `--git` migration and second-Mac join
- `bin/memory-compact.js` the `--compact` archive proposer
- `bin/apple-embed.swift` fallback embeddings via Apple NaturalLanguage
- `templates/family-memory/` canonical family memory templates
- `test/` one suite per module, plain Node, no framework
- `docs/` architecture notes, getting-started walkthrough, figure sources in `docs/img/`

## Working here

- Read a file before changing it. Prefer editing existing files to adding new ones.
- Run `npm test` before opening a pull request. All suites must pass.
- Smoke test installer changes from a packed tarball, not from the working tree: `npm pack`,
  install the tarball into a scratch directory, run `node node_modules/setup-claude-memory/bin/setup.js`.
- Keep the two servers' tool names and response shapes stable. Other software depends on them.
- README figures are generated: edit `docs/img/build-figures.py`, then run
  `THEMES=light,dark python3 docs/img/build-figures.py`. Do not hand-edit the SVG output.
  The hero and social preview PNGs come from `python3 docs/img/render-png.py`, which needs
  headless Chrome and Pillow. The character art in `docs/img/art/` has its own README.
- Commit messages are imperative and explain why. Stage files by name, never `git add -A`.

## Never do these

- Do not run `npm publish` or bump the version in `package.json`. Releases are a human decision.
- Do not delete, rewrite, or "clean up" a user's memory files. The package itself never deletes
  memory; `--compact` archives and only with approval.
- Do not write memory data, example memory files, or anything from a real memory folder into
  this repository. It is public.
- Do not add analytics, telemetry, or any network call beyond GitHub for `--git`.
- Do not make the `--git` repo public or change the pre-push scan to warn instead of block.
