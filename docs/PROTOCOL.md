# Legacy Resideo mobile protocol

This JavaScript implementation ports the supplied Resideo Native 0.1.2
Home Assistant integration, whose protocol documentation attributes the
legacy API to Resideo Android **6.21.1**, package
`com.honeywell.android.lyric`. The original APK SHA-256 was
`3e5f5b2ae3e61ae0bd28693e69a4870ebe603dcc39f0038e7165d71fded44e87`.
Neither that APK nor its decompiled code is distributed here.

## Authorization

Azure B2C authority:
`https://lyricprod.b2clogin.com/lyricprod.onmicrosoft.com`.
Policy: `b2c_1a_signin_mob_hh`. Public native client:
`d7baddb4-d9f3-4575-af28-f1b04a7883f2`.
Registered redirect:
`com.honeywell.acs.lyric.enterprise://oauth2redirect`.
Scopes: CHILAPIService `user_impersonation`, `profile email openid offline_access`.

The plugin creates a random state/nonce/verifier and S256 challenge. Direct
sign-in reads JSON `SETTINGS` from the hosted page, submits its cookie/CSRF-bound
`SelfAsserted` form, follows `CombinedSigninAndSignup/confirmed`, and redeems the
authorization code using PKCE without a client secret. Only redirects to the
original B2C origin and the exact native callback are accepted. Interactive
prompts fall back to browser sign-in. The browser callback is checked locally
before code redemption. Token renewal uses the refresh-token grant.

## Native API

Base: `https://lyric.alarmnet.com/`. Requests include a bearer token, public
mobile app subscription identifier, activity UUID, app version, app-style
User-Agent, and UTC `MobileClientTime`.

| Operation | Method and route |
| --- | --- |
| Initialize account | `GET api/v2/session` |
| Discover locations/devices | `GET api/v4/locations` |
| Heat target | `PUT api/v2/locations/{location}/devices/{device}/thermostat/HeatSetpoint` |
| Cool target | `PUT api/v2/locations/{location}/devices/{device}/thermostat/Coolsetpoint` |
| HVAC mode | `PUT api/locations/{location}/devices/{device}/thermostat/Mode` |
| Auto range | `POST api/locations/{location}/devices/{device}/thermostat/changeableValues` |
| Hold/schedule | `PUT api/locations/{location}/devices/{device}/hold` |

Single target body (23.5 °C on Jasper):

```json
{"thermostatSetpoint":74.3,"thermostatSetpointStatus":"TemporaryHold","unit":"Celsius"}
```

Mode body:

```json
{"thermostatMode":"Heat"}
```

Auto range body (20–24 °C on Jasper; case-sensitive property spelling):

```json
{"autoChangeoverActive":true,"heatSetPoint":68,"coolSetPoint":75.2,"mode":"Auto","thermostatSetpointStatus":"TemporaryHold","unit":"Celsius"}
```

Follow schedule:

```json
{"Status":"NoHold"}
```

Temporary hold includes `HoldUntil` when a next schedule transition is reported.
Commands never create or replace schedule periods.

## Model handling

Locations are a top-level array. A legacy thermostat has `deviceClass`,
`deviceID`, and nested `thermostat.changeableValues`. Titan-only devices are
skipped. Units, allowed modes, limits, humidity, activity, and setpoints come
from this nested model; the public developer API's flat schema is not assumed.

The source integration identifies Jasper, FlyCatcher, Storm, Focus Pro,
Houdini, and Blackbeard as Fahrenheit-encoded absolute-value models. HomeKit
temperatures are always Celsius, independently of display preference. All
absolute readings, bounds and setpoints are normalized to Celsius; commands are
encoded back to the device's wire unit. Deadband is treated as a difference in
the source integration's preferred display unit, scaled by 5/9 for Fahrenheit
preferences. Models use explicit rules, not numeric magnitude heuristics.

Changes relative to the Home Assistant adapter are limited to platform needs:
HomeKit characteristics, two hold switches, combined slider writes, cache,
custom UI/CLI, and shared token-file coordination. The protocol command routes
and body spellings come from the supplied integration.
