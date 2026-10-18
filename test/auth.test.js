'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { ResideoAuth, readSettings } = require('../lib/auth');
const { LoginCookies, retrySeconds } = require('../lib/http');
const C = require('../lib/constants');
const { backend, token } = require('./helpers');

test('direct hosted login carries CSRF cookies and redeems a PKCE code without a secret', async t => {
  const s = await backend(t);
  const auth = new ResideoAuth(s.authOptions);
  const result = await auth.login('private@example.test', 'correct-password', 'ro');
  assert.equal(s.cookieVerified, true); assert.ok(result.refresh_token);
  const form = new URLSearchParams(s.calls.find(c => c.path.endsWith('/token')).text);
  assert.equal(form.get('redirect_uri'), C.REDIRECT_URI); assert.equal(form.has('client_secret'), false);
  assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), s.challenge);
  assert.equal(s.calls[0].url.searchParams.get('country'), 'RO');
});

test('browser-normalized callback root slash completes sign-in', async t => {
  const s = await backend(t); s.callbackPath = '/';
  await new ResideoAuth(s.authOptions).login('private@example.test', 'correct-password');
  assert.equal(s.tokenCount, 1);
});

test('wrong password errors contain no account or response details', async t => {
  const s = await backend(t);
  await assert.rejects(new ResideoAuth(s.authOptions).login('private@example.test', 'wrong'), error => error.code === 'authentication_required' && !/private|wrong/.test(error.message));
});

test('verification and changed sign-in pages require browser interaction', async t => {
  const s = await backend(t); s.signInResult = { status: '400', message: 'Please verify your account' };
  await assert.rejects(new ResideoAuth(s.authOptions).login('user', 'correct-password'), { code: 'interaction_required' });
  s.loginPage = '<html>new sign-in page</html>';
  await assert.rejects(new ResideoAuth(s.authOptions).login('user', 'correct-password'), { code: 'interaction_required' });
  assert.throws(() => readSettings('var SETTINGS = {"api":"CombinedSigninAndSignup","csrf":"x","transId":"x","hosts":{"tenant":"//attacker.test","policy":"b2c_1a_signin_mob_hh"}};'), { code: 'interaction_required' });
});

test('credentials and cookies cannot follow a foreign sign-in redirect', async t => {
  const s = await backend(t); s.redirect = 'https://attacker.example/capture';
  await assert.rejects(new ResideoAuth(s.authOptions).login('user', 'correct-password'), { code: 'invalid_response' });
  assert.equal(s.calls.every(c => c.url.origin === s.root || c.url.origin === 'http://localhost'), true);
});

test('callback state, duplicate parameters, native authority and paths are checked locally', async t => {
  const s = await backend(t); const auth = new ResideoAuth(s.authOptions); const a = auth.newAuthorization();
  const valid = `${C.REDIRECT_URI}?state=${a.state}&code=one-time`;
  for (const value of [valid.replace(a.state, 'wrong'), `${valid}&state=${a.state}`, `${valid}&code=second`, valid.replace('oauth2redirect?', 'oauth2redirect/other?'), `${valid}#fragment`, valid.replace('oauth2redirect?', 'user@oauth2redirect?'), 'not a url']) {
    await assert.rejects(auth.exchangeCallback(value, a), { code: 'invalid_callback' });
  }
  assert.equal(s.tokenCount, 0);
  await assert.rejects(auth.exchangeCallback(valid, { ...a, createdAt: Date.now() - 16 * 60000 }), { code: 'invalid_callback' });
});

test('concurrent refreshes rotate a token exactly once', async t => {
  const s = await backend(t);
  const auth = new ResideoAuth({ ...s.authOptions, token: token({ expires_at: 1 }) });
  const values = await Promise.all(Array.from({ length: 8 }, () => auth.accessToken()));
  assert.equal(s.refreshCount, 1); assert.equal(new Set(values).size, 1);
  await Promise.all(Array.from({ length: 5 }, () => auth.accessToken('valid')));
  assert.equal(s.refreshCount, 1);
});

test('revoked authorization is reported without leaking server error data', async t => {
  const s = await backend(t);
  const auth = new ResideoAuth({ ...s.authOptions, token: token({ refresh_token: 'revoked', expires_at: 1 }) });
  await assert.rejects(auth.accessToken(), error => error.code === 'authentication_required' && !/private/.test(error.message));
});

test('sign-in service respects Retry-After without sending another request', async t => {
  const s = await backend(t); s.failures.set('/lyricprod.onmicrosoft.com/oauth2/v2.0/token', { status: 429, headers: { 'retry-after': '90' } });
  const auth = new ResideoAuth(s.authOptions);
  await assert.rejects(auth.importRefreshToken('test'), { code: 'rate_limited' });
  const calls = s.calls.length;
  await assert.rejects(auth.importRefreshToken('test'), { code: 'rate_limited' });
  assert.equal(s.calls.length, calls);
  assert.equal(retrySeconds('bad'), 60); assert.equal(retrySeconds('0'), 1);
  assert.equal(retrySeconds('Sun, 18 Oct 2026 20:02:00 GMT', Date.parse('2026-10-18T20:00:00Z')), 120);
});

test('login cookies respect origin, paths, expiry, and Secure', () => {
  const jar = new LoginCookies('https://auth.example');
  jar.receive('https://auth.example/a/login', new Headers({ 'set-cookie': 'csrf=good; Path=/a; Secure' }));
  assert.equal(jar.header('https://auth.example/a/post'), 'csrf=good');
  assert.equal(jar.header('https://auth.example/another'), '');
  assert.equal(jar.header('https://other.example/a/post'), '');
  assert.equal(jar.header('http://auth.example/a/post'), '');
  jar.receive('https://auth.example/a/login', new Headers({ 'set-cookie': 'csrf=deleted; Path=/a; Max-Age=0' }));
  assert.equal(jar.header('https://auth.example/a/post'), '');
  jar.receive('https://auth.example/a/login', new Headers({ 'set-cookie': 'csrf=deleted; Path=/a; Expires=Thu, 01 Jan 1970 00:00:00 GMT' }));
  assert.equal(jar.header('https://auth.example/a/post'), '');
});
