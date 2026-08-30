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

**Do this in the same sitting as Phase 1**, because both edit the same 4 config surfaces. Doing
them together is one cutover instead of two.

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

## Order of work

1. Phase 0 items 2–3 (small, no decisions)
2. **Phase 1 + Phase 2 together** in one sitting — shared config cutover
3. Phase 3
4. Phase 4 after the Tiera question is answered

Deferred and still needing explicit go-ahead: condensing the `Content_Strategy_App` durable core
(a rewrite of wording, not a move).
