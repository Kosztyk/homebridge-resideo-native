'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { backend, locations, rawDevice, enableAuto } = require('./helpers');
const { parseLocations } = require('../lib/device');
const { NativeClient } = require('../lib/client');
const { request } = require('../lib/http');

test('Jasper readings, targets and bounds use Fahrenheit encoding with a Celsius display', () => {
  const payload = locations(); const original = structuredClone(payload);
  const d = parseLocations(payload).get('T6-test');
  assert.equal(d.currentTemperature, 26); assert.equal(d.setpoint('heat'), 23);
  assert.deepEqual(d.limits('heat'), [5, 35]); assert.equal(d.toWire(23.5), 74.3);
  assert.equal(d.humidity, null); assert.deepEqual(payload, original);
});

test('Fahrenheit display values also become Celsius for HomeKit, without double conversion', () => {
  const payload = locations(); rawDevice(payload).thermostat.units = 'Fahrenheit';
  const d = parseLocations(payload).get('T6-test');
  assert.equal(d.unit, 'Fahrenheit'); assert.equal(d.currentTemperature, 26); assert.equal(d.setpoint('heat'), 23);
  assert.equal(d.toWire(23), 73.4);
});

test('native Celsius models are unchanged and invalid sensor values are not invented', () => {
  const payload = locations(); const raw = rawDevice(payload);
  raw.deviceType = 'HoneyBadger'; raw.thermostat.indoorTemperature = 26;
  raw.thermostat.minHeatSetpoint = 5; raw.thermostat.maxHeatSetpoint = 35;
  raw.displayIndoorHumidity = true; raw.thermostat.indoorHumidity = 43;
  let d = parseLocations(payload).get('T6-test');
  assert.equal(d.currentTemperature, 26); assert.equal(d.toWire(23), 23); assert.equal(d.humidity, 43);
  raw.thermostat.indoorTemperature = true; raw.thermostat.indoorHumidity = 128;
  d = parseLocations(payload).get('T6-test'); assert.equal(d.currentTemperature, null); assert.equal(d.humidity, null);
});

test('native automatic and emergency reporting aliases retain the supplied integration display behavior', () => {
  const payload = locations(); const raw = rawDevice(payload);
  for (const [native, expected] of [['AutoHeat', 'Auto'], ['AutoCool', 'Auto'], ['EmergencyHeat', 'Heat']]) {
    raw.thermostat.changeableValues.mode = native;
    assert.equal(parseLocations(payload).get('T6-test').mode, expected);
  }
});

test('discovery initializes the native session once and shares concurrent polls', async t => {
  const s = await backend(t);
  const results = await Promise.all([s.client.update(), s.client.update(), s.client.update()]);
  assert.equal(results[0].size, 1); assert.equal(s.client.accountId, '456');
  assert.equal(s.calls.filter(c => c.path === '/api/v2/session').length, 1);
  assert.equal(s.calls.filter(c => c.path === '/api/v4/locations').length, 1);
  await s.client.update(); assert.equal(s.calls.filter(c => c.path === '/api/v2/session').length, 1);
  const headers = s.calls[0].headers;
  assert.equal(headers.appver, '6.21.1'); assert.ok(headers['ocp-apim-subscription-key']); assert.ok(headers.activityid);
});

test('a 401 refreshes once and retries, while a repeated 401 stops', async t => {
  const s = await backend(t); s.validTokens.delete('valid');
  await s.client.update(); assert.equal(s.refreshCount, 1);
  s.rejectAllTokens = true;
  const before = s.refreshCount;
  await assert.rejects(s.client.update(), { code: 'authentication_required' });
  assert.equal(s.refreshCount, before + 1);
});

test('API rate limits pause later requests across the account', async t => {
  const s = await backend(t); await s.client.update();
  s.failures.set('/api/v4/locations', { status: 429, headers: { 'retry-after': '120' } });
  await assert.rejects(s.client.update(), error => error.code === 'rate_limited' && error.retryAfter === 120);
  const before = s.calls.length;
  await assert.rejects(s.client.command('T6-test', { mode: 'Off' }), { code: 'rate_limited' });
  assert.equal(s.calls.length, before);
});

test('manual Celsius setpoint uses the native method, route, unit, and wire value', async t => {
  const s = await backend(t); await s.client.update();
  await s.client.command('T6-test', { temperatures: { target: 23.5 } });
  const write = s.writes()[0];
  assert.equal(write.method, 'PUT'); assert.equal(write.path, '/api/v2/locations/123/devices/T6-test/thermostat/HeatSetpoint');
  assert.deepEqual(JSON.parse(write.text), { thermostatSetpoint: 74.3, thermostatSetpointStatus: 'TemporaryHold', unit: 'Celsius' });
  assert.equal(s.client.devices.get('T6-test').setpoint('heat'), 23.5);
});

test('Fahrenheit preference sends a Fahrenheit wire value and the Fahrenheit unit field', async t => {
  const s = await backend(t); rawDevice(s.payload).thermostat.units = 'Fahrenheit';
  await s.client.update(); await s.client.command('T6-test', { temperatures: { target: 23 } });
  assert.deepEqual(JSON.parse(s.writes()[0].text), { thermostatSetpoint: 73.4, thermostatSetpointStatus: 'TemporaryHold', unit: 'Fahrenheit' });
});

test('unsupported modes, offline devices and absent safety bounds send no commands', async t => {
  const s = await backend(t); await s.client.update();
  await assert.rejects(s.client.command('T6-test', { mode: 'Cool' }), { code: 'command_rejected' });
  await assert.rejects(s.client.command('T6-test', { temperatures: { target: 40 } }), { code: 'command_rejected' });
  delete rawDevice(s.payload).thermostat.minHeatSetpoint; await s.client.update();
  await assert.rejects(s.client.command('T6-test', { temperatures: { target: 22 } }), { code: 'command_rejected' });
  rawDevice(s.payload).isAlive = false; await s.client.update();
  await assert.rejects(s.client.command('T6-test', { mode: 'Off' }), { code: 'command_rejected' });
  assert.equal(s.writes().length, 0);
});

test('automatic ranges use one POST, both capitalized setpoints and a validated deadband', async t => {
  const s = await backend(t); enableAuto(s); await s.client.update();
  await s.client.command('T6-test', { temperatures: { heat: 21, cool: 25 } });
  assert.equal(s.writes()[0].method, 'POST');
  assert.deepEqual(JSON.parse(s.writes()[0].text), { autoChangeoverActive: true, heatSetPoint: 69.8, coolSetPoint: 77, mode: 'Auto', thermostatSetpointStatus: 'TemporaryHold', unit: 'Celsius' });
  await assert.rejects(s.client.command('T6-test', { temperatures: { heat: 24, cool: 25 } }), { code: 'command_rejected' });
  assert.equal(s.writes().length, 1);
});

test('a one-sided automatic change retains the other server-confirmed setpoint', async t => {
  const s = await backend(t); enableAuto(s); await s.client.update();
  await s.client.command('T6-test', { temperatures: { cool: 26 } });
  assert.equal(JSON.parse(s.writes()[0].text).heatSetPoint, 68);
  assert.equal(s.client.devices.get('T6-test').setpoint('cool'), 26);
});

test('mode and subsequent target writes use the refreshed mode rather than stale heating state', async t => {
  const s = await backend(t); const d = enableAuto(s); d.changeableValues.mode = 'Heat'; d.changeableValues.autoChangeoverActive = false;
  await s.client.update();
  await Promise.all([s.client.command('T6-test', { mode: 'Cool' }), s.client.command('T6-test', { temperatures: { target: 24 } })]);
  assert.equal(s.writes()[1].path.endsWith('/Coolsetpoint'), true);
});

test('permanent hold is retained and resume schedule writes NoHold', async t => {
  const s = await backend(t); rawDevice(s.payload).thermostat.changeableValues.thermostatSetpointStatus = 'PermanentHold';
  await s.client.update(); await s.client.command('T6-test', { temperatures: { target: 22 } });
  assert.equal(JSON.parse(s.writes()[0].text).thermostatSetpointStatus, 'PermanentHold');
  await s.client.command('T6-test', { hold: 'NoHold' });
  assert.deepEqual(JSON.parse(s.writes()[1].text), { Status: 'NoHold' });
  await s.client.command('T6-test', { hold: 'TemporaryHold' });
  assert.deepEqual(JSON.parse(s.writes()[2].text), { Status: 'TemporaryHold', HoldUntil: '2026-10-18T22:00:00' });
});

test('server readback controls published state instead of optimistic target values', async t => {
  const s = await backend(t); s.updateWrites = false;
  await s.client.update(); await s.client.command('T6-test', { temperatures: { target: 24 } });
  assert.equal(s.client.devices.get('T6-test').setpoint('heat'), 23);
});

test('a timed-out command is not replayed', async t => {
  const s = await backend(t); s.writeDelay = 150;
  const client = new NativeClient(s.auth, { baseUrl: s.root, http: (method, url, options) => request(method, url, { ...options, timeout: method === 'GET' ? 2000 : 40 }) });
  await client.update();
  await assert.rejects(client.command('T6-test', { mode: 'Off' }), error => error.code === 'cannot_connect' && /not replayed/.test(error.message));
  assert.equal(s.writes().length, 1);
});

test('malformed discovery is rejected without replacing the last successful device map', async t => {
  const s = await backend(t); await s.client.update();
  s.payload = { devices: [] };
  await assert.rejects(s.client.update(), { code: 'invalid_response' });
  assert.equal(s.client.devices.size, 1);
  assert.throws(() => parseLocations([{ locationID: 1, devices: {} }]), { code: 'invalid_response' });
});
