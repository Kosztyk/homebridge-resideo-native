'use strict';

const { ResideoAuth } = require('../lib/auth');
const { TokenStore } = require('../lib/token-store');
const auth = new ResideoAuth({ store: new TokenStore(process.argv[2]), authority: process.argv[3] });
auth.accessToken().then(() => {
  process.send({ success: true, expiresAt: auth.token.expires_at }); process.disconnect();
}, () => { process.send({ success: false }); process.disconnect(); process.exitCode = 1; });
