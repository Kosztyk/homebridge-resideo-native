'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { TokenStore } = require('../lib/token-store');
const { ResideoAuth } = require('../lib/auth');
const { NativeClient } = require('../lib/client');
const { LoginService } = require('../lib/login-service');
const { normalizeConfig } = require('../lib/platform');
const { backend, token } = require('./helpers');
const C = require('../lib/constants');

async function storage(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'resideo-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
function service(s, directory) {
  return new LoginService(directory, {
    authFactory: options => new ResideoAuth({ ...s.authOptions, ...options }),
    clientFactory: auth => new NativeClient(auth, { baseUrl: s.root }),
  });
}

test('one-time sign-in persists tokens privately without a password or email', async t => {
  const s = await backend(t); const directory = await storage(t);
  const login = service(s, directory);
  const result = await login.login({ username: 'private@example.test', password: 'correct-password', country: 'RO' });
  assert.equal(result.signedIn, true); assert.equal(result.devices.length, 1);
  const content = await fs.readFile(login.store.file, 'utf8');
  assert.equal(/password|private@example|correct-password/.test(content), false);
  const record = JSON.parse(content); assert.equal(record.accountId, '456'); assert.ok(record.token.refresh_token);
  assert.equal((await fs.stat(login.store.file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(login.store.directory)).mode & 0o777, 0o700);
  assert.deepEqual(Object.keys(await login.status()).sort(), ['expiresAt', 'signedIn']);
});

test('two independent processes of authorization share rotating refresh-token storage', async t => {
  const s = await backend(t); const directory = await storage(t);
  const store1 = new TokenStore(directory); const store2 = new TokenStore(directory);
  await store1.write({ accountId: '456', token: token({ expires_at: 1 }) });
  function refreshInChild() {
    const child = fork(path.join(__dirname, 'refresh-worker.js'), [directory, s.authOptions.authority], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    t.after(() => child.kill('SIGTERM'));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Refresh worker timed out')); }, 5000);
      child.once('message', result => { clearTimeout(timeout); if (result.success) resolve(result.expiresAt); else reject(new Error('Refresh worker failed')); });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
    });
  }
  const values = await Promise.all([refreshInChild(), refreshInChild()]);
  assert.equal(values[0], values[1]); assert.equal(s.refreshCount, 1);
  assert.equal((await store1.read()).token.refresh_token, 'rotated-1');
  const third = new ResideoAuth({ ...s.authOptions, store: new TokenStore(directory) });
  assert.equal(await third.accessToken(), (await store2.read()).token.access_token); assert.equal(s.refreshCount, 1);
});

test('changing an account cannot silently apply old accessory commands to a different account', async t => {
  const s = await backend(t); const store = new TokenStore(await storage(t));
  await store.write({ accountId: '456', token: token() });
  const auth = new ResideoAuth({ ...s.authOptions, store }); await auth.accessToken();
  await store.write({ accountId: 'other-account', token: token() });
  await assert.rejects(auth.accessToken(), { code: 'authentication_required' });
});

test('failed discovery leaves an existing working authorization intact', async t => {
  const s = await backend(t); const login = service(s, await storage(t));
  const original = { accountId: '456', token: token() };
  await login.store.write(original);
  s.payload = [];
  await assert.rejects(login.login({ username: 'test', password: 'correct-password' }), { code: 'invalid_response' });
  assert.equal((await login.store.read()).token.refresh_token, original.token.refresh_token);
});

test('verification falls back to a browser link using the selected account country', async t => {
  const s = await backend(t); s.signInResult = { status: 400, message: 'Verification required' };
  const login = service(s, await storage(t));
  const result = await login.login({ username: 'test', password: 'correct-password', country: 'DE' });
  assert.equal(result.browserRequired, true); assert.equal(new URL(result.url).searchParams.get('country'), 'DE');
  assert.equal((await login.status()).signedIn, false);
});

test('invalid callback preserves the pending PKCE attempt; a rejected exchange clears it', async t => {
  const s = await backend(t); const login = service(s, await storage(t));
  login.startBrowser('RO'); const original = login.authorization;
  await assert.rejects(login.callback({ redirectUrl: `${C.REDIRECT_URI}?state=wrong&code=test` }), { code: 'invalid_callback' });
  assert.equal(login.authorization, original);
  s.failures.set('/lyricprod.onmicrosoft.com/oauth2/v2.0/token', { status: 400, body: { error: 'invalid_grant' } });
  await assert.rejects(login.callback({ redirectUrl: `${C.REDIRECT_URI}/?state=${original.state}&code=test` }), { code: 'authentication_required' });
  assert.equal(login.authorization, null);
});

test('empty device override rows are ignored and default configuration discovers everything', () => {
  const config = normalizeConfig({ devices: [{ exclude: false }, {}, { id: ' T6-test ', name: 'Kitchen' }], pollInterval: 1 });
  assert.equal(config.pollInterval, 30); assert.deepEqual(config.devices, [{ id: 'T6-test', name: 'Kitchen' }]);
  assert.deepEqual(normalizeConfig({}).devices, []); assert.equal(normalizeConfig({}).defaultHold, 'TemporaryHold');
});

test('the actual Homebridge UI server starts and returns a sanitized missing-auth response over IPC', async t => {
  const directory = await storage(t);
  const child = fork(path.join(__dirname, '../homebridge-ui/server.js'), [], {
    env: { ...process.env, HOMEBRIDGE_STORAGE_PATH: directory }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => { child.kill('SIGTERM'); });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  function receive(action, id) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error('UI server timeout')); }, 5000);
      const listener = value => { if (value.action === action && (id === undefined || value.payload.requestId === id)) { cleanup(); resolve(value); } };
      const exited = code => { cleanup(); reject(new Error(`UI server exited ${code}`)); };
      const cleanup = () => { clearTimeout(timeout); child.off('message', listener); child.off('exit', exited); };
      child.on('message', listener); child.on('exit', exited);
    });
  }
  await receive('ready');
  const statusResponse = receive('response', 1);
  child.send({ action: 'request', path: '/status', requestId: 1 });
  assert.equal((await statusResponse).payload.data.signedIn, false);
  const testResponse = receive('response', 2);
  child.send({ action: 'request', path: '/test', requestId: 2 });
  const failed = (await testResponse).payload;
  assert.equal(failed.success, false); assert.equal(failed.data.error.code, 'authentication_required');
  assert.equal(/access_token|refresh_token|password|Error:|at Resideo/.test(logs), false);
});
