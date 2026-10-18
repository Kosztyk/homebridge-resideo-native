'use strict';

const http = require('node:http');
const { createHash } = require('node:crypto');
const { ResideoAuth } = require('../lib/auth');
const { NativeClient } = require('../lib/client');
const C = require('../lib/constants');

function locations() {
  return [{ locationID: 123, name: 'Test home', devices: [
    { deviceClass: 'LeakDetector', deviceID: 'ignored' },
    { deviceClass: 'Thermostat', deviceID: 'T6-test', name: 'Test thermostat', deviceType: 'Jasper', deviceModel: 'Jasper', isAlive: true, displayIndoorHumidity: false,
      thermostat: { units: 'Celsius', indoorTemperature: 78.8, indoorHumidity: 128, allowedModes: ['Off', 'Heat'], minHeatSetpoint: 41, maxHeatSetpoint: 95, operationStatus: { mode: 'Heat' },
        changeableValues: { mode: 'Heat', heatSetpoint: 73.4, thermostatSetpointStatus: 'NoHold', nextPeriodTime: '2026-10-18T22:00:00' } } },
  ] }];
}
function rawDevice(payload) { return payload[0].devices.find(d => d.deviceClass === 'Thermostat'); }
const token = (overrides = {}) => ({ access_token: 'valid', refresh_token: 'refresh-initial', expires_at: Date.now() / 1000 + 3600, ...overrides });

async function backend(t) {
  const state = { payload: locations(), calls: [], failures: new Map(), refreshCount: 0, tokenCount: 0, validTokens: new Set(['valid']), callbackPath: '', updateWrites: true };
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString();
      const url = new URL(req.url, 'http://localhost');
      const call = { method: req.method, path: url.pathname, headers: req.headers, text, url };
      state.calls.push(call);
      const json = (data, status = 200, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
      if (state.failures.has(url.pathname)) {
        const failure = state.failures.get(url.pathname);
        if (failure.once) state.failures.delete(url.pathname);
        json(failure.body || { private: 'private-response-must-not-be-logged' }, failure.status, failure.headers);
        return;
      }
      if (url.pathname.endsWith('/authorize')) {
        state.authState = url.searchParams.get('state'); state.challenge = url.searchParams.get('code_challenge');
        const settings = { csrf: 'csrf-test', transId: 'StateProperties=test', api: 'CombinedSigninAndSignup', hosts: { tenant: '/lyricprod.onmicrosoft.com/B2C_1A_SignIn_Mob_HH', policy: 'B2C_1A_SignIn_Mob_HH' } };
        res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': ['x-ms-cpim-csrf=cookie-test; Path=/; HttpOnly', 'other=value; Path=/'] });
        res.end(state.loginPage || `<html><script>var SETTINGS = ${JSON.stringify(settings)}; var OTHER = {};</script></html>`);
        return;
      }
      if (url.pathname.endsWith('/SelfAsserted')) {
        const form = new URLSearchParams(text);
        state.cookieVerified = req.headers.cookie?.includes('x-ms-cpim-csrf=cookie-test') && req.headers['x-csrf-token'] === 'csrf-test';
        if (!state.cookieVerified || form.get('password') !== 'correct-password') { json({ status: '400', message: 'Incorrect password for private@example.test' }); return; }
        json(state.signInResult || { status: '200' }); return;
      }
      if (url.pathname.endsWith('/confirmed')) {
        res.writeHead(302, { location: state.redirect || `${C.REDIRECT_URI}${state.callbackPath}?code=one-time-code&state=${state.authState}` }); res.end(); return;
      }
      if (url.pathname.endsWith('/token')) {
        state.tokenCount++;
        const form = new URLSearchParams(text);
        if (form.get('grant_type') === 'authorization_code') {
          if (createHash('sha256').update(form.get('code_verifier') || '').digest('base64url') !== state.challenge) { json({ error: 'invalid_grant' }, 400); return; }
        } else {
          state.refreshCount++;
          if (form.get('refresh_token') === 'revoked') { json({ error: 'invalid_grant', error_description: 'private details' }, 400); return; }
        }
        const access = `valid-${state.tokenCount}`;
        state.validTokens.add(access);
        json({ access_token: access, refresh_token: `rotated-${state.tokenCount}`, expires_in: 3600 }); return;
      }
      if (!state.validTokens.has((req.headers.authorization || '').replace(/^Bearer /, '')) || state.rejectAllTokens) { json({ error: 'expired' }, 401); return; }
      if (url.pathname === '/api/v2/session') { json({ user: { userID: 456, username: 'private@example.test' }, bodytoken: 'private-secret' }); return; }
      if (url.pathname === '/api/v4/locations') { json(state.payload); return; }
      if (req.method !== 'GET') {
        const body = JSON.parse(text);
        const raw = rawDevice(state.payload);
        if (state.updateWrites) {
          const values = raw.thermostat.changeableValues;
          if (url.pathname.endsWith('/Mode')) { values.mode = body.thermostatMode; values.autoChangeoverActive = body.thermostatMode === 'Auto'; }
          if (url.pathname.endsWith('/HeatSetpoint')) values.heatSetpoint = body.thermostatSetpoint;
          if (url.pathname.endsWith('/Coolsetpoint')) values.coolSetpoint = body.thermostatSetpoint;
          if (url.pathname.endsWith('/changeableValues')) { values.heatSetpoint = body.heatSetPoint; values.coolSetpoint = body.coolSetPoint; }
          if (body.thermostatSetpointStatus) values.thermostatSetpointStatus = body.thermostatSetpointStatus;
          if (body.Status) values.thermostatSetpointStatus = body.Status;
        }
        if (state.writeDelay) await new Promise(resolve => setTimeout(resolve, state.writeDelay));
        res.writeHead(204); res.end(); return;
      }
      json({}, 404);
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  state.root = root;
  state.authOptions = { authority: `${root}/lyricprod.onmicrosoft.com` };
  state.auth = new ResideoAuth({ ...state.authOptions, token: token() });
  state.client = new NativeClient(state.auth, { baseUrl: `${root}/` });
  state.writes = () => state.calls.filter(call => call.method !== 'GET' && call.path.startsWith('/api/'));
  return state;
}
function enableAuto(state) {
  const raw = rawDevice(state.payload); const d = raw.thermostat;
  d.allowedModes = ['Off', 'Heat', 'Cool', 'Auto']; d.minCoolSetpoint = 50; d.maxCoolSetpoint = 95; d.deadband = 2;
  d.changeableValues.mode = 'Auto'; d.changeableValues.autoChangeoverActive = true;
  d.changeableValues.heatSetpoint = 68; d.changeableValues.coolSetpoint = 75.2;
  return d;
}
module.exports = { backend, locations, rawDevice, token, enableAuto };
