#!/usr/bin/env node
// Kam Memory — Deep Context Layer MCP Server
// Part of setup-claude-memory v1.3.0

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { execFile, execFileSync } from 'child_process';
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
const KG_PATH     = path.join(MEMORY_PATH, 'memory.jsonl');

const APPLE_EMBED_SRC    = path.join(path.dirname(new URL(import.meta.url).pathname), 'apple-embed.swift');
const APPLE_EMBED_CACHE  = path.join(process.env.HOME || '/tmp', '.cache', 'aim');
const APPLE_EMBED_BIN    = path.join(APPLE_EMBED_CACHE, 'apple-embed');

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

function saveUserConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

// ─── Version check ───────────────────────────────────────────────────────────

let updateAvailable = null;

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

// ─── Embedding Engine ────────────────────────────────────────────────────────

let transformersPipeline = null;
let transformersAvailable = null; // null=untested, true/false

async function getTransformersPipeline() {
  if (transformersAvailable === false) return null;
  if (transformersPipeline) return transformersPipeline;

  try {
    const { pipeline } = await import('@huggingface/transformers');
    const config = loadUserConfig();
    const model = config.embedding_model || 'Xenova/all-MiniLM-L6-v2';
    transformersPipeline = await pipeline('feature-extraction', model, {
      quantized: true,
    });
    transformersAvailable = true;
    return transformersPipeline;
  } catch (err) {
    process.stderr.write(`Transformers.js not available: ${err.message}\n`);
    transformersAvailable = false;
    return null;
  }
}

function compileAppleEmbed() {
  if (fs.existsSync(APPLE_EMBED_BIN)) return true;
  if (!fs.existsSync(APPLE_EMBED_SRC)) return false;

  try {
    fs.mkdirSync(APPLE_EMBED_CACHE, { recursive: true });
    execFileSync('swiftc', [
      '-O', APPLE_EMBED_SRC, '-o', APPLE_EMBED_BIN,
      '-framework', 'NaturalLanguage',
    ], { timeout: 60000, stdio: 'pipe' });
    return true;
  } catch (err) {
    process.stderr.write(`Failed to compile apple-embed: ${err.message}\n`);
    return false;
  }
}

function appleEmbed(text) {
  return new Promise((resolve, reject) => {
    // Try compiled binary first
    if (fs.existsSync(APPLE_EMBED_BIN)) {
      const child = execFile(APPLE_EMBED_BIN, [], { timeout: 10000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`apple-embed failed: ${stderr || err.message}`));
        try { resolve(JSON.parse(stdout.trim())); }
        catch { reject(new Error(`apple-embed invalid output: ${stdout}`)); }
      });
      child.stdin.write(text);
      child.stdin.end();
      return;
    }

    // Fall back to interpreting the Swift source directly
    if (!fs.existsSync(APPLE_EMBED_SRC)) {
      return reject(new Error('apple-embed.swift not found'));
    }

    const child = execFile('swift', [APPLE_EMBED_SRC], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`swift apple-embed failed: ${stderr || err.message}`));
      try { resolve(JSON.parse(stdout.trim())); }
      catch { reject(new Error(`apple-embed invalid output: ${stdout}`)); }
    });
    child.stdin.write(text);
    child.stdin.end();
  });
}

async function generateEmbedding(text) {
  const config = loadUserConfig();
  const engine = config.embedding_engine || 'auto';

  // Truncate to reasonable length for embedding
  const truncated = text.slice(0, 2000);

  // Try Transformers.js first (unless Apple is forced)
  if (engine === 'transformers' || engine === 'auto') {
    const pipe = await getTransformersPipeline();
    if (pipe) {
      const output = await pipe(truncated, { pooling: 'mean', normalize: true });
      const data = Array.from(output.data);
      return { embedding: data, model: config.embedding_model || 'Xenova/all-MiniLM-L6-v2', dim: data.length };
    }
  }

  // Try Apple NaturalLanguage fallback
  if (engine === 'apple' || engine === 'auto') {
    compileAppleEmbed(); // Compile Swift binary on first use (no-op if already compiled)

    try {
      const data = await appleEmbed(truncated);
      return { embedding: data, model: 'apple-nlembedding', dim: data.length };
    } catch (err) {
      process.stderr.write(`Apple embedding failed: ${err.message}\n`);
    }
  }

  return null; // No embedding engine available
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Knowledge Graph Reader (read-only access to memory.jsonl) ───────────────

function readKnowledgeGraph() {
  if (!fs.existsSync(KG_PATH)) return { entities: [], relationships: [] };
  const lines = fs.readFileSync(KG_PATH, 'utf8').split('\n').filter(Boolean);
  const entities = [];
  const relationships = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'entity') entities.push(obj);
      else if (obj.type === 'relationship') relationships.push(obj);
    } catch { /* skip malformed lines */ }
  }
  return { entities, relationships };
}

function buildAdjacencyList(relationships) {
  const adj = {};
  for (const r of relationships) {
    if (!adj[r.from]) adj[r.from] = [];
    if (!adj[r.to])   adj[r.to]   = [];
    adj[r.from].push({ target: r.to, relation: r.relationType, direction: 'outgoing' });
    adj[r.to].push({ target: r.from, relation: r.relationType, direction: 'incoming' });
  }
  return adj;
}

// ─── Tool implementations ────────────────────────────────────────────────────

async function toolStore(input) {
  for (const f of ['id', 'project', 'tags', 'type', 'date', 'summary', 'content']) {
    if (!input[f]) throw new Error(`Missing required field: ${f}`);
  }
  const { id, project, client, tags, type, date, summary, content } = input;
  const meta = { id, project, client, tags, type, date, summary };
  const filePath = path.join(DEEP_PATH, `${id}.md`);
  fs.writeFileSync(filePath, `${buildFrontmatter(meta)}\n\n${content}`, 'utf8');

  // Generate embedding for the document
  const embeddingText = `${summary} ${content.slice(0, 1500)}`;
  const embResult = await generateEmbedding(embeddingText);
  if (embResult) {
    meta.embedding = embResult.embedding;
    meta.embedding_model = embResult.model;
    meta.embedding_dim = embResult.dim;
  }

  upsertIndex(meta);

  const result = { success: true, id, path: filePath };
  if (embResult) {
    result.embedding_status = `Embedded with ${embResult.model} (${embResult.dim}d)`;
  } else {
    result.embedding_status = 'No embedding engine available — document stored without semantic indexing. Run aim_deep_reindex after installing @huggingface/transformers.';
  }
  result.hint = 'Consider running aim_deep_extract_entities to sync entities to the knowledge graph.';
  return result;
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

  // Cross-reference: attach related knowledge graph entities (Feature 4)
  const results = index.map((e) => {
    const stripped = { ...e };
    delete stripped.embedding; // Don't send embedding vectors in results
    return stripped;
  });
  const crossRefs = getCrossReferences(results.map((r) => r.id));
  for (const r of results) {
    if (crossRefs[r.id]?.length) r.related_entities = crossRefs[r.id];
  }

  return { results, count: results.length };
}

async function toolSemanticSearch(input) {
  const { query, limit = 5, threshold = 0.3 } = input || {};
  if (!query) throw new Error('Missing required field: query');

  const queryEmb = await generateEmbedding(query);
  if (!queryEmb) {
    throw new Error('No embedding engine available. Install @huggingface/transformers or ensure macOS 14+ for Apple NaturalLanguage fallback.');
  }

  const index = readIndex();
  const scored = index
    .filter((e) => e.embedding && e.embedding_dim === queryEmb.dim)
    .map((e) => {
      const score = cosineSimilarity(queryEmb.embedding, e.embedding);
      const stripped = { ...e };
      delete stripped.embedding;
      return { ...stripped, similarity: Math.round(score * 1000) / 1000 };
    })
    .filter((e) => e.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  // Cross-reference
  const crossRefs = getCrossReferences(scored.map((r) => r.id));
  for (const r of scored) {
    if (crossRefs[r.id]?.length) r.related_entities = crossRefs[r.id];
  }

  const total = index.length;
  const indexed = index.filter((e) => e.embedding).length;

  return {
    results: scored,
    count: scored.length,
    engine: queryEmb.model,
    index_coverage: `${indexed}/${total} documents indexed`,
  };
}

async function toolReindex(_input) {
  const index = readIndex();
  let indexed = 0;
  let skipped = 0;
  let failed  = 0;

  for (const entry of index) {
    if (entry.embedding) { skipped++; continue; }

    const filePath = path.join(DEEP_PATH, `${entry.id}.md`);
    if (!fs.existsSync(filePath)) { failed++; continue; }

    const raw = fs.readFileSync(filePath, 'utf8');
    const { content } = parseFrontmatter(raw);
    const embeddingText = `${entry.summary || ''} ${(content || '').slice(0, 1500)}`;

    const embResult = await generateEmbedding(embeddingText);
    if (embResult) {
      entry.embedding = embResult.embedding;
      entry.embedding_model = embResult.model;
      entry.embedding_dim = embResult.dim;
      indexed++;
    } else {
      failed++;
    }
  }

  writeIndex(index);

  return {
    success: true,
    indexed,
    skipped,
    failed,
    total: index.length,
    message: `Indexed ${indexed} documents, skipped ${skipped} (already indexed), ${failed} failed. Total: ${index.length}.`,
  };
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
  const docs = index.slice(0, limit).map((e) => {
    const stripped = { ...e };
    delete stripped.embedding;
    return stripped;
  });
  const result = { documents: docs, count: index.length };
  if (updateAvailable) {
    result.system_notice = `Update available for Kam Memory (v${updateAvailable}). Run \`npx setup-claude-memory@latest\` to update.`;
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

// ─── Feature 2: Entity Extraction ────────────────────────────────────────────

function toolExtractEntities(input) {
  const { id } = input || {};
  if (!id) throw new Error('Missing required field: id');

  const filePath = path.join(DEEP_PATH, `${id}.md`);
  if (!fs.existsSync(filePath)) throw new Error(`Document not found: ${id}`);

  const raw = fs.readFileSync(filePath, 'utf8');
  const { meta, content } = parseFrontmatter(raw);
  const fullText = `${meta.summary || ''}\n${content}`;

  // Extract entities using pattern-based heuristics
  const entities = [];
  const relationships = [];
  const seenNames = new Set();

  // 1. Project entity (always extract from metadata)
  const projectName = meta.project || (typeof input.project === 'string' ? input.project : null);
  if (projectName && !seenNames.has(projectName)) {
    entities.push({
      name: projectName,
      entityType: 'project',
      observations: [
        `Source: deep-context://${id}`,
        meta.summary || `Referenced in deep context document ${id}`,
      ],
    });
    seenNames.add(projectName);
  }

  // 2. Client entity
  const clientName = meta.client;
  if (clientName && !seenNames.has(clientName)) {
    entities.push({
      name: clientName,
      entityType: 'client',
      observations: [`Source: deep-context://${id}`],
    });
    seenNames.add(clientName);
    if (projectName) {
      relationships.push({ from: clientName, to: projectName, relationType: 'owns_project' });
    }
  }

  // 3. Extract technology/tool mentions from common patterns
  const techPatterns = [
    /\b(SwiftUI|SwiftData|Swift|Xcode|XcodeGen)\b/g,
    /\b(React|Next\.js|Node\.js|TypeScript|JavaScript)\b/g,
    /\b(Docker|Kubernetes|Terraform|AWS|GCP|Azure)\b/g,
    /\b(Notion|Slack|GitHub|Linear|Jira|Figma)\b/g,
    /\b(DaVinci Resolve|Blender|Premiere|After Effects)\b/g,
    /\b(Sparkle|MCP|Claude|GPT|OpenAI|Anthropic)\b/g,
    /\b(PostgreSQL|SQLite|MongoDB|Redis|Firebase)\b/g,
    /\b(npm|pip|brew|Homebrew|CocoaPods|SPM)\b/g,
  ];

  for (const pattern of techPatterns) {
    for (const match of fullText.matchAll(pattern)) {
      const name = match[1];
      if (!seenNames.has(name)) {
        entities.push({
          name,
          entityType: 'technology',
          observations: [`Used in ${projectName || 'project'} — source: deep-context://${id}`],
        });
        seenNames.add(name);
        if (projectName) {
          relationships.push({ from: projectName, to: name, relationType: 'uses' });
        }
      }
    }
  }

  // 4. Extract version mentions (v1.0.0, v1.1.0, etc.)
  const versionPattern = /\bv(\d+\.\d+\.\d+)\b/g;
  const versions = new Set();
  for (const match of fullText.matchAll(versionPattern)) {
    versions.add(match[1]);
  }
  if (versions.size > 0 && projectName) {
    const versionObs = [...versions].map((v) => `Version ${v} referenced in deep-context://${id}`);
    const existing = entities.find((e) => e.name === projectName);
    if (existing) {
      existing.observations.push(...versionObs);
    }
  }

  // 5. Extract markdown headings as potential topic entities
  const headingPattern = /^#{1,3}\s+(.+)$/gm;
  const topics = [];
  for (const match of content.matchAll(headingPattern)) {
    topics.push(match[1].trim());
  }

  return {
    document_id: id,
    project: projectName,
    suggested_entities: entities,
    suggested_relationships: relationships,
    document_topics: topics.slice(0, 15),
    instruction: 'Review these suggestions. Use aim_memory_store to create entities and aim_memory_link to create relationships. Modify names/types as needed before committing.',
  };
}

// ─── Feature 3: Graph Traversal Search ───────────────────────────────────────

function toolGraphSearch(input) {
  const { query, depth = 1 } = input || {};
  if (!query) throw new Error('Missing required field: query');
  const maxDepth = Math.min(depth, 3);

  const { entities, relationships } = readKnowledgeGraph();
  const adj = buildAdjacencyList(relationships);

  // Find seed entities matching query
  const q = query.toLowerCase();
  const seeds = entities.filter((e) =>
    e.name?.toLowerCase().includes(q) ||
    e.entityType?.toLowerCase().includes(q) ||
    (Array.isArray(e.observations) && e.observations.some((o) => o.toLowerCase().includes(q)))
  );

  if (seeds.length === 0) {
    return { results: [], count: 0, message: `No entities matched query: "${query}"` };
  }

  // BFS traversal from seeds
  const visited = new Set(seeds.map((s) => s.name));
  const entityMap = new Map(entities.map((e) => [e.name, e]));
  const traversalResults = [];
  let frontier = seeds.map((s) => ({ entity: s, depth: 0, path: [] }));

  while (frontier.length > 0) {
    const next = [];
    for (const { entity, depth: d, path: p } of frontier) {
      traversalResults.push({
        name: entity.name,
        entityType: entity.entityType,
        observations: entity.observations,
        depth: d,
        path: p,
      });

      if (d < maxDepth) {
        const neighbors = adj[entity.name] || [];
        for (const { target, relation, direction } of neighbors) {
          if (!visited.has(target)) {
            visited.add(target);
            const targetEntity = entityMap.get(target);
            if (targetEntity) {
              next.push({
                entity: targetEntity,
                depth: d + 1,
                path: [...p, { from: entity.name, relation, direction, to: target }],
              });
            }
          }
        }
      }
    }
    frontier = next;
  }

  return {
    results: traversalResults,
    count: traversalResults.length,
    seed_matches: seeds.length,
    max_depth: maxDepth,
  };
}

// ─── Feature 4: Cross-references ─────────────────────────────────────────────

function getCrossReferences(docIds) {
  if (!docIds?.length) return {};
  const { entities } = readKnowledgeGraph();
  const refs = {};

  for (const docId of docIds) {
    refs[docId] = [];
    const pattern = `deep-context://${docId}`;
    for (const entity of entities) {
      if (Array.isArray(entity.observations)) {
        if (entity.observations.some((o) => o.includes(pattern))) {
          refs[docId].push(entity.name);
        }
      }
    }
  }

  return refs;
}

// ─── Build context-aware server description ──────────────────────────────────

const userConfig = loadUserConfig();

const notionGuidance = userConfig.notion_enabled
  ? 'Use Notion for structured project data (schedules, contacts, deliverables, databases). Do NOT duplicate Notion content into deep context — if it lives in Notion, query Notion directly.'
  : 'Notion is not configured — store structured project info in deep context instead.';

const SERVER_DESCRIPTION = [
  'Kam Memory — Deep Context Layer. Stores and retrieves long-form context documents synced via iCloud.',
  'v1.3.0: Now with semantic search, entity extraction, graph traversal, and cross-references.',
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
  'research, or decision-making — automatically call aim_deep_store with a session-summary, then run',
  'aim_deep_extract_entities to sync entities to the knowledge graph, then confirm:',
  '"Session saved to your deep context archive — you can pick this up on any machine."',
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
        'research, or decision-making — automatically call aim_deep_store with a session-summary, then run',
        'aim_deep_extract_entities to sync entities to the knowledge graph, then confirm to the user:',
        '"Session saved to your deep context archive — you can pick this up on any machine."',
        '',
        'Document types: session-summary, creative-brief, research, decision-log, project-narrative.',
        '',
        'Embeddings are generated automatically on store for semantic search. If no embedding engine is available,',
        'the document is stored without an embedding — run aim_deep_reindex later to add embeddings.',
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
        'Search the deep context archive by keyword, tag, project, client, or date range. Returns metadata + summaries only (not full document content) — use aim_deep_get to load the full content of any match. Use this to find prior session summaries, creative briefs, research notes, or decision logs across all projects. For meaning-based search, use aim_deep_semantic_search instead.',
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
      name: 'aim_deep_semantic_search',
      description: [
        'Search deep context documents using semantic/vector similarity. Finds documents with similar meaning,',
        'not just matching keywords. For example, searching "deployment" will find documents about "shipping to production".',
        '',
        'Requires at least one embedding engine: @huggingface/transformers (npm) or Apple NaturalLanguage (macOS 14+).',
        'Run aim_deep_reindex first if existing documents have not been indexed yet.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query:     { type: 'string', description: 'Search query in natural language — finds documents by meaning' },
          limit:     { type: 'number', description: 'Max results to return (default: 5)' },
          threshold: { type: 'number', description: 'Minimum similarity score 0-1 (default: 0.3)' },
        },
      },
    },
    {
      name: 'aim_deep_reindex',
      description: [
        'Generate embeddings for all deep context documents that are missing them.',
        'Run this once after upgrading to v1.3.0 to enable semantic search on existing documents.',
        'Documents stored after the upgrade are automatically indexed.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'aim_deep_extract_entities',
      description: [
        'Extract entity and relationship suggestions from a stored deep context document.',
        'Returns structured suggestions that can be reviewed and then committed to the knowledge graph',
        'using aim_memory_store and aim_memory_link. This keeps the deep context and knowledge graph in sync.',
        '',
        'Extracts: project names, client names, technologies/tools, version references, and document topics.',
        'Each extracted entity includes a deep-context:// source link for traceability.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Document ID to extract entities from' },
        },
      },
    },
    {
      name: 'aim_deep_graph_search',
      description: [
        'Search the knowledge graph with relationship traversal. Finds entities matching a query,',
        'then follows relationship links up to N hops deep to surface connected entities.',
        '',
        'Example: searching "Fort Abode" with depth 2 will find the project entity AND all entities',
        'connected to it (Sparkle, notarization, GitHub release, etc.).',
        '',
        'This is a read-only view of the knowledge graph (memory.jsonl) — it does not modify anything.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Search text to match against entity names, types, and observations' },
          depth: { type: 'number', description: 'How many relationship hops to follow (default: 1, max: 3)' },
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
      case 'aim_deep_store':            result = await toolStore(input);          break;
      case 'aim_deep_search':           result = toolSearch(input);              break;
      case 'aim_deep_semantic_search':   result = await toolSemanticSearch(input); break;
      case 'aim_deep_reindex':          result = await toolReindex(input);       break;
      case 'aim_deep_extract_entities': result = toolExtractEntities(input);     break;
      case 'aim_deep_graph_search':     result = toolGraphSearch(input);         break;
      case 'aim_deep_get':              result = toolGet(input);                 break;
      case 'aim_deep_list':             result = toolList(input);                break;
      case 'aim_deep_delete':           result = toolDelete(input);              break;
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
  checkForUpdates().catch(() => {});
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
