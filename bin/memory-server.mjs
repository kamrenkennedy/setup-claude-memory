#!/usr/bin/env node
// Kam Memory — AIM knowledge graph MCP server, search-first edition
// Part of setup-claude-memory
//
// A drop-in replacement for `mcp-knowledge-graph` (MIT, Shane Holloman) that keeps
// the file format, tool names and write semantics byte-for-byte compatible, and
// changes exactly two things that matter:
//
//   1. READS ARE BOUNDED. The upstream `searchNodes` filters entities and then
//      returns each match WHOLE — every observation. One 400K entity would blow a
//      session's context. Here, a search returns the MATCHING OBSERVATIONS, and
//      every read path has a character budget.
//   2. WRITES ARE ATOMIC. Upstream uses a plain writeFile, so a crash mid-write
//      truncates the store. Here it is write-temp-then-rename, preserving the
//      existing file mode (several stores are deliberately 0600).

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { promises as fs, existsSync } from 'fs';
import path from 'path';
import { isAbsolute } from 'path';
import { createRequire } from 'module';
import {
  DEFAULTS, clampNumber, fitToBudget, capGraph, searchNodes, openNodes,
  formatGraphPretty, formatSearchPretty,
} from '../lib/read-core.mjs';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

// ─── Parse args ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const mpIdx = argv.indexOf('--memory-path');
let memoryPath = mpIdx !== -1 ? argv[mpIdx + 1] : undefined;
if (memoryPath && !isAbsolute(memoryPath)) memoryPath = path.resolve(process.cwd(), memoryPath);

// A --memory-path may point at the directory or at memory.jsonl inside it.
let baseMemoryPath;
if (memoryPath) {
  baseMemoryPath = memoryPath.endsWith('.jsonl') ? path.dirname(memoryPath) : memoryPath;
} else {
  process.stderr.write('Usage: aim-memory-server --memory-path <path>\n');
  process.exit(1);
}

// ─── Read budgets ────────────────────────────────────────────────────────────
// The bounded reads themselves live in lib/read-core.mjs, shared with the remote
// Worker. What stays here is the write-side threshold.

// An observation longer than this is almost certainly narrative that belongs in the
// deep-context archive. Measured 2026-09-06: the store's median observation is 297
// chars and 49% exceed 300 — the "short pointer" convention in the global CLAUDE.md is
// universally ignored, which is what actually drives entity growth. Bounded reads made
// that survivable; they did not make it stop.
const LONG_OBSERVATION = 300;

// ─── File layout (identical to mcp-knowledge-graph) ──────────────────────────

const FILE_MARKER = { type: '_aim', source: 'mcp-knowledge-graph' };

function findProjectRoot(startDir = process.cwd()) {
  const markers = ['.aim', '.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    for (const m of markers) if (existsSync(path.join(dir, m))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function getMemoryFilePath(context, location) {
  const filename = context ? `memory-${context}.jsonl` : 'memory.jsonl';
  if (location === 'global') return path.join(baseMemoryPath, filename);
  if (location === 'project') {
    const root = findProjectRoot();
    if (!root) throw new Error('No project detected - cannot use project location');
    return path.join(root, '.aim', filename);
  }
  const root = findProjectRoot();
  if (root) {
    const aimDir = path.join(root, '.aim');
    if (existsSync(aimDir)) return path.join(aimDir, filename);
  }
  return path.join(baseMemoryPath, filename);
}

// ─── Load / save ─────────────────────────────────────────────────────────────

async function loadGraph(context, location) {
  const filePath = getMemoryFilePath(context, location);
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    const lines = data.split('\n').filter(l => l.trim() !== '');
    if (lines.length === 0) return { entities: [], relations: [] };
    const first = JSON.parse(lines[0]);
    if (first.type !== '_aim' || first.source !== 'mcp-knowledge-graph') {
      throw new Error(
        `File ${filePath} does not contain required _aim safety marker. This file may not belong to the knowledge graph system. Expected first line: {"type":"_aim","source":"mcp-knowledge-graph"}`
      );
    }
    return lines.slice(1).reduce((g, line) => {
      const item = JSON.parse(line);
      if (item.type === 'entity') g.entities.push(item);
      if (item.type === 'relation') g.relations.push(item);
      return g;
    }, { entities: [], relations: [] });
  } catch (err) {
    if (err && err.code === 'ENOENT') return { entities: [], relations: [] };
    throw err;
  }
}

function serialize(graph) {
  // Key order and the absent trailing newline both match mcp-knowledge-graph, so
  // this round-trips an untouched file byte-for-byte.
  return [
    JSON.stringify(FILE_MARKER),
    ...graph.entities.map(e => JSON.stringify({ type: 'entity', ...e })),
    ...graph.relations.map(r => JSON.stringify({ type: 'relation', ...r })),
  ].join('\n');
}

async function saveGraph(graph, context, location) {
  const filePath = getMemoryFilePath(context, location);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  // Resolve symlinks first so a bridged path is written THROUGH rather than
  // replaced by the rename below.
  let realPath = filePath;
  let mode = 0o644;
  try {
    realPath = await fs.realpath(filePath);
    mode = (await fs.stat(realPath)).mode & 0o777; // keep 0600 stores at 0600
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }

  const dir = path.dirname(realPath);
  const tmp = path.join(dir, `.${path.basename(realPath)}.tmp-${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(tmp, serialize(graph), { mode });
    await fs.rename(tmp, realPath); // atomic within the directory
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// ─── Writes (semantics identical to upstream) ────────────────────────────────

async function createEntities(entities, context, location) {
  const graph = await loadGraph(context, location);
  const added = entities.filter(e => !graph.entities.some(x => x.name === e.name));
  graph.entities.push(...added);
  await saveGraph(graph, context, location);
  return added;
}

async function createRelations(relations, context, location) {
  const graph = await loadGraph(context, location);
  const added = relations.filter(r => !graph.relations.some(x =>
    x.from === r.from && x.to === r.to && x.relationType === r.relationType));
  graph.relations.push(...added);
  await saveGraph(graph, context, location);
  return added;
}

// Report back on what was just written, so the writer sees the cost of its own habits.
// Silent acceptance is why this drifted: nothing ever pushed back.
function writeFeedback(entity, added) {
  const longOnes = added.filter(o => o.length > LONG_OBSERVATION);
  const chars = entity.observations.reduce((n, o) => n + o.length, 0);
  const out = {
    entity_total_observations: entity.observations.length,
    entity_total_chars: chars,
  };
  if (longOnes.length) {
    const lengths = longOnes.map(o => o.length).join(', ');
    out.guidance =
      `${longOnes.length} of ${added.length} observation(s) exceed ${LONG_OBSERVATION} characters (${lengths}). ` +
      `Memory holds SHORT POINTERS; narrative belongs in the deep-context archive. ` +
      `Prefer "<what happened> — see deep context \`<doc-id>\`" and put the detail in aim_deep_store. ` +
      `Long observations are what made entities grow past the point of being readable.`;
  }
  if (chars > 400000) {
    out.size_warning =
      `"${entity.name}" is ${chars.toLocaleString()} characters across ${entity.observations.length} observations. ` +
      `Reads stay bounded, but a store this dense returns weaker search results. Consider archiving finished work.`;
  }
  return out;
}

async function addObservations(observations, context, location) {
  const graph = await loadGraph(context, location);
  const results = observations.map(o => {
    const entity = graph.entities.find(e => e.name === o.entityName);
    if (!entity) throw new Error(`Entity with name ${o.entityName} not found`);
    const added = o.contents.filter(c => !entity.observations.includes(c));
    entity.observations.push(...added);
    return { entityName: o.entityName, addedObservations: added, ...writeFeedback(entity, added) };
  });
  await saveGraph(graph, context, location);
  return results;
}

async function deleteEntities(entityNames, context, location) {
  const graph = await loadGraph(context, location);
  graph.entities = graph.entities.filter(e => !entityNames.includes(e.name));
  graph.relations = graph.relations.filter(r => !entityNames.includes(r.from) && !entityNames.includes(r.to));
  await saveGraph(graph, context, location);
}

async function deleteObservations(deletions, context, location) {
  const graph = await loadGraph(context, location);
  for (const d of deletions) {
    const entity = graph.entities.find(e => e.name === d.entityName);
    if (entity) entity.observations = entity.observations.filter(o => !d.observations.includes(o));
  }
  await saveGraph(graph, context, location);
}

async function deleteRelations(relations, context, location) {
  const graph = await loadGraph(context, location);
  graph.relations = graph.relations.filter(r => !relations.some(d =>
    r.from === d.from && r.to === d.to && r.relationType === d.relationType));
  await saveGraph(graph, context, location);
}

async function listDatabases() {
  const nameOf = f => (f === 'memory.jsonl' ? 'default' : f.replace('memory-', '').replace('.jsonl', ''));
  const result = { project_databases: [], global_databases: [], current_location: '' };
  const root = findProjectRoot();
  if (root) {
    const aimDir = path.join(root, '.aim');
    if (existsSync(aimDir)) {
      result.current_location = 'project (.aim directory detected)';
      try {
        result.project_databases = (await fs.readdir(aimDir))
          .filter(f => f.endsWith('.jsonl')).map(nameOf).sort();
      } catch { /* unreadable — leave empty */ }
    } else {
      result.current_location = 'global (no .aim directory in project)';
    }
  } else {
    result.current_location = 'global (no project detected)';
  }
  try {
    result.global_databases = (await fs.readdir(baseMemoryPath))
      .filter(f => f.endsWith('.jsonl')).map(nameOf).sort();
  } catch {
    result.global_databases = [];
  }
  return result;
}

// ─── Tool definitions ────────────────────────────────────────────────────────

const CONTEXT_PROP = {
  type: 'string',
  description: "Optional memory context (database). Defaults to the master database. Use a simple consistent name ('work', 'personal', 'family').",
};
const LOCATION_PROP = {
  type: 'string',
  enum: ['project', 'global'],
  description: "Optional storage location override. 'project' forces the project-local .aim directory, 'global' forces the configured directory. Omit for automatic detection.",
};
const FORMAT_PROP = {
  type: 'string',
  enum: ['json', 'pretty'],
  description: "Output format. 'json' (default) for structured data, 'pretty' for human-readable text.",
};

const TOOLS = [
  {
    name: 'aim_memory_search',
    description: `Search memories by keyword. START HERE — this is the cheapest way into memory.

Returns ONLY the observations that match your query, never a whole entity. Large entities are safe to search.

Each match reports how many observations matched vs. how many were returned, so you can tell when to narrow the query. Observation indices are shown for reference.

Params: limit (total observations, default ${DEFAULTS.searchTotal}), per_entity (default ${DEFAULTS.searchPerEntity}), max_chars (default ${DEFAULTS.maxChars}).`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text matched case-insensitively against entity names, entity types, and observation content' },
        context: CONTEXT_PROP,
        location: LOCATION_PROP,
        format: FORMAT_PROP,
        limit: { type: 'number', description: `Max observations returned overall (default ${DEFAULTS.searchTotal})` },
        per_entity: { type: 'number', description: `Max observations returned per entity (default ${DEFAULTS.searchPerEntity})` },
        max_chars: { type: 'number', description: `Character ceiling on the response (default ${DEFAULTS.maxChars})` },
      },
      required: ['query'],
    },
  },
  {
    name: 'aim_memory_get',
    description: `Retrieve entities by exact name.

Returns the ${DEFAULTS.getRecent} most recent observations per entity by default and reports how many older ones were omitted — a large entity will not flood the context. Pass full:true to load everything (check total_observations first), or recent:N for a different slice.

To find a specific older fact, use aim_memory_search instead of loading the whole entity.

full:true bypasses the character budget entirely — it is an explicit opt-in, not a suggestion.`,
    inputSchema: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, description: 'An array of entity names to retrieve' },
        context: CONTEXT_PROP,
        location: LOCATION_PROP,
        format: FORMAT_PROP,
        recent: { type: 'number', description: `How many of the most recent observations to return (default ${DEFAULTS.getRecent})` },
        full: { type: 'boolean', description: 'Return every observation, bypassing the character budget. Check total_observations first — this is how you flood a context. Pass max_chars alongside to keep a bound.' },
        max_chars: { type: 'number', description: `Character ceiling on the response (default ${DEFAULTS.maxChars})` },
      },
      required: ['names'],
    },
  },
  {
    name: 'aim_memory_store',
    description: `Store new memories — people, projects, concepts, anything worth persisting.

Keep observations SHORT and pointer-style. Long narratives belong in the deep context archive; oversized entities are what made this server's bounded reads necessary.`,
    inputSchema: {
      type: 'object',
      properties: {
        entities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'The name of the entity' },
              entityType: { type: 'string', description: 'The type of the entity (person, project, concept, ...)' },
              observations: { type: 'array', items: { type: 'string' }, description: 'Facts about the entity' },
            },
            required: ['name', 'entityType', 'observations'],
          },
        },
        context: CONTEXT_PROP,
        location: LOCATION_PROP,
      },
      required: ['entities'],
    },
  },
  {
    name: 'aim_memory_add_facts',
    description: `Append observations to an existing entity. The entity must already exist; duplicates are ignored.

KEEP EACH OBSERVATION UNDER ~${LONG_OBSERVATION} CHARACTERS. Memory holds short, findable pointers —
"shipped X on DATE — see deep context \`doc-id\`" — not narrative. Long-form belongs in aim_deep_store.
The response reports the entity's size back to you; if it warns, shorten the next one rather than
adding to the problem.`,
    inputSchema: {
      type: 'object',
      properties: {
        observations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              entityName: { type: 'string', description: 'The name of the entity to add the observations to' },
              contents: { type: 'array', items: { type: 'string' }, description: 'An array of observation contents to add' },
            },
            required: ['entityName', 'contents'],
          },
        },
        context: CONTEXT_PROP,
        location: LOCATION_PROP,
      },
      required: ['observations'],
    },
  },
  {
    name: 'aim_memory_read_all',
    description: `Dump every entity in a database. EXPENSIVE — prefer aim_memory_search.

Bounded by max_chars (default ${DEFAULTS.maxChars}); a large store will be truncated rather than flooding the context.`,
    inputSchema: {
      type: 'object',
      properties: {
        context: CONTEXT_PROP,
        location: LOCATION_PROP,
        format: FORMAT_PROP,
        max_chars: { type: 'number', description: `Character ceiling on the response (default ${DEFAULTS.maxChars})` },
      },
    },
  },
  {
    name: 'aim_memory_list_stores',
    description: 'List available memory databases and the current storage location.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'aim_memory_link',
    description: 'Create relations between two entities.',
    inputSchema: {
      type: 'object',
      properties: {
        relations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string', description: 'The name of the entity where the relation starts' },
              to: { type: 'string', description: 'The name of the entity where the relation ends' },
              relationType: { type: 'string', description: 'The type of the relation, in active voice' },
            },
            required: ['from', 'to', 'relationType'],
          },
        },
        context: CONTEXT_PROP,
        location: LOCATION_PROP,
      },
      required: ['relations'],
    },
  },
  {
    name: 'aim_memory_unlink',
    description: 'Remove relations between entities.',
    inputSchema: {
      type: 'object',
      properties: {
        relations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string', description: 'The name of the entity where the relation starts' },
              to: { type: 'string', description: 'The name of the entity where the relation ends' },
              relationType: { type: 'string', description: 'The type of the relation' },
            },
            required: ['from', 'to', 'relationType'],
          },
        },
        context: CONTEXT_PROP,
        location: LOCATION_PROP,
      },
      required: ['relations'],
    },
  },
  {
    name: 'aim_memory_remove_facts',
    description: 'Delete specific observations from an entity. Prefer moving them to an archive entity over deleting outright.',
    inputSchema: {
      type: 'object',
      properties: {
        deletions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              entityName: { type: 'string', description: 'The name of the entity containing the observations' },
              observations: { type: 'array', items: { type: 'string' }, description: 'An array of observations to delete' },
            },
            required: ['entityName', 'observations'],
          },
        },
        context: CONTEXT_PROP,
        location: LOCATION_PROP,
      },
      required: ['deletions'],
    },
  },
  {
    name: 'aim_memory_forget',
    description: 'Delete entities entirely, along with their relations. Irreversible.',
    inputSchema: {
      type: 'object',
      properties: {
        entityNames: { type: 'array', items: { type: 'string' }, description: 'An array of entity names to delete' },
        context: CONTEXT_PROP,
        location: LOCATION_PROP,
      },
      required: ['entityNames'],
    },
  },
];

// ─── Server ──────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'aim-memory-server', version: pkg.version },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = request.params.arguments || {};
  const text = t => ({ content: [{ type: 'text', text: t }] });
  const cap = clampNumber(args.max_chars, DEFAULTS.maxChars);

  switch (name) {
    case 'aim_memory_search': {
      const graph = await loadGraph(args.context, args.location);
      return text(fitToBudget(
        allowance => searchNodes(graph, args.query, {
          ...args,
          ...(allowance !== Infinity && { per_entity: allowance, limit: allowance * 5 }),
        }),
        r => (args.format === 'pretty' ? formatSearchPretty(r) : JSON.stringify(r, null, 2)),
        cap,
        'Narrow the query.'
      ));
    }
    case 'aim_memory_get': {
      const graph = await loadGraph(args.context, args.location);
      // full:true is an explicit opt-in to the whole entity, so it bypasses the
      // character budget — silently capping it would make the escape hatch a lie.
      // Passing max_chars alongside full re-imposes a bound.
      const wantsFull = args.full === true || args.full === 'true';
      const getCap = wantsFull && args.max_chars === undefined ? Infinity : cap;
      return text(fitToBudget(
        allowance => openNodes(graph, args.names, allowance === Infinity ? args : { ...args, full: false, recent: allowance }),
        r => (args.format === 'pretty' ? formatGraphPretty(r, args.context) : JSON.stringify(r, null, 2)),
        getCap,
        'Use aim_memory_search to find specific facts instead of loading the entity.'
      ));
    }
    case 'aim_memory_read_all': {
      const graph = await loadGraph(args.context, args.location);
      return text(fitToBudget(
        allowance => capGraph(graph, allowance),
        g => (args.format === 'pretty' ? formatGraphPretty(g, args.context) : JSON.stringify(g, null, 2)),
        cap,
        'Use aim_memory_search or aim_memory_get instead.'
      ));
    }
    case 'aim_memory_store':
      return text(JSON.stringify(await createEntities(args.entities, args.context, args.location), null, 2));
    case 'aim_memory_link':
      return text(JSON.stringify(await createRelations(args.relations, args.context, args.location), null, 2));
    case 'aim_memory_add_facts':
      return text(JSON.stringify(await addObservations(args.observations, args.context, args.location), null, 2));
    case 'aim_memory_forget':
      await deleteEntities(args.entityNames, args.context, args.location);
      return text('Entities deleted successfully');
    case 'aim_memory_remove_facts':
      await deleteObservations(args.deletions, args.context, args.location);
      return text('Observations deleted successfully');
    case 'aim_memory_unlink':
      await deleteRelations(args.relations, args.context, args.location);
      return text('Relations deleted successfully');
    case 'aim_memory_list_stores':
      return text(JSON.stringify(await listDatabases(), null, 2));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

async function main() {
  await server.connect(new StdioServerTransport());
  process.stderr.write(`AIM memory server (search-first) running on stdio — store: ${baseMemoryPath}\n`);
}

main().catch(err => {
  process.stderr.write(`Fatal error in main(): ${err.message}\n`);
  process.exit(1);
});
