// Starts the server with scratch folders and signs in the way Claude does.
import { createHash, randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

export const PUBLIC_URL = 'https://connector.example';
export const PASSPHRASE = 'correct horse battery staple';
const REDIRECT = 'http://127.0.0.1:9/callback';

// Folders are fixed when the server modules load, so set them before importing.
export async function startServer(name) {
  const scratch = join(import.meta.dirname, `.scratch-${name}`);
  await rm(scratch, { recursive: true, force: true });
  process.env.STATE_DIR = join(scratch, 'state');
  process.env.FILES_DIR = join(scratch, 'files');
  process.env.PUBLIC_URL = PUBLIC_URL;
  const { savePassphrase } = await import('../src/auth.js');
  savePassphrase(PASSPHRASE);
  const { createApp } = await import('../src/server.js');
  const listener = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => listener.once('listening', resolve));
  return {
    base: `http://127.0.0.1:${listener.address().port}`,
    createApp,
    close: async () => {
      listener.close();
      await rm(scratch, { recursive: true, force: true });
    },
  };
}

const form = (fields) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields),
  redirect: 'manual',
});

export async function register(base, redirectUri = REDIRECT, clientName = 'Test client') {
  return fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', client_name: clientName }),
  });
}

// Returns the sign-in page for a new client, and what is needed to finish.
export async function startSignIn(base, clientName) {
  const client = await (await register(base, REDIRECT, clientName)).json();
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'state-1',
    resource: `${PUBLIC_URL}/mcp`,
  });
  const page = await (await fetch(`${base}/authorize?${query}`)).text();
  return { client, verifier, page, id: page.match(/name="id" value="([^"]+)"/)?.[1] };
}

export function submitPassphrase(base, id, passphrase) {
  return fetch(`${base}/sign-in`, form({ id, passphrase }));
}

export function tokenRequest(base, fields) {
  return fetch(`${base}/token`, form(fields));
}

export async function signIn(base) {
  const { client, verifier, id } = await startSignIn(base);
  const redirect = new URL((await submitPassphrase(base, id, PASSPHRASE)).headers.get('location'));
  const response = await tokenRequest(base, {
    grant_type: 'authorization_code',
    code: redirect.searchParams.get('code'),
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: REDIRECT,
  });
  return { client, redirect, tokens: await response.json() };
}
