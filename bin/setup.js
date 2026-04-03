#!/usr/bin/env node

const inquirer      = require('inquirer');
const chalk         = require('chalk');
const os            = require('os');
const fs            = require('fs');
const path          = require('path');
const { execSync }  = require('child_process');

const homeDir       = os.homedir();
const ICLOUD_BASE   = path.join(homeDir, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
const CLAUDE_CONFIG = path.join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');

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
  for (const [key, val] of Object.entries(mcpServers)) {
    if (!Array.isArray(val.args)) continue;
    if (!val.args.includes('mcp-knowledge-graph')) continue;
    const mpIdx = val.args.indexOf('--memory-path');
    if (mpIdx === -1 || !val.args[mpIdx + 1]) continue;
    return { serverName: key, memoryPath: val.args[mpIdx + 1] };
  }
  return null;
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
function pinToICloud(folderPath) {
  try {
    execSync(`xattr -w com.apple.fileprovider.pinned 1 "${folderPath}"`);
  } catch {
    // Non-critical — the MCP still works, files just might get offloaded
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
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

      const { doUpdate } = await inquirer.prompt([{
        type: 'confirm', name: 'doUpdate',
        message: 'Everything looks good. Want to update your configuration?',
        default: false
      }]);

      if (!doUpdate) {
        // Re-verify MCP entries are current and exit quietly
        config.mcpServers[serverName]     = kgEntry(memoryPath);
        config.mcpServers[deepServerName] = deepEntry(memoryPath);
        saveClaudeConfig(config);
        console.log(chalk.bold.green('\n✅  All good — nothing changed.\n'));
        return;
      }

      await runConfigQuestionnaire(configPath, firstName, true);
      console.log(chalk.bold.green('\n✅  Configuration updated.\n'));
      console.log(chalk.dim('Restart Claude Desktop for changes to take effect.\n'));
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

  await runConfigQuestionnaire(configPath, firstName, false, '7.');

  console.log('');
  console.log(chalk.bold.green('✅  Setup complete!\n'));
  console.log(chalk.bold('Next steps:'));
  console.log(`  1. Fully quit Claude Desktop  ${chalk.dim('(Cmd+Q — not just close the window)')}`);
  console.log('  2. Relaunch Claude Desktop');
  console.log(`  3. Click  +  →  Connectors  — you should see  "${chalk.cyan(serverName)}"  and  "${chalk.cyan(deepServerName)}"\n`);
  console.log(chalk.bold('Deep context:'));
  console.log('  After any substantive session, Claude will automatically save a summary so you');
  console.log('  can pick up right where you left off on any machine.\n');
  console.log(chalk.dim(`Setting up a second Mac? Run this script there — it'll detect your iCloud folder automatically.\n`));
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

  // Store first_name if it wasn't in config.json yet
  if (userConfig && !userConfig.first_name) {
    step('6. Updating configuration...           ', () => {
      fs.writeFileSync(configPath, JSON.stringify({ ...userConfig, first_name: firstName }, null, 2), 'utf8');
    });
  }

  console.log('');
  console.log(chalk.bold.green('✅  This Mac is now connected!\n'));
  console.log(chalk.bold('Next steps:'));
  console.log(`  1. Fully quit Claude Desktop  ${chalk.dim('(Cmd+Q)')}`);
  console.log('  2. Relaunch Claude Desktop');
  console.log(`  3. Your existing memories and deep context will be available immediately via ${chalk.cyan(serverName)}\n`);
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
  return { command: 'npx', args: ['-y', 'mcp-knowledge-graph', '--memory-path', memoryPath] };
}

function deepEntry(memoryPath) {
  return { command: 'npx', args: ['-y', '--package=setup-claude-memory@latest', 'aim-deep-context-server', '--memory-path', memoryPath] };
}

function readUserConfig(configPath) {
  if (!fs.existsSync(configPath)) return null;
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch { return null; }
}

// ─── run ─────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error(chalk.red('\nUnexpected error:'), err.message);
  process.exit(1);
});
