# setup-claude-memory

> One-command setup for persistent Claude memory via iCloud — Mac only.

Installs an AIM knowledge-graph memory server and a long-form deep-context archive, and connects them to your Claude Desktop app. Your memory lives in iCloud so it syncs across all your Macs automatically.

---

## What it does

1. Creates a `Claude Memory` folder in your iCloud Drive
2. Adds the memory server and deep-context server to your Claude Desktop config
3. Labels it with your name (e.g. `Alex-Memory`)
4. Tells you exactly what to do next

---

## Requirements

- macOS with iCloud Drive enabled
- [Claude Desktop](https://claude.ai/download) installed
- [Node.js 18+](https://nodejs.org)

To check Node.js: `node --version`
To install: `brew install node`

---

## Run it (no install needed)

```bash
npx setup-claude-memory@latest
```

That's it. Follow the prompts.

---

## After running

1. Fully quit Claude Desktop (`Cmd+Q`)
2. Relaunch Claude Desktop
3. Click `+` → **Connectors** — you should see your memory server listed

**Test it:** Tell Claude *"Remember that my name is [Name] and I work in [field]."*
Open a new chat and ask *"What do you know about me?"* — it should remember.

---

## Second Mac setup

Just run the same command on your second Mac:

```bash
npx setup-claude-memory@latest
```

Use the **same folder name** when prompted (default: `Claude Memory`). Your iCloud folder and all memories will already be there.

---

## Family Memory (optional, shared across family)

After setting up your personal memory, the CLI asks if you share an iCloud folder with family members. If yes, it deploys a **Family Memory** template into `<shared folder>/Claude/Family Memory/` and installs a routing block in `~/.claude/CLAUDE.md` so Claude consults shared family facts (insurance, house, pets, shared finances) before answering family questions.

To install family memory on an already-configured Mac, or on a partner's Mac that already has their own personal memory:

```bash
npx setup-claude-memory@latest --family
```

The routing block is idempotent — re-running is safe. Templates never clobber existing files, so edits you make to `FAMILY_MEMORY.md` or `facts.json` stick.

---

## Always use `@latest`

Run **`npx setup-claude-memory@latest`**, not the bare `npx setup-claude-memory`.

A bare `npx <package>` records a `^X.Y.0` range the first time you run it and will happily keep
serving that cached copy — for months. Someone whose cache was seeded in April silently re-ran a
four-month-old installer, which rewrote their config back to the old memory server and looked like
it had worked. `@latest` forces npm to check the registry.

---

## Search-first reads (v1.6.0+)

Memory grows. Once a project entity reaches a few hundred observations, a naive lookup returns the
*whole* entity and swallows the context window — the assistant then has less room to do the work you
asked for.

This package ships its own memory server, `aim-memory-server`, to stop that:

- **`aim_memory_search` returns the matching observations, not the whole entity.** It also reports
  how many matched versus how many it returned, so the assistant knows when to narrow the query.
- **`aim_memory_get` returns the 30 most recent observations by default** and says how many older
  ones it withheld. `full: true` still loads everything when you genuinely want it.
- **Every response has a character budget.** Over budget, the server returns *fewer observations* —
  it never cuts a response mid-JSON.
- **Writes are atomic** (write-temp-then-rename), so an interrupted write cannot truncate your
  memory file. File permissions are preserved.

Measured against a real 981-observation entity: a search that previously returned ~809,000
characters now returns ~13,000.

It is a drop-in replacement for [`mcp-knowledge-graph`](https://github.com/shaneholloman/mcp-knowledge-graph)
(MIT) — same tool names, same file format, same write semantics. **Existing memory files work
unchanged, and upgrading is just re-running the installer.** Sessions already open keep the old
server until they restart, which is safe: both read and write the same file in the same format.

---

## Your memory file

All memories live here — you can open, read, or edit it anytime:

```
~/Library/Mobile Documents/com~apple~CloudDocs/Claude Memory/memory.jsonl
```

Each line is a JSON object. Delete a line to remove that memory. Delete the file to start fresh.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Server not showing in Connectors | Fully quit Claude (Cmd+Q), not just close the window. Check config for JSON errors at [jsonlint.com](https://jsonlint.com) |
| Memory not syncing to second Mac | Make sure iCloud Drive is on and signed in. Wait ~1 min after writing. |
| `npx: command not found` | Install Node.js from [nodejs.org](https://nodejs.org) |

---

Made by [Kam Studios](https://kamstudios.com)
