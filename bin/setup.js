#!/usr/bin/env node

const inquirer = require('inquirer');
const chalk    = require('chalk');
const os       = require('os');
const fs       = require('fs');
const path     = require('path');

const homeDir      = os.homedir();
const ICLOUD_BASE  = path.join(homeDir, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
const CLAUDE_CONFIG = path.join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');

// ─── helpers ────────────────────────────────────────────────────────────────

function checkPrerequisites() {
  const errors = [];

  // Node version
  const major = parseInt(process.version.slice(1).split('.')[0], 10);
  if (major < 18) {
    errors.push(`Node.js 18+ required — you have ${process.version}. Upgrade at https://nodejs.org`);
  }

  // iCloud Drive
  if (!fs.existsSync(ICLOUD_BASE)) {
    errors.push('iCloud Drive not found. Make sure iCloud Drive is enabled and signed in on this Mac.');
  }

  // Claude Desktop
  const configDir = path.dirname(CLAUDE_CONFIG);
  if (!fs.existsSync(configDir)) {
    errors.push('Claude Desktop config directory not found. Is Claude Desktop installed?');
  }

  return errors;
}

function loadConfig() {
  if (!fs.existsSync(CLAUDE_CONFIG)) return {};
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_CONFIG, 'utf8'));
  } catch {
    throw new Error('Could not parse your existing claude_desktop_config.json — check it for JSON syntax errors at jsonlint.com');
  }
}

function saveConfig(config) {
  fs.writeFileSync(CLAUDE_CONFIG, JSON.stringify(config, null, 2), 'utf8');
}

function findExistingMemoryServer(mcpServers) {
  return Object.keys(mcpServers).find(k =>
    Array.isArray(mcpServers[k].args) &&
    mcpServers[k].args.includes('mcp-knowledge-graph')
  );
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(chalk.bold.cyan('\n🧠  Claude Memory Setup\n'));
  console.log('Sets up persistent memory for Claude Desktop, synced via iCloud.\n');

  // Pre-flight checks
  const errors = checkPrerequisites();
  if (errors.length) {
    errors.forEach(e => console.log(chalk.red(`✗ ${e}`)));
    process.exit(1);
  }
  console.log(chalk.green('✓ Prerequisites look good\n'));

  // Ask questions
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'firstName',
      message: 'Your first name (used to label your memory server, e.g. "Alex-Memory"):',
      validate: v => v.trim().length > 0 || 'Please enter your name'
    },
    {
      type: 'input',
      name: 'folderName',
      message: 'iCloud folder name for your memory file:',
      default: 'Claude Memory'
    }
  ]);

  const serverName  = `${answers.firstName.trim()}-Memory`;
  const memoryPath  = path.join(ICLOUD_BASE, answers.folderName.trim());

  // Confirm
  console.log('');
  console.log(chalk.bold('Here\'s what will be set up:'));
  console.log(`  Memory server name : ${chalk.cyan(serverName)}`);
  console.log(`  iCloud folder      : ${chalk.cyan(memoryPath)}`);
  console.log(`  Config file        : ${chalk.cyan(CLAUDE_CONFIG)}`);
  console.log('');

  const { confirmed } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirmed',
    message: 'Proceed?',
    default: true
  }]);

  if (!confirmed) {
    console.log(chalk.yellow('\nSetup cancelled. Nothing was changed.\n'));
    process.exit(0);
  }

  console.log('');

  // ── Step 1: Create iCloud folder ─────────────────────────────────────────
  process.stdout.write('1. Creating iCloud memory folder... ');
  try {
    fs.mkdirSync(memoryPath, { recursive: true });
    console.log(chalk.green('✓'));
  } catch (err) {
    console.log(chalk.red(`✗\n   ${err.message}`));
    process.exit(1);
  }

  // ── Step 2: Update Claude Desktop config ─────────────────────────────────
  process.stdout.write('2. Updating Claude Desktop config...  ');

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.log(chalk.red(`✗\n   ${err.message}`));
    process.exit(1);
  }

  if (!config.mcpServers) config.mcpServers = {};

  // Handle existing memory server
  const existing = findExistingMemoryServer(config.mcpServers);
  if (existing && existing !== serverName) {
    console.log('');
    console.log(chalk.yellow(`   ⚠  Found an existing memory server: "${existing}"`));
    const { replace } = await inquirer.prompt([{
      type: 'confirm',
      name: 'replace',
      message: `   Replace "${existing}" with "${serverName}"?`,
      default: false
    }]);
    if (replace) {
      delete config.mcpServers[existing];
    } else {
      console.log(chalk.yellow('   Kept existing server. Skipping config update.'));
    }
    process.stdout.write('   Saving config... ');
  }

  config.mcpServers[serverName] = {
    command: 'npx',
    args: [
      '-y',
      'mcp-knowledge-graph',
      '--memory-path',
      memoryPath
    ]
  };

  try {
    saveConfig(config);
    console.log(chalk.green('✓'));
  } catch (err) {
    console.log(chalk.red(`✗\n   Failed to write config: ${err.message}`));
    process.exit(1);
  }

  // ── Done ─────────────────────────────────────────────────────────────────
  console.log('');
  console.log(chalk.bold.green('✅  Setup complete!\n'));
  console.log(chalk.bold('Next steps:'));
  console.log(`  1. Fully quit Claude Desktop  ${chalk.dim('(Cmd+Q — not just close the window)')}`);
  console.log('  2. Relaunch Claude Desktop');
  console.log(`  3. Click  +  →  Connectors  — you should see  "${chalk.cyan(serverName)}"\n`);
  console.log(chalk.bold('Test it:'));
  console.log('  Tell Claude: "Remember that my name is [Your Name] and I use Claude for [your work]."');
  console.log('  Open a new chat and ask: "What do you know about me?"\n');
  console.log(chalk.dim('Setting up a second Mac? Just run this script there too.'));
  console.log(chalk.dim(`Your iCloud folder and memories will already be synced — use the same folder name: "${answers.folderName.trim()}"\n`));
}

main().catch(err => {
  console.error(chalk.red('\nUnexpected error:'), err.message);
  process.exit(1);
});
