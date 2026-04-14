# Fort Abode Integration Notes

_How `setup-claude-memory` interacts with Fort Abode Utility Central. Keep this current so Fort Abode sessions always know what coordination is needed._

## What Fort Abode already does for this repo

Fort Abode manages `setup-claude-memory` as a component in its `component-registry.json`. On app launch and periodic check:

1. Calls `npm view setup-claude-memory version` to get the latest published version
2. Compares against the locally-installed version (detected via npm or existing Claude Desktop config)
3. If newer: shows an update prompt in the Fort Abode UI
4. On user accept: runs the install command (effectively `npx setup-claude-memory` under the hood or a bundled equivalent)
5. Post-install: runs `performMemoryPostInstall()` — iCloud folder pinning + CLAUDE.md sync

Fort Abode also handles **per-user personalization** for the memory MCP server names:

- Setup wizard collects `DISPLAY_NAME` (e.g. "Kam" or "Tiera")
- Config keys use `{{user_input:DISPLAY_NAME}}-Memory` and `{{user_input:DISPLAY_NAME}}-Deep-Context`
- Stored resolved `DISPLAY_NAME` in UserDefaults keyed by component ID
- Auto-migration renames any legacy `Kam-*` keys on Tiera's machines via `detectMemoryMigration()` / `migrateMemoryKeys(displayName:)`
- This landed in Fort Abode v3.0ish on 2026-04-09 (see deep context `fort-abode-memory-naming-personalization-2026-04-09`)

## What v1.5.0 of this CLI needs from Fort Abode

**Short answer: nothing new.** The existing update flow is sufficient.

**Details:**
- Fort Abode already detects new npm versions. When we publish v1.5.0, Tiera's Fort Abode will offer the update normally.
- The family memory deploy is **opt-in by design** — the CLI prompts the user during the normal flow. Fort Abode's update handler doesn't need to trigger anything extra.
- No new component registry entry needed — family memory is a feature inside the existing `setup-claude-memory` component, not a new component.

**Optional enhancement (deferred):** Fort Abode could add a "Family Memory" section to the app UI that shows a status chip — "Family Memory: not configured" / "Family Memory: installed, last synced X". Would be a nice visual confirmation without requiring user action. Low priority; defer until v1.5.0 is stable and Kam asks for it.

## What v1.5.0 of this CLI needs to avoid breaking in Fort Abode

1. **Don't rename existing Claude Desktop config keys.** The personalized key names (`Kam-Memory`, `Tiera-Memory`, etc.) are managed by Fort Abode. The v1.5.0 family memory step must only touch files inside `~/Library/Mobile Documents/com~apple~CloudDocs/Kennedy Family Docs/Claude/Family Memory/` and append to `~/.claude/CLAUDE.md`. It must NOT modify `~/Library/Application Support/Claude/claude_desktop_config.json`.
2. **Don't clobber Fort Abode's iCloud pinning.** Fort Abode uses `xattr` to keep the `Claude Memory` folder downloaded locally (`performMemoryPostInstall`). The v1.5.0 family memory step should not touch the personal `Claude Memory` folder at all — different iCloud folder entirely.
3. **Don't modify bundled template versions.** The Weekly Rhythm Engine templates are Fort Abode-managed (bundled in the app, silent updates). Family memory templates are CLI-managed (bundled in this npm package). Keep the two clearly separated.

## Coordination protocol when shipping updates

### When shipping a `setup-claude-memory` version that affects Fort Abode behavior

1. Before publishing: check the Fort Abode `component-registry.json` entry for `setup-claude-memory`. If the new CLI version changes any config-key format, update `component-registry.json` in the Fort Abode repo first.
2. After publishing npm: run `aim_memory_add_facts` on `Fort_Abode_Utility_Central` entity noting the new version + any coordination notes.
3. If the new CLI version requires a Fort Abode bump (unlikely for v1.5.0): file a follow-up task in Kam's Weekly Rhythm for the next Fort Abode session.

### When shipping a Fort Abode update that changes memory handling

1. Check this file first to see what assumptions `setup-claude-memory` is making
2. If Fort Abode starts managing family memory directly (future `FamilyMemoryService.swift`): update this doc to list that as a new Fort Abode responsibility and optionally remove the corresponding CLI flow

## Relevant Fort Abode files (reference — do not modify from this repo)

- `Services/ClaudeDesktopConfigService.swift` — manages Claude Desktop config file
- `Services/WeeklyRhythmService.swift` — pattern to follow if we ever build `FamilyMemoryService.swift`
- `ViewModels/ComponentListViewModel.swift` — component install/update orchestration
- `Resources/component-registry.json` — registry entry for `setup-claude-memory`
- `ViewModels/ComponentListViewModel.swift.performMemoryPostInstall()` — iCloud pinning + CLAUDE.md sync

## Current Fort Abode version + compat

- **Fort Abode:** v3.7.0 (shipped 2026-04-14)
- **`setup-claude-memory` latest on npm:** v1.4.0 (as of 2026-04-14)
- **Family memory target version:** v1.5.0 (next minor bump, Phase 2 of `pure-sparking-grove.md`)
- **Fort Abode min version for family memory coexistence:** v3.7.0 already sufficient — no Fort Abode bump needed

## Checklist for next v1.5.0 session

- [ ] Modify `bin/setup.js` — add Path A (interactive family memory prompt after personal memory setup) + Path B (`--family` flag)
- [ ] Add idempotent routing-block append to `~/.claude/CLAUDE.md` logic (check for `<!-- family-memory-routing v1 -->` marker)
- [ ] Ensure `package.json` `files` field includes `templates/` so `npm publish` ships them
- [ ] Update `README.md` — new Family Memory section
- [ ] Bump to v1.5.0, commit, `npm publish`, `git tag v1.5.0 && git push --tags`
- [ ] Verify `npm view setup-claude-memory version` shows v1.5.0
- [ ] `aim_memory_add_facts` on Fort_Abode_Utility_Central entity: "setup-claude-memory v1.5.0 ships family memory feature"
- [ ] Walk Tiera through updating Fort Abode → running `npx setup-claude-memory --family` → confirming routing block + folder contents on her side
