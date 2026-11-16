// Single-user sign-in. The MCP SDK provides the OAuth endpoints (discovery,
// client registration, PKCE, token requests); this file decides who gets a
// token: whoever types the passphrase on the sign-in page.
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { InvalidGrantError, InvalidTokenError, InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

export const STATE_DIR = process.env.STATE_DIR ?? join(homedir(), '.local/state/claude-web-youtube-connector');
const PASSPHRASE_FILE = join(STATE_DIR, 'passphrase');
const AUTH_FILE = join(STATE_DIR, 'auth.json');

const ACCESS_SECONDS = 60 * 60;
const REFRESH_SECONDS = 90 * 24 * 60 * 60;
const SIGN_IN_SECONDS = 10 * 60;
const MAX_FAILURES_PER_HOUR = 10;

// Codes may only go back to Claude on the web or to a program on this machine.
const ALLOWED_REDIRECTS = [
  /^https:\/\/claude\.(ai|com)\/api\/mcp\/auth_callback$/,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[^?#]*$/,
];

export function hashPassphrase(passphrase) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(passphrase, salt, 32).toString('hex')}`;
}

function passphraseMatches(passphrase) {
  if (!existsSync(PASSPHRASE_FILE)) return false;
  const [salt, hash] = readFileSync(PASSPHRASE_FILE, 'utf8').trim().split(':');
  return timingSafeEqual(scryptSync(passphrase, Buffer.from(salt, 'hex'), 32), Buffer.from(hash, 'hex'));
}

export function savePassphrase(passphrase) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(PASSPHRASE_FILE, `${hashPassphrase(passphrase)}\n`, { mode: 0o600 });
}

const now = () => Math.floor(Date.now() / 1000);
const token = () => randomBytes(32).toString('base64url');
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export class PassphraseProvider {
  constructor() {
    // Clients and tokens survive a restart; sign-ins in progress and codes do not need to.
    this.state = existsSync(AUTH_FILE)
      ? JSON.parse(readFileSync(AUTH_FILE, 'utf8'))
      : { clients: {}, accessTokens: {}, refreshTokens: {} };
    this.signIns = new Map();
    this.codes = new Map();
    this.failures = [];
  }

  save() {
    for (const kind of ['accessTokens', 'refreshTokens']) {
      for (const [key, value] of Object.entries(this.state[kind])) if (value.expiresAt < now()) delete this.state[kind][key];
    }
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(AUTH_FILE, JSON.stringify(this.state, null, 2), { mode: 0o600 });
  }

  get clientsStore() {
    return {
      getClient: (clientId) => this.state.clients[clientId],
      registerClient: (client) => {
        if (!client.redirect_uris.every((uri) => ALLOWED_REDIRECTS.some((pattern) => pattern.test(uri)))) {
          throw new InvalidClientMetadataError('Only Claude and programs on this machine can sign in here');
        }
        const full = { ...client, client_id: randomUUID(), client_id_issued_at: now() };
        this.state.clients[full.client_id] = full;
        this.save();
        return full;
      },
    };
  }

  async authorize(client, params, res) {
    const id = token();
    this.signIns.set(id, { client, params, expiresAt: now() + SIGN_IN_SECONDS });
    res.type('html').send(signInPage(id, client.client_name ?? 'An MCP client'));
  }

  // The sign-in form posts here with the passphrase.
  signInRouter() {
    const router = express.Router();
    router.post('/sign-in', express.urlencoded({ extended: false }), async (req, res) => {
      const signIn = this.signIns.get(req.body.id);
      if (!signIn || signIn.expiresAt < now()) {
        res.status(400).type('text/plain').send('This sign-in has expired. Start again from Claude.\n');
        return;
      }
      this.failures = this.failures.filter((time) => time > now() - 3600);
      if (this.failures.length >= MAX_FAILURES_PER_HOUR) {
        res.status(429).type('text/plain').send('Too many wrong passphrases in the last hour. Try again later.\n');
        return;
      }
      if (!passphraseMatches(String(req.body.passphrase ?? ''))) {
        this.failures.push(now());
        await new Promise((resolve) => setTimeout(resolve, 1000));
        res.status(401).type('html').send(signInPage(req.body.id, signIn.client.client_name ?? 'An MCP client', true));
        return;
      }
      this.signIns.delete(req.body.id);
      const code = token();
      this.codes.set(code, { ...signIn, expiresAt: now() + 300 });
      const target = new URL(signIn.params.redirectUri);
      target.searchParams.set('code', code);
      if (signIn.params.state !== undefined) target.searchParams.set('state', signIn.params.state);
      res.redirect(target.href);
    });
    return router;
  }

  async challengeForAuthorizationCode(client, code) {
    const entry = this.codes.get(code);
    if (!entry || entry.client.client_id !== client.client_id) throw new InvalidGrantError('Unknown authorization code');
    return entry.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client, code, verifier, redirectUri) {
    const entry = this.codes.get(code);
    this.codes.delete(code);
    if (!entry || entry.client.client_id !== client.client_id || entry.expiresAt < now()) {
      throw new InvalidGrantError('Unknown or expired authorization code');
    }
    if (redirectUri && redirectUri !== entry.params.redirectUri) throw new InvalidGrantError('redirect_uri does not match');
    return this.issueTokens(client.client_id);
  }

  async exchangeRefreshToken(client, refreshToken) {
    const entry = this.state.refreshTokens[refreshToken];
    if (!entry || entry.clientId !== client.client_id || entry.expiresAt < now()) {
      throw new InvalidGrantError('Unknown or expired refresh token');
    }
    delete this.state.refreshTokens[refreshToken];
    return this.issueTokens(client.client_id);
  }

  issueTokens(clientId) {
    const access = token();
    const refresh = token();
    this.state.accessTokens[access] = { clientId, expiresAt: now() + ACCESS_SECONDS };
    this.state.refreshTokens[refresh] = { clientId, expiresAt: now() + REFRESH_SECONDS };
    this.save();
    return { access_token: access, token_type: 'bearer', expires_in: ACCESS_SECONDS, refresh_token: refresh };
  }

  async verifyAccessToken(accessToken) {
    const entry = this.state.accessTokens[accessToken];
    if (!entry || entry.expiresAt < now()) throw new InvalidTokenError('Unknown or expired access token');
    return { token: accessToken, clientId: entry.clientId, scopes: [], expiresAt: entry.expiresAt };
  }
}

function signInPage(id, clientName, wrong = false) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to the YouTube connector</title>
<style>body{font:16px system-ui,sans-serif;max-width:26rem;margin:3rem auto;padding:0 1rem}
input,button{font:inherit;padding:.5rem;width:100%;box-sizing:border-box;margin-top:.5rem}.wrong{color:#b00}</style></head>
<body><h1>YouTube connector</h1>
<p>${escapeHtml(clientName)} wants to use the YouTube tools on your computer.</p>
${wrong ? '<p class="wrong">That passphrase is wrong.</p>' : ''}
<form method="post" action="/sign-in">
<input type="hidden" name="id" value="${escapeHtml(id)}">
<label>Passphrase <input type="password" name="passphrase" autocomplete="current-password" autofocus required></label>
<button type="submit">Allow</button>
</form></body></html>
`;
}
