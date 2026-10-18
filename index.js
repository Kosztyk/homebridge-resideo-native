'use strict';

const { ResideoPlatform } = require('./lib/platform');
const { PLUGIN_NAME, PLATFORM_NAME } = require('./lib/constants');

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, ResideoPlatform);
};
