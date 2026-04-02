#!/usr/bin/env node
// Kam Memory — Deep Context Layer MCP Server
// Part of setup-claude-memory v1.2.0

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

// ─── Parse args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const mpIdx = args.indexOf('--memory-path');
if (mpIdx === -1 || !args[mpIdx + 1]) {
  process.stderr.write('Usage: aim-deep-context-server --memory-path <path>\n');
  process.exit(1);
}

const MEMORY_PATH = args[mpIdx + 1];
const DEEP_PATH   = path.join(MEMORY_PATH, 'deep');
const INDEX_PATH  = path.join(DEEP_PATH, 'index.json');
const CONFIG_PATH = path.join(MEMORY_PATH, 'config.json');

// ─── Bootstrap /deep/ directory ──────────────────────────────────────────────

fs.mkdirSync(DEEP_PATH, { recursive: true });
if (!fs.existsSync(INDEX_PATH)) {
  fs.writeFileSync(INDEX_PATH, '[]', 'utf8');
}

// ─── User config ─────────────────────────────────────────────────────────────

function loadUserConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

// ─── Version check ───────────────────────────────────────────────────────────

let updateAvailable = null; // null = unknown | false = up to date | string = newer version

function checkForUpdates() {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'registry.npmjs.org',
        path: '/setup-claude-memory/latest',
        method: 'GET',
        headers: { Accept: 'application/json' },
        timeout: 5000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const latest = JSON.parse(data).version;
            updateAvailable = (latest && latest !== pkg.version) ? latest : false;
          } catch {
            updateAvailable = false;
          }
          resolve();
        });
      }
    );
    req.on('error', () => { updateAvailable = false; resolve(); });
    req.on('timeout', () => { req.destroy(); updateAvailable = false; resolve(); });
    req.end();
  });
}

// ─── Index helpers ───────────────────────────────────────────────────────────

function readIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')); }
  catch { return []; }
}

function writeIndex(index) {
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), 'utf8');
}

function upsertIndex(entry) {
  const index = readIndex();
  const pos = index.findIndex((e) => e.id === entry.id);
  if (pos >= 0) index[pos] = entry;
  else index.push(entry);
  writeIndex(index);
}

function removeFromIndex(id) {
  writeIndex(readIndex().filter((e) => e.id !== id));
}

// ─── Document helpers ─────────────────────────────────────────────────────────

function buildFrontmatter(meta) {
  const tags = Array.isArray(meta.tags)
    ? `[${meta.tags.join(', ')}]`
    : '[]';
  return [
    '---',
    `id: ${meta.id}`,
    `project: ${meta.project}`,
    meta.client ? `client: ${meta.client}` : null,
    `tags: ${tags}`,
    `type: ${meta.type}`,
    `date: ${meta.date}`,
    `summary: ${meta.summary}`,
    '---',
  ]
    .filter(Boolean)
    .join('\n');
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, content: raw };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let val = line.slice(colon + 1).trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    }
    meta[key] = val;
  }
  return { meta, content: match[2].trim() };
}

// ─── Tool implementations ────────────────────────────────────────────────────

function toolStore(input) {
  for (const f of ['id', 'project', 'tags', 'type', 'date', 'summary', 'content']) {
    if (!input[f]) throw new Error(`Missing required field: ${f}`);
  }
  const { id, project, client, tags, type, date, summary, content } = input;
  const meta = { id, project, client, tags, type, date, summary };
  const filePath = path.join(DEEP_PATH, `${id}.md`);
  fs.writeFileSync(filePath, `${buildFrontmatter(meta)}\n\n${content}`, 'utf8');
  upsertIndex(meta);
  return { success: true, id, path: filePath };
}

function toolSearch(input) {
  const { query, project, tags, type, date_from, date_to } = input || {};
  let index = readIndex();
  if (project)           index = index.filter((e) => e.project?.toLowerCase().includes(project.toLowerCase()));
  if (type)              index = index.filter((e) => e.type === type);
  if (tags?.length)      index = index.filter((e) => Array.isArray(e.tags) && tags.some((t) => e.tags.includes(t)));
  if (date_from)         index = index.filter((e) => e.date >= date_from);
  if (date_to)           index = index.filter((e) => e.date <= date_to);
  if (query) {
    const q = query.toLowerCase();
    index = index.filter((e) =>
      e.summary?.toLowerCase().includes(q) ||
      e.project?.toLowerCase().includes(q) ||
      e.client?.toLowerCase().includes(q) ||
      (Array.isArray(e.tags) && e.tags.some((t) => t.toLowerCase().includes(q)))
    );
  }
  return { results: index, count: index.length };
}

function toolGet(input) {
  const { id } = input || {};
  if (!id) throw new Error('Missing required field: id');
  const filePath = path.join(DEEP_PATH, `${id}.md`);
  if (!fs.existsSync(filePath)) throw new Error(`Document not found: ${id}`);
  const raw = fs.readFileSync(filePath, 'utf8');
  const { meta, content } = parseFrontmatter(raw);
  return { id, meta, content, raw };
}

function toolList(input) {
  const limit   = input?.limit   || 20;
  const project = input?.project;
  let index = readIndex();
  if (project) index = index.filter((e) => e.project?.toLowerCase().includes(project.toLowerCase()));
  index.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const result = { documents: index.slice(0, limit), count: index.length };
  if (updateAvailable) {
    result.system_notice = `Update available for Kam Memory (v${updateAvailable}). Run \`npx setup-claude-memory\` to update.`;
  }
  return result;
}

function toolDelete(input) {
  const { id } = input || {};
  if (!id) throw new Error('Missing required field: id');
  const filePath = path.join(DEEP_PATH, `${id}.md`);
  if (!fs.existsSync(filePath)) throw new Error(`Document not found: ${id}`);
  fs.unlinkSync(filePath);
  removeFromIndex(id);
  return { success: true, id };
}

// ─── Build context-aware server description ──────────────────────────────────

const userConfig = loadUserConfig();

const notionGuidance = userConfig.notion_enabled
  ? 'Use Notion for structured project data (schedules, contacts, deliverables, databases). Do NOT duplicate Notion content into deep context — if it lives in Notion, query Notion directly.'
  : 'Notion is not configured — store structured project info in deep context instead.';

const SERVER_DESCRIPTION = [
  'Kam Memory — Deep Context Layer. Stores and retrieves long-form context documents synced via iCloud.',
  '',
  'Use aim_deep_* tools for:',
  '- End-of-session summaries from long or complex sessions',
  '- Creative development threads (treatment development, concept evolution)',
  '- Decision reasoning: why a direction was chosen, what was rejected and why',
  '- Research passes on any topic',
  '- Anything longer than ~300 words that tells a story or captures a process',
  '',
  'Use aim_memory_* tools (knowledge graph) for:',
  '- Quick facts: contact info, client names, project statuses, preferences',
  '- Entity relationships: who works with whom, what belongs to what',
  '- Session state: what was just completed, what is next',
  '- Short structured notes queried frequently',
  '',
  notionGuidance,
  '',
  'General principle: Notion for structure, knowledge graph for facts, deep context for narrative, calendar for time.',
  '',
  'SESSION WRAP-UP: After any substantive session involving significant creative work, multi-step planning,',
  'research, or decision-making — automatically call aim_deep_store with a session-summary, then store a',
  'pointer entity in the knowledge graph, then confirm: "Session saved to your deep context archive — you',
  'can pick this up on any machine."',
].join('\n');

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'aim-deep-context', version: pkg.version, description: SERVER_DESCRIPTION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'aim_deep_store',
      description: [
        'Store a long-form context document in the deep context archive, synced across machines via iCloud.',
        '',
        'WHEN TO USE THIS TOOL (deep context):',
        '- End-of-session summaries from long or complex sessions',
        '- Creative development threads (treatment development, concept evolution)',
        '- Decision reasoning: why a direction was chosen, what was rejected and why',
        '- Research passes on any topic',
        '- Project narratives that capture process, context, or rationale',
        '- Anything longer than ~300 words that tells a story or captures a process',
        '',
        'WHEN TO USE aim_memory_* (knowledge graph) INSTEAD:',
        '- Quick facts: contact info, client names, project statuses, preferences',
        '- Entity relationships: who works with whom, what belongs to what',
        '- Session state: what was just completed, what is next',
        '- Short structured notes queried frequently',
        '',
        notionGuidance,
        '',
        'General principle: Notion for structure, knowledge graph for facts, deep context for narrative, calendar for time.',
        '',
        'SESSION WRAP-UP: After any substantive session involving significant creative work, multi-step planning,',
        'research, or decision-making — automatically call aim_deep_store with a session-summary, then store a',
        'pointer entity in the knowledge graph (aim_memory_store), then confirm to the user:',
        '"Session saved to your deep context archive — you can pick this up on any machine."',
        '',
        'Document types: session-summary, creative-brief, research, decision-log, project-narrative.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        required: ['id', 'project', 'tags', 'type', 'date', 'summary', 'content'],
        properties: {
          id:      { type: 'string',  description: 'Unique kebab-case identifier (e.g. "gs2026-greenhouse-session-01")' },
          project: { type: 'string',  description: 'Project name' },
          client:  { type: 'string',  description: 'Client name (optional)' },
          tags:    { type: 'array', items: { type: 'string' }, description: 'Searchable tags' },
          type:    { type: 'string', enum: ['session-summary', 'creative-brief', 'research', 'decision-log', 'project-narrative'] },
          date:    { type: 'string',  description: 'ISO date YYYY-MM-DD' },
          summary: { type: 'string',  description: 'One-sentence description used in search index' },
          content: { type: 'string',  description: 'Full markdown document body' },
        },
      },
    },
    {
      name: 'aim_deep_search',
      description:
        'Search the deep context archive by keyword, tag, project, client, or date range. Returns metadata + summaries only (not full document content) — use aim_deep_get to load the full content of any match. Use this to find prior session summaries, creative briefs, research notes, or decision logs across all projects.',
      inputSchema: {
        type: 'object',
        properties: {
          query:     { type: 'string', description: 'Keyword to search across summary, project, client, tags' },
          project:   { type: 'string', description: 'Filter by project name (partial match)' },
          tags:      { type: 'array', items: { type: 'string' }, description: 'Filter by tags (any match)' },
          type:      { type: 'string', enum: ['session-summary', 'creative-brief', 'research', 'decision-log', 'project-narrative'] },
          date_from: { type: 'string', description: 'ISO date range start' },
          date_to:   { type: 'string', description: 'ISO date range end' },
        },
      },
    },
    {
      name: 'aim_deep_get',
      description: 'Retrieve the full content of a specific deep context document by ID. Use after aim_deep_search or aim_deep_list to load the complete document.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Document ID' },
        },
      },
    },
    {
      name: 'aim_deep_list',
      description:
        'List all deep context documents sorted by date descending. Returns metadata only — use aim_deep_get to load full content. Good starting point when picking up a conversation, reviewing past sessions, or exploring what has been stored. Check system_notice in the response for any available update notifications.',
      inputSchema: {
        type: 'object',
        properties: {
          limit:   { type: 'number',  description: 'Max documents to return (default 20)' },
          project: { type: 'string',  description: 'Filter by project name (optional)' },
        },
      },
    },
    {
      name: 'aim_deep_delete',
      description: 'Permanently remove a document from the deep context archive.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Document ID to delete' },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: input } = request.params;
  try {
    let result;
    switch (name) {
      case 'aim_deep_store':  result = toolStore(input);  break;
      case 'aim_deep_search': result = toolSearch(input); break;
      case 'aim_deep_get':    result = toolGet(input);    break;
      case 'aim_deep_list':   result = toolList(input);   break;
      case 'aim_deep_delete': result = toolDelete(input); break;
      default: throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  checkForUpdates().catch(() => {}); // non-blocking background check
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
