# setup-claude-memory

> One-command setup for persistent Claude memory via iCloud — Mac only.

Installs the [MCP Knowledge Graph Memory Server](https://github.com/modelcontextprotocol/servers) and connects it to your Claude Desktop app, with your memory file stored in iCloud so it syncs across all your Macs automatically.

---

## What it does

1. Creates a `Claude Memory` folder in your iCloud Drive
2. Adds the `mcp-knowledge-graph` server to your Claude Desktop config
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
npx setup-claude-memory
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
npx setup-claude-memory
```

Use the **same folder name** when prompted (default: `Claude Memory`). Your iCloud folder and all memories will already be there.

---

## Family Memory (optional, shared across family)

After setting up your personal memory, the CLI asks if you share an iCloud folder with family members. If yes, it deploys a **Family Memory** template into `<shared folder>/Claude/Family Memory/` and installs a routing block in `~/.claude/CLAUDE.md` so Claude consults shared family facts (insurance, house, pets, shared finances) before answering family questions.

To install family memory on an already-configured Mac, or on a partner's Mac that already has their own personal memory:

```bash
npx setup-claude-memory --family
```

The routing block is idempotent — re-running is safe. Templates never clobber existing files, so edits you make to `FAMILY_MEMORY.md` or `facts.json` stick.

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
