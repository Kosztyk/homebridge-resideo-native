'use strict';

const { CommandError, InvalidResponse } = require('./errors');
const WIRE_FAHRENHEIT = new Set(['flycatcher', 'jasper', 'storm', 'focus pro', 'houdini', 'blackbeard']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function number(value) {
  if (value === null || value === undefined || typeof value === 'boolean' || (typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
const round = value => Math.round(value * 1e6) / 1e6;
const toCelsius = (value, unit) => value === null ? null : unit === 'Fahrenheit' ? round((value - 32) * 5 / 9) : value;

class Thermostat {
  constructor(location, raw) { this.locationId = String(location.locationID); this.locationName = String(location.name || ''); this.id = String(raw.deviceID); this.raw = raw; }
  get name() { return String(this.raw.userDefinedDeviceName || this.raw.deviceSettings?.userDefinedName || this.raw.name || 'Thermostat'); }
  get model() { return String(this.raw.deviceModel || this.raw.deviceType || 'Honeywell Home thermostat'); }
  get thermostat() { return this.raw.thermostat; }
  get values() { return this.thermostat.changeableValues || {}; }
  get unit() { return ['Celsius', 'Fahrenheit'].includes(this.thermostat.units) ? this.thermostat.units : null; }
  get wireUnit() {
    const model = String(this.raw.deviceType || this.raw.deviceModel || '').trim().toLowerCase();
    return this.unit && WIRE_FAHRENHEIT.has(model) ? 'Fahrenheit' : this.unit;
  }
  fromWire(value) {
    const n = number(value);
    if (!this.unit || n === null) return null;
    return toCelsius(n, this.wireUnit);
  }
  // HomeKit always reads/writes Celsius, even for a Fahrenheit display preference.
  toWire(celsius) { return this.wireUnit === 'Fahrenheit' ? round(celsius * 9 / 5 + 32) : celsius; }
  get online() { return this.raw.isAlive !== false; }
  get currentTemperature() { return this.fromWire(this.thermostat.indoorTemperature); }
  setpoint(kind) { return this.fromWire(this.values[`${kind}Setpoint`]); }
  get humidity() {
    if (this.raw.displayIndoorHumidity === false) return null;
    const n = number(this.thermostat.indoorHumidity);
    return n !== null && n >= 0 && n <= 100 ? n : null;
  }
  get mode() {
    if (this.values.autoChangeoverActive === true) return 'Auto';
    const mode = this.values.mode;
    return typeof mode === 'string' ? ({ AutoHeat: 'Auto', AutoCool: 'Auto', EmergencyHeat: 'Heat' }[mode] || mode) : null;
  }
  get allowedModes() {
    const modes = this.thermostat.allowedModes;
    return Array.isArray(modes) ? modes.filter(mode => ['Off', 'Heat', 'Cool', 'Auto'].includes(mode)) : this.mode ? [this.mode].filter(mode => ['Off', 'Heat', 'Cool', 'Auto'].includes(mode)) : [];
  }
  get operation() { return typeof this.thermostat.operationStatus?.mode === 'string' ? this.thermostat.operationStatus.mode : null; }
  get hold() { return this.values.thermostatSetpointStatus === 'HoldUntil' ? 'TemporaryHold' : this.values.thermostatSetpointStatus; }
  get temperatureKind() {
    if (this.mode === 'Heat') return 'heat';
    if (this.mode === 'Cool') return 'cool';
    if (this.mode === 'Off') {
      if (this.values.heatCoolMode === 'Cool' && this.allowedModes.includes('Cool')) return 'cool';
      if (this.values.heatCoolMode === 'Heat' || this.allowedModes.includes('Heat') && !this.allowedModes.includes('Cool')) return 'heat';
    }
    return null;
  }
  limits(kind) {
    const prefix = kind === 'heat' ? 'Heat' : 'Cool';
    return [this.fromWire(this.thermostat[`min${prefix}Setpoint`]), this.fromWire(this.thermostat[`max${prefix}Setpoint`])];
  }
  get deadband() {
    const gap = number(this.thermostat.deadband);
    // The source integration compares deadband in the display unit. It is a
    // difference, so Fahrenheit preferences need scaling, never subtraction of 32.
    return gap === null ? null : this.unit === 'Fahrenheit' ? round(gap * 5 / 9) : gap;
  }
  validateTemperature(value, kind) {
    const n = number(value); const [low, high] = this.limits(kind);
    if (!this.unit || n === null) throw new CommandError('A valid temperature and thermostat unit are required.');
    if (low === null || high === null || low > high) throw new CommandError('Resideo did not report valid temperature limits.');
    if (n < low - 1e-6 || n > high + 1e-6) throw new CommandError('Requested temperature is outside the thermostat limits.');
    if (!this.online) throw new CommandError('The thermostat is offline.');
    return n;
  }
}

function parseLocations(payload) {
  if (!Array.isArray(payload)) throw new InvalidResponse('Resideo returned an unexpected locations response.');
  const result = new Map();
  for (const location of payload) {
    if (!object(location) || location.devices !== undefined && !Array.isArray(location.devices)) throw new InvalidResponse('Resideo returned an invalid location or device list.');
    for (const raw of location.devices || []) {
      if (!object(raw) || String(raw.deviceClass || '').toLowerCase() !== 'thermostat') continue;
      if (location.locationID == null || !raw.deviceID || !object(raw.thermostat)) continue;
      if (raw.thermostat.changeableValues !== undefined && !object(raw.thermostat.changeableValues)) throw new InvalidResponse('Resideo returned invalid thermostat values.');
      result.set(String(raw.deviceID), new Thermostat(location, raw));
    }
  }
  return result;
}
module.exports = { Thermostat, parseLocations, number, toCelsius };
