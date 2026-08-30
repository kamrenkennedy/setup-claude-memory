# Memory durability + search-first reads — the plan

Status: **awaiting Kam's go on Phase 2 only.** Phases 0/1 need no decision.
Written 2026-08-30. Background: Deep Context `content-strategy-app-memory-hand-triage-executed-2026-08-30`
and `memory-durability-claude-md-modernization-2026-08-30`.

---

## The finding that shapes everything

Two upgrades were being discussed as one thing. They are separable, and they have very
different value for each person:

| | What it fixes | Who gets it | Git required |
|---|---|---|---|
| **A. Search-first reads** | The overflow. A lookup returns matching observations, not a 411K entity. | **Both** | No |
| **B. Git durability** | Silent divergence between machines, off-iCloud reach, cloud sessions, version history. | **Both** — Kam's decision 2026-08-30, full parity | Yes |

**Kam's ruling on B (2026-08-30):** Tiera gets the same system Kam does — her own private repo on
**her** GitHub account. An earlier draft proposed giving her scheduled local snapshots instead,
because she is not a developer. Kam heard that and reaffirmed parity. That is the decision; the
concern is closed.

It is also the better design, for a reason the earlier draft under-weighted: **two divergent designs
cost more to maintain than one**, and symmetry means she is already set up the day she gets a second
machine or wants cloud sessions.

**The consequence that reshapes this plan:** if Tiera gets the same thing, the migration cannot be a
set of commands run by hand on Kam's Mac. **It has to be a feature in `setup.js`** — which makes
Kam's own migration the feature's first run rather than a one-off. That is better engineering
regardless: reproducible, testable, and re-runnable on any future machine.

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

## Phase 2 — Git-backed memory, built as an installer feature (needs Kam's go)

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

### What the feature has to do — `npx setup-claude-memory --git`

Everything below runs for whoever is running it, against **their own** GitHub account. Nobody ever
types a git command.

1. **Pick a safe repo location, and refuse unsafe ones.** Must not be inside iCloud, Dropbox,
   `~/Documents`, or `~/Desktop`. ⚠️ **`~/Documents` and `~/Desktop` are iCloud-synced whenever
   "Desktop & Documents Folders" is enabled — verified ON on Kam's Mac 2026-08-30**, and it is a
   common default, so assume Tiera has it too. Home root is not synced. Default: `~/ClaudeMemory`
   for a general user; Kam may pick `~/Developer/claude-memory` to sit with his other repos. The
   installer must *detect* the unsafe cases rather than trusting the default.
2. **Ensure `gh` and authenticate.** `gh auth login`'s browser flow is the friendliest path — it
   shows a code, opens the browser, the user clicks authorize. If `gh` is missing, guide the
   install (Kam has it via homebrew; Tiera likely has neither, so fall back to the official
   installer package rather than assuming brew).
3. **Move the store in**, `.gitignore` the `*.bak-*` / `backup-*` files and `.DS_Store`.
4. **Secret-scan gate before the first push ever happens.** Non-negotiable — the store carries phone
   numbers, live prod invite codes, emails, UUIDs, and `memory-family.jsonl`. The push does not
   happen if the scan trips; it reports and stops.
5. **Create the PRIVATE repo on the running user's account**, push.
6. **Install the semantic merge driver** (below) plus `.gitattributes`, so a conflict never reaches
   the user.
7. **Rewrite the config surfaces** it owns, and *report* any it does not own so Kam can cut his
   three extra ones by hand.
8. **Leave the directory-symlink bridge** at the old path for the gradual cutover; replace it with
   the hard-fail tripwire once every session is on the new path.
9. **Schedule background sync** — periodic pull-rebase-push. Silent when clean.

### The merge driver — this is what makes git safe for a non-developer

A merge conflict Tiera cannot clear equals broken memory. So conflicts must resolve themselves
**correctly**, not merely automatically.

`git merge=union` is *not* good enough here: `memory.jsonl` is one JSON object per line, so a union
merge of two edits to the same entity yields **two lines with the same entity name** — a corrupted
graph. It needs a semantic driver instead:

- Parse base, ours, theirs as JSONL.
- **Entities** key by `name`; **relations** key by `(from, to, relationType)`.
- Proper 3-way set semantics per entity's `observations`: start from the union of ours and theirs,
  then drop anything that is present in base but was deliberately removed on either side. That
  preserves genuine archival moves (remove from A, add to B) instead of resurrecting them.
- Emit in a deterministic order.
- `deep/` documents are write-once with unique ids, so they cannot conflict. `deep/index.json` is
  derivable — on conflict, union by id or regenerate via `aim_deep_reindex`.

This driver is also what makes concurrent multi-session writing *safe* rather than merely loud,
which is the deeper win over the current last-write-wins file.

Any step touching `memory.jsonl` follows the live-store discipline in CLAUDE.md (snapshot + md5,
verify by content not index, byte-identical round-trip proof, `mkstemp` + `os.replace`, `chmod 0644`).

## Phase 3 — Kam runs it (the feature's first user)

At a natural break, with the symlink bridge so his own cutover is session-by-session rather than
all at once. He goes first deliberately: anything rough about the feature surfaces on his Mac, where
he can debug it, not on Tiera's.

Kam-specific: he owns **four** config surfaces, and the installer only rewrites the one it manages
(`claude_desktop_config.json`). It must *report* the other three — `~/.claude.json`,
`~/.codex/config.toml`, `App Projects/Persona — Content Studio/.codex/config.toml` — so he can cut
them, and the symlink bridge keeps everything working until he does.

## Phase 4 — Tiera onto the same system

She runs the Phase 2 feature, delivered as a Fort Abode update. Her own GitHub account, her own
private repo, her own memory. Identical to Kam's, with three differences that are facts about her
setup rather than a reduced design:

- **One config surface, written automatically.** `setup.js` writes `claude_desktop_config.json`,
  which is also what Cowork reads. Kam's extra three exist only because he hand-wired Claude Code
  and Codex.
- **Repo location default** is a plain home-folder path, not `~/Developer`.
- **`gh` is probably absent**, so the guided install matters more on her Mac than on Kam's.

Her involvement: accept the update, click through a GitHub sign-in once. Nothing after that.

**Family memory stays on shared iCloud** — that is a separate system on a separate path (see above),
and the shared folder is what lets it span two iCloud accounts. Kam's side can additionally mirror it
into his private repo on a schedule for version history, costing Tiera nothing.

## Phase 5 — Scheduled compaction (both)

Staged for per-item approval, `plaud-triage` style. This is what stops the regrowth that made four
manual passes necessary in six weeks. Never a heroic manual pass. Nothing is ever deleted — moves go
to an archive entity and stay recoverable.

## Order of work (revised 2026-08-30 for live-work safety)

1. ✅ Phase 0 item 2 done — public templates stripped of household identity (`6e80264`)
2. Phase 0 item 3 — move the 6 backup files out
3. **Phase 1 alone.** Ship it, then switch sessions over one at a time as they restart. Old and new
   coexist safely, so there is no deadline and no big-bang moment.
4. **Phase 2** — build `--git` as a real installer feature, including the merge driver. Bigger than
   the original hand-migration, and the price of parity.
5. **Phase 3** — Kam runs it at a natural break, with the symlink bridge so his own cutover is also
   session-by-session. He is the feature's first user; anything rough surfaces on his Mac, not hers.
6. **Phase 4** — Tiera runs it via a Fort Abode update.
7. **Phase 5** — scheduled compaction, both.

Family memory stays on shared iCloud throughout — it is not part of any phase.

Deferred and still needing explicit go-ahead: condensing the `Content_Strategy_App` durable core
(a rewrite of wording, not a move).
