# Aligned Memory

_Spec for turning this package's two local memory servers into one hosted memory that every AI
surface can pair with. Decision record: Deep Context `aligned-memory-product-decision-2026-10-27`.
Earlier threat research: `remote-memory-access-research-2026-06-26`._

**Status (2026-10-27):** step 1 built and tested locally (`worker/`, `bin/memory-export.mjs`).
Not deployed: no Cloudflare resource, GitHub app or secret exists yet. Kam's picks, 2026-10-27:
D1 mirror pushed from the Mac, software-projects allowlist, GitHub sign-in, free tier only.

## What it is

One memory a person owns, reachable as a **remote MCP server** on a Cloudflare Worker. Claude
Desktop, the Claude phone app, Claude Code, ChatGPT, Persona and Boardroom all add it like any
other connector: paste a URL, sign in. The local git copy on each Mac stays, and becomes a
follower of the server instead of the only copy.

## Phases

Each phase ships on its own and stacks on the one before. Nothing later is built early.

| # | Phase | What it adds | Gate to start it |
|---|---|---|---|
| 1 | **Read-only, work scope, Kam alone** | Remote MCP, OAuth sign-in, search/get tools only, a work-only slice of the store, rate limits, audit log | Kam's picks below |
| 2 | Writes + reconcile | `add_facts` / `deep_store` from the cloud; the server's writes reconcile with Mac writes through the existing semantic merge driver (`bin/memory-merge-driver.mjs`, `bin/deep-index-merge-driver.mjs`) | Step 1 in daily use for two weeks with a clean audit log |
| 3 | Scopes + Tiera | `personal` / `family` / `work` as real server-side scopes; Tiera as user two with her own `tiera` store; family scope readable by both | Writes proven; a permission model for shared scopes |
| 4 | Persona + Boardroom pairing | Both apps sign in with the same Aligned login and read/write through the same server | Phase 3 |
| 5 | Team permissions + memory steward | Dropbox-style per-member access for team scope; the steward (built from the unreleased v1.8.0 write-path feedback + `bin/memory-compact.js`) proposes prunes and merges, the owner approves | Phase 4; a first outside team user |

## Step 1 — design

### Shape

```
 Kam's Mac                                    Cloudflare (one Worker: aligned-memory)
 ─────────                                    ───────────────────────────────────────
 ~/Developer/claude-memory (full store)       /authorize, /callback   consent → GitHub → token
        │                                     /oauth/token, /register OAuthAuthorizationServer (KV)
        ▼                                     /mcp                    OAuthResourceServer → read tools
 aim-memory-export --scope work                        │
   exact-name allowlist, deny_patterns,                ▼
   redaction, embeddings stay home            D1: aligned-memory
        │                                       entities, observations, relations, docs,
        ▼  wrangler d1 execute (Kam's login)    doc_chunks, meta, audit_log
 work snapshot (.sql) ───────────────────────▶
```

The full store never leaves the Mac. The Worker holds no credential that can reach it.

### Choice 1 — where the Worker reads data from

| Option | Verdict |
|---|---|
| Worker reads the private `Kam-Memory` GitHub repo through the API | **Rejected.** The token it needs can also read `memory-family.jsonl` and `memory-personal.jsonl`. A leak or a bug exposes everything. `deep/index.json` alone is 36 MB. |
| R2 holds a JSON snapshot | Workable, but every cold start parses a multi-MB file. That breaks the Workers Free 10 ms CPU limit, so it needs Workers Paid ($5/mo). |
| A separate private GitHub repo holding only the work slice | Keeps a git history of what went to the cloud. Still needs a GitHub token in the Worker, plus the same parse cost. |
| **D1 mirror, pushed from the Mac** | **Picked.** The exporter writes a work-only SQL snapshot and Kam's own `wrangler` login loads it; rows go in under a new snapshot id that becomes visible in one final write, so a failed import keeps the old snapshot serving. Search runs in SQL (case-folded substring, the local server's rule), so Worker CPU stays tiny and it fits the free tier. Phase 2 writes land in the same tables. |

Freshness in step 1: the export is run by hand (one command). Wiring it into the existing background
sync is a follow-up once the slice has been reviewed a few times.

### Choice 2 — what "work scope" means

`memory-work.jsonl` is 2 entities and 5 KB. Boardroom, Persona and every other project live in the
master `memory.jsonl` (190 entities, 3.2 MB), right next to health, tax, banking and personal
entries. So work scope **cannot be a file**. It has to be a filter, and the filter has to fail closed.

How the exporter enforces it:

1. **Deny by default.** An allowlist names the entities and deep-doc projects that may leave the
   Mac. Anything not listed stays home, including every new entity until someone adds it. The list
   lives on the Mac (`~/.aligned-memory/scopes/work.json`), never in the Worker.
2. **Only `memory.jsonl` and `deep/` are ever opened.** The exporter refuses `memory-family`,
   `memory-personal`, `memory-gifts` and every other scope file by name, so no allowlist mistake
   can pull one in.
3. **Redaction with the scanner's own patterns** (`lib/secret-patterns.mjs`, shared with
   `bin/memory-scan.mjs`). Credentials are replaced with `[redacted: …]`, private keys including
   their body, and so are phone numbers and email addresses. UUIDs stay: in a work store they are
   record ids. The scope's `deny_patterns` drop whole observations and docs (invite codes,
   passwords, family, health, money).
4. **Kam reviews before upload.** Export and upload are separate commands. The exporter prints
   counts only (entities, observations, docs per project, what was dropped or redacted) and
   writes the snapshot at mode 0600. Nothing goes up until Kam runs the upload.
5. **Embeddings stay home.** Deep docs go up as metadata + markdown only.

The Worker serves what is in D1 and nothing else. Excluded data is not hidden by the server. It is
absent from Cloudflare entirely.

The real scope file lives at `~/.aligned-memory/scopes/work.json`, outside this public repo,
because its deny list is itself personal. `worker/scopes/work.example.json` shows the format. A dry
export on 2026-10-27: 19 of 190 entities, 6,387 observations, 2,076 of 3,268 deep docs (23 of them
Boardroom); 728 docs and 312 observations dropped by `deny_patterns`.

**Starting allowlist (picked):** the software projects only. Boardroom, Boardroom_Native, Spec,
Dash, Persona / persona-cloud / persona-site / Content Strategy App, Claude Memory MCP Setup /
setup-claude-memory, Weekly Rhythm Engine. Client and shoot work, people, money, health, house,
family and personal all stay out of step 1.

### Choice 3 — auth

Verified against Claude's connector docs (2026-10-27): the hosted Claude apps (web, Desktop,
mobile) accept OAuth with DCR or CIMD, or no auth. A fixed bearer header exists only as a beta for
some organizations. **So a bearer token cannot meet "add it in the phone app"; OAuth is required.**
Connectors are added on web or Desktop, then appear on the phone. Claude Code uses the same OAuth
through a loopback redirect.

Requirements Claude imposes, all met by `@cloudflare/workers-oauth-provider`: `401` with a
`WWW-Authenticate: Bearer resource_metadata=…` pointer, S256 PKCE, redirect
`https://claude.ai/api/mcp/auth_callback`, port-agnostic loopback redirects for Claude Code,
refresh-token rotation, token endpoint under 10 s.

Built as **one Worker that hosts both roles** with the library's split classes
(`OAuthAuthorizationServer` + `OAuthResourceServer`, `@cloudflare/workers-oauth-provider` 1.2).
Cloudflare recommends two Workers joined by a service binding; one keeps step 1 to a single URL
and a single deploy, and moving the authorization server out (to become the Aligned login that
Persona and Boardroom share in phase 4) is a config change, not a rewrite. The MCP side uses the
same SDK as the local servers (`WebStandardStreamableHTTPServerTransport`, stateless, JSON
responses), not the `agents` package, which is mid-migration to SDK v2.

Who may sign in:

| Option | Verdict |
|---|---|
| **GitHub sign-in, Kam's numeric GitHub user id allowlisted** | **Picked.** Uses his 2FA'd GitHub account. Needs a free GitHub OAuth App. GitHub is asked for no scopes, its token is used once to read the user id and never stored. Anyone else is refused at the callback, and the MCP handler re-checks the id on every request. |
| Cloudflare Access as the identity provider | Strongest policy controls (device posture, country). More dashboard setup; free up to 50 users. |
| Passphrase page on the authorization Worker | No third party. Weakest: one secret, phishable. |
| Bearer token only | Floor for Claude Code if OAuth slips. Does not satisfy the phone-app goal. |

### Choice 4 — tool surface

Read tools only. Write tools are **not registered**, so they do not exist on the remote server,
rather than existing and refusing.

| Tool | Notes |
|---|---|
| `aim_memory_search` | Same bounded, matching-observations-only behaviour as `bin/memory-server.mjs` |
| `aim_memory_get` | Same recent-slice default; `full:true` still capped by the character budget |
| `aim_deep_search` | Keyword over summary / project / tags / type / date, as today |
| `aim_deep_get` | One doc by id |
| `aim_deep_list` | Newest first, paged |

Left out of step 1: `aim_memory_read_all` (unbounded), `aim_memory_list_stores` (scope names are
none of a client's business), `aim_deep_semantic_search` (doc embeddings are MiniLM via
transformers.js; Workers AI does not host that model, so semantic search needs a re-embed with
`@cf/baai/bge-small-en-v1.5` and is its own small follow-up), `aim_deep_graph_search`.

The bounded-read logic in `bin/memory-server.mjs` (`searchNodes`, `openNodes`, `fitToBudget`)
moves to a shared module so the local and remote servers return identical shapes.

### Choice 5 — rate limiting and audit log

- **Rate limits** (Workers Rate Limiting binding): 60 tool calls/min per signed-in user;
  10 sign-in attempts/min per IP on the authorization Worker.
- **Audit log** (D1 `audit_log`): one row per authenticated MCP request and per sign-in
  attempt, refused ones included. Time, user, OAuth client, JSON-RPC method, tool, arguments,
  outcome, response size, IP, country. Never the token. Requests with no valid token are not
  written (they would let anyone fill the table); they show in Workers Logs. A daily cron keeps
  90 days.
- Rate limits are per Cloudflare location, not global. That is fine for one person.

### Threats step 1 handles

| Threat | Control |
|---|---|
| A phishing link to a real consent page for a rogue client | Tokens can only be delivered to Claude's callback (`https://claude.ai/api/mcp/auth_callback`) or a loopback port (Claude Code); any other redirect gets no consent page and is logged. `EXTRA_REDIRECT_URIS` adds ChatGPT later |
| Token leak or endpoint compromise | OAuth with short-lived, rotating tokens; worst case reads the work slice only |
| Family or personal data exposed | Absent from Cloudflare (Choice 2); no credential reaches the full repo (Choice 1) |
| Destructive writes from the cloud | No write tools exist (Choice 4) |
| Credentials stored in memory | Secret scan blocks the export |
| Prompt injection from stored text | Read-only limits the damage to a bad answer; tool descriptions tell the client memory is data, not instructions |
| Abuse or scraping | Rate limits + audit log |

### Cost

Everything in step 1 fits Cloudflare's free tier: two Workers, one D1 database, one KV namespace, a
rate-limit binding. GitHub OAuth Apps are free. Creating each resource, deploying, and setting each
secret is Kam's call at the moment it happens.

### Done means

- Kam adds the connector on Claude web or Desktop, opens the phone app, asks "where is Boardroom
  at?", and gets an answer drawn from his real memory.
- `claude mcp add --transport http aligned-memory <url>` works in Claude Code after the browser
  sign-in.
- Asking for a family or personal fact returns nothing, because nothing is there to return, and the
  test suite proves it against a fixture that contains such facts.
- Every call shows up in the audit log.

### Tests

Same style as `test/memory-server.test.mjs`: a real MCP client against a real server, on a fixture.

- `test/memory-export.test.mjs` (37): a fixture with family, personal and secret-bearing entries.
  The allowlist fails closed, a typo is reported, other scope files are refused by name and by
  resolved path (a `memory.jsonl` symlinked to the family file), credentials, key bodies and
  contact details are redacted, `deny_patterns` drop entries, the snapshot loads into SQLite,
  every statement fits D1's 100 KB limit, and a re-export swaps snapshots without touching the
  audit log.
- `test/worker.test.mjs` (53): the Worker under `wrangler dev` with local D1 and a fake GitHub.
  401 with `resource_metadata`, discovery, DCR, CIMD advertised, PKCE, consent page, GitHub
  round trip, token exchange; a different GitHub account refused; only the five read tools; output
  **byte-identical to the local stdio server** on the same store; family data unreachable; deep
  doc windows; audit rows; 90-day sweep; sign-in rate limit.

## Step 1 — deploy and install

Every step that creates a resource, stores a secret or exposes data is Kam's to run. Run from
`worker/` in a checkout that is not in Dropbox.

**1. One-time Cloudflare setup**

```bash
npm install
npx wrangler login
npx wrangler d1 create aligned-memory
npx wrangler kv namespace create OAUTH_KV
```

Paste the two ids it prints into `wrangler.jsonc` (`database_id`, and the KV `id`).

**2. First deploy, closed.** `ALLOWED_GITHUB_ID` is empty, so nobody can sign in yet.

```bash
npx wrangler deploy
```

Note the URL it prints, `https://aligned-memory.<subdomain>.workers.dev`. If the deploy refuses
the `ratelimits` binding on the free plan, stop there and say so: the docs do not state whether
the free plan includes it.

**3. GitHub OAuth App** at github.com → Settings → Developer settings → OAuth Apps → New OAuth App:
Homepage URL = the Worker URL, Authorization callback URL = `<Worker URL>/callback`. Copy the
client id, then generate a client secret.

**4. Fill in the config.** In `wrangler.jsonc` set `PUBLIC_ORIGIN` to the Worker URL,
`GITHUB_CLIENT_ID`, and `ALLOWED_GITHUB_ID` to the number from `gh api user --jq .id`. Then:

```bash
npx wrangler secret put GITHUB_CLIENT_SECRET
```

**5. Export, review, upload.**

```bash
node ../bin/memory-export.mjs --memory-path ~/Developer/claude-memory --scope ~/.aligned-memory/scopes/work.json --out ~/.aligned-memory/work-snapshot.sql
```

Read the counts. Then:

```bash
npx wrangler d1 execute aligned-memory --remote --file ~/.aligned-memory/work-snapshot.sql
```

**6. Deploy open.**

```bash
npx wrangler deploy
```

**7. Add it to Claude.**
- **Claude web or Desktop:** Customize → Connectors → Add custom connector. URL = `<Worker URL>/mcp`.
  Authentication: Sign in now. OAuth client: Use Claude's published identity. Add, then Connect:
  the consent page, then GitHub.
- **Claude phone app:** connectors cannot be added on mobile. Once added on web or Desktop it
  appears on the phone; turn it on in a chat under + → Connectors.
- **Claude Code:** `claude mcp add --transport http --scope user aligned-memory <Worker URL>/mcp`,
  then `/mcp` inside Claude Code (or `claude mcp login aligned-memory`) to sign in. On a Mac that
  already has the local Kam-Memory servers this is only useful for testing.

**8. Check it.** Ask "Where is Boardroom at?" on the phone. Then read the audit log:

```bash
npx wrangler d1 execute aligned-memory --remote --command "SELECT ts, method, tool, outcome, country FROM audit_log ORDER BY id DESC LIMIT 20"
```

**Refreshing:** repeat step 5 whenever the cloud copy should catch up. Hooking it into the
background sync is a follow-up.

**Shutting it off:** set `ALLOWED_GITHUB_ID` to `""` and `npx wrangler deploy`. Every MCP call is
refused from that moment, because the handler checks it on each request. Removing the connector in
Claude only disconnects that one client.
