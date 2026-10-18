#!/usr/bin/env node
'use strict';

const readline = require('node:readline/promises');
const { Writable } = require('node:stream');
const path = require('node:path');
const os = require('node:os');
const { LoginService } = require('../lib/login-service');
const { safeMessage, InvalidResponse } = require('../lib/errors');

async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Resideo Native one-time sign-in\n\nresideo-native-login [--storage /var/lib/homebridge] [--country RO] [--browser | --token | --test]\n\nRun as the same OS user as Homebridge. Passwords/tokens are prompted without echo.\nNo credentials are accepted as command-line arguments.');
    return;
  }
  const options = { storage: path.join(os.homedir(), '.homebridge'), country: 'RO' };
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (['--storage', '--country'].includes(option) && args[i + 1] && !args[i + 1].startsWith('--')) options[option.slice(2)] = args[++i];
    else if (['--browser', '--token', '--test'].includes(option)) options[option.slice(2)] = true;
    else throw new InvalidResponse('Invalid arguments. Run resideo-native-login --help for usage.');
  }
  if ([options.browser, options.token, options.test].filter(Boolean).length > 1) throw new InvalidResponse('Choose only one of --browser, --token, or --test.');
  if (!process.stdin.isTTY && !options.test) { console.error('Use an interactive terminal to sign in, or use the Homebridge plugin settings.'); process.exitCode = 1; return; }
  const service = new LoginService(path.resolve(options.storage));
  if (options.test) { print(await service.testConnection()); return; }
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  const secret = async prompt => {
    process.stdout.write(prompt); muted = true;
    try { return await rl.question(''); } finally { muted = false; process.stdout.write('\n'); }
  };
  try {
    let result;
    if (options.token) result = await service.importToken({ refreshToken: await secret('Legacy app refresh token: ') });
    else if (options.browser) result = service.startBrowser(options.country);
    else result = await service.login({ username: await rl.question('Resideo email: '), password: await secret('Resideo password: '), country: options.country });
    if (result.browserRequired) {
      console.log(`\nOpen this URL in your desktop browser:\n${result.url}\n\nIn that tab, open Developer Tools → Network, enable Preserve log, then sign in.\nCopy the failed com.honeywell.acs.lyric.enterprise://oauth2redirect request URL.\n`);
      result = await service.callback({ redirectUrl: await secret('Full callback URL: ') });
    }
    print(result);
    console.log('Authorization saved. Save the ResideoNative platform configuration and restart Homebridge.');
  } finally { rl.close(); }
}
function print(result) {
  console.log(`Connected. Found ${result.devices?.length || 0} thermostat(s).`);
  for (const device of result.devices || []) console.log(`${device.name} | ${device.model} | ${device.id} | ${device.online ? 'online' : 'offline'}`);
}
if (require.main === module) main().catch(error => { console.error(safeMessage(error)); process.exitCode = 1; });
module.exports = { main };
