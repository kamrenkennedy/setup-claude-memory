// Kam Memory — credential and personal-data patterns
// Part of setup-claude-memory
//
// Shared by the pre-push scanner (bin/memory-scan.mjs) and the Aligned Memory
// exporter (bin/memory-export.mjs). The scanner decides whether a push may go ahead;
// the exporter redacts matches before anything leaves the Mac.

// ─── Patterns ────────────────────────────────────────────────────────────────
//
// Every pattern is anchored against a preceding word character. Calibrating
// against the real store found three "OpenAI keys" that were actually the letters
// `sk-` sitting inside ordinary slugs — `invoice-desk-...`, `martha-risk-...`,
// `deploy-task-...`. An unanchored pattern cries wolf, and a scanner people stop
// believing is worse than no scanner.

const NWB = '(?<![A-Za-z0-9])';   // not preceded by a word character

export const BLOCK_PATTERNS = [
  ['AWS access key id',       new RegExp(`${NWB}AKIA[0-9A-Z]{16}(?![A-Za-z0-9])`, 'g')],
  ['GitHub token',            new RegExp(`${NWB}gh[pousr]_[A-Za-z0-9]{36,}`, 'g')],
  ['GitHub fine-grained PAT', new RegExp(`${NWB}github_pat_[A-Za-z0-9_]{50,}`, 'g')],
  ['OpenAI key',              new RegExp(`${NWB}sk-[A-Za-z0-9]{32,}`, 'g')],
  ['OpenAI project key',      new RegExp(`${NWB}sk-proj-[A-Za-z0-9_-]{32,}`, 'g')],
  ['Anthropic key',           new RegExp(`${NWB}sk-ant-[A-Za-z0-9_-]{32,}`, 'g')],
  ['Google API key',          new RegExp(`${NWB}AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])`, 'g')],
  ['Slack token',             new RegExp(`${NWB}xox[baprse]-[A-Za-z0-9-]{10,}`, 'g')],
  ['Stripe live key',         new RegExp(`${NWB}(?:sk|rk)_live_[A-Za-z0-9]{16,}`, 'g')],
  ['npm token',               new RegExp(`${NWB}npm_[A-Za-z0-9]{36}`, 'g')],
  ['Twilio SID/key',          new RegExp(`${NWB}(?:AC|SK)[0-9a-f]{32}(?![0-9a-f])`, 'g')],
  ['SendGrid key',            new RegExp(`${NWB}SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}`, 'g')],
  ['Private key block',       /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['JSON Web Token',          new RegExp(`${NWB}eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}`, 'g')],
  ['Inline secret assignment',
    /(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd)["']?\s*[:=]\s*["'][^"'\s]{16,}["']/gi],
];

export const REVIEW_PATTERNS = [
  ['Phone number',    /(?<![\d-])\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}(?![\d-])/g],
  ['Email address',   /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ['UUID / user id',  /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi],
];
