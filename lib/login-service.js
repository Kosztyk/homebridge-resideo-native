'use strict';

const { TokenStore } = require('./token-store');
const { ResideoAuth, countryCode } = require('./auth');
const { NativeClient } = require('./client');
const { InteractionRequired, InvalidCallback, InvalidResponse, CannotConnect } = require('./errors');

class LoginService {
  constructor(storagePath, { store, authFactory, clientFactory } = {}) {
    this.store = store || new TokenStore(storagePath);
    this.authFactory = authFactory || (options => new ResideoAuth(options));
    this.clientFactory = clientFactory || (auth => new NativeClient(auth));
    this.auth = this.authFactory({});
    this.authorization = null; this.busy = false;
  }
  async exclusive(operation) {
    if (this.busy) throw new CannotConnect('A sign-in operation is already running. Wait for it to finish.');
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }
  async status() {
    const record = await this.store.read();
    return { signedIn: Boolean(record), expiresAt: record?.token.expires_at || null };
  }
  startBrowser(country = 'RO') {
    this.authorization = this.auth.newAuthorization(countryCode(country));
    return { browserRequired: true, url: this.authorization.url };
  }
  async finish(auth) {
    const client = this.clientFactory(auth);
    const devices = await client.update();
    if (!devices.size) throw new InvalidResponse('Sign-in succeeded, but no compatible legacy Resideo thermostats were found. First Alert/Titan and Total Connect accounts are not supported.');
    // Do not replace a working authorization until sign-in AND discovery pass.
    await this.store.withLock(() => this.store.write({ accountId: client.accountId, token: auth.token }));
    this.authorization = null;
    return { signedIn: true, devices: [...devices.values()].map(d => ({ id: d.id, name: d.name, model: d.model, online: d.online })) };
  }
  login({ username, password, country = 'RO' } = {}) {
    return this.exclusive(async () => {
      try { await this.auth.login(username, password, country); }
      catch (error) { if (error instanceof InteractionRequired) return this.startBrowser(country); throw error; }
      return this.finish(this.auth);
    });
  }
  callback({ redirectUrl } = {}) {
    return this.exclusive(async () => {
      if (!this.authorization) throw new InvalidCallback('Start browser sign-in first.');
      try { await this.auth.exchangeCallback(redirectUrl, this.authorization); }
      catch (error) {
        if (!(error instanceof InvalidCallback)) this.authorization = null;
        throw error;
      }
      this.authorization = null;
      return this.finish(this.auth);
    });
  }
  importToken({ refreshToken } = {}) {
    return this.exclusive(async () => { await this.auth.importRefreshToken(refreshToken); return this.finish(this.auth); });
  }
  testConnection() {
    return this.exclusive(async () => {
      const auth = this.authFactory({ store: this.store });
      const client = this.clientFactory(auth);
      const devices = await client.update();
      return { signedIn: true, devices: [...devices.values()].map(d => ({ id: d.id, name: d.name, model: d.model, online: d.online })) };
    });
  }
}
module.exports = { LoginService };
