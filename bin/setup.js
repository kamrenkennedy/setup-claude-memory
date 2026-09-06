#!/usr/bin/env node

const inquirer      = require('inquirer');
const chalk         = require('chalk');
const os            = require('os');
const fs            = require('fs');
const path          = require('path');
const { execSync, spawnSync }  = require('child_process');
const gm            = require('./git-migrate');
const mc            = require('./memory-compact');

const homeDir       = os.homedir();
const ICLOUD_BASE   = path.join(homeDir, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
const CLAUDE_CONFIG = path.join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');

const FAMILY_ROUTING_MARKER_OPEN  = '<!-- family-memory-routing v1 -->';
const FAMILY_ROUTING_MARKER_CLOSE = '<!-- /family-memory-routing -->';
const FAMILY_MEMORY_SUBPATH       = path.join('Claude', 'Family Memory');

// ─── helpers ────────────────────────────────────────────────────────────────

function checkPrerequisites() {
  const errors = [];
  const major = parseInt(process.version.slice(1).split('.')[0], 10);
  if (major < 18) errors.push(`Node.js 18+ required — you have ${process.version}. Upgrade at https://nodejs.org`);
  if (!fs.existsSync(ICLOUD_BASE)) errors.push('iCloud Drive not found. Make sure iCloud Drive is enabled and signed in on this Mac.');
  if (!fs.existsSync(path.dirname(CLAUDE_CONFIG))) errors.push('Claude Desktop config directory not found. Is Claude Desktop installed?');
  return errors;
}

function loadClaudeConfig() {
  if (!fs.existsSync(CLAUDE_CONFIG)) return {};
  try { return JSON.parse(fs.readFileSync(CLAUDE_CONFIG, 'utf8')); }
  catch { throw new Error('Could not parse claude_desktop_config.json — check for JSON errors at jsonlint.com'); }
}

function saveClaudeConfig(config) {
  fs.writeFileSync(CLAUDE_CONFIG, JSON.stringify(config, null, 2), 'utf8');
}

// Scan the Claude Desktop config for an existing knowledge graph server.
// Returns { serverName, memoryPath } or null.
function detectFromClaudeConfig(mcpServers) {
  // Match BOTH the legacy third-party server and our own (v1.6.0+). Matching only
  // 'mcp-knowledge-graph' meant that once a user upgraded, the installer stopped
  // recognising their existing setup and re-ran as if this were a fresh machine.
  const isMemoryServer = args =>
    args.includes('mcp-knowledge-graph') || args.includes('aim-memory-server');

  const candidates = [];
  for (const [key, val] of Object.entries(mcpServers)) {
    if (!Array.isArray(val.args) || !isMemoryServer(val.args)) continue;
    const mpIdx = val.args.indexOf('--memory-path');
    if (mpIdx === -1 || !val.args[mpIdx + 1]) continue;
    candidates.push({ serverName: key, memoryPath: val.args[mpIdx + 1] });
  }
  if (candidates.length === 0) return null;

  // Skip entries whose name still contains an unresolved {{placeholder}} — those are
  // broken installs, and adopting one would derive a first name of
  // '{{user_input:DISPLAY_NAME}}' and write real servers under that garbage key.
  return candidates.find(c => !c.serverName.includes('{{')) || candidates[0];
}

// Config entries left behind by a failed install: the server name still carries an
// unresolved template placeholder, so they can never start.
function findBrokenPlaceholderServers(mcpServers) {
  return Object.keys(mcpServers).filter(k => k.includes('{{'));
}

function findExistingDeepServer(mcpServers) {
  return Object.keys(mcpServers).find(k =>
    Array.isArray(mcpServers[k].args) && mcpServers[k].args.includes('aim-deep-context-server')
  );
}

// Scan iCloud Drive for folders that look like an existing memory setup
// (contains memory.jsonl). Returns array of folder paths found.
function scanICloudForMemory() {
  if (!fs.existsSync(ICLOUD_BASE)) return [];
  try {
    return fs.readdirSync(ICLOUD_BASE)
      .map(name => path.join(ICLOUD_BASE, name))
      .filter(p => {
        try {
          return fs.statSync(p).isDirectory() &&
                 fs.existsSync(path.join(p, 'memory.jsonl'));
        } catch { return false; }
      });
  } catch { return []; }
}

function readUserConfig(configPath) {
  if (!fs.existsSync(configPath)) return null;
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch { return null; }
}

// ─── step helper ─────────────────────────────────────────────────────────────

function step(label, fn) {
  process.stdout.write(label);
  try {
    fn();
    console.log(chalk.green('✓'));
  } catch (err) {
    console.log(chalk.red(`✗\n   ${err.message}`));
    process.exit(1);
  }
}

// Pin an iCloud folder so macOS keeps it downloaded locally at all times
// (equivalent to Finder → right-click → "Keep Downloaded")
// Uses brctl at folder level (pins all current + future files) with xattr fallback
function pinToICloud(folderPath) {
  try {
    execSync(`brctl download "${folderPath}" 2>/dev/null`);
  } catch {
    try {
      execSync(`xattr -w com.apple.fileprovider.pinned 1 "${folderPath}"`);
    } catch {
      // Non-critical — the MCP still works, files just might get offloaded
    }
  }
}

// ─── CLAUDE.md global config ────────────────────────────────────────────────

const CLAUDE_MD_DIR  = path.join(homeDir, '.claude');
const CLAUDE_MD_PATH = path.join(CLAUDE_MD_DIR, 'CLAUDE.md');

const CLAUDE_MD_TEMPLATE = `# Global Claude Instructions

## Session Wrap (mandatory)

At the end of every session where meaningful work was done — any topic, any project — perform a session wrap before closing out:

1. **Memory MCP** (\`aim_memory_store\` or \`aim_memory_add_facts\`) — update the relevant project entity with current status, what was done, what's next, and key file locations. Remove stale observations that are no longer accurate.
2. **Deep Context** (\`aim_deep_store\`) — store a session summary with full narrative: what happened, decisions made, current state, how to resume.
3. Both systems must be current — they are the only things that persist across machines and sessions.

Don't wait to be asked. After finishing the main work, proactively run the session wrap. If the session is being cut short, prioritize the memory update over finishing extra tasks — the memory is what carries forward.

## Memory MCP Usage

- Memory MCP and Deep Context MCP are always available — use both
- Memory MCP = quick facts, project status, current state (knowledge graph)
- Deep Context = session narratives, decision logs, detailed context (long-form)
- When starting a new session, search both if the user references prior work
- When the user says "pick up where we left off," search Memory + Deep Context immediately before doing anything else
`;

function setupClaudeMd(icloudClaudeDir) {
  const icloudMdPath = path.join(icloudClaudeDir, 'CLAUDE.md');

  // Create iCloud Claude config directory
  fs.mkdirSync(icloudClaudeDir, { recursive: true });

  // Write CLAUDE.md to iCloud (only if it doesn't exist — don't overwrite user edits)
  if (!fs.existsSync(icloudMdPath)) {
    fs.writeFileSync(icloudMdPath, CLAUDE_MD_TEMPLATE, 'utf8');
  }

  // Ensure ~/.claude/ exists
  fs.mkdirSync(CLAUDE_MD_DIR, { recursive: true });

  // Create symlink (remove existing file/symlink first)
  try {
    const stat = fs.lstatSync(CLAUDE_MD_PATH);
    if (stat.isSymbolicLink() || stat.isFile()) {
      fs.unlinkSync(CLAUDE_MD_PATH);
    }
  } catch {
    // Doesn't exist — that's fine
  }
  fs.symlinkSync(icloudMdPath, CLAUDE_MD_PATH);

  // Pin the iCloud Claude config folder
  pinToICloud(icloudClaudeDir);
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const familyOnly = argv.includes('--family');
  const gitMode    = argv.includes('--git');
  const scanOnly   = argv.includes('--scan');
  const compactMode= argv.includes('--compact');

  if (scanOnly || gitMode || compactMode) {
    const errs = checkPrerequisites();
    if (errs.length) { errs.forEach(e => console.log(chalk.red(`✗ ${e}`))); process.exit(1); }
    let cfg;
    try { cfg = loadClaudeConfig(); } catch (err) { console.log(chalk.red(`✗ ${err.message}`)); process.exit(1); }
    const found = detectFromClaudeConfig(cfg.mcpServers || {});
    if (!found) {
      console.log(chalk.red('\n✗ No memory setup found on this machine. Run `npx setup-claude-memory@latest` first.\n'));
      process.exit(1);
    }
    if (scanOnly) { process.exit(runScan(found.memoryPath) ? 0 : 1); }
    if (compactMode) { await runCompaction(found.memoryPath, argv[argv.indexOf('--compact') + 1]); return; }
    await runGitMigration({ config: cfg, ...found });
    return;
  }

  if (familyOnly) {
    console.log(chalk.bold.cyan('\n👪  Family Memory Setup\n'));
    const errs = checkPrerequisites();
    if (errs.length) { errs.forEach(e => console.log(chalk.red(`✗ ${e}`))); process.exit(1); }
    await runFamilySetup();
    return;
  }

  console.log(chalk.bold.cyan('\n🧠  Claude Memory Setup\n'));

  const errors = checkPrerequisites();
  if (errors.length) {
    errors.forEach(e => console.log(chalk.red(`✗ ${e}`)));
    process.exit(1);
  }

  // Read Claude Desktop config first — before asking a single question
  let config;
  try { config = loadClaudeConfig(); }
  catch (err) { console.log(chalk.red(`✗ ${err.message}`)); process.exit(1); }
  if (!config.mcpServers) config.mcpServers = {};

  // ── Scenario 1: Already configured on THIS machine ───────────────────────
  const existingLocal = detectFromClaudeConfig(config.mcpServers);

  // Offer to clear out entries a failed install left behind. They can never start,
  // so Claude shows a "Server disconnected" error for each one on every launch.
  const broken = findBrokenPlaceholderServers(config.mcpServers);
  if (broken.length) {
    console.log(chalk.yellow(`\n⚠️  Found ${broken.length} broken server ${broken.length === 1 ? 'entry' : 'entries'} in your Claude config:\n`));
    for (const k of broken) console.log(`  ${chalk.dim(k)}`);
    console.log(chalk.dim('\n  The name still contains an unfilled placeholder, so these can never start —'));
    console.log(chalk.dim('  Claude reports "Server disconnected" for each one every launch.\n'));
    const { removeBroken } = await inquirer.prompt([{
      type: 'confirm', name: 'removeBroken', message: 'Remove them?', default: true
    }]);
    if (removeBroken) {
      for (const k of broken) delete config.mcpServers[k];
      saveClaudeConfig(config);
      console.log(chalk.green('  ✓ Removed.\n'));
    }
  }

  if (existingLocal) {
    const { serverName, memoryPath } = existingLocal;
    const firstName      = serverName.replace(/-Memory$/i, '');
    const deepServerName = `${firstName}-Deep-Context`;
    const deepPath       = path.join(memoryPath, 'deep');
    const configPath     = path.join(memoryPath, 'config.json');
    const hasDeepDir     = fs.existsSync(deepPath);
    const hasConfig      = fs.existsSync(configPath);
    const hasDeepMCP     = !!findExistingDeepServer(config.mcpServers);
    const fullySetUp     = hasDeepDir && hasConfig && hasDeepMCP;

    if (fullySetUp) {
      console.log(chalk.green('✓ Found existing setup on this machine:\n'));
      console.log(`  Knowledge graph : ${chalk.cyan(serverName)}`);
      console.log(`  Deep context    : ${chalk.cyan(deepServerName)}`);
      console.log(`  iCloud folder   : ${chalk.cyan(memoryPath)}\n`);

      // Bring the MCP server entries up to date UNCONDITIONALLY. This is what
      // actually swaps in a new server version, so it must not hang off the
      // question below — which asks about preferences, not servers. Until v1.6.2
      // this lived only in the "no" branch, so answering YES to "update your
      // configuration?" upgraded strictly less than answering no.
      const wasLegacy = isLegacyMemoryEntry(config.mcpServers[serverName]);
      config.mcpServers[serverName]     = kgEntry(memoryPath);
      config.mcpServers[deepServerName] = deepEntry(memoryPath);
      saveClaudeConfig(config);

      if (wasLegacy) {
        console.log(chalk.bold.green('✅  Memory server upgraded to search-first reads.\n'));
        console.log('  Searches now return matching observations instead of whole entities,');
        console.log('  so a large memory can no longer flood a session. Your memory files are');
        console.log('  unchanged — same format, same location.\n');
        console.log(chalk.dim('  Restart Claude Desktop to pick it up. Sessions already running\n  keep the old server until they restart, which is safe.\n'));
      }

      const { doUpdate } = await inquirer.prompt([{
        type: 'confirm', name: 'doUpdate',
        message: 'Review your preferences (Notion, Calendar, Reminders)?',
        default: false
      }]);

      if (!doUpdate) {
        if (!wasLegacy) console.log(chalk.bold.green('✅  All good — nothing changed.\n'));
        await maybePromptFamilySetup();
        return;
      }

      await runConfigQuestionnaire(configPath, firstName, true);
      console.log(chalk.bold.green('\n✅  Preferences updated.\n'));
      console.log(chalk.dim('Restart Claude Desktop for changes to take effect.\n'));
      await maybePromptFamilySetup();
      return;

    } else {
      // Partial — upgrade from older version
      console.log(chalk.yellow('↑  Upgrading existing setup:\n'));
      console.log(`  Found   : ${chalk.cyan(serverName)} → ${chalk.dim(memoryPath)}`);
      if (!hasDeepDir) console.log(`  Adding  : ${chalk.cyan('deep context archive')}`);
      if (!hasDeepMCP) console.log(`  Adding  : ${chalk.cyan(deepServerName)}`);
      if (!hasConfig)  console.log(`  Adding  : ${chalk.cyan('config.json')} (quick questionnaire)`);
      console.log('');

      const { confirmed } = await inquirer.prompt([{
        type: 'confirm', name: 'confirmed', message: 'Proceed?', default: true
      }]);
      if (!confirmed) { console.log(chalk.yellow('\nCancelled.\n')); process.exit(0); }
      console.log('');

      await runUpgrade({ config, serverName, deepServerName, firstName, memoryPath, hasDeepDir, hasDeepMCP, hasConfig, configPath });
      return;
    }
  }

  // ── Scenario 2: New machine, but iCloud folder already exists ────────────
  const iCloudMatches = scanICloudForMemory();

  if (iCloudMatches.length > 0) {
    // Pick the right folder if there are multiple
    let memoryPath;
    if (iCloudMatches.length === 1) {
      memoryPath = iCloudMatches[0];
    } else {
      const { chosen } = await inquirer.prompt([{
        type: 'list', name: 'chosen',
        message: 'Found multiple memory folders in iCloud — which one is yours?',
        choices: iCloudMatches.map(p => ({ name: path.basename(p), value: p }))
      }]);
      memoryPath = chosen;
    }

    const configPath   = path.join(memoryPath, 'config.json');
    const userConfig   = readUserConfig(configPath);
    const folderName   = path.basename(memoryPath);
    const detectedName = userConfig && userConfig.first_name;

    let firstName;

    if (detectedName) {
      // We know who this is — one confirmation and done
      console.log(chalk.green(`✓ Found ${detectedName}'s memory in iCloud:\n`));
      console.log(`  Folder  : ${chalk.cyan(folderName)}`);
      console.log(`  ${chalk.dim('Your existing memories and deep context will be available immediately.')}\n`);

      const { confirmed } = await inquirer.prompt([{
        type: 'confirm', name: 'confirmed',
        message: `Connect this Mac to ${detectedName}'s memory?`,
        default: true
      }]);
      if (!confirmed) { console.log(chalk.yellow('\nCancelled.\n')); process.exit(0); }

      firstName = detectedName;
    } else {
      // Found folder but no first_name stored — ask just for the name
      console.log(chalk.green(`✓ Found existing memory folder in iCloud: "${folderName}"\n`));
      console.log(chalk.dim('  Your existing memories will be available immediately.\n'));

      const { name } = await inquirer.prompt([{
        type: 'input', name: 'name',
        message: 'Your first name (to label your memory servers):',
        validate: v => v.trim().length > 0 || 'Please enter your name'
      }]);
      firstName = name.trim();
    }

    const serverName     = `${firstName}-Memory`;
    const deepServerName = `${firstName}-Deep-Context`;

    console.log('');
    await runMachine2Setup({ config, serverName, deepServerName, firstName, memoryPath, configPath, userConfig });
    return;
  }

  // ── Scenario 3: Completely fresh install ─────────────────────────────────
  console.log('Sets up persistent memory for Claude Desktop, synced via iCloud.\n');

  const answers = await inquirer.prompt([
    {
      type: 'input', name: 'firstName',
      message: 'Your first name (used to label your memory servers, e.g. "Kam-Memory"):',
      validate: v => v.trim().length > 0 || 'Please enter your name'
    },
    {
      type: 'input', name: 'folderName',
      message: 'iCloud folder name for your memory files:',
      default: 'Claude Memory'
    }
  ]);

  const firstName      = answers.firstName.trim();
  const folderName     = answers.folderName.trim();
  const serverName     = `${firstName}-Memory`;
  const deepServerName = `${firstName}-Deep-Context`;
  const memoryPath     = path.join(ICLOUD_BASE, folderName);
  const deepPath       = path.join(memoryPath, 'deep');
  const configPath     = path.join(memoryPath, 'config.json');

  console.log('');
  console.log(chalk.bold('Here\'s what will be set up:'));
  console.log(`  Knowledge graph server : ${chalk.cyan(serverName)}`);
  console.log(`  Deep context server    : ${chalk.cyan(deepServerName)}`);
  console.log(`  iCloud folder          : ${chalk.cyan(memoryPath)}`);
  console.log('');

  const { confirmed } = await inquirer.prompt([{
    type: 'confirm', name: 'confirmed', message: 'Proceed?', default: true
  }]);
  if (!confirmed) { console.log(chalk.yellow('\nSetup cancelled.\n')); process.exit(0); }
  console.log('');

  await runFreshInstall({ config, serverName, deepServerName, firstName, memoryPath, deepPath, configPath, folderName });
}

// ─── install routines ────────────────────────────────────────────────────────

async function runFreshInstall({ config, serverName, deepServerName, firstName, memoryPath, deepPath, configPath, folderName }) {
  const indexPath = path.join(deepPath, 'index.json');

  step('1. Creating iCloud memory folder...   ', () => fs.mkdirSync(memoryPath, { recursive: true }));
  step('2. Pinning folder (Keep Downloaded)...', () => pinToICloud(memoryPath));
  step('3. Configuring knowledge graph MCP... ', () => { config.mcpServers[serverName] = kgEntry(memoryPath); });
  step('4. Configuring deep context MCP...    ', () => { config.mcpServers[deepServerName] = deepEntry(memoryPath); });
  step('5. Saving Claude Desktop config...    ', () => saveClaudeConfig(config));
  step('6. Creating deep context archive...   ', () => {
    fs.mkdirSync(deepPath, { recursive: true });
    if (!fs.existsSync(indexPath)) fs.writeFileSync(indexPath, '[]', 'utf8');
  });
  step('7. Setting up global CLAUDE.md...     ', () => {
    const icloudClaudeDir = path.join(ICLOUD_BASE, path.basename(path.dirname(memoryPath)), 'Claude');
    // Fallback: put it alongside the memory folder if structure doesn't fit
    const claudeDir = fs.existsSync(path.dirname(memoryPath))
      ? path.join(path.dirname(memoryPath), 'Claude')
      : path.join(ICLOUD_BASE, 'Claude');
    setupClaudeMd(claudeDir);
  });

  await runConfigQuestionnaire(configPath, firstName, false, '8.');

  console.log('');
  console.log(chalk.bold.green('✅  Setup complete!\n'));
  console.log(chalk.bold('Next steps:'));
  console.log(`  1. Fully quit Claude Desktop  ${chalk.dim('(Cmd+Q — not just close the window)')}`);
  console.log('  2. Relaunch Claude Desktop');
  console.log(`  3. Click  +  →  Connectors  — you should see  "${chalk.cyan(serverName)}"  and  "${chalk.cyan(deepServerName)}"\n`);
  console.log(chalk.bold('Session memory:'));
  console.log('  A global CLAUDE.md has been created and symlinked to ~/.claude/CLAUDE.md.');
  console.log('  It instructs Claude to always save session state to Memory + Deep Context');
  console.log('  at the end of every session — so you can pick up right where you left off');
  console.log('  on any machine. Edit the iCloud copy to customize.\n');
  console.log(chalk.dim(`Setting up a second Mac? Run this script there — it'll detect your iCloud folder automatically.\n`));

  await maybePromptFamilySetup();
}

async function runUpgrade({ config, serverName, deepServerName, firstName, memoryPath, hasDeepDir, hasDeepMCP, hasConfig, configPath }) {
  const deepPath  = path.join(memoryPath, 'deep');
  const indexPath = path.join(deepPath, 'index.json');
  let n = 1;

  config.mcpServers[serverName]     = kgEntry(memoryPath);
  config.mcpServers[deepServerName] = deepEntry(memoryPath);

  step(`${n++}. Saving Claude Desktop config...    `, () => saveClaudeConfig(config));

  if (!hasDeepDir) {
    step(`${n++}. Creating deep context archive...   `, () => {
      fs.mkdirSync(deepPath, { recursive: true });
      if (!fs.existsSync(indexPath)) fs.writeFileSync(indexPath, '[]', 'utf8');
    });
  }

  // Set up global CLAUDE.md (symlinked to iCloud)
  step(`${n++}. Setting up global CLAUDE.md...      `, () => {
    const claudeDir = path.join(path.dirname(memoryPath), 'Claude');
    setupClaudeMd(claudeDir);
  });

  if (!hasConfig) {
    await runConfigQuestionnaire(configPath, firstName, false, `${n++}.`);
  } else {
    // Ensure first_name is stored even on older config.json installs
    const existing = readUserConfig(configPath) || {};
    if (!existing.first_name) {
      step(`${n++}. Updating configuration...           `, () => {
        fs.writeFileSync(configPath, JSON.stringify({ ...existing, first_name: firstName }, null, 2), 'utf8');
      });
    }
  }

  console.log('');
  console.log(chalk.bold.green('✅  Upgrade complete!\n'));
  console.log(chalk.dim('Restart Claude Desktop to activate the new deep context server.\n'));

  await maybePromptFamilySetup();
}

async function runMachine2Setup({ config, serverName, deepServerName, firstName, memoryPath, configPath, userConfig }) {
  const deepPath  = path.join(memoryPath, 'deep');
  const indexPath = path.join(deepPath, 'index.json');

  step('1. Configuring knowledge graph MCP...  ', () => { config.mcpServers[serverName] = kgEntry(memoryPath); });
  step('2. Configuring deep context MCP...     ', () => { config.mcpServers[deepServerName] = deepEntry(memoryPath); });
  step('3. Saving Claude Desktop config...     ', () => saveClaudeConfig(config));
  step('4. Pinning folder (Keep Downloaded)... ', () => pinToICloud(memoryPath));
  step('5. Verifying deep context archive...   ', () => {
    // deep/ should already be synced from the first machine, but ensure it exists
    // in case iCloud hasn't finished syncing yet
    fs.mkdirSync(deepPath, { recursive: true });
    if (!fs.existsSync(indexPath)) fs.writeFileSync(indexPath, '[]', 'utf8');
  });
  step('6. Setting up global CLAUDE.md...      ', () => {
    const claudeDir = path.join(path.dirname(memoryPath), 'Claude');
    setupClaudeMd(claudeDir);
  });

  // Store first_name if it wasn't in config.json yet
  if (userConfig && !userConfig.first_name) {
    step('7. Updating configuration...           ', () => {
      fs.writeFileSync(configPath, JSON.stringify({ ...userConfig, first_name: firstName }, null, 2), 'utf8');
    });
  }

  console.log('');
  console.log(chalk.bold.green('✅  This Mac is now connected!\n'));
  console.log(chalk.bold('Next steps:'));
  console.log(`  1. Fully quit Claude Desktop  ${chalk.dim('(Cmd+Q)')}`);
  console.log('  2. Relaunch Claude Desktop');
  console.log(`  3. Your existing memories and deep context will be available immediately via ${chalk.cyan(serverName)}\n`);

  await maybePromptFamilySetup();
}

// ─── config questionnaire ────────────────────────────────────────────────────

async function runConfigQuestionnaire(configPath, firstName, isUpdate, prefix = '6.') {
  console.log('');
  console.log(chalk.bold(isUpdate ? 'Update your configuration:\n' : 'Quick configuration (helps Claude know which tools you use):\n'));

  const answers = await inquirer.prompt([
    { type: 'confirm', name: 'notion_enabled',    message: 'Do you use Notion for project management?', default: false },
    { type: 'confirm', name: 'gcal_enabled',      message: 'Do you use Google Calendar?',               default: false },
    { type: 'confirm', name: 'reminders_enabled', message: 'Do you use Apple Reminders?',               default: false }
  ]);

  const existing = readUserConfig(configPath) || {};
  const userConfig = {
    ...existing,
    schema_version:    1,
    first_name:        firstName,
    notion_enabled:    answers.notion_enabled,
    gcal_enabled:      answers.gcal_enabled,
    reminders_enabled: answers.reminders_enabled,
  };

  console.log('');
  step(`${prefix} Saving configuration...             `, () => {
    fs.writeFileSync(configPath, JSON.stringify(userConfig, null, 2), 'utf8');
  });
}

// ─── MCP config entry builders ───────────────────────────────────────────────

function kgEntry(memoryPath) {
  // Our own search-first server (v1.6.0+). A drop-in for mcp-knowledge-graph —
  // same tools, same file format — but a search returns matching observations
  // instead of whole entities, and writes are atomic.
  return { command: 'npx', args: ['-y', '--package=setup-claude-memory@latest', 'aim-memory-server', '--memory-path', memoryPath] };
}

// True when the configured memory server is the old third-party one.
function isLegacyMemoryEntry(entry) {
  return !!entry && Array.isArray(entry.args) && entry.args.includes('mcp-knowledge-graph');
}

function deepEntry(memoryPath) {
  return { command: 'npx', args: ['-y', '--package=setup-claude-memory@latest', 'aim-deep-context-server', '--memory-path', memoryPath] };
}

function readUserConfig(configPath) {
  if (!fs.existsSync(configPath)) return null;
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch { return null; }
}

// ─── compaction (--compact) ──────────────────────────────────────────────────

function loadStore(memoryPath) {
  const file = path.join(memoryPath, 'memory.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
  const graph = { entities: [], relations: [] };
  for (const l of lines.slice(1)) {
    const o = JSON.parse(l);
    if (o.type === 'entity') graph.entities.push(o);
    else if (o.type === 'relation') graph.relations.push(o);
  }
  return { file, graph };
}

function saveStore(file, graph) {
  const out = [
    JSON.stringify({ type: '_aim', source: 'mcp-knowledge-graph' }),
    ...graph.entities.map(e => JSON.stringify({ type: 'entity', ...e })),
    ...graph.relations.map(r => JSON.stringify({ type: 'relation', ...r })),
  ].join('\n');
  const mode = fs.statSync(file).mode & 0o777;
  const tmp = path.join(path.dirname(file), `.memory.jsonl.tmp-${process.pid}`);
  fs.writeFileSync(tmp, out, { mode });
  fs.renameSync(tmp, file);
}

async function runCompaction(memoryPath, requested) {
  console.log(chalk.bold.cyan('\n🧹  Archive finished work\n'));
  console.log(chalk.dim('  Nothing is deleted. Approved items move to an archive entity and stay searchable.\n'));

  const { file, graph } = loadStore(memoryPath);

  let entityName = requested && !requested.startsWith('--') ? requested : null;
  if (!entityName) {
    const sized = graph.entities
      .filter(e => !e.name.endsWith(mc.ARCHIVE_SUFFIX))
      .map(e => ({ name: e.name, chars: e.observations.reduce((n, o) => n + o.length, 0), obs: e.observations.length }))
      .sort((a, b) => b.chars - a.chars).slice(0, 10);
    const { pick } = await inquirer.prompt([{
      type: 'list', name: 'pick', message: 'Which entity?',
      choices: sized.map(e => ({ name: `${String(e.chars).padStart(7)} ch  ${String(e.obs).padStart(5)} obs  ${e.name}`, value: e.name })),
    }]);
    entityName = pick;
  }

  const p = mc.proposeCompaction(graph, entityName);
  console.log('');
  console.log(`  ${chalk.bold(p.entity)}: ${p.totalObservations} observations, ${p.totalChars.toLocaleString()} chars`);
  if (!p.candidates.length) { console.log(chalk.green('\n  Nothing to archive — no finished work matched.\n')); return; }
  console.log(`  Proposed: ${p.candidates.length} observations, ${p.proposedChars.toLocaleString()} chars ` +
              chalk.dim(`(${Math.round(p.proposedChars / p.totalChars * 100)}%)`));
  console.log('');

  const approved = [];
  for (const group of p.groups) {
    const clean = group.items.filter(i => !i.needsReview);
    const flagged = group.items.filter(i => i.needsReview);
    console.log(chalk.bold(`  ${group.label}`));
    console.log(chalk.dim(`    ${group.why}`));
    console.log(`    ${group.items.length} matched — ${clean.length} clean, ${flagged.length} need a look\n`);

    if (clean.length) {
      clean.slice(0, 3).forEach(i => console.log(chalk.dim(`      • ${i.text.slice(0, 100).replace(/\n/g, ' ')}…`)));
      if (clean.length > 3) console.log(chalk.dim(`      … and ${clean.length - 3} more`));
      const { take } = await inquirer.prompt([{
        type: 'confirm', name: 'take', message: `  Archive all ${clean.length} clean ones?`, default: true,
      }]);
      if (take) approved.push(...clean.map(i => i.text));
      console.log('');
    }

    // Flagged items hold the last copy of some identifier. Never bulk-approve these.
    if (flagged.length) {
      const { how } = await inquirer.prompt([{
        type: 'list', name: 'how',
        message: `  ${flagged.length} hold the ONLY copy of some identifier. These need a decision:`,
        choices: [
          { name: 'Keep them all (recommended)', value: 'keep' },
          { name: 'Review one at a time', value: 'each' },
        ],
      }]);
      if (how === 'each') {
        for (const item of flagged) {
          console.log('\n' + chalk.yellow('  ─────'));
          console.log('  ' + item.text.replace(/\n/g, '\n  '));
          console.log(chalk.yellow(`\n  Only copy of: ${item.orphanTokens.slice(0, 6).join(', ')}`));
          const { move } = await inquirer.prompt([{ type: 'confirm', name: 'move', message: '  Archive it anyway?', default: false }]);
          if (move) approved.push(item.text);
        }
      }
      console.log('');
    }
  }

  if (!approved.length) { console.log(chalk.yellow('\n  Nothing approved — no changes made.\n')); return; }

  const chars = approved.reduce((n, t) => n + t.length, 0);
  const { confirm } = await inquirer.prompt([{
    type: 'confirm', name: 'confirm',
    message: `Move ${approved.length} observations (${chars.toLocaleString()} chars) to ${p.archiveEntity}?`, default: true,
  }]);
  if (!confirm) { console.log(chalk.yellow('\nCancelled — nothing changed.\n')); return; }

  const beforeTotal = graph.entities.reduce((n, e) => n + e.observations.length, 0);
  const result = mc.applyCompaction(graph, entityName, approved);
  const afterTotal = graph.entities.reduce((n, e) => n + e.observations.length, 0);
  if (beforeTotal !== afterTotal) {
    console.log(chalk.red(`\n✗ Refusing to write: observation count changed ${beforeTotal} → ${afterTotal}.\n`));
    process.exit(1);
  }
  saveStore(file, graph);

  console.log('');
  console.log(chalk.bold.green(`✅  Moved ${result.moved} to ${result.archiveEntity} (now ${result.archiveTotal} observations).\n`));
  console.log(chalk.dim('  Nothing was deleted — everything moved is still searchable in the archive entity,'));
  console.log(chalk.dim('  and the next sync commits this, so it is revertable.\n'));
}

// ─── git migration (--git) ───────────────────────────────────────────────────

// Run the credential gate. Returns true when it is safe to push.
function runScan(storePath) {
  const scanner = path.join(__dirname, 'memory-scan.mjs');
  const r = spawnSync('node', [scanner, storePath], { stdio: 'inherit' });
  return r.status === 0;
}

async function runGitMigration({ config, serverName, memoryPath }) {
  const firstName = serverName.replace(/-Memory$/i, '');
  console.log(chalk.bold.cyan('\n📦  Move your memory into a private git repo\n'));
  console.log(`  Store : ${chalk.cyan(memoryPath)}\n`);

  // 1. Prerequisites. gh auth is the one step only the user can do.
  const pre = gm.checkGitPrereqs();
  if (!pre.git) {
    console.log(chalk.red('✗ git is not installed. Install the Xcode command line tools:\n    xcode-select --install\n'));
    process.exit(1);
  }
  if (!pre.gh) {
    console.log(chalk.red('✗ The GitHub CLI (gh) is not installed.\n'));
    console.log('  It handles signing in and creating the private repo for you.\n');
    console.log(`  Install it from ${chalk.cyan('https://cli.github.com')} — the .pkg installer needs no`);
    console.log('  Homebrew — then run this again.\n');
    process.exit(1);
  }
  if (!pre.ghAuthed) {
    console.log(chalk.yellow('!  You are not signed in to GitHub yet.\n'));
    console.log('  This opens your browser and asks you to authorize. Nothing is typed here.\n');
    const { doAuth } = await inquirer.prompt([{ type: 'confirm', name: 'doAuth', message: 'Sign in to GitHub now?', default: true }]);
    if (!doAuth) { console.log(chalk.yellow('\nCancelled.\n')); process.exit(0); }
    const r = spawnSync('gh', ['auth', 'login', '--web', '--git-protocol', 'https'], { stdio: 'inherit' });
    if (r.status !== 0 || !gm.checkGitPrereqs().ghAuthed) {
      console.log(chalk.red('\n✗ Sign-in did not complete. Run `gh auth login` yourself, then re-run this.\n'));
      process.exit(1);
    }
  }
  const account = gm.checkGitPrereqs().ghUser;
  console.log(chalk.green(`✓ Signed in to GitHub${account ? ` as ${account}` : ''}\n`));

  // 2. The credential gate, BEFORE anything is created. Git history is permanent.
  console.log(chalk.bold('Checking your memory for credentials...\n'));
  if (!runScan(memoryPath)) {
    console.log(chalk.red('✗ Stopping. Rotate anything real, remove it from your memory, then run this again.\n'));
    process.exit(1);
  }

  // 3. Where the repo lives. Refuse synced locations rather than warning about them.
  const suggested = gm.defaultRepoLocation();
  let repoPath;
  for (;;) {
    const { where } = await inquirer.prompt([{
      type: 'input', name: 'where', message: 'Folder for the repo:', default: suggested,
    }]);
    const candidate = path.resolve(where.trim().replace(/^~/, homeDir));
    const problem = gm.unsafeRepoLocation(candidate);
    if (!problem) { repoPath = candidate; break; }
    console.log(chalk.red(`\n  ✗ ${problem}\n`));
  }

  const { repoName } = await inquirer.prompt([{
    type: 'input', name: 'repoName', message: 'Private repo name:',
    default: `${firstName.toLowerCase()}-claude-memory`,
    validate: v => /^[A-Za-z0-9._-]+$/.test(v.trim()) || 'Letters, numbers, dots, dashes and underscores only',
  }]);

  // Second machine: the repo already exists, so JOIN it rather than trying to create
  // and push a divergent history.
  if (gm.repoExistsOnAccount(repoName)) {
    return runGitJoin({ repoName, repoPath, memoryPath, account, firstName });
  }

  console.log('');
  console.log(chalk.bold('About to:'));
  console.log(`  • copy your memory to ${chalk.cyan(repoPath)}`);
  console.log(`  • create ${chalk.cyan(`${account || 'you'}/${repoName}`)} as a ${chalk.bold('PRIVATE')} repo and push`);
  console.log(`  • leave a link at the old location so nothing breaks mid-session`);
  console.log(`  • sync in the background every 15 minutes\n`);
  console.log(chalk.dim('  Your original folder is kept, renamed, not deleted.\n'));
  const { go } = await inquirer.prompt([{ type: 'confirm', name: 'go', message: 'Proceed?', default: true }]);
  if (!go) { console.log(chalk.yellow('\nCancelled — nothing changed.\n')); process.exit(0); }
  console.log('');

  // 4. Copy, then PROVE the copy before anything destructive happens.
  let hashes;
  step('1. Copying your memory...                  ', () => {
    hashes = gm.fileHashes(memoryPath);
    gm.copyTree(memoryPath, repoPath);
  });
  step('2. Verifying every file byte-for-byte...    ', () => {
    const v = gm.verifyCopy(hashes, repoPath);
    if (v.mismatched.length) throw new Error(`copy mismatch on ${v.mismatched.length} file(s): ${v.mismatched.slice(0, 3).join(', ')}`);
    if (!v.checked) throw new Error('copy verified nothing — refusing to continue');
  });

  step('3. Setting up the repo...                   ', () => {
    if (!fs.existsSync(path.join(repoPath, '.git'))) gm.git(repoPath, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repoPath, '.gitignore'), gm.GITIGNORE, 'utf8');
    fs.writeFileSync(path.join(repoPath, '.gitattributes'), gm.GITATTRIBUTES, 'utf8');
    if (!fs.existsSync(path.join(repoPath, 'README.md'))) {
      fs.writeFileSync(path.join(repoPath, 'README.md'), gm.repoReadme(firstName), 'utf8');
    }
  });

  step('4. Installing the merge driver...           ', () => {
    gm.registerMergeDriver(repoPath, path.join(__dirname, 'memory-merge-driver.mjs'));
  });

  step('5. Committing...                            ', () => {
    gm.git(repoPath, ['add', '-A']);
    try { gm.git(repoPath, ['diff', '--cached', '--quiet']); }
    catch { gm.git(repoPath, ['commit', '-q', '-m', 'Move Claude memory into version control']); }
  });

  step('6. Creating the PRIVATE repo and pushing... ', () => {
    const exists = spawnSync('gh', ['repo', 'view', repoName], { encoding: 'utf8' }).status === 0;
    if (!exists) {
      const r = spawnSync('gh', ['repo', 'create', repoName, '--private', '--source', repoPath, '--push'], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`gh repo create failed: ${(r.stderr || '').trim().split('\n')[0]}`);
    } else {
      gm.git(repoPath, ['push', '-u', 'origin', 'main']);
    }
  });

  // Never take "it pushed" on trust — confirm GitHub agrees it is private.
  step('7. Confirming the repo is private...        ', () => {
    const r = spawnSync('gh', ['repo', 'view', repoName, '--json', 'isPrivate'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('could not read the repo back from GitHub');
    if (JSON.parse(r.stdout).isPrivate !== true) {
      throw new Error('THE REPO IS PUBLIC — make it private immediately in GitHub settings');
    }
  });

  let parked;
  step('8. Linking the old location...              ', () => { parked = gm.createBridge(memoryPath, repoPath); });

  step('9. Scheduling background sync...            ', () => {
    const dir = path.join(homeDir, 'Library', 'Application Support', 'claude-memory-sync');
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(dir, 'sync.sh');
    const log = path.join(dir, 'sync.log');
    fs.writeFileSync(script, gm.syncScript(repoPath, log), { mode: 0o755 });
    const label = 'com.kamstudios.claude-memory-sync';
    const plist = path.join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, gm.launchAgentPlist(label, script, 900), 'utf8');
    spawnSync('launchctl', ['unload', plist], { stdio: 'ignore' });
    spawnSync('launchctl', ['load', plist], { stdio: 'ignore' });
  });

  console.log('');
  console.log(chalk.bold.green('✅  Your memory is in a private git repo.\n'));
  console.log(`  Repo    : ${chalk.cyan(`${account || ''}/${repoName}`)} ${chalk.dim('(private, verified)')}`);
  console.log(`  Local   : ${chalk.cyan(repoPath)}`);
  console.log(`  Original: ${chalk.dim(parked)} ${chalk.dim('(kept — delete it yourself once you are happy)')}`);
  console.log(`  Syncing : every 15 min\n`);
  console.log(chalk.bold('Nothing needs changing right now.'));
  console.log('  The old location now points at the repo, so every session keeps working —');
  console.log('  running ones included. Config can be updated whenever you like.\n');

  // Report the surfaces this installer does not own, rather than editing them blind.
  const others = otherConfigSurfaces(memoryPath);
  if (others.length) {
    console.log(chalk.yellow('  These files still name the old path. They keep working through the link,'));
    console.log(chalk.yellow('  but update them when convenient:\n'));
    others.forEach(f => console.log(`    ${chalk.dim(f)}`));
    console.log('');
  }
}

// Second machine joining an existing memory repo. No migration happens here — the repo
// IS the store. What matters is that everything a clone does NOT bring gets installed:
// the merge driver above all, since without it this machine writes conflict markers.
async function runGitJoin({ repoName, repoPath, memoryPath, account, firstName }) {
  console.log('');
  console.log(chalk.bold.green(`✓ Found your existing memory repo: ${account || ''}/${repoName}\n`));
  console.log('  This machine will JOIN it rather than create a new one.\n');
  console.log(chalk.bold('About to:'));
  console.log(`  • clone it to ${chalk.cyan(repoPath)}`);
  console.log(`  • install the merge driver ${chalk.dim('(a clone does NOT bring this — without it this Mac writes conflict markers)')}`);
  console.log(`  • point this Mac's memory at the repo, and sync every 15 minutes`);
  console.log(`  • keep this Mac's current memory folder, renamed\n`);

  const { go } = await inquirer.prompt([{ type: 'confirm', name: 'go', message: 'Proceed?', default: true }]);
  if (!go) { console.log(chalk.yellow('\nCancelled — nothing changed.\n')); process.exit(0); }
  console.log('');

  step('1. Cloning your memory repo...             ', () => {
    if (fs.existsSync(path.join(repoPath, '.git'))) {
      gm.git(repoPath, ['pull', '--rebase', '--autostash']);
    } else {
      gm.cloneMemoryRepo(repoName, repoPath);
    }
  });

  step('2. Installing the merge driver...          ', () => {
    gm.registerMergeDriver(repoPath, path.join(__dirname, 'memory-merge-driver.mjs'));
  });

  // Anything this Mac wrote locally that never reached the repo would be lost by a
  // silent swap. Say so instead.
  let divergence = { comparable: false, entities: [], total: 0 };
  step('3. Checking this Mac for unsynced memory...', () => {
    divergence = gm.observationsMissingFromRepo(memoryPath, repoPath);
  });

  let parked;
  step('4. Linking this Mac to the repo...         ', () => { parked = gm.createBridge(memoryPath, repoPath); });

  step('5. Scheduling background sync...           ', () => {
    const dir = path.join(homeDir, 'Library', 'Application Support', 'claude-memory-sync');
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(dir, 'sync.sh');
    fs.writeFileSync(script, gm.syncScript(repoPath, path.join(dir, 'sync.log')), { mode: 0o755 });
    const label = 'com.kamstudios.claude-memory-sync';
    const plist = path.join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, gm.launchAgentPlist(label, script, 900), 'utf8');
    spawnSync('launchctl', ['unload', plist], { stdio: 'ignore' });
    spawnSync('launchctl', ['load', plist], { stdio: 'ignore' });
  });

  console.log('');
  console.log(chalk.bold.green('✅  This Mac is on your shared memory.\n'));
  console.log(`  Repo    : ${chalk.cyan(`${account || ''}/${repoName}`)}`);
  console.log(`  Local   : ${chalk.cyan(repoPath)}`);
  console.log(`  Original: ${chalk.dim(parked)} ${chalk.dim('(kept)')}`);
  console.log(`  Syncing : every 15 min\n`);

  if (divergence.comparable && divergence.total > 0) {
    console.log(chalk.yellow(`  ⚠️  This Mac's old folder held ${divergence.total} observation(s) the repo does not have:\n`));
    divergence.entities.slice(0, 8).forEach(e => console.log(`      ${String(e.missing).padStart(5)}  ${e.name}`));
    if (divergence.entities.length > 8) console.log(chalk.dim(`      … and ${divergence.entities.length - 8} more entities`));
    console.log('');
    console.log('  They are safe in the renamed folder above — nothing was deleted. Ask Claude to');
    console.log('  merge them in if they matter; this Mac had been writing memory of its own.\n');
  } else if (divergence.comparable) {
    console.log(chalk.dim('  This Mac had nothing the repo was missing — a clean join.\n'));
  }

  const others = otherConfigSurfaces(memoryPath);
  if (others.length) {
    console.log(chalk.yellow('  These files still name the old path. They work through the link, but update'));
    console.log(chalk.yellow('  them when convenient:\n'));
    others.forEach(f => console.log(`    ${chalk.dim(f)}`));
    console.log('');
  }
}

// Config files this installer does NOT manage, which may carry --memory-path.
function otherConfigSurfaces(memoryPath) {
  const candidates = [
    path.join(homeDir, '.claude.json'),
    path.join(homeDir, '.codex', 'config.toml'),
  ];
  return candidates.filter(f => {
    try { return fs.readFileSync(f, 'utf8').includes(memoryPath); } catch { return false; }
  });
}

// ─── family memory ───────────────────────────────────────────────────────────

async function maybePromptFamilySetup() {
  if (isFamilyRoutingInstalled()) return;

  console.log('');
  const { wantFamily } = await inquirer.prompt([{
    type: 'confirm', name: 'wantFamily',
    message: 'Do you share an iCloud folder with family members for common docs (insurance, house, etc.)?',
    default: false
  }]);
  if (!wantFamily) return;

  await runFamilySetup();
}

async function runFamilySetup() {
  const { sharedRoot } = await inquirer.prompt([{
    type: 'input', name: 'sharedRoot',
    message: 'Absolute path to the shared family iCloud folder:',
    default: path.join(ICLOUD_BASE, 'Kennedy Family Docs'),
    validate: v => fs.existsSync(v.trim()) || 'Path not found — make sure iCloud has synced this folder to this Mac first'
  }]);

  const familyRoot = path.join(sharedRoot.trim(), FAMILY_MEMORY_SUBPATH);

  console.log('');
  step('1. Creating Family Memory folder...         ', () => fs.mkdirSync(familyRoot, { recursive: true }));
  step('2. Deploying templates (no clobber)...      ', () => deployFamilyTemplates(familyRoot, familyRoot));
  step('3. Pinning folder (Keep Downloaded)...      ', () => pinToICloud(familyRoot));
  step('4. Installing routing block in ~/.claude/...', () => installFamilyRoutingBlock(familyRoot));

  console.log('');
  console.log(chalk.bold.green('✅  Family memory ready.\n'));
  console.log(chalk.bold('What this did:'));
  console.log(`  • Deployed templates to ${chalk.cyan(familyRoot)}`);
  console.log('  • Added a family-memory routing block to ~/.claude/CLAUDE.md');
  console.log('  • Left any existing files in the shared folder untouched\n');
  console.log(chalk.bold('Next steps:'));
  console.log('  1. Open that folder in Finder; populate FAMILY_MEMORY.md as facts accumulate');
  console.log(`  2. On your partner's Macs, run ${chalk.cyan('npx setup-claude-memory --family')} to install the routing block there too\n`);
}

function deployFamilyTemplates(destDir, familyRoot) {
  const tplDir = path.join(__dirname, '..', 'templates', 'family-memory');
  if (!fs.existsSync(tplDir)) throw new Error(`Templates missing at ${tplDir} — reinstall the package`);

  for (const f of fs.readdirSync(tplDir)) {
    const src = path.join(tplDir, f);
    const dst = path.join(destDir, f);
    if (fs.statSync(src).isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      continue;
    }
    if (fs.existsSync(dst)) continue; // never clobber user edits
    const rendered = renderFamilyTemplate(fs.readFileSync(src, 'utf8'), familyRoot);
    fs.writeFileSync(dst, rendered, 'utf8');
  }

  // Always ensure these subdirs exist, even if they weren't in the template
  for (const sub of ['pdf-cache', 'changelog-archive']) {
    fs.mkdirSync(path.join(destDir, sub), { recursive: true });
  }
}

function renderFamilyTemplate(body, familyRoot) {
  const today = new Date().toISOString().slice(0, 10);
  const username = (os.userInfo().username || 'user');
  const cliVersion = require('../package.json').version;
  return body
    .replace(/\{\{INSTALL_DATE\}\}/g, today)
    .replace(/\{\{INSTALL_USER\}\}/g, username)
    .replace(/\{\{CLI_VERSION\}\}/g, cliVersion)
    .replace(/\{\{FAMILY_ROOT\}\}/g, familyRoot)
    .replace(/\{\{INSTALL_TIME\}\}/g, new Date().toISOString().slice(11, 16));
  // {{FAMILY_NAME}} intentionally left as a placeholder so the user personalizes it.
}

function isFamilyRoutingInstalled() {
  if (!fs.existsSync(CLAUDE_MD_PATH)) return false;
  try {
    return fs.readFileSync(CLAUDE_MD_PATH, 'utf8').includes(FAMILY_ROUTING_MARKER_OPEN);
  } catch { return false; }
}

function installFamilyRoutingBlock(familyRoot) {
  if (isFamilyRoutingInstalled()) return; // idempotent

  // Read the canonical block from the shipped template, not a duplicated literal
  const tplPath = path.join(__dirname, '..', 'templates', 'family-memory', 'ROUTING.md');
  if (!fs.existsSync(tplPath)) throw new Error('ROUTING.md template missing');
  const full = fs.readFileSync(tplPath, 'utf8');

  const openIdx  = full.indexOf(FAMILY_ROUTING_MARKER_OPEN);
  const closeIdx = full.indexOf(FAMILY_ROUTING_MARKER_CLOSE);
  if (openIdx === -1 || closeIdx === -1) throw new Error('ROUTING.md template missing magic markers');
  // Render placeholders — the block is written into ~/.claude/CLAUDE.md verbatim,
  // so an unrendered {{FAMILY_ROOT}} would leave every session with a dead path.
  const block = renderFamilyTemplate(full.slice(openIdx, closeIdx + FAMILY_ROUTING_MARKER_CLOSE.length), familyRoot);

  // ~/.claude/CLAUDE.md may be a symlink to iCloud (setupClaudeMd creates it
  // that way). Writing through the symlink updates the iCloud target — fine.
  fs.mkdirSync(CLAUDE_MD_DIR, { recursive: true });
  if (!fs.existsSync(CLAUDE_MD_PATH)) {
    fs.writeFileSync(CLAUDE_MD_PATH, block + '\n', 'utf8');
    return;
  }
  const current = fs.readFileSync(CLAUDE_MD_PATH, 'utf8');
  const sep = current.length === 0 || current.endsWith('\n') ? '\n' : '\n\n';
  fs.appendFileSync(CLAUDE_MD_PATH, sep + block + '\n', 'utf8');
}

// ─── run ─────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error(chalk.red('\nUnexpected error:'), err.message);
  process.exit(1);
});
