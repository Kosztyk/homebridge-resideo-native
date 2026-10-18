'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { ResideoPlatform } = require('../lib/platform');
const { currentState } = require('../lib/accessory');
const { parseLocations } = require('../lib/device');
const { AuthenticationError } = require('../lib/errors');
const { backend, locations, rawDevice, enableAuto } = require('./helpers');

const homebridgePath = process.env.HOMEBRIDGE_TEST_PATH;

test('actual Homebridge API and HomeKit characteristics', { skip: !homebridgePath }, async t => {
  const apiFile = fs.existsSync(path.join(homebridgePath, 'dist/api.js')) ? 'dist/api.js' : 'lib/api.js';
  const { HomebridgeAPI } = await import(pathToFileURL(path.join(homebridgePath, apiFile)).href);
  async function fixture(t, options = {}) {
    const s = await backend(t); if (options.auto) enableAuto(s);
    const api = new HomebridgeAPI();
    api.user = { storagePath: () => os.tmpdir() };
    const registered = []; const removed = []; const warnings = []; const messages = [];
    const attach = a => a._associatedHAPAccessory.on('characteristic-warning', warning => warnings.push(warning));
    const OriginalAccessory = api.platformAccessory;
    api.platformAccessory = class extends OriginalAccessory { constructor(...args) { super(...args); attach(this); } };
    api.on('registerPlatformAccessories', accessories => { registered.push(...accessories); });
    api.on('unregisterPlatformAccessories', accessories => removed.push(...accessories));
    const log = Object.fromEntries(['info', 'debug', 'warn', 'error'].map(level => [level, message => messages.push([level, message])]));
    const store = { read: async () => null };
    const platform = new ResideoPlatform(log, { platform: 'ResideoNative', ...options.config }, api, { client: s.client, auth: s.auth, store });
    t.after(() => platform.shutdown());
    await s.client.update();
    const accessory = [...platform.cached.values()][0];
    const service = accessory?.getService(api.hap.Service.Thermostat);
    return { ...s, api, platform, accessory, service, C: api.hap.Characteristic, registered, removed, warnings, messages, attach };
  }
  await t.test('registration creates a heating-only thermostat with correct Celsius readings', async t => {
    const s = await fixture(t);
    assert.equal(s.registered.length, 1);
    assert.equal(s.accessory._associatedHAPAccessory.category, s.api.hap.Categories.THERMOSTAT);
    assert.equal(await s.service.getCharacteristic(s.C.CurrentTemperature).handleGetRequest(), 26);
    assert.equal(await s.service.getCharacteristic(s.C.TargetTemperature).handleGetRequest(), 23);
    assert.deepEqual(s.service.getCharacteristic(s.C.TargetHeatingCoolingState).props.validValues, [0, 1]);
    assert.equal(s.service.testCharacteristic(s.C.CoolingThresholdTemperature), false);
    assert.equal(s.service.testCharacteristic(s.C.CurrentRelativeHumidity), false);
    assert.equal(s.service.getCharacteristic(s.C.TargetTemperature).props.minValue, 5);
    assert.equal(s.service.getCharacteristic(s.C.TargetTemperature).props.maxValue, 35);
    assert.equal(s.warnings.length, 0);
  });
  await t.test('actual characteristic setters encode temperature and mode commands', async t => {
    const s = await fixture(t);
    await s.service.getCharacteristic(s.C.TargetTemperature).handleSetRequest(23.5);
    assert.equal(JSON.parse(s.writes()[0].text).thermostatSetpoint, 74.3);
    await s.service.getCharacteristic(s.C.TargetHeatingCoolingState).handleSetRequest(0);
    assert.deepEqual(JSON.parse(s.writes()[1].text), { thermostatMode: 'Off' });
    assert.equal(s.warnings.length, 0);
  });
  await t.test('automatic HomeKit threshold changes coalesce to one valid range command', async t => {
    const s = await fixture(t, { auto: true });
    await Promise.all([
      s.service.getCharacteristic(s.C.HeatingThresholdTemperature).handleSetRequest(25),
      s.service.getCharacteristic(s.C.CoolingThresholdTemperature).handleSetRequest(27),
    ]);
    assert.equal(s.writes().length, 1);
    assert.equal(JSON.parse(s.writes()[0].text).heatSetPoint, 77);
    assert.equal(JSON.parse(s.writes()[0].text).coolSetPoint, 80.6);
    assert.equal(s.warnings.length, 0);
  });
  await t.test('HomeKit retains the server-confirmed value when a cloud write has not changed it', async t => {
    const s = await fixture(t); s.client.update = s.client.update.bind(s.client);
    // The HTTP fixture is shared by reference, so suppress updates on its state.
    rawDevice(s.payload).thermostat.changeableValues.heatSetpoint = 73.4;
    const actualCommand = s.platform.client.command.bind(s.platform.client);
    s.platform.client.command = async () => { await s.platform.client.update(); };
    await s.service.getCharacteristic(s.C.TargetTemperature).handleSetRequest(24);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.service.getCharacteristic(s.C.TargetTemperature).value, 23);
    s.platform.client.command = actualCommand;
  });
  await t.test('schedule and permanent-hold switches preserve native semantics', async t => {
    const s = await fixture(t);
    const schedule = s.accessory.getServiceById(s.api.hap.Service.Switch, 'resideo-schedule');
    const permanent = s.accessory.getServiceById(s.api.hap.Service.Switch, 'resideo-permanent');
    assert.equal(await schedule.getCharacteristic(s.C.On).handleGetRequest(), true);
    await schedule.getCharacteristic(s.C.On).handleSetRequest(false);
    assert.equal(JSON.parse(s.writes()[0].text).Status, 'TemporaryHold');
    await permanent.getCharacteristic(s.C.On).handleSetRequest(true);
    assert.equal(JSON.parse(s.writes()[1].text).Status, 'PermanentHold');
    await permanent.getCharacteristic(s.C.On).handleSetRequest(false);
    assert.equal(JSON.parse(s.writes()[2].text).Status, 'NoHold');
    assert.equal(s.warnings.length, 0);
  });
  await t.test('offline and removed devices become unavailable without deleting cached accessories', async t => {
    const s = await fixture(t);
    rawDevice(s.payload).isAlive = false; await s.client.update();
    await assert.rejects(s.service.getCharacteristic(s.C.CurrentTemperature).handleGetRequest());
    s.payload.length = 0; await s.client.update();
    assert.equal(s.platform.cached.size, 1); assert.equal(s.removed.length, 0);
  });
  await t.test('new devices are discovered automatically and explicit exclusions are respected', async t => {
    const s = await fixture(t);
    const second = structuredClone(rawDevice(s.payload)); second.deviceID = 'T6-second'; second.name = 'Bedroom';
    s.payload[0].devices.push(second); await s.client.update();
    assert.equal(s.platform.cached.size, 2);
    s.platform.config.devices = [{ id: 'T6-second', exclude: true }]; await s.client.update();
    assert.equal(s.platform.cached.size, 1); assert.equal(s.removed.length, 1);
  });
  await t.test('cached restoration preserves the accessory UUID and custom context never stores credentials', async t => {
    const s = await fixture(t);
    const serialized = s.api.platformAccessory.serialize(s.accessory);
    const restored = s.api.platformAccessory.deserialize(serialized);
    const oldHandler = [...s.platform.handlers.values()][0]; oldHandler.shutdown();
    s.platform.handlers.clear(); s.platform.cached.clear(); s.platform.configureAccessory(restored);
    await s.client.update();
    assert.equal([...s.platform.cached.values()][0], restored);
    assert.equal(s.registered.length, 1);
    assert.deepEqual(restored.context, { deviceId: 'T6-test', accountId: '456' });
    assert.equal(await restored.getService(s.api.hap.Service.Thermostat).getCharacteristic(s.C.CurrentTemperature).handleGetRequest(), 26);
  });
  await t.test('valid humidity is added, while heating activity follows reported operation, not temperature', async t => {
    const s = await fixture(t); const raw = rawDevice(s.payload);
    raw.displayIndoorHumidity = true; raw.thermostat.indoorHumidity = 45; raw.thermostat.operationStatus.mode = 'Idle';
    await s.client.update();
    assert.equal(await s.service.getCharacteristic(s.C.CurrentRelativeHumidity).handleGetRequest(), 45);
    assert.equal(await s.service.getCharacteristic(s.C.CurrentHeatingCoolingState).handleGetRequest(), 0);
    raw.thermostat.operationStatus.mode = 'Heat'; await s.client.update();
    assert.equal(await s.service.getCharacteristic(s.C.CurrentHeatingCoolingState).handleGetRequest(), 1);
    raw.displayIndoorHumidity = false; await s.client.update();
    assert.equal(s.service.testCharacteristic(s.C.CurrentRelativeHumidity), false);
  });
  await t.test('authentication failures stop repeated cloud attempts until authorization changes', async t => {
    const s = await fixture(t); let calls = 0;
    s.client.update = async () => { calls++; throw new AuthenticationError(); };
    s.platform.store.read = async () => ({ token: { refresh_token: s.auth.token.refresh_token } });
    await s.platform.poll(); await s.platform.poll();
    assert.equal(calls, 1);
    s.platform.store.read = async () => ({ token: { refresh_token: 'new-login' } });
    await s.platform.poll(); assert.equal(calls, 2);
  });
  await t.test('failed discovery cannot unregister cached devices', async t => {
    const s = await fixture(t);
    s.failures.set('/api/v4/locations', { status: 503 });
    await s.platform.poll(); assert.equal(s.platform.cached.size, 1); assert.equal(s.removed.length, 0);
  });
});

test('heating activity is not inferred from the target/current temperature difference', () => {
  const payload = locations(); const raw = rawDevice(payload); raw.thermostat.operationStatus = {};
  const d = parseLocations(payload).get('T6-test'); assert.equal(currentState(d), null);
  raw.thermostat.operationStatus.mode = 'Idle'; assert.equal(currentState(d), 0);
  raw.thermostat.operationStatus.mode = 'Heat'; assert.equal(currentState(d), 1);
});
