'use strict';

const C = require('./constants');
const { TokenStore } = require('./token-store');
const { ResideoAuth } = require('./auth');
const { NativeClient } = require('./client');
const { ThermostatAccessory } = require('./accessory');
const { AuthenticationError, InteractionRequired, RateLimited, safeMessage } = require('./errors');

function normalizeConfig(config) {
  const poll = Number(config.pollInterval ?? 60);
  return {
    ...config,
    platform: C.PLATFORM_NAME,
    name: typeof config.name === 'string' && config.name.trim() ? config.name.trim() : 'Resideo Native',
    pollInterval: Number.isFinite(poll) ? Math.max(30, Math.min(600, poll)) : 60,
    defaultHold: config.defaultHold === 'PermanentHold' ? 'PermanentHold' : 'TemporaryHold',
    exposeHoldSwitches: config.exposeHoldSwitches !== false,
    devices: Array.isArray(config.devices) ? config.devices.filter(d => d && typeof d.id === 'string' && d.id.trim()).map(d => ({ ...d, id: d.id.trim() })) : [],
  };
}

class ResideoPlatform {
  constructor(log, config, api, dependencies = {}) {
    this.log = log; this.api = api; this.config = normalizeConfig(config || {});
    this.cached = new Map(); this.handlers = new Map(); this.stopped = false;
    this.authBlockedToken = null; this.lastFailure = null;
    if (!config) return;
    this.store = dependencies.store || new TokenStore(api.user.storagePath());
    this.auth = dependencies.auth || new ResideoAuth({ store: this.store });
    this.client = dependencies.client || new NativeClient(this.auth);
    this.client.on('updated', devices => { if (!this.stopped) this.applyDevices(devices); });
    api.on('didFinishLaunching', () => { this.poll().catch(error => this.handleFailure(error)); });
    api.on('shutdown', () => this.shutdown());
  }
  configureAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory);
    this.markCachedUnavailable(accessory);
  }
  markCachedUnavailable(accessory) {
    const service = accessory.getService(this.api.hap.Service.Thermostat);
    if (!service) return;
    const error = new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    const C = this.api.hap.Characteristic;
    for (const type of [C.CurrentTemperature, C.TargetTemperature, C.CurrentHeatingCoolingState, C.TargetHeatingCoolingState, C.HeatingThresholdTemperature, C.CoolingThresholdTemperature, C.CurrentRelativeHumidity, C.TemperatureDisplayUnits]) {
      if (service.testCharacteristic(type)) service.updateCharacteristic(type, error);
    }
    for (const subtype of ['resideo-schedule', 'resideo-permanent']) accessory.getServiceById(this.api.hap.Service.Switch, subtype)?.updateCharacteristic(C.On, error);
  }
  deviceOptions(id) { return this.config.devices.find(device => device.id === id) || {}; }
  applyDevices(devices) {
    const accountId = this.client.accountId;
    for (const [uuid, accessory] of this.cached) {
      const id = accessory.context.deviceId;
      if (accessory.context.accountId !== accountId || this.deviceOptions(id).exclude === true) {
        this.handlers.get(uuid)?.shutdown(); this.handlers.delete(uuid);
        this.api.unregisterPlatformAccessories(C.PLUGIN_NAME, C.PLATFORM_NAME, [accessory]);
        this.cached.delete(uuid);
      }
    }
    let added = 0;
    for (const device of devices.values()) {
      if (this.deviceOptions(device.id).exclude === true) continue;
      const uuid = this.api.hap.uuid.generate(`resideo-native:${accountId}:${device.id}`);
      let accessory = this.cached.get(uuid);
      const isNew = !accessory;
      if (!accessory) accessory = new this.api.platformAccessory(this.deviceOptions(device.id).name || device.name, uuid, this.api.hap.Categories.THERMOSTAT);
      accessory.context = { deviceId: device.id, accountId };
      let handler = this.handlers.get(uuid);
      if (!handler) {
        handler = new ThermostatAccessory(this, accessory, device);
        this.handlers.set(uuid, handler);
      } else handler.update(device);
      if (isNew) {
        this.cached.set(uuid, accessory);
        this.api.registerPlatformAccessories(C.PLUGIN_NAME, C.PLATFORM_NAME, [accessory]);
        added++;
      } else this.api.updatePlatformAccessories([accessory]);
    }
    for (const handler of this.handlers.values()) {
      if (!devices.has(handler.accessory.context.deviceId)) handler.setUnavailable();
    }
    // Removed cloud devices remain cached and unavailable. A transient empty
    // response must not erase HomeKit room assignments or automations.
    if (added) this.log.info(`Added ${added} Resideo thermostat${added === 1 ? '' : 's'}.`);
    if (this.config.debug) this.log.debug(`Account poll returned ${devices.size} thermostat(s).`);
    if (this.lastFailure) this.log.info('Resideo connection restored.');
    this.lastFailure = null;
  }
  async poll() {
    if (this.stopped) return;
    let next = this.config.pollInterval * 1000;
    try {
      if (this.authBlockedToken !== null) {
        const record = await this.store.read();
        const current = record?.token.refresh_token || 'missing';
        if (current === this.authBlockedToken) return;
        this.authBlockedToken = null;
      }
      const devices = await this.client.update();
      if (!devices.size && !this.warnedEmpty) {
        this.log.warn('No compatible legacy Resideo thermostats were found. Check that this account uses the Resideo app backend.');
        this.warnedEmpty = true;
      }
    } catch (error) {
      this.handleFailure(error);
      if (error instanceof RateLimited) next = Math.max(next, error.retryAfter * 1000 + 1000);
    } finally {
      if (!this.stopped) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.poll().catch(error => this.handleFailure(error)); }, next);
        this.timer.unref?.();
      }
    }
  }
  handleFailure(error) {
    if (error instanceof AuthenticationError || error instanceof InteractionRequired) this.authBlockedToken = this.auth.token?.refresh_token || 'missing';
    for (const accessory of this.cached.values()) this.markCachedUnavailable(accessory);
    for (const handler of this.handlers.values()) handler.setUnavailable();
    const message = safeMessage(error);
    if (this.lastFailure !== message) this.log.warn(message);
    this.lastFailure = message;
  }
  async command(id, change) {
    if (this.stopped) throw new AuthenticationError('Homebridge is shutting down.');
    try { return await this.client.command(id, change, this.config.defaultHold); }
    catch (error) {
      if (!(error.code === 'command_rejected')) this.handleFailure(error);
      throw error;
    }
  }
  reportCommandError(error) { this.log.warn(safeMessage(error)); }
  shutdown() {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const handler of this.handlers.values()) handler.shutdown();
  }
}
module.exports = { ResideoPlatform, normalizeConfig };
