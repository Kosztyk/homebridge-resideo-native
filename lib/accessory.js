'use strict';

const { CommandError } = require('./errors');
const MODE = { Off: 0, Heat: 1, Cool: 2, Auto: 3 };
const NATIVE_MODE = ['Off', 'Heat', 'Cool', 'Auto'];

function currentState(device) {
  const operation = device.operation?.trim().toLowerCase();
  if (['heat', 'heating'].includes(operation)) return 1;
  if (['cool', 'cooling'].includes(operation)) return 2;
  // EquipmentOff is Resideo's normal relay-idle status while the selected
  // thermostat mode can still be Heat, Cool, or Auto.
  if (device.mode === 'Off' || ['equipmentoff', 'idle', 'off', 'none', 'fan'].includes(operation)) return 0;
  return null;
}

class ThermostatAccessory {
  constructor(platform, accessory, device) {
    this.platform = platform; this.accessory = accessory; this.device = device;
    this.C = platform.api.hap.Characteristic; this.S = platform.api.hap.Service;
    this.available = false; this.pending = null; this.readFailures = new Set();
    this.service = accessory.getService(this.S.Thermostat) || accessory.addService(this.S.Thermostat, accessory.displayName);
    this.service.setPrimaryService(true);
    this.bind(this.C.CurrentTemperature, d => d.currentTemperature);
    this.bind(this.C.TargetTemperature, d => {
      if (d.mode === 'Auto') {
        const low = d.setpoint('heat'); const high = d.setpoint('cool');
        return low === null || high === null ? null : (low + high) / 2;
      }
      return d.temperatureKind ? d.setpoint(d.temperatureKind) : null;
    }, value => this.deferTemperature('target', value));
    this.bind(this.C.TargetHeatingCoolingState, d => MODE[d.mode] ?? null, value => {
      if (!Number.isInteger(value) || !NATIVE_MODE[value]) throw new CommandError('Unsupported thermostat mode.');
      return this.write({ mode: NATIVE_MODE[value] });
    });
    this.bind(this.C.CurrentHeatingCoolingState, currentState);
    this.bind(this.C.TemperatureDisplayUnits, d => d.unit === 'Fahrenheit' ? 1 : d.unit === 'Celsius' ? 0 : null);
    // The native integration cannot change device units. HomeKit still stores
    // temperatures in Celsius and displays them using this preference.
    this.service.getCharacteristic(this.C.TemperatureDisplayUnits).setProps({ perms: ['pr', 'ev'] });
    this.update(device);
  }
  failure() { return new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE); }
  requireDevice() {
    if (!this.available || !this.device?.online || !this.device.unit) throw this.failure();
    return this.device;
  }
  value(read, label) {
    try {
      const value = read(this.requireDevice());
      if (value === null || value === undefined || typeof value === 'number' && !Number.isFinite(value)) throw this.failure();
      if (label && this.readFailures.delete(label)) this.platform.log.info(`${this.accessory.displayName}: ${label} is available again.`);
      return value;
    } catch (error) {
      if (label && !this.readFailures.has(label)) {
        this.readFailures.add(label);
        const reason = !this.device ? 'no thermostat data'
          : !this.device.online ? 'thermostat reported offline'
          : !this.device.unit ? 'temperature units are missing or unsupported'
          : !this.available ? 'no successful current Resideo update'
          : 'Resideo value is missing or unsupported';
        this.platform.log.warn(`${this.accessory.displayName}: ${label} is unavailable (${reason}). HomeKit receives No Response.`);
      }
      throw error;
    }
  }
  bind(type, read, write) {
    const characteristic = this.service.getCharacteristic(type);
    characteristic.onGet(() => this.value(read, type.name));
    if (write) characteristic.onSet(async value => {
      this.requireDevice();
      try { await write(value); this.publishAfterSet(); }
      catch (error) { this.platform.reportCommandError(error); throw this.failure(); }
    });
  }
  async write(change) { this.requireDevice(); return this.platform.command(this.device.id, change); }
  publishAfterSet() {
    // HAP commits the requested characteristic value after onSet resolves.
    // Re-apply the readback on the next turn if the cloud kept another value.
    setImmediate(() => { if (!this.platform.stopped && this.device) this.publish(); });
  }
  deferTemperature(kind, value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return Promise.reject(new CommandError('A finite temperature is required.'));
    if (!this.pending) this.pending = { values: {}, waiters: [] };
    const pending = this.pending;
    pending.values[kind] = value;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(async () => {
      if (this.pending === pending) this.pending = null;
      try {
        await this.write({ temperatures: pending.values });
        for (const waiter of pending.waiters) waiter.resolve();
      } catch (error) { for (const waiter of pending.waiters) waiter.reject(error); }
    }, 300);
    return new Promise((resolve, reject) => pending.waiters.push({ resolve, reject }));
  }
  update(device) {
    this.device = device;
    this.available = Boolean(device?.online && device.unit);
    if (!device) { this.setUnavailable(); return; }
    const information = this.accessory.getService(this.S.AccessoryInformation);
    information.setCharacteristic(this.C.Manufacturer, 'Resideo / Honeywell Home')
      .setCharacteristic(this.C.Model, device.model)
      .setCharacteristic(this.C.SerialNumber, device.id);
    const firmware = device.raw.firmwareVersion || device.raw.thermostatVersion || device.raw.firmware;
    if (typeof firmware === 'string' && firmware) information.setCharacteristic(this.C.FirmwareRevision, firmware);
    const name = this.platform.deviceOptions(device.id).name || device.name;
    if (name !== this.accessory.displayName) {
      this.accessory.displayName = name;
      this.service.setCharacteristic(this.C.Name, name);
      if (!this.service.testCharacteristic(this.C.ConfiguredName)) this.service.addOptionalCharacteristic(this.C.ConfiguredName);
      this.service.setCharacteristic(this.C.ConfiguredName, name);
    }
    this.service.getCharacteristic(this.C.CurrentTemperature).setProps({ minValue: -100, maxValue: 150, minStep: 0.1 });
    const modes = device.allowedModes.map(mode => MODE[mode]);
    if (modes.length) this.service.getCharacteristic(this.C.TargetHeatingCoolingState).setProps({ validValues: modes });
    const kind = device.temperatureKind || 'heat';
    this.setLimits(this.C.TargetTemperature, device.mode === 'Auto' ? [device.limits('heat')[0], device.limits('cool')[1]] : device.limits(kind), device.unit);
    if (device.allowedModes.includes('Auto')) {
      if (!this.autoBound) {
        this.bind(this.C.HeatingThresholdTemperature, d => d.setpoint('heat'), value => this.deferTemperature('heat', value));
        this.bind(this.C.CoolingThresholdTemperature, d => d.setpoint('cool'), value => this.deferTemperature('cool', value));
        this.autoBound = true;
      }
      this.setLimits(this.C.HeatingThresholdTemperature, device.limits('heat'), device.unit);
      this.setLimits(this.C.CoolingThresholdTemperature, device.limits('cool'), device.unit);
    } else if (this.autoBound || this.service.testCharacteristic(this.C.HeatingThresholdTemperature)) {
      if (this.service.testCharacteristic(this.C.HeatingThresholdTemperature)) this.service.removeCharacteristic(this.service.getCharacteristic(this.C.HeatingThresholdTemperature));
      if (this.service.testCharacteristic(this.C.CoolingThresholdTemperature)) this.service.removeCharacteristic(this.service.getCharacteristic(this.C.CoolingThresholdTemperature));
      this.autoBound = false;
    }
    if (device.humidity !== null) {
      if (!this.humidityBound) { this.bind(this.C.CurrentRelativeHumidity, d => d.humidity); this.humidityBound = true; }
    } else if (this.humidityBound || this.service.testCharacteristic(this.C.CurrentRelativeHumidity)) {
      this.service.removeCharacteristic(this.service.getCharacteristic(this.C.CurrentRelativeHumidity)); this.humidityBound = false;
    }
    this.configureHoldSwitches();
    this.publish();
  }
  setLimits(type, limits, unit) {
    const [low, high] = limits;
    if (low !== null && high !== null && low < high && low >= -273 && high <= 150) {
      const characteristic = this.service.getCharacteristic(type);
      if (typeof characteristic.value === 'number' && (characteristic.value < low || characteristic.value > high)) characteristic.updateValue(this.failure());
      characteristic.setProps({ minValue: low, maxValue: high, minStep: unit === 'Fahrenheit' ? 0.1 : 0.5 });
    }
  }
  configureHoldSwitches() {
    this.holdServices = this.holdServices || [];
    const definitions = [
      ['resideo-schedule', 'Follow schedule', 'NoHold', 'TemporaryHold'],
      ['resideo-permanent', 'Permanent hold', 'PermanentHold', 'NoHold'],
    ];
    for (const [subtype, label, on, off] of definitions) {
      let service = this.accessory.getServiceById(this.S.Switch, subtype);
      if (!this.platform.config.exposeHoldSwitches) { if (service) this.accessory.removeService(service); continue; }
      if (!service) service = this.accessory.addService(this.S.Switch, `${this.accessory.displayName} ${label}`, subtype);
      if (!service.testCharacteristic(this.C.ConfiguredName)) service.addOptionalCharacteristic(this.C.ConfiguredName);
      service.setCharacteristic(this.C.ConfiguredName, `${this.accessory.displayName} ${label}`);
      service.getCharacteristic(this.C.On).onGet(() => this.value(d => d.hold ? d.hold === on : null, `${subtype}.On`));
      service.getCharacteristic(this.C.On).onSet(async value => {
        try { await this.write({ hold: value ? on : off }); this.publishAfterSet(); }
        catch (error) { this.platform.reportCommandError(error); throw this.failure(); }
      });
      if (!this.holdServices.some(item => item.service === service)) this.holdServices.push({ service, on });
    }
    this.holdServices = this.holdServices.filter(item => this.accessory.services.includes(item.service));
  }
  publish() {
    const d = this.device;
    const entries = [
      [this.C.CurrentTemperature, () => d.currentTemperature],
      [this.C.TargetTemperature, () => d.mode === 'Auto' ? d.setpoint('heat') === null || d.setpoint('cool') === null ? null : (d.setpoint('heat') + d.setpoint('cool')) / 2 : d.temperatureKind ? d.setpoint(d.temperatureKind) : null],
      [this.C.TargetHeatingCoolingState, () => MODE[d.mode] ?? null],
      [this.C.CurrentHeatingCoolingState, () => currentState(d)],
      [this.C.TemperatureDisplayUnits, () => d.unit === 'Fahrenheit' ? 1 : d.unit === 'Celsius' ? 0 : null],
    ];
    if (this.autoBound) entries.push([this.C.HeatingThresholdTemperature, () => d.setpoint('heat')], [this.C.CoolingThresholdTemperature, () => d.setpoint('cool')]);
    if (this.humidityBound) entries.push([this.C.CurrentRelativeHumidity, () => d.humidity]);
    for (const [type, read] of entries) {
      let value;
      try { value = this.value(read, type.name); } catch { value = this.failure(); }
      this.service.updateCharacteristic(type, value);
    }
    for (const { service, on } of this.holdServices || []) {
      let value;
      try { value = this.value(device => device.hold ? device.hold === on : null, `${service.subtype}.On`); } catch { value = this.failure(); }
      service.updateCharacteristic(this.C.On, value);
    }
  }
  setUnavailable() {
    this.available = false;
    for (const type of [this.C.CurrentTemperature, this.C.TargetTemperature, this.C.CurrentHeatingCoolingState, this.C.TargetHeatingCoolingState]) this.service.updateCharacteristic(type, this.failure());
    for (const { service } of this.holdServices || []) service.updateCharacteristic(this.C.On, this.failure());
  }
  shutdown() {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      for (const waiter of this.pending.waiters) waiter.reject(this.failure());
      this.pending = null;
    }
  }
}
module.exports = { ThermostatAccessory, currentState, MODE };
