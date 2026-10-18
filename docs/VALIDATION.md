# Validation — 1.0.0

Date: 18 October 2026. Runtime: Node.js 24.19.0 / npm 11.9.0.

## Automated checks

- **52 tests passed** in the complete suite against **Homebridge 1.11.4** (hap-nodejs 0.14.3)
  and **Homebridge 2.4.0** (@homebridge/hap-nodejs 2.2.2).
- Protocol tests use a real local HTTP server, not just stubbed request methods.
  They exercise form submission, cookies/CSRF, PKCE, native callbacks, token
  renewal, bounded 401 recovery, Retry-After, request methods/bodies, and readback.
- Temperature regression values from the supplied integration: Jasper/T6
  `78.8` / `73.4` become 26 °C / 23 °C with 5–35 °C bounds. Commands encode
  correctly, including a half-degree target. Native Celsius and Fahrenheit
  display preferences are covered independently.
- Native reporting aliases, offline devices, absent limits, auto ranges and
  deadband, permanent/temporary holds, schedule resume, empty device overrides,
  malformed payloads, and uncertain-write handling are covered.
- Two separate Node processes request renewal against one expired token file;
  only one refresh request is made and the rotated token is preserved.
- Actual Homebridge API tests create real PlatformAccessory/Thermostat services
  and invoke HomeKit characteristic getters/setters. Tests cover heat-only
  controls, temperature/mode writes, combined automatic thresholds, schedule
  switches, unavailable devices, dynamic discovery/exclusion, cache restoration,
  optional humidity, and authentication suspension.
- HomeKit's own post-set value commit is followed by the server readback state,
  including when a simulated accepted command has not changed the target.
- The actual custom UI server is forked with IPC and tested for startup,
  missing-authorization handling, and sanitized errors. DOM tests exercise
  generated defaults, country preservation, sign-in submission, credential
  clearing, safe device-name rendering, and browser fallback.
- JavaScript and inline UI script syntax, JSON, configuration/schema validation,
  CLI help, npm package contents, and isolated package installation are checked.

The GitHub workflow additionally defines Node.js 22/24/26 jobs for both
Homebridge versions. These CI jobs are supplied for publication; this local
validation does not claim to have run remote GitHub Actions or all Node versions.

## Live boundary

No account credentials or physical thermostat commands were used while creating
this port. The supplied Home Assistant integration reports prior live browser
sign-in and discovery for a European Jasper/T6. That result is provenance for
the original protocol, not a live test of this plugin. Live account sign-in,
cloud command acceptance, and physical thermostat behavior remain to be tested
on the user's installation. Other device families using this backend are not
advertised as hardware-tested.

The release is prepared locally. No GitHub repository creation or npm
publication was performed.
