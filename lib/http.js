'use strict';

const { CannotConnect, InvalidResponse } = require('./errors');

function retrySeconds(value, now = Date.now()) {
  const seconds = value == null || value === '' ? 60 : Number(value);
  if (Number.isFinite(seconds)) return Math.max(1, seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1, (date - now) / 1000) : 60;
}

// Short-lived jar for one B2C origin. Cookies never reach the device API.
class LoginCookies {
  constructor(origin) { this.origin = origin; this.cookies = new Map(); }
  receive(url, headers) {
    const u = new URL(url);
    if (u.origin !== this.origin) return;
    for (const line of headers.getSetCookie()) {
      const [first, ...attributes] = line.split(';');
      const i = first.indexOf('=');
      if (i < 1) continue;
      const cookie = { name: first.slice(0, i).trim(), value: first.slice(i + 1).trim(), path: u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1) || '/', secure: false };
      let permitted = true;
      for (const attribute of attributes) {
        const [key, ...valueParts] = attribute.trim().split('=');
        const value = valueParts.join('=');
        if (key.toLowerCase() === 'path' && value.startsWith('/')) cookie.path = value;
        if (key.toLowerCase() === 'domain') {
          const domain = value.replace(/^\./, '').toLowerCase();
          if (u.hostname !== domain && !u.hostname.endsWith(`.${domain}`)) permitted = false;
        }
        if (key.toLowerCase() === 'secure') cookie.secure = true;
        if (key.toLowerCase() === 'max-age' && Number.isFinite(Number(value))) cookie.expires = Date.now() + Number(value) * 1000;
        if (key.toLowerCase() === 'expires' && cookie.expires === undefined) cookie.expires = Date.parse(value);
      }
      if (permitted) this.cookies.set(`${cookie.path}|${cookie.name}`, cookie);
    }
  }
  header(url) {
    const u = new URL(url);
    if (u.origin !== this.origin) return '';
    return [...this.cookies.values()].filter(c =>
      (c.expires === undefined || !Number.isFinite(c.expires) || c.expires > Date.now()) && (!c.secure || u.protocol === 'https:') &&
      (u.pathname === c.path || u.pathname.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`)),
    ).sort((a, b) => b.path.length - a.path.length).map(c => `${c.name}=${c.value}`).join('; ');
  }
}

async function request(method, url, { headers = {}, form, json, cookies, timeout = 45000 } = {}) {
  const allHeaders = { ...headers };
  if (cookies?.header(url)) allHeaders.Cookie = cookies.header(url);
  let body;
  if (form) { body = new URLSearchParams(form).toString(); allHeaders['Content-Type'] = 'application/x-www-form-urlencoded'; }
  if (json !== undefined) { body = JSON.stringify(json); allHeaders['Content-Type'] = 'application/json; charset=utf-8'; }
  try {
    const response = await fetch(url, { method, headers: allHeaders, body, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    cookies?.receive(url, response.headers);
    // Bound response memory, including sign-in HTML and large accounts.
    const reader = response.body?.getReader();
    const chunks = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new InvalidResponse('Resideo returned an oversized response.'); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
    }
    return { status: response.status, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') };
  } catch (error) {
    if (error instanceof InvalidResponse) throw error;
    throw new CannotConnect(method === 'GET' ? 'Cannot reach Resideo.' : 'Cannot reach Resideo; command delivery may be unknown. The request was not replayed.');
  }
}

module.exports = { request, retrySeconds, LoginCookies };
