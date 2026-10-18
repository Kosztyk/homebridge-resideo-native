'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const C = require('./constants');
const { request, retrySeconds } = require('./http');
const { parseLocations, number } = require('./device');
const { AuthenticationError, InteractionRequired, CannotConnect, InvalidResponse, CommandError, RateLimited } = require('./errors');

class NativeClient extends EventEmitter {
  constructor(auth, { http = request, baseUrl = C.BASE_URL } = {}) {
    super();
    this.auth = auth; this.http = http; this.baseUrl = baseUrl;
    this.devices = new Map(); this.accountId = null; this.initialized = false;
    this.retryAt = 0; this.queue = Promise.resolve(); this.updatePending = null;
  }
  serial(task) {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }
  async apiRequest(method, route, body) {
    if (this.retryAt > Date.now()) throw new RateLimited((this.retryAt - Date.now()) / 1000);
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.auth.accessToken();
      const response = await this.http(method, new URL(route, this.baseUrl).href, {
        headers: { Authorization: `Bearer ${token}`, 'Ocp-Apim-Subscription-Key': C.APP_SUBSCRIPTION,
          ActivityId: randomUUID(), AppVer: '6.21.1', 'User-Agent': C.USER_AGENT,
          MobileClientTime: new Date().toISOString().slice(0, 19), Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8' },
        ...(body !== undefined ? { json: body } : {}),
      });
      if (response.status === 401) {
        if (attempt) throw new AuthenticationError('Resideo rejected the renewed authorization. Sign in again.');
        await this.auth.accessToken(token);
        continue;
      }
      if (response.status === 429) {
        const seconds = retrySeconds(response.headers.get('retry-after'));
        this.retryAt = Date.now() + seconds * 1000;
        throw new RateLimited(seconds);
      }
      if (response.status === 403) throw new InteractionRequired('Resideo denied access. Check sign-in and pending terms in the official app.');
      if (response.status >= 500) throw new CannotConnect('Resideo API is temporarily unavailable.');
      if (response.status < 200 || response.status >= 300) {
        if (method !== 'GET') throw new CommandError(`Resideo rejected the command (HTTP ${response.status}).`);
        throw new InvalidResponse(`Resideo API returned HTTP ${response.status}.`);
      }
      if (!response.text.trim()) {
        if (method === 'GET') throw new InvalidResponse('Resideo returned an empty API response.');
        return null;
      }
      try { return JSON.parse(response.text); } catch { throw new InvalidResponse('Resideo returned invalid JSON.'); }
    }
    throw new AuthenticationError();
  }
  async initialize() {
    if (this.initialized) return;
    const session = await this.apiRequest('GET', 'api/v2/session');
    if (!session?.user || session.user.userID == null) throw new InvalidResponse('Resideo did not return the expected legacy account session.');
    this.accountId = String(session.user.userID);
    if (this.auth.accountId && this.auth.accountId !== this.accountId) throw new AuthenticationError('The saved authorization belongs to a different Resideo account. Sign in again.');
    this.initialized = true;
  }
  async updateInternal() {
    await this.initialize();
    const devices = parseLocations(await this.apiRequest('GET', 'api/v4/locations'));
    this.devices = devices;
    this.emit('updated', devices);
    return devices;
  }
  update() {
    if (this.updatePending) return this.updatePending;
    const pending = this.serial(() => this.updateInternal());
    this.updatePending = pending;
    pending.finally(() => { if (this.updatePending === pending) this.updatePending = null; }).catch(() => {});
    return pending;
  }
  device(id) {
    const device = this.devices.get(id);
    if (!device) throw new CommandError('The thermostat is no longer in this Resideo account.');
    if (!device.online) throw new CommandError('The thermostat is offline.');
    return device;
  }
  path(device, suffix, version = '') {
    return `api/${version}locations/${encodeURIComponent(device.locationId)}/devices/${encodeURIComponent(device.id)}/${suffix}`;
  }
  // Commands and their readback share the same queue as polling. Each later
  // command uses the last server state, including concurrent HomeKit changes.
  command(id, change, defaultHold = 'TemporaryHold') {
    return this.serial(async () => {
      const device = this.device(id);
      if (change.mode !== undefined) {
        if (!device.allowedModes.includes(change.mode)) throw new CommandError('This mode is not supported by the thermostat.');
        await this.apiRequest('PUT', this.path(device, 'thermostat/Mode'), { thermostatMode: change.mode });
      } else if (change.hold !== undefined) {
        if (!C.HOLDS.includes(change.hold)) throw new CommandError('Unsupported hold status.');
        const body = { Status: change.hold };
        if (change.hold === 'TemporaryHold' && typeof device.values.nextPeriodTime === 'string' && device.values.nextPeriodTime) body.HoldUntil = device.values.nextPeriodTime;
        await this.apiRequest('PUT', this.path(device, 'hold'), body);
      } else if (change.temperatures) {
        const values = change.temperatures;
        let heat = values.heat; let cool = values.cool;
        if (values.target !== undefined) {
          if (!device.temperatureKind) throw new CommandError('Use the low and high setpoints in automatic mode, or select heating/cooling first.');
          if (device.temperatureKind === 'heat') heat = values.target;
          else cool = values.target;
        }
        if (device.mode === 'Auto') {
          heat = heat ?? device.setpoint('heat'); cool = cool ?? device.setpoint('cool');
        }
        const hold = device.hold === 'PermanentHold' ? 'PermanentHold' : defaultHold;
        await this.setTemperature(device, { heat, cool, hold });
      } else throw new CommandError('No thermostat change was requested.');
      // Never invent success values or replay an uncertain write.
      return this.updateInternal();
    });
  }
  async setTemperature(device, { heat, cool, hold }) {
    if (!['TemporaryHold', 'PermanentHold'].includes(hold)) throw new CommandError('Unsupported temperature hold type.');
    if (heat == null && cool == null) throw new CommandError('A temperature is required.');
    if (heat != null) {
      heat = device.validateTemperature(heat, 'heat');
      if (!device.allowedModes.some(mode => ['Heat', 'Auto'].includes(mode))) throw new CommandError('The thermostat does not support heating.');
    }
    if (cool != null) {
      cool = device.validateTemperature(cool, 'cool');
      if (!device.allowedModes.some(mode => ['Cool', 'Auto'].includes(mode))) throw new CommandError('The thermostat does not support cooling.');
    }
    if (device.mode === 'Auto' && (heat == null || cool == null)) throw new CommandError('Both limits are required in automatic mode.');
    if (heat != null && cool != null) {
      if (device.mode !== 'Auto' || !device.allowedModes.includes('Auto')) throw new CommandError('A temperature range requires automatic mode.');
      const gap = number(device.deadband);
      if (gap === null || gap < 0) throw new CommandError('Resideo did not report a valid heating/cooling deadband.');
      if (heat >= cool || cool - heat + 1e-6 < gap) throw new CommandError('The low and high setpoints violate the thermostat deadband.');
      await this.apiRequest('POST', this.path(device, 'thermostat/changeableValues'), {
        autoChangeoverActive: true, heatSetPoint: device.toWire(heat), coolSetPoint: device.toWire(cool), mode: 'Auto', thermostatSetpointStatus: hold, unit: device.unit,
      });
    } else {
      await this.apiRequest('PUT', this.path(device, heat != null ? 'thermostat/HeatSetpoint' : 'thermostat/Coolsetpoint', 'v2/'), {
        thermostatSetpoint: device.toWire(heat != null ? heat : cool), thermostatSetpointStatus: hold, unit: device.unit,
      });
    }
  }
}
module.exports = { NativeClient };
