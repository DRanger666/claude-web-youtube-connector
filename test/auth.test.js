import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PASSPHRASE, PUBLIC_URL, register, signIn, startServer, startSignIn, submitPassphrase, tokenRequest } from './helpers.js';

let server;
let base;

before(async () => {
  server = await startServer('auth');
  base = server.base;
});

after(() => server.close());

const listTools = (accessToken, url = base) => fetch(`${url}/mcp`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});

test('Claude can discover how to sign in', async () => {
  const unsigned = await listTools();
  assert.equal(unsigned.status, 401);
  assert.match(unsigned.headers.get('www-authenticate'),
    new RegExp(`resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`));

  const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(resource.resource, `${PUBLIC_URL}/mcp`);
  assert.deepEqual(resource.authorization_servers, [`${PUBLIC_URL}/`]);

  const metadata = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  assert.equal(metadata.registration_endpoint, `${PUBLIC_URL}/register`);
});

test('only Claude and programs on this machine can register', async () => {
  for (const uri of ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:4567/callback']) {
    assert.equal((await register(base, uri)).status, 201, uri);
  }
  for (const uri of ['https://evil.example/callback', 'https://claude.ai.evil.example/api/mcp/auth_callback']) {
    assert.equal((await register(base, uri)).status, 400, uri);
  }
});

test('the sign-in page names the client safely and rejects a wrong passphrase', async () => {
  const { page, id } = await startSignIn(base);
  assert.match(page, /Test client wants to use the YouTube tools/);
  const wrong = await submitPassphrase(base, id, 'not the passphrase');
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /That passphrase is wrong/);
  assert.equal((await submitPassphrase(base, id, PASSPHRASE)).status, 302);
  assert.equal((await submitPassphrase(base, id, PASSPHRASE)).status, 400, 'a sign-in is used once');

  const named = await startSignIn(base, '<script>alert(1)</script>');
  assert.doesNotMatch(named.page, /<script>/);
  assert.match(named.page, /&#60;script&#62;alert\(1\)&#60;\/script&#62; wants to use/);
});

test('the passphrase gives tokens that open the tools, and the code works once', async () => {
  const { client, redirect, tokens } = await signIn(base);
  assert.equal(redirect.searchParams.get('state'), 'state-1');
  assert.equal(tokens.token_type, 'bearer');
  assert.equal((await listTools(tokens.access_token)).status, 200);
  assert.equal((await listTools('made-up-token')).status, 401);

  const reused = await tokenRequest(base, {
    grant_type: 'authorization_code', code: redirect.searchParams.get('code'), code_verifier: 'x', client_id: client.client_id,
  });
  assert.equal((await reused.json()).error, 'invalid_grant');
});

test('refresh tokens are replaced on use, and the old one is refused', async () => {
  const { client, tokens } = await signIn(base);
  const refresh = (token) => tokenRequest(base, { grant_type: 'refresh_token', refresh_token: token, client_id: client.client_id });
  const renewed = await (await refresh(tokens.refresh_token)).json();
  assert.notEqual(renewed.refresh_token, tokens.refresh_token);
  assert.equal((await listTools(renewed.access_token)).status, 200);
  assert.equal((await (await refresh(tokens.refresh_token)).json()).error, 'invalid_grant');
});

test('tokens survive a restart', async () => {
  const { tokens } = await signIn(base);
  const restarted = server.createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => restarted.once('listening', resolve));
  assert.equal((await listTools(tokens.access_token, `http://127.0.0.1:${restarted.address().port}`)).status, 200);
  restarted.close();
});

// Last, because it locks the sign-in page for the rest of the hour.
test('after ten wrong passphrases in an hour, sign-in stops', async () => {
  const { id } = await startSignIn(base);
  await Promise.all(Array.from({ length: 10 }, () => submitPassphrase(base, id, 'guess')));
  assert.equal((await submitPassphrase(base, id, PASSPHRASE)).status, 429);
});
