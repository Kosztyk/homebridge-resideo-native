'use strict';

const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const C = require('./constants');
const { request, retrySeconds, LoginCookies } = require('./http');
const { validateToken } = require('./token-store');
const { AuthenticationError, InteractionRequired, InvalidCallback, InvalidResponse, CannotConnect, RateLimited } = require('./errors');

function countryCode(value = 'RO') {
  if (typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value.trim())) throw new InvalidResponse('Use a two-letter country code, for example RO.');
  return value.trim().toUpperCase();
}
function isNativeCallback(url) {
  return url.protocol === 'com.honeywell.acs.lyric.enterprise:' && url.host === 'oauth2redirect' &&
    !url.username && !url.password && ['', '/'].includes(url.pathname) && !url.hash;
}
function readSettings(page) {
  const match = /\bvar\s+SETTINGS\s*=\s*/.exec(page);
  if (!match) throw new InteractionRequired();
  const tail = page.slice(match.index + match[0].length).trimStart();
  let depth = 0; let quoted = false; let escaped = false; let end = -1;
  if (tail[0] !== '{') throw new InteractionRequired();
  for (let i = 0; i < tail.length; i++) {
    const c = tail[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { end = i + 1; break; }
  }
  try {
    const settings = JSON.parse(tail.slice(0, end));
    if (typeof settings.csrf !== 'string' || !settings.csrf || typeof settings.transId !== 'string' ||
        settings.api !== 'CombinedSigninAndSignup' || typeof settings.hosts?.tenant !== 'string' ||
        !/^\/lyricprod\.onmicrosoft\.com\/[A-Za-z0-9_/-]+$/.test(settings.hosts.tenant) ||
        typeof settings.hosts.policy !== 'string' || settings.hosts.policy.toLowerCase() !== C.POLICY) throw new Error();
    return settings;
  } catch { throw new InteractionRequired(); }
}

class ResideoAuth {
  constructor({ store, token, authority = C.AUTHORITY, http = request } = {}) {
    this.store = store;
    this.token = token ? validateToken(token) : null;
    this.authority = authority;
    this.http = http;
    this.retryAt = 0;
    this.accountId = null;
    this.queue = Promise.resolve();
  }
  newAuthorization(country = 'RO') {
    const verifier = randomBytes(64).toString('base64url');
    const state = randomBytes(24).toString('base64url');
    const params = new URLSearchParams({
      p: C.POLICY, client_id: C.CLIENT_ID, redirect_uri: C.REDIRECT_URI, scope: C.SCOPE,
      response_type: 'code', state, nonce: randomBytes(16).toString('base64url'),
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      ui_locales: 'en-US', country: countryCode(country), enableContractor: 'false', prompt: 'login',
    });
    return { url: `${this.authority}/oauth2/v2.0/authorize?${params}`, verifier, state, createdAt: Date.now() };
  }
  async authRequest(method, url, options = {}) {
    if (this.retryAt > Date.now()) throw new RateLimited((this.retryAt - Date.now()) / 1000);
    const response = await this.http(method, url, { ...options, headers: { 'User-Agent': C.USER_AGENT, ...options.headers } });
    if (response.status === 429) {
      const pause = retrySeconds(response.headers.get('retry-after'));
      this.retryAt = Date.now() + pause * 1000;
      throw new RateLimited(pause);
    }
    if (response.status >= 500) throw new CannotConnect('Resideo sign-in is temporarily unavailable.');
    return response;
  }
  assertAuthOrigin(url) {
    if (url.origin !== new URL(this.authority).origin || url.username || url.password) {
      throw new InvalidResponse('Unexpected redirect during Resideo sign-in.');
    }
  }
  async followPage(url, cookies) {
    for (let count = 0; count < 8; count++) {
      this.assertAuthOrigin(new URL(url));
      const response = await this.authRequest('GET', url, { cookies });
      if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.get('location')) {
        url = new URL(response.headers.get('location'), url).href;
      } else return response;
    }
    throw new InteractionRequired();
  }
  async login(username, password, country = 'RO') {
    if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
      throw new AuthenticationError('Enter your Resideo email address and password.');
    }
    const authorization = this.newAuthorization(country);
    const origin = new URL(this.authority).origin;
    const cookies = new LoginCookies(origin);
    const page = await this.followPage(authorization.url, cookies);
    const settings = readSettings(page.text);
    const base = origin + settings.hosts.tenant;
    const params = new URLSearchParams({ tx: settings.transId, p: settings.hosts.policy });
    const response = await this.authRequest('POST', `${base}/SelfAsserted?${params}`, {
      cookies, headers: { 'X-CSRF-TOKEN': settings.csrf, Referer: authorization.url },
      form: { request_type: 'RESPONSE', signInName: username.trim(), password },
    });
    let result;
    try { result = JSON.parse(response.text); } catch { throw new InteractionRequired(); }
    if (response.status !== 200 || !result || String(result.status) !== '200') {
      if (/verification|captcha|multifactor|multi-factor|verify|eula|consent/i.test(String(result?.message || ''))) throw new InteractionRequired();
      throw new AuthenticationError('Resideo rejected sign-in. Check your account in the official Resideo app.');
    }
    params.set('csrf_token', settings.csrf); params.set('rememberMe', 'false');
    let url = `${base}/api/CombinedSigninAndSignup/confirmed?${params}`;
    for (let count = 0; count < 8; count++) {
      const parsed = new URL(url);
      if (isNativeCallback(parsed)) return this.exchangeCallback(url, authorization);
      this.assertAuthOrigin(parsed);
      const next = await this.authRequest('GET', url, { cookies });
      if (![301, 302, 303, 307, 308].includes(next.status) || !next.headers.get('location')) throw new InteractionRequired();
      url = new URL(next.headers.get('location'), url).href;
    }
    throw new InteractionRequired();
  }
  async exchangeCallback(callback, authorization) {
    if (!authorization || Date.now() - authorization.createdAt > 15 * 60 * 1000) {
      throw new InvalidCallback('This sign-in attempt expired. Start browser sign-in again.');
    }
    let parsed;
    try { parsed = new URL(String(callback).trim()); } catch { throw new InvalidCallback(); }
    if (!isNativeCallback(parsed) || [...parsed.searchParams].length > 20) throw new InvalidCallback();
    const state = parsed.searchParams.getAll('state');
    const code = parsed.searchParams.getAll('code');
    const expected = Buffer.from(authorization.state);
    const received = Buffer.from(state[0] || '');
    if (state.length !== 1 || expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new InvalidCallback('This callback belongs to a different sign-in attempt. Use the current sign-in link.');
    }
    if (parsed.searchParams.has('error')) throw new AuthenticationError('Resideo did not authorize sign-in. Start again.');
    if (code.length !== 1 || !code[0]) throw new InvalidCallback();
    return this.tokenRequest({ grant_type: 'authorization_code', code: code[0], code_verifier: authorization.verifier });
  }
  async importRefreshToken(refreshToken) {
    if (typeof refreshToken !== 'string' || !refreshToken.trim()) throw new AuthenticationError('Enter a legacy Resideo app refresh token.');
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken.trim() });
  }
  async tokenRequest(grant) {
    const response = await this.authRequest('POST', `${this.authority}/oauth2/v2.0/token?p=${C.POLICY}`, {
      form: { client_id: C.CLIENT_ID, redirect_uri: C.REDIRECT_URI, scope: C.SCOPE, ...grant },
    });
    let data;
    try { data = JSON.parse(response.text); } catch { throw new InvalidResponse('Resideo returned an invalid token response.'); }
    if ([400, 401, 403].includes(response.status) || data?.error) {
      if (['temporarily_unavailable', 'server_error'].includes(data?.error)) throw new CannotConnect('Resideo sign-in is temporarily unavailable.');
      throw new AuthenticationError('Resideo authorization expired or was rejected. Sign in again.');
    }
    if (response.status !== 200 || !data || typeof data !== 'object') throw new CannotConnect('Resideo token request failed.');
    const lifetime = Number(data.expires_in);
    if (!Number.isFinite(lifetime) || lifetime <= 0) throw new InvalidResponse('Resideo did not return a valid token expiry.');
    const token = validateToken({ access_token: data.access_token, refresh_token: data.refresh_token || grant.refresh_token, expires_at: Date.now() / 1000 + lifetime });
    this.token = token;
    return token;
  }
  accessToken(rejectedToken) {
    const operation = async () => {
      const run = async () => {
        let record;
        if (this.store) {
          record = await this.store.read();
          if (!record) throw new AuthenticationError();
          if (this.accountId && record.accountId !== this.accountId) throw new AuthenticationError('The Resideo account changed. Restart Homebridge to load the new account.');
          this.accountId = record.accountId;
          this.token = record.token;
        }
        if (!this.token) throw new AuthenticationError();
        // Another pending request may already have refreshed this rejected token.
        if (rejectedToken !== undefined && this.token.access_token !== rejectedToken && this.token.expires_at > Date.now() / 1000 + 120) return this.token.access_token;
        if (rejectedToken !== undefined || this.token.expires_at <= Date.now() / 1000 + 120) {
          await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.token.refresh_token });
          if (this.store) await this.store.write({ accountId: record.accountId, token: this.token });
        }
        return this.token.access_token;
      };
      return this.store ? this.store.withLock(run) : run();
    };
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }
}
module.exports = { ResideoAuth, readSettings, isNativeCallback, countryCode };
