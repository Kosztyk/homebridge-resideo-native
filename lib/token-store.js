'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AuthenticationError, CannotConnect } = require('./errors');

function validateToken(token) {
  if (!token || typeof token.access_token !== 'string' || !token.access_token ||
      typeof token.refresh_token !== 'string' || !token.refresh_token ||
      typeof token.expires_at !== 'number' || !Number.isFinite(token.expires_at)) {
    throw new AuthenticationError('Stored Resideo authorization is incomplete. Sign in again in the plugin settings.');
  }
  return { access_token: token.access_token, refresh_token: token.refresh_token, expires_at: token.expires_at };
}

class TokenStore {
  constructor(storagePath) {
    if (!storagePath || !path.isAbsolute(storagePath)) throw new CannotConnect('The Homebridge storage path is unavailable.');
    this.directory = path.join(storagePath, 'resideo-native');
    this.file = path.join(this.directory, 'authorization.json');
    this.lock = path.join(this.directory, 'authorization.lock');
  }
  async read() {
    try {
      const record = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (record.version !== 1 || typeof record.accountId !== 'string' || !record.accountId) throw new AuthenticationError();
      return { version: 1, accountId: record.accountId, token: validateToken(record.token) };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error instanceof AuthenticationError) throw error;
      throw new AuthenticationError('Cannot read stored Resideo authorization. Check storage permissions or sign in again.');
    }
  }
  async write(record) {
    const token = validateToken(record.token);
    if (!record.accountId || typeof record.accountId !== 'string') throw new AuthenticationError();
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.directory, `.authorization-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, accountId: record.accountId, token }), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, this.file);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async withLock(operation) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 60000;
    let handle;
    while (!handle) {
      try {
        handle = await fs.open(this.lock, 'wx', 0o600);
        try { await handle.writeFile(String(process.pid)); }
        catch (error) { await handle.close(); await fs.unlink(this.lock).catch(() => {}); handle = null; throw error; }
      } catch (error) {
        if (error.code !== 'EEXIST') throw new CannotConnect('Cannot access Resideo authorization storage. Check filesystem permissions.');
        // Recover only a dead process's lock, never steal a live refresh.
        try {
          const pid = Number(await fs.readFile(this.lock, 'utf8'));
          const stat = await fs.stat(this.lock);
          let dead = false;
          if (Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); } catch (e) { dead = e.code === 'ESRCH'; }
          } else { dead = Date.now() - stat.mtimeMs > 120000; }
          if (dead) { await fs.unlink(this.lock); continue; }
        } catch { /* Another owner may have just released the lock. */ }
        if (Date.now() >= deadline) throw new CannotConnect('Resideo authorization is busy. Wait a moment and try again.');
        await new Promise(resolve => setTimeout(resolve, 75));
      }
    }
    try { return await operation(); }
    finally { await handle.close(); await fs.unlink(this.lock).catch(() => {}); }
  }
}
module.exports = { TokenStore, validateToken };
