# Family Memory Routing

This is the canonical routing protocol for family memory. Every Claude session that might touch a family topic should follow this. The same block is appended (idempotently, via magic marker comment) to each user's `~/.claude/CLAUDE.md` by `setup-claude-memory` v1.5.0+.

---

<!-- family-memory-routing v1 -->
## Family Memory (Kam + Tiera)

For ANY family-related topic — health insurance, house, vehicles, pets, shared finances, wedding/anniversary, shared contacts, family calendar, joint travel, home maintenance — BEFORE answering:

1. Read `~/Library/Mobile Documents/com~apple~CloudDocs/Kennedy Family Docs/Claude/Family Memory/FAMILY_MEMORY.md` for the current state of shared facts
2. Read `.../Family Memory/changelog.md` to see what was added/changed since your last session (the other person may have updated it)
3. If the question is about a specific document (insurance plan, warranty, deed, vehicle title), consult `.../Family Memory/pdf-index.md` first, then use the `anthropic-skills:pdf` skill to open the file on demand
4. For structured lookups (deductibles, plan IDs, claim phones), check `.../Family Memory/facts.json`

### Family Memory Session Wrap

If this session added or modified any family facts:
- Append a timestamped entry to `changelog.md` (append-only — never delete past entries). ISO timestamp format `YYYY-MM-DDTHH:MM`. Sign with initials (KK = Kam, TK = Tiera).
- Update the relevant `## Section` in `FAMILY_MEMORY.md` surgically (one section at a time, never rewrite the whole file).
- If a PDF was parsed, cache the extracted text to `pdf-cache/{filename}.txt`.
- Update the `last_modified` field in `facts.json` if facts were added/changed.

### Write discipline (iCloud conflict avoidance)

- `changelog.md` is **append-only** — safe under concurrent edits
- `FAMILY_MEMORY.md` edits are **section-based** — replace one `## Heading` at a time, never rewrite the whole file
- Check `Last Modified` header at top of `FAMILY_MEMORY.md` before editing — warn user if it changed mid-session
- Never commit SSNs, driver license numbers, or full account numbers to any file here — plan details, deductibles, claim phones, and ID card surface info are fine
<!-- /family-memory-routing -->
