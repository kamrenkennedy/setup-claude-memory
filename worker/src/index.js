// Aligned Memory — Worker entry
//
// One Worker, both OAuth roles, built from the library's split classes so the
// authorization server can move to its own Worker (the shared Aligned login) without
// touching the MCP side:
//
//   /authorize, /callback      sign-in: consent page, then GitHub, then a token
//   /oauth/token, /register,   the authorization server (OAuthAuthorizationServer)
//   /.well-known/oauth-authorization-server
//   /mcp, /.well-known/oauth-protected-resource…   the MCP resource (OAuthResourceServer)
//
// Only the GitHub account named by ALLOWED_GITHUB_ID can finish signing in, and the
// MCP handler checks that again on every request.

import {
  OAuthAuthorizationServer, OAuthResourceServer, AuthorizationError, CimdFetchError,
  authorizationErrorRedirect,
} from '@cloudflare/workers-oauth-provider';
import { handleMcp } from './mcp.js';

// ─── Config ──────────────────────────────────────────────────────────────────

let built;
function servers(env) {
  if (built && built.key === env.PUBLIC_ORIGIN) return built;
  const origin = env.PUBLIC_ORIGIN.replace(/\/$/, '');
  const resource = `${origin}/mcp`;
  const authorizationServer = new OAuthAuthorizationServer({
    issuer: origin,
    resources: [resource],
    defaultResource: resource,
    clientRegistrationEndpoint: '/register',
    scopesSupported: ['mcp:read', 'offline_access'],
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 24 * 3600,
  });
  const resourceServer = new OAuthResourceServer({
    resourceMetadata: { resource, authorization_servers: [origin], resource_name: 'Aligned Memory' },
    requiredScopes: ['mcp:read'],
    validateToken: e => (res, token) => authorizationServer.validateToken(res, token, e),
    handler: { fetch: mcpHandler },
  });
  built = { key: env.PUBLIC_ORIGIN, origin, authorizationServer, resourceServer };
  return built;
}

const GITHUB_OAUTH = env => env.GITHUB_OAUTH_BASE || 'https://github.com';
const GITHUB_API = env => env.GITHUB_API_BASE || 'https://api.github.com';

// ─── Audit ───────────────────────────────────────────────────────────────────

const clip = (v, n) => (v === undefined ? null : String(v).slice(0, n));

function writeAudit(env, ctx, request, row) {
  const stmt = env.DB.prepare(
    `INSERT INTO audit_log (ts, user_id, client_id, method, tool, args, outcome, result_chars, ip, country)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
  ).bind(
    new Date().toISOString(),
    clip(row.user_id, 100), clip(row.client_id, 300), clip(row.method, 100), clip(row.tool, 100),
    row.args === undefined ? null : clip(JSON.stringify(row.args), 2000),
    row.outcome, row.result_chars ?? null,
    request.headers.get('CF-Connecting-IP'), request.cf?.country ?? null,
  );
  ctx.waitUntil(stmt.run().catch(err => console.error('audit write failed', err.message)));
}

// ─── MCP ─────────────────────────────────────────────────────────────────────

async function mcpHandler(request, env, ctx) {
  const props = ctx.props || {};
  const row = { user_id: props.userId, client_id: ctx.auth?.clientId, outcome: 'ok' };

  if (!ctx.auth?.scope?.includes('mcp:read')) {
    row.outcome = 'insufficient_scope';
    writeAudit(env, ctx, request, row);
    return new Response('insufficient scope', { status: 403 });
  }
  // The sign-in flow already refused everyone else. Checked again so a token minted any
  // other way still cannot read.
  if (!env.ALLOWED_GITHUB_ID || String(props.githubId) !== String(env.ALLOWED_GITHUB_ID)) {
    row.outcome = 'forbidden_user';
    writeAudit(env, ctx, request, row);
    return new Response('forbidden', { status: 403 });
  }
  const { success } = await env.MCP_LIMITER.limit({ key: props.userId });
  if (!success) {
    row.outcome = 'rate_limited';
    writeAudit(env, ctx, request, row);
    return new Response('rate limited', { status: 429, headers: { 'Retry-After': '60' } });
  }

  if (request.method === 'POST') {
    try {
      const body = await request.clone().json();
      row.method = (Array.isArray(body) ? body : [body]).map(m => m?.method).filter(Boolean).join(',') || null;
    } catch { row.method = 'unparseable'; }
  } else {
    row.method = request.method;
  }

  const response = await handleMcp(request, env, row);
  if (response.status >= 400 && row.outcome === 'ok') row.outcome = `http_${response.status}`;
  writeAudit(env, ctx, request, row);
  return response;
}

// ─── Sign-in ─────────────────────────────────────────────────────────────────

const escape = value => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

const page = (title, body, headers = new Headers(), status = 200) => {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; color: #1d1d1f; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #f5f5f7; background: #111; } }
  button { font: inherit; padding: .6rem 1.2rem; margin-right: .5rem; border-radius: .5rem; border: 1px solid #888; }
  .warn { border-left: 3px solid #c80; padding-left: .8rem; }
</style>
${body}</html>`, { status, headers });
};

function consentPage(details, handle) {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : 'This app registered itself, so its name is not verified.';
  return `<h1>Let ${name} read your memory?</h1>
<p>${origin} Access goes to <strong>${escape(details.redirectHost)}</strong>.</p>
<p>It can read your work memory. It cannot change anything.</p>
${details.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on this computer.</strong> Continue only if you just started connecting from it, such as Claude Code.</p>' : ''}
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <p>Next you will sign in with GitHub.</p>
  <p><button name="decision" value="approve">Continue</button><button name="decision" value="deny">Cancel</button></p>
</form>`;
}

async function s256(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function authorize(request, env, ctx, oauth, origin) {
  if (request.method === 'GET') {
    const authRequest = await oauth.parseAuthRequest(request);
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    return page('Aligned Memory', consentPage(details, consent.handle), consent.headers);
  }
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const form = await request.formData();
  const handle = String(form.get('handle') || '');
  if (form.get('decision') !== 'approve') {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle, { scope: ['mcp:read'] });
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
  const to = new URL('/login/oauth/authorize', GITHUB_OAUTH(env));
  to.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  to.searchParams.set('redirect_uri', `${origin}/callback`);
  to.searchParams.set('state', state);
  to.searchParams.set('code_challenge', await s256(verifier));
  to.searchParams.set('code_challenge_method', 'S256');
  to.searchParams.set('allow_signup', 'false');
  headers.set('Location', to.toString());
  return new Response(null, { status: 302, headers });
}

async function callback(request, env, ctx, oauth, origin) {
  const { request: original, data, headers } = await oauth.finishUpstream(request);
  const url = new URL(request.url);
  const refuse = (outcome, extra = {}) => {
    writeAudit(env, ctx, request, { method: 'sign_in', outcome, client_id: original.clientId, ...extra });
    headers.set('Location', authorizationErrorRedirect(original, 'access_denied'));
    return new Response(null, { status: 302, headers });
  };
  if (url.searchParams.get('error') || !url.searchParams.get('code')) return refuse('github_declined');

  // The GitHub token is used once, to learn who signed in, and is never stored.
  const tokenRes = await fetch(new URL('/login/oauth/access_token', GITHUB_OAUTH(env)), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code: url.searchParams.get('code'),
      redirect_uri: `${origin}/callback`,
      code_verifier: data.verifier,
    }),
  });
  const token = tokenRes.ok ? await tokenRes.json() : {};
  if (!token.access_token) return refuse('github_token_failed');

  const userRes = await fetch(new URL('/user', GITHUB_API(env)), {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'aligned-memory' },
  });
  const user = userRes.ok ? await userRes.json() : {};
  if (!user.id) return refuse('github_user_failed');
  if (!env.ALLOWED_GITHUB_ID || String(user.id) !== String(env.ALLOWED_GITHUB_ID)) {
    return refuse('forbidden_user', { user_id: `github-${user.id}` });
  }

  const userId = `github-${user.id}`;
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId,
    metadata: { login: user.login },
    scope: original.scope,
    props: { userId, githubId: String(user.id), login: user.login },
  });
  writeAudit(env, ctx, request, { method: 'sign_in', outcome: 'ok', user_id: userId, client_id: original.clientId });
  headers.set('Location', redirectTo);
  return new Response(null, { status: 302, headers });
}

async function signIn(request, env, ctx, { authorizationServer, origin }, path) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { success } = await env.SIGNIN_LIMITER.limit({ key: ip });
  if (!success) return new Response('Too many sign-in attempts. Wait a minute.', { status: 429, headers: { 'Retry-After': '60' } });

  const oauth = authorizationServer.getOAuthApi(env);
  try {
    return path === '/authorize'
      ? await authorize(request, env, ctx, oauth, origin)
      : await callback(request, env, ctx, oauth, origin);
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const message = error instanceof AuthorizationError ? error.description : 'This app could not be verified.';
      return page('Aligned Memory', `<h1>Could not sign in</h1><p>${escape(message || 'The request was not valid.')}</p>`, new Headers(), 400);
    }
    throw error;
  }
}

// ─── Router ──────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const s = servers(env);
    const path = new URL(request.url).pathname;
    if (path === '/authorize' || path === '/callback') return signIn(request, env, ctx, s, path);
    if (path === '/mcp' || path.startsWith('/mcp/') || path.startsWith('/.well-known/oauth-protected-resource')) {
      return s.resourceServer.fetch(request, env, ctx);
    }
    if (path === '/') return new Response('Aligned Memory. Add this server in Claude with the /mcp URL.\n');
    return s.authorizationServer.fetch(request, env, ctx);
  },

  // Daily: the audit log keeps 90 days. OAuth records expire on their own KV TTLs.
  async scheduled(event, env) {
    await env.DB.prepare("DELETE FROM audit_log WHERE ts < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days')").run();
  },
};
