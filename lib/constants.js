'use strict';

module.exports = Object.freeze({
  PLUGIN_NAME: 'homebridge-resideo-native',
  PLATFORM_NAME: 'ResideoNative',
  AUTHORITY: 'https://lyricprod.b2clogin.com/lyricprod.onmicrosoft.com',
  CLIENT_ID: 'd7baddb4-d9f3-4575-af28-f1b04a7883f2',
  POLICY: 'b2c_1a_signin_mob_hh',
  REDIRECT_URI: 'com.honeywell.acs.lyric.enterprise://oauth2redirect',
  SCOPE: 'https://lyricprod.onmicrosoft.com/CHILAPIService/user_impersonation profile email openid offline_access',
  BASE_URL: 'https://lyric.alarmnet.com/',
  // Public identifier bundled with Resideo Android 6.21.1, not a user secret.
  APP_SUBSCRIPTION: '8c9485374bab4b1aa4b3555ac2f032c4',
  USER_AGENT: 'Lyric/6.21.1(Homebridge;Android 10)',
  HOLDS: ['NoHold', 'TemporaryHold', 'PermanentHold'],
});
