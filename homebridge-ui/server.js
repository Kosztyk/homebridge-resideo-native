'use strict';

const { LoginService } = require('../lib/login-service');
const { safeMessage } = require('../lib/errors');

// plugin-ui-utils 2.x is ESM. Dynamic import also works with Node 22 LTS.
async function start() {
  const { HomebridgePluginUiServer, RequestError } = await import('@homebridge/plugin-ui-utils');
  class ResideoUiServer extends HomebridgePluginUiServer {
    constructor() {
      super();
      this.loginService = new LoginService(this.homebridgeStoragePath);
      const handle = (route, operation) => this.onRequest(route, async payload => {
        try { return await operation(payload || {}); }
        catch (error) { throw new RequestError(safeMessage(error), { code: error.code || 'unexpected_error' }); }
      });
      handle('/status', () => this.loginService.status());
      handle('/login', data => this.loginService.login(data));
      handle('/browser', data => this.loginService.exclusive(() => this.loginService.startBrowser(data.country)));
      handle('/callback', data => this.loginService.callback(data));
      handle('/refresh-token', data => this.loginService.importToken(data));
      handle('/test', () => this.loginService.testConnection());
      this.ready();
    }
  }
  return new ResideoUiServer();
}
if (require.main === module) start().catch(() => { console.error('Resideo settings could not start. Check the Homebridge UI version and storage permissions.'); process.exitCode = 1; });
module.exports = { start };
