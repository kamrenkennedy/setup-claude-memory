# Setting up your Claude memory — Tiera

Hi Tiera — this updates how Claude remembers things for you. Two parts, about 10 minutes total.
You can stop after Part 1 if you want; it works fine on its own.

**What changes:** Claude's memory has gotten big enough that it was slowing conversations down —
it used to load *everything* it knew about a project just to answer one question. Now it looks up
only what it needs. Part 2 also puts your memory somewhere it can't get lost.

Nothing you've saved is deleted at any point.

---

## Part 1 — the update (5 minutes)

**1. Open Terminal.** Press `Cmd + Space`, type `Terminal`, press Return. A window with text appears.
That's it — you'll paste one line into it.

**2. Copy this exactly and paste it in, then press Return:**

```
npx setup-claude-memory@latest
```

The `@latest` matters. Without it your Mac can quietly run a months-old copy and nothing will look
wrong. That cost us three rounds of debugging on Kam's Mac.

**3. Answer the questions.** It may ask your first name, and whether you want to review preferences.
Defaults are fine.

**4. Quit Claude Desktop completely** (`Cmd + Q`, not just closing the window) **and reopen it.**

That's Part 1. Claude's memory is now faster and won't crowd out your conversations.

---

## Part 2 — your own private backup (5 minutes)

This puts your memory in a private space on GitHub under **your own account**, so it's backed up,
versioned, and safe if two things ever write at once. It is private — only you can see it.

**You'll need a GitHub account.** Free at [github.com](https://github.com). If you already have one,
use it.

**1. In Terminal, paste this and press Return:**

```
npx setup-claude-memory@latest --git
```

**2. It walks you through everything.** It will:
- open your browser to sign in to GitHub (click Authorize)
- check your memory for any passwords or keys that shouldn't be backed up
- ask where to put the folder — **the default is fine**, just press Return
- ask what to name it — **the default is fine**
- show you exactly what it's about to do and wait for you to say yes

**3. If it says `gh` is not installed:** download it from
[cli.github.com](https://cli.github.com) — the `.pkg` file, double-click to install — then run the
command again.

You never type a git command. Your original memory folder is renamed and kept, not deleted.

---

## Your Google Maps key (separate, quick)

The travel-itinerary tool needs its own key, and yours needs replacing — the old shared one was
retired. **Kam will send you a new one privately** (through a password manager, not text or email).

To enter it:
1. Claude Desktop → **Settings** → **Extensions**
2. Find **travel-itinerary** (lowercase, with the hyphen)
3. Click the gear or **…** on that row
4. Paste the key into **Google Maps API Key**

It's stored encrypted on your Mac. You only do this once.

---

## If something looks wrong

**"It says it worked but nothing changed."** This is the one to watch for — it happened twice on
Kam's Mac. Ask your Claude: *"check my memory config and tell me which server it's actually using."*
Don't assume it took just because it said it did.

**An error mentioning a server that won't start, right after updating.** Usually harmless — your Mac
is downloading the new version and it timed out the first time. Quit Claude Desktop and reopen it.

**Anything else** — send Kam a screenshot of the Terminal window. The full text matters, especially
the last few lines.

---

## What you get

- Conversations stop slowing down as Claude remembers more
- Your memory is backed up privately and automatically, every 15 minutes
- Nothing is ever deleted — older notes move to an archive and stay searchable
- If your Mac dies, your memory is safe

Your memory stays entirely yours. It's a private space on your own account; Kam's is separate.
