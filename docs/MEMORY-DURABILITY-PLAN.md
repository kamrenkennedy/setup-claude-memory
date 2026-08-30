# Memory durability + search-first reads — the plan

Status: **awaiting Kam's go on Phase 2 only.** Phases 0/1 need no decision.
Written 2026-08-30. Background: Deep Context `content-strategy-app-memory-hand-triage-executed-2026-08-30`
and `memory-durability-claude-md-modernization-2026-08-30`.

---

## The finding that shapes everything

Two upgrades were being discussed as one thing. They are separable, and they have very
different value for each person:

| | What it fixes | Who needs it | Git required |
|---|---|---|---|
| **A. Search-first reads** | The overflow. A lookup returns matching observations, not a 411K entity. | **Kam AND Tiera** | No |
| **B. Git durability** | Silent divergence between machines, off-iCloud reach, cloud sessions. | **Kam** (Tiera: only if she has 2 Macs / wants cloud sessions) | Yes |

**A is the actual fix and it needs no git at all.** `bin/setup.js:501` — `kgEntry()` is a single
function returning the memory server's command line. Swap `mcp-knowledge-graph` for our own server
there and *everyone who runs the installer gets the fix*, Tiera included, with no new concepts.

**`setup.js` only ever writes `claude_desktop_config.json`.** It never touches `~/.claude.json` or
`.codex/config.toml`. So Tiera has **one** config surface; Kam has **four** only because he
hand-wired Claude Code and Codex. Her upgrade is genuinely just "run the updater."

---

## Family memory and Cowork — both verified out of scope (2026-08-30)

Two questions from Kam, both answered by inspection rather than assumption.

### Family memory is a different system and the migration does not touch it

| | Personal memory | Family memory |
|---|---|---|
| What | `memory.jsonl`, `deep/` | `FAMILY_MEMORY.md`, `changelog.md`, `facts.json` |
| Where | `com~apple~CloudDocs/Claude Memory/` | `com~apple~CloudDocs/Kennedy Family Docs/Claude/Family Memory/` |
| Read by | **MCP servers** (`aim_memory_*`, `aim_deep_*`) | **Claude's direct file access**, via the routing block in `~/.claude/CLAUDE.md` |
| Path set by | `--memory-path` | the routing block's literal path |
| Shared? | no — one person | **yes** — shared iCloud folder across two separate iCloud accounts |

Only the left column moves. Confirmed on disk by Cowork's own allowlist:
`localAgentModeTrustedFolders` contains `Kennedy Family Docs` (that is how the agent reads family
memory directly) and does **not** contain `Claude Memory` (it never needs to — MCP servers read that
as subprocesses, outside the agent's file tools).

**Recommendation: leave family memory on the shared iCloud folder.** That shared folder is precisely
what lets it work across two separate iCloud accounts with neither person needing an account on the
other's services. Putting it in git would force GitHub and git literacy onto Tiera for the one
system that has to work for both of them. Write frequency is low (family facts change rarely, unlike
per-session project memory), and the existing discipline already handles concurrency: `changelog.md`
is append-only, `FAMILY_MEMORY.md` is edited one `## Section` at a time.

**Optional, no cost to Tiera:** Kam's Mac can mirror the family folder into his private repo on a
schedule — a read-only backup that buys version history and recoverability. iCloud stays the live
path; Tiera never sees a git command.

**Naming trap:** `memory-family.jsonl` inside `Claude Memory/` is **not** the shared family memory.
It is Kam's *personal* AIM context database (`--context family`), visible only to him. It moves with
the migration. The shared family memory is the markdown folder above.

**Also verified:** `~/.claude/CLAUDE.md` is a symlink to
`Kennedy Family Docs/Claude/CLAUDE.md` — the family folder, **not** the store. The migration does
not disturb the global instructions.

### Cowork is not a separate config surface

Cowork is not a separate app — it runs inside `Claude.app` and reads the same
`claude_desktop_config.json`, where `mcpServers` is a top-level key. So Cowork uses the same memory
servers as Claude Desktop. Update that one file and Cowork follows. **The "Tiera has one config
surface" conclusion holds.**

Memory reaches Cowork through MCP servers, which run as subprocesses and are *not* gated by
`localAgentModeTrustedFolders`. That is why `Claude Memory` is absent from that list and memory
still works.

*Caveat, not a blocker:* if Kam ever wants Cowork's agent to read the memory **files** directly
rather than through MCP after the move, add `~/Developer/claude-memory` to trusted folders. Not
needed for normal operation.

## Phase 0 — Safety and hygiene (no decisions needed)

1. ✅ **DONE — GitHub exposure check.** No memory repo exists on GitHub, public or private. Memory
   content has never been pushed anywhere. The only memory-named public repo is
   `setup-claude-memory` — the installer, correctly public, verified to track **zero** `.jsonl`
   files, zero `deep/` docs, and zero phone/email patterns.
2. ⚠️ **Public template placeholders.** `templates/family-memory/FAMILY_MEMORY.md` and `facts.json`
   hardcode `Kam`, `Tiera`, and `Franklin, TN` in the **public** repo. Not credentials, but it is
   the family's first names + city. Should be `{{...}}` placeholders like the rest of the file.
3. **Move the 6 backup files** (`memory.jsonl.bak-*`, `backup-*`, ~8.6MB) out of the store folder
   before any repo exists.

## Phase 1 — Search-first reads (ships to both; no git)

The permanent overflow fix. `mcp-knowledge-graph` is MIT, third-party, invoked via `npx -y`, so it
cannot be patched durably in place — we vendor it.

1. Vendor `mcp-knowledge-graph` into `bin/` as `aim-memory-server`, shipped from this package
   exactly the way `aim-deep-context-server` already is.
2. Fix the read path. Today `searchNodes` (its `dist/index.js:230`) matches entities then returns
   each match **whole**. New behavior: return the *matching observations* plus a small amount of
   surrounding context, with a hard cap and a "N more matches" pointer. `aim_memory_get` gains the
   same cap so a whole-entity read can never blow a session again.
3. Point `kgEntry()` at the new server.
4. Ship as **v1.6.0** → npm → Fort Abode's scheduled check surfaces it.
5. **Tiera:** accepts the Fort Abode update. Done — that is her entire involvement.
6. **Kam:** same, plus hand-update his 3 extra surfaces (`~/.claude.json`, `~/.codex/config.toml`,
   `Persona — Content Studio/.codex/config.toml`).

Fort Abode checklist applies (CLAUDE.md → Shipping through Fort Abode). This is user-visible, so it
needs `component-registry.json` copy + a `whats-new.json` entry — and the pending `--family` copy
fix can ride along.

## Phase 2 — Kam's git migration (needs Kam's go)

**Revised 2026-08-30: do this AFTER Phase 1 has settled, not in the same sitting.** The earlier
"do them together to share one config edit" advice was optimizing ~5 minutes of work. Kam is doing
live memory-backed work and wants to switch sessions over gradually, and that constraint wins:
Phase 1 is gradual for free, Phase 2 is not. Do not couple a safe change to a risky one.

### Why the two phases behave differently

- **Phase 1 is inherently zero-downtime.** The new server reads the *same file at the same path*.
  Old server and new server are interchangeable at any instant — a running session keeps its
  existing server process, and the next session started picks up the new one. They can coexist
  indefinitely. No deadline, no coordination, nothing to undo.
- **Phase 2 cannot be gradual by default.** Two paths means two files means silent divergence —
  precisely the failure this whole track exists to eliminate.

### The bridge that makes Phase 2 switchable too — VERIFIED 2026-08-30

Leave a **directory symlink** at the old iCloud path pointing at `~/Developer/claude-memory`.
Sessions on the old path and sessions on the new path then resolve to the same real file, so config
surfaces can be cut over lazily, one session at a time.

Verified empirically, not assumed:
- `mcp-knowledge-graph` saves with a plain `fs.writeFile` (its `dist/index.js:171`) — no
  temp-file-plus-rename — so writes follow the symlink through to the target.
  `bin/deep-context-server.mjs` likewise uses plain `writeFileSync`.
- Live test in the real iCloud Drive: created a directory symlink there, read through it, wrote
  through it with `fs.writeFile`, confirmed the bytes landed in the true target and the symlink was
  **not** replaced. Test artifacts removed.
- **Use a DIRECTORY symlink, never a file symlink.** A directory symlink survives any write style,
  including a future temp+rename, because the rename then happens inside the real target directory.

Sequence with the bridge: move the store → create the symlink → everything keeps working on the old
path → cut the 4 config surfaces whenever convenient → once every session is on the new path,
replace the symlink with the hard-fail tripwire.

**Note:** neither server writes atomically today — a crash mid-write truncates the store. The
vendored server in Phase 1 should fix that (`mkstemp` + `os.replace`, `chmod 0644`).

### Steps

1. `~/Developer/claude-memory` as the working copy — outside iCloud and Dropbox (both corrupt git:
   iCloud on `.git` internals, Dropbox on mtimes; both documented traps).
2. Copy the store in; `.gitignore` the backups and `.DS_Store`.
3. **Pre-push secret scan before the first push ever happens.** Non-negotiable: the store carries
   phone numbers, live prod D1 invite codes, emails, UUIDs, and `memory-family.jsonl`.
4. Create the **private** repo on Kam's account; push.
5. Cut all 14 `--memory-path` references across the 4 files to the new path.
6. **Tripwire:** replace `memory.jsonl` at the old iCloud path with a *directory* of that name. Any
   machine left behind fails loudly instead of silently writing to a ghost store — and iCloud
   delivers that tripwire to every Mac by itself.
7. Verify every MCP server comes up on the new path before closing the session.

Any step touching `memory.jsonl` follows the live-store discipline in CLAUDE.md (snapshot + md5,
verify by content not index, byte-identical round-trip proof, `mkstemp` + `os.replace`, `chmod 0644`).

## Phase 3 — Scheduled compaction (both)

Staged for per-item approval, `plaud-triage` style. This is what stops the regrowth that made four
manual passes necessary in six weeks. Never a heroic manual pass. Nothing is ever deleted — moves go
to an archive entity and stay recoverable.

## Phase 4 — Tiera's durability (decide only after she is on Phase 1)

Open question: **does Tiera have more than one Mac, or want cloud sessions?** That is the only thing
git buys her, and it is what should decide this.

- **If no** → she does not need git. Give her scheduled local snapshots instead: same "never
  silently lose an edit" protection, no new concepts, nothing that can break in a way she cannot
  self-service.
- **If yes** → her own private repo on **her** GitHub account, and the sync must be **fully
  automatic** (scheduled pull-rebase-push run by the installer). On conflict it snapshots and
  alerts — it must never ask her to resolve a merge by hand. A merge conflict a non-developer
  cannot clear equals broken memory.

Either way it ships through the installer + Fort Abode. She should never see a git command.

---

## Order of work (revised 2026-08-30 for live-work safety)

1. ✅ Phase 0 item 2 done — public templates stripped of household identity (`6e80264`)
2. Phase 0 item 3 — move the 6 backup files out
3. **Phase 1 alone.** Ship it, then switch sessions over one at a time as they restart. Old and new
   coexist safely, so there is no deadline and no big-bang moment.
4. **Phase 2** once Phase 1 has settled and Kam is at a natural break — with the symlink bridge, so
   it is also switchable session-by-session rather than all at once.
5. Phase 3
6. Phase 4 after the Tiera question is answered

Family memory stays on shared iCloud throughout — it is not part of any phase.

Deferred and still needing explicit go-ahead: condensing the `Content_Strategy_App` durable core
(a rewrite of wording, not a move).
