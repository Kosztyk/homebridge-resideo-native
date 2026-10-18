# Changelog

## 1.0.0 — 2026-10-18

- Initial Homebridge port of Resideo Native Home Assistant 0.1.2.
- Resideo app email/password sign-in with browser PKCE fallback and optional
  legacy refresh-token import; tokens stored separately from configuration.
- HomeKit thermostat discovery, model-specific Celsius/Fahrenheit conversion,
  supported HVAC modes, operation state, auto ranges, optional humidity, and
  schedule/permanent-hold switches.
- Shared polling, command serialization/readback, combined temperature changes,
  bounded 401 recovery, Retry-After handling, offline state, and accessory cache.
- Homebridge UI settings and independent one-time CLI sign-in.
- Complete npm package, source, tests, configuration examples, and GitHub CI.
