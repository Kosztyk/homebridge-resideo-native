# Homebridge Resideo Native

**Honeywell Home / Resideo Lyric T6 and T6R thermostats in Apple Home**, using the
same legacy cloud protocol as the Resideo Smart Home Android app. Developed by
**Kosztyk**. Version **1.0.0**.

Sign in with your Resideo account in the Homebridge plugin settings. No
developer account, consumer key, consumer secret, SmartThings connection,
Home Assistant installation, or thermostat HomeKit pairing is needed.

This is a JavaScript port of the supplied **Resideo Native 0.1.2** Home Assistant
integration. It preserves its PKCE authentication, thermostat API routes,
Jasper/T6 temperature conversion, and supported controls. This plugin connects
directly to Resideo; it does not call Home Assistant.

## Install the provided package

Requirements: **Node.js 22.12+, 24, or 26**, **Homebridge 1.8+ or 2.x**, and the
Homebridge UI for the graphical sign-in screen. Node.js 24 is suitable.
The command-line sign-in tool also works without the UI.

1. Copy `homebridge-resideo-native-1.0.0.tgz` to the Homebridge host.
2. In the **Homebridge UI → Terminal**, install the file using its full path:

   ```sh
   npm install -g /full/path/homebridge-resideo-native-1.0.0.tgz
   ```

   If your installation requires administrator privileges, run the installation
   with the same privileges you use to install other Homebridge plugins. The
   sign-in itself must run as the Homebridge service user, not root.

3. Open **Plugins → Resideo Native → Settings**.
4. Set your Resideo account country, e.g. **RO**, in the settings form.
5. Enter your Resideo app email/password and click **Sign in**. The password is
   used only for this request and is never saved to `config.json`.
6. If Resideo needs an interactive prompt, the settings page opens the browser
   fallback instructions. Complete those instead of repeatedly trying passwords.
7. Save the settings and restart Homebridge. Discovered thermostats appear
   through your Homebridge bridge. A child bridge is also supported.

The package contains runnable JavaScript. **No compilation step is needed** to
install it. The `.zip` contains the complete source, tests, package lock,
configuration UI, documentation, and GitHub workflow.

The provided files are ready for local installation and publication, but this
release has **not been published to npm or GitHub**. Searching by package name
in Homebridge will work only after npm publication and indexing.

## Thermostat controls

Each supported device becomes a real HomeKit **Thermostat**, with:

- Current temperature and target temperature.
- Off, Heat, Cool, and Auto **only if reported by that device**. A heating-only
  European T6 offers Off and Heat.
- Heating/cooling activity from the device's operation status. It is not
  guessed from the room/target temperature difference, which is unsuitable for
  TPI boiler control.
- Separate low/high setpoints for automatic heat/cool, with bounds/deadband
  validation and a single combined native command.
- Indoor humidity when the device reports a valid, enabled reading.
- Two optional switches for schedule/hold control, usually grouped with the
  thermostat by Apple Home. Other HomeKit clients may show them separately.

| Control | Result |
| --- | --- |
| Follow schedule → On | Resume the existing schedule (`NoHold`) |
| Follow schedule → Off | Temporary hold until the next scheduled period |
| Permanent hold → On | Enable permanent hold |
| Permanent hold → Off | Resume the existing schedule |
| Change target temperature | Use the configured default hold; preserve an existing permanent hold |

The plugin does not overwrite schedule periods. Full schedule editing, vacation
creation, hot water, fan controls, geofencing, and installer settings are outside
the supplied integration's implemented scope.

## Correct temperature units

Jasper/T6, FlyCatcher, Storm, Focus Pro/Houdini, and Blackbeard encode absolute
API temperatures in Fahrenheit, including when their display preference is
Celsius. The plugin uses the device model to convert these values correctly.

For a Jasper/T6, API readings `78.8` / `73.4` become **26 °C** current /
**23 °C** target. Selecting **23.5 °C** sends the native numeric setpoint
`74.3`, retaining the API's `unit: "Celsius"` display-preference field.

HomeKit's protocol always carries Celsius temperatures. A Fahrenheit-preference
thermostat is also converted to Celsius internally and advertised with a
Fahrenheit display preference; values are never converted twice. Native-Celsius
models remain in Celsius. The plugin exposes the display preference read-only
because the supplied protocol implementation has no unit-change endpoint.

## Configuration

The settings UI creates this platform block. Do not add a blank device row:

```json
{
  "platform": "ResideoNative",
  "name": "Resideo Native",
  "country": "RO",
  "pollInterval": 60,
  "defaultHold": "TemporaryHold",
  "exposeHoldSwitches": true,
  "devices": [],
  "debug": false
}
```

`devices: []` discovers all compatible thermostats. For an explicit override:

```json
"devices": [
  { "id": "YOUR_DEVICE_ID", "name": "Living Room" },
  { "id": "ANOTHER_DEVICE_ID", "exclude": true }
]
```

Use **Test connection** in the settings to see discovered device IDs. Blank rows
are ignored rather than applied to every thermostat. Removing an override does
not exclude the device; set `exclude: true` to hide it.

One account/platform instance is supported per Homebridge storage directory.
Sign-in tokens are stored separately from configuration at
`<Homebridge storage>/resideo-native/authorization.json`, with owner-only file
permissions. Tokens rotate automatically, including across restarts. A shared
file lock prevents the UI connection test and running plugin from consuming a
rotating refresh token concurrently. Do not copy, publish, or commit that file.

## Browser sign-in fallback

Most setup attempts begin with the email/password form. If Resideo's hosted
page requires a verification, terms, or another interactive step:

1. Start browser sign-in in the plugin settings.
2. Open the displayed link. In that same desktop browser tab, open
   **Developer Tools → Network** and enable **Preserve log** before signing in.
3. Complete sign-in normally.
4. Copy the failed request's full **Request URL** starting with
   `com.honeywell.acs.lyric.enterprise://oauth2redirect`. The browser may display
   it in the Console instead. It cannot launch the Android app on a desktop;
   this is expected.
5. Paste that full URL into **Complete sign-in** in the plugin settings.

Both `oauth2redirect?` and `oauth2redirect/?` are accepted. The URL is checked
against the random state and PKCE verifier of the current attempt. A malformed
callback does not change your current link; if the code was rejected by Resideo,
start a new browser sign-in. An attempt expires locally after 15 minutes.
The callback contains a one-time authorization code; do not share it.

The UI provides an advanced legacy app refresh-token import. This is optional;
developer API, Home Assistant public Honeywell API, and First Alert tokens are
not interchangeable with this public mobile client.

## Command-line sign-in

For installations without the Homebridge UI, run from an interactive terminal
as the same operating-system user as Homebridge. Use your actual storage path:

```sh
resideo-native-login --storage /var/lib/homebridge --country RO
```

Use `--browser` for browser sign-in, `--token` to import a legacy app refresh
token, or `--test` for read-only discovery with saved authorization. Passwords,
tokens, and callback URLs are prompted without echo; they are not accepted as
command-line arguments. A successful sign-in only performs read-only account
discovery, then saves tokens. Add the platform block and restart Homebridge.

## Connection behavior

- One shared account poll covers all thermostats every **60 seconds** by default
  (configurable **30–600 seconds**). There is no SignalR push implementation.
- Commands and polling use one serial queue. Each command is followed by a
  server readback. Rapid temperature/automatic-range changes are combined over
  300 ms, avoiding half-updated ranges and excessive slider traffic.
- A 401 renews authorization once and retries once. A permanently rejected
  authorization pauses cloud polling until a new authorization is saved.
- A 429 honors the server's `Retry-After` interval. Network/5xx failures do not
  automatically replay thermostat writes.
- Offline/removed devices become unavailable. Temporary discovery failures or
  empty responses do not delete cached accessories or HomeKit room assignments.
- Explicit exclusions remove only the selected thermostat from Homebridge.
  Successful sign-in to a different account replaces accessories after restart.
- Debug logs contain discovery counts, never passwords, tokens, native callback
  URLs, API response bodies, or raw account data.

The plugin requires internet access and a working Resideo cloud account.
“Native” refers to the mobile-app protocol; this is cloud control.

## Compatibility and validation

This implements the legacy Resideo / Honeywell Home / CHAPI backend used by
the supplied integration and European Jasper/T6 accounts. It does not implement
First Alert Auth0/Titan, Total Connect Comfort, or Total Connect security.

The original integration reported successful live browser sign-in and discovery
on a European Jasper/T6. This JavaScript port has been verified against a local
HTTP protocol simulator and actual Homebridge APIs; **physical thermostat
commands and this plugin's sign-in against your live account still need testing**.
Do not interpret simulated protocol tests as a claim of hardware verification.
See [docs/VALIDATION.md](docs/VALIDATION.md).

## Development and publication

```sh
npm ci
npm run build
npm test
npm pack
```

`build` checks runnable source; it does not generate an omitted `dist` directory.
`npm pack` runs the source checks and tests before producing the installable
archive. Its explicit `files` list includes the executable plugin, all runtime
modules, CLI, custom settings UI, and configuration schema.

To run additional tests against an installed Homebridge, set the absolute module
path (the directory containing that Homebridge package's `package.json`):

```sh
HOMEBRIDGE_TEST_PATH=/path/to/node_modules/homebridge npm test
```

The GitHub workflow runs the suite against Homebridge 1.11.4 and 2.4.0 on Node
22/24/26. Publish the **source directory's complete contents** to
`Kosztyk/homebridge-resideo-native`, then use your npm account:

```sh
npm login
npm publish --access public
```

The intended repository metadata is included; creating the repository or npm
publication is a separate action. Do not replace `package.json` with a minimal
placeholder: it must retain `main`, `files`, `dependencies`, the Homebridge
engine range, and the `homebridge-plugin` keyword.

## Protocol provenance

Based on the user-supplied MIT-licensed Resideo Native 0.1.2 integration by
Kosztyk, recovered from Resideo Android 6.21.1. No APK, decompiled app code, user
credentials, or real thermostat/account identifiers are included. Public app
identifiers are retained for the same legacy protocol.

Homebridge implementation references:
[plugin template](https://github.com/homebridge/homebridge-plugin-template),
[custom UI API](https://github.com/homebridge/plugin-ui-utils), and
[HomeKit characteristic reference](https://developers.homebridge.io/HAP-NodeJS/classes/Characteristic.html).

MIT License. Independent community plugin; not affiliated with Resideo,
Honeywell, Apple, or Homebridge.
