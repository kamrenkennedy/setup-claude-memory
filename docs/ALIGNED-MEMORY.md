# Aligned Memory

_Spec for turning this package's two local memory servers into one hosted memory that every AI
surface can pair with. Decision record: Deep Context `aligned-memory-product-decision-2026-10-27`.
Earlier threat research: `remote-memory-access-research-2026-06-26`._

**Status (2026-10-27):** spec written, step 1 design choices waiting on Kam. Nothing deployed.

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
 Kam's Mac                                   Cloudflare
 ─────────                                   ──────────
 ~/Developer/claude-memory (full store)
        │
        ▼
 aim-memory-export --scope work             ┌──────────────────────┐
   1. deny-by-default allowlist              │ aligned-auth Worker  │  OAuth 2.1 + PKCE,
   2. secret scan (bin/memory-scan.mjs)      │  (KV: tokens)        │  DCR + CIMD, GitHub
   3. writes a work-only snapshot            └──────────┬───────────┘  as the sign-in
        │                                               │ service binding
        ▼  wrangler d1 execute (Kam's login)            ▼
 ┌──────────────────────┐                   ┌──────────────────────┐
 │ D1: aligned-memory   │◀──── reads ───────│ aligned-memory Worker│◀── Claude apps,
 │  entities, obs, docs │                   │  /mcp (Streamable    │    Claude Code
 │  audit_log           │──── writes log ──▶│  HTTP, stateless)    │
 └──────────────────────┘                   └──────────────────────┘
```

The full store never leaves the Mac. The Worker holds no credential that can reach it.

### Choice 1 — where the Worker reads data from

| Option | Verdict |
|---|---|
| Worker reads the private `Kam-Memory` GitHub repo through the API | **Rejected.** The token it needs can also read `memory-family.jsonl` and `memory-personal.jsonl`. A leak or a bug exposes everything. `deep/index.json` alone is 36 MB. |
| R2 holds a JSON snapshot | Workable, but every cold start parses a multi-MB file. That breaks the Workers Free 10 ms CPU limit, so it needs Workers Paid ($5/mo). |
| A separate private GitHub repo holding only the work slice | Keeps a git history of what went to the cloud. Still needs a GitHub token in the Worker, plus the same parse cost. |
| **D1 mirror, pushed from the Mac** | **Recommended.** The exporter writes a work-only SQL snapshot and Kam's own `wrangler` login replaces the D1 contents in one transaction. Search runs as SQL (`LIKE`, same substring rule the local server uses), so CPU stays tiny and it fits the free tier. Phase 2 writes land in the same tables. |

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
3. **Secret scan on the slice.** `bin/memory-scan.mjs` runs on the exported content. Any BLOCK
   finding (keys, tokens, private keys) stops the export. REVIEW findings (phone numbers, emails)
   are dropped from the cloud copy by default, observation by observation.
4. **Kam reviews the first snapshot.** The exporter prints a summary (entities, observation counts,
   docs per project, what was dropped and why) before anything uploads. Nothing goes up without a
   yes on the first run.
5. **Embeddings stay home.** Deep docs go up as metadata + markdown only.

The Worker serves what is in D1 and nothing else. Excluded data is not hidden by the server. It is
absent from Cloudflare entirely.

**Recommended starting allowlist:** the software projects only. Boardroom, Boardroom_Native, Spec,
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

Cloudflare's current guidance splits this into two Workers: an authorization server
(`OAuthAuthorizationServer`, KV-backed) and the MCP resource server (`OAuthResourceServer` around
`createMcpHandler`, linked by a service binding). The authorization Worker becomes the Aligned
login that Persona and Boardroom share in phase 4.

Who may sign in:

| Option | Verdict |
|---|---|
| **GitHub sign-in, Kam's numeric GitHub user id allowlisted** | **Recommended.** Uses his 2FA'd GitHub account. Needs a free GitHub OAuth App. Anyone else who signs in is refused after GitHub returns. |
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
- **Audit log** (D1 `audit_log`): one row per request, including refused ones. Time, user,
  OAuth client, tool, query text, rows returned, response size, IP, country, outcome. 90-day
  retention. Read it with `wrangler d1 execute aligned-memory --remote --command "select …"`.

### Threats step 1 handles

| Threat | Control |
|---|---|
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

- `test/memory-export.test.mjs`: a fixture store with family, personal and secret-bearing entries.
  Asserts the allowlist fails closed, other scope files are refused by name, BLOCK findings stop
  the export, REVIEW findings are dropped.
- `test/worker.test.mjs`: the Worker under `wrangler dev` (local D1), driven by the SDK's Streamable
  HTTP client. Asserts unauthenticated calls get `401` with `resource_metadata`, only the five read
  tools are listed, results match the local server's shapes, an out-of-scope entity is unreachable,
  and the audit row is written.
