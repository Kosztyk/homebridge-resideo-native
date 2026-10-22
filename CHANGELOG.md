# Changelog

## 1.0.2 — 2026-10-22

- Declare HAP transport support for the Homebridge catalog.
- Use standard object-level required arrays in the configuration schema.

## 1.0.1 — 2026-10-18

- Treat Resideo's normal `EquipmentOff` relay status as idle. Version 1.0.0
  returned HomeKit communication error `-70402` for this status while Heat,
  Cool, or Auto was selected, making a reachable thermostat show No Response.
- Log the affected HomeKit characteristic when a Resideo reading is missing
  or unsupported, then log recovery. Repeated identical failures are suppressed;
  cloud response bodies, credentials, and tokens are never logged.
- Add Homebridge regression coverage for heating/idle transitions, missing
  activity and hold readings, diagnostic deduplication, and recovery.

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
