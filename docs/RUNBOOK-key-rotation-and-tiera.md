# Runbook — Google Maps key rotation, Tiera's setup, and continuing Phase 2

Written 2026-09-05. Steps marked **[KAM]** need you; **[CLAUDE]** I do in a session.

---

## First: this was already half-solved, and already flagged

Checked memory before proposing anything. Two prior findings apply:

- **2026-04-23** — `.mcpb` `user_config` with `sensitive: true` stores the key in the **OS keychain**
  at install. Memory recorded this as *resolving* the open item "Google Maps API key sync between
  family machines."
- **2026-06-23** — *"SECURITY SMELL: the Google Maps API key is stored in plaintext in this memory
  entity. Consider rotating + removing from memory."* **Flagged 2.5 months ago and never acted on.**
  The scanner re-found it independently on 2026-09-05, which is the argument for the scanner existing.
- **2026-06-23 architecture split** — planning logic syncs (iCloud SKILL.md); the **maps engine's key
  is entered per-machine at install and is deliberately NOT synced.**

So the *operational* system was already right. Verified on disk today: the `.mcpb` stores the key as
`__encrypted__:…` and **no Claude config file holds it in plaintext**.

**The leak is only in places that copy text around.** Where the key actually sits in plaintext:

| Location | Count | Fix |
|---|---|---|
| Cowork plugin `.mcp.json` `env` block (active install + marketplace source) | 2 | replace with the new key (or drop to an env var) |
| `memory.jsonl` — entities `Travel Itinerary Skill`, `Google Maps` | 2 | strip |
| deep doc `wre-phase7-preview-verification-2026-04-13.md` | 1 | strip |
| `memory.jsonl.bak-*` / `backup-*` | ~11 | move out of the store folder |
| `.mcpb` extension settings | 0 — **already encrypted** | nothing |

---

## The answer on keeping Tiera updated: don't sync the key. Give her her own.

The instinct to automate distribution is the wrong shape here, for a reason worth stating once:
**every channel available — iCloud, the Mailroom, memory — is plaintext.** Automating delivery
through any of them turns one leak into a permanent pipeline for leaks. A credential should not
travel through a sync folder.

**Do this instead: a separate Google Cloud API key per person.**

- Google Cloud allows many keys on one project. Tiera gets her own, restricted to the Directions API.
- Then **rotation is independent** — you rotate yours, and hers keeps working. Nothing to distribute,
  nothing to keep in sync, nothing to automate.
- If hers ever leaks, you revoke one key without touching your Macs.
- It also gives you per-person usage visibility in the Cloud Console, which matters because a Maps
  key is billable.

**Her key reaches her exactly once, by hand, through the `.mcpb` install prompt** — which is already
how it works today and stores it encrypted in her keychain. If you need to send her the string, use a
password manager share, not iCloud, the Mailroom, or a message.

Miss Fiddle / the Mailroom are the right channel for *"your Travel Itinerary needs a new key, here's
how to enter it"* — a **notification**, never the key itself.

---

## Steps

### Part A — rotate the key

1. **[KAM]** Google Cloud Console → APIs & Services → Credentials.
   - Create a **new** key for yourself. Restrict it: **API restriction → Directions API** (plus
     Geocoding if you use `maps_geocode`), and set an **Application restriction** if you can.
   - Create a **second key for Tiera**, same restrictions.
   - **Do not delete the old key yet** — it's live in your Cowork plugin and your `.mcpb`.
2. **[KAM]** Give me the new key **for your machine only** when I'm ready to update the two
   `.mcp.json` files — or paste it into those files yourself if you'd rather I never see it. Either
   is fine; say which.
3. **[CLAUDE]** Update the Cowork plugin `.mcp.json` in both locations (active install + marketplace
   source — memory notes the marketplace copy regresses on re-sync if missed).
4. **[KAM]** Re-enter your new key in the Travel Itinerary `.mcpb`: Claude Desktop → Settings →
   Extensions → Travel Itinerary → update the API key field. It re-encrypts to the keychain.
5. **[KAM]** Test: ask for a drive time. If `duration_in_traffic` comes back, the new key works.
6. **[KAM]** **Only now**, delete the old key in the Cloud Console.
7. **[CLAUDE]** Strip the old key from `memory.jsonl` (2 observations), the deep doc, and confirm the
   scanner goes green.

### Part B — Tiera

8. **[KAM]** Send Tiera her own key via a password manager share. Not iCloud, not the Mailroom.
9. **[TIERA]** Claude Desktop → Settings → Extensions → Travel Itinerary → paste the key. If she
   doesn't have the extension yet, she installs the `.mcpb` from the travel-itinerary GitHub release
   and it prompts her during install.
10. **[TIERA]** Get her onto search-first memory — one command, nothing else:
    ```
    npx setup-claude-memory@latest
    ```
    Then restart Claude Desktop. **The `@latest` is not optional** — a bare `npx` can serve a
    months-old cached copy (that trap cost this project three debugging rounds).

### Part C — continue Phase 2

11. **[CLAUDE]** Build the `--git` installer flow. The two hard pieces are already done and tested:
    the semantic merge driver (`1f9a191`, 32 tests) and the secret scanner (`1f8352d`, 29 tests).
    Remaining: safe repo-location picker, guided `gh` auth, private repo creation, scan gate wiring,
    merge-driver registration (**quoted path** — git runs it through a shell), the directory-symlink
    bridge, and scheduled sync.
12. **[KAM]** Run it when it's ready. You go first; Tiera follows once it's proven on your machine.

---

## Two things that block Part C

- **The key must be rotated and stripped first.** The scanner refuses the first push while a live
  credential is in the store, which is the whole point of it.
- **Move the 6 backup files out** of the store folder (Phase 0 item 3). They hold ~11 copies of the
  old key, and they inflate every scan.

---

## Note on this session

Memory searches in this session still return whole entities — one search came back at 110,572
characters. That's the **old** server still running in this session's process. Your config is
correct; MCP servers just don't swap until the session restarts. Expected, and exactly the
"gradual switchover" behaviour that was designed in.
