# Getting started, for people who do not live in Terminal

This is the walkthrough for someone who has never opened Terminal and would rather not. About
ten minutes. You can stop after Part 1 and everything works; Parts 2 and 3 are the upgrades.

Nothing you save is ever deleted by this tool, at any step.

---

## What you are getting

Claude forgets everything when a conversation ends. This gives it a memory that carries over:
who you are, what you are working on, what you decided last week, in your words.

The memory is a folder of plain text files on your Mac. You can open them. You can edit them.
You can delete a line and Claude forgets that one thing. There is no account to create
and no server in the middle. The files sync through accounts you already own:
iCloud Drive by default, or a private GitHub repo if you want version history and a backup.

One honest caveat. When Claude uses your memory, the relevant parts travel with the
conversation, the same as anything you type into Claude. Your Claude plan's data policy is the
one that applies. If you use Claude at work on a work computer, your company's policy applies
there too. Keep work and personal on separate machines and separate Claude accounts, and this
stays simple.

---

## What you need

- A Mac with iCloud Drive turned on and signed in
- [Claude Desktop](https://claude.ai/download) installed
- Node.js, which is free. Check by opening Terminal (below) and typing `node --version`. If
  you see a version number of 18 or higher, you are set. If not, install it from
  [nodejs.org](https://nodejs.org) and try again.

---

## Part 1: install (5 minutes)

**1. Open Terminal.** Press `Cmd + Space`, type `Terminal`, press Return. A window with text
appears. It is a place to paste one line; that is all you will do with it.

**2. Paste this exactly and press Return:**

```
npx setup-claude-memory@latest
```

The `@latest` matters. Without it your Mac can quietly run a months-old copy and nothing will
look wrong.

**3. Answer the questions.** It asks your first name, and whether you share an iCloud folder
with family. Defaults are fine. Say no to family unless someone set that up with you.

**4. Quit Claude Desktop completely.** `Cmd + Q`, not just closing the window. Then reopen it.

---

## Part 2: check it actually worked (2 minutes)

Do not trust the installer's green text. Check.

**1. Ask Claude:** "Remember that my name is [your name] and I work in [your field]."

**2. Open a brand new chat and ask:** "What do you know about me?" It should answer with
what you just told it.

**3. Look at the file yourself.** In Finder, open iCloud Drive, then the `Claude Memory`
folder. Inside is `memory.jsonl`. Open it with TextEdit. What you told Claude is in there, in
plain text. That is the whole system. Nothing hidden.

If step 2 fails, the fix is almost always that Claude Desktop was closed but not quit. Do
`Cmd + Q` and try again.

---

## Part 3: keep it in git (optional, 5 minutes)

This puts your memory in a private GitHub repo under **your own account**: backed up,
versioned, and safe if two of your Macs write at the same time. Only you can see it.

You need a free GitHub account from [github.com](https://github.com).

**1. In Terminal, paste this and press Return:**

```
npx setup-claude-memory@latest --git
```

**2. A browser window opens and asks you to sign in to GitHub.** Sign in. Come back to
Terminal.

**3. It checks your memory for anything that looks like a password or key before it uploads
anything.** If it finds one, it stops and tells you where. Fix that line, then run the command
again. Phone numbers and emails are reported but do not stop it, because a memory of your own
life has those in it, and the repo is private.

**4. Quit and reopen Claude Desktop** like before.

Your old iCloud folder is renamed, not deleted. From now on the memory lives in a folder
outside iCloud and syncs to GitHub every fifteen minutes on its own.

**On a second Mac,** run the same command. It notices the repo exists and joins it.

---

## What to say to Claude on day one

- "Remember that I prefer short answers and no bullet lists unless I ask."
- "Here is what I am working on this month: ... Remember it."
- "What do you remember about [a project]?"
- "Save a summary of what we decided in this conversation to my deep context."
- "Forget that I said [thing]."

---

## When something looks wrong

| What you see | What to do |
|---|---|
| Claude says it has no memory of you | Quit Claude with `Cmd + Q`, reopen, ask again. |
| The memory server is missing from Claude's Connectors list | Same fix. If it is still missing, run the install command again. |
| Terminal says `npx: command not found` | Install Node.js from [nodejs.org](https://nodejs.org). |
| You want to start over | Delete the `Claude Memory` folder in iCloud Drive. Run the install again. |

Made by [Kam Studios](https://kamstudios.com). The code is public at
[github.com/kamrenkennedy/setup-claude-memory](https://github.com/kamrenkennedy/setup-claude-memory).
