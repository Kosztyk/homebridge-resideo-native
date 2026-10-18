'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const Ajv = require('ajv');

async function setup(t, handler, existing = []) {
  const calls = []; let blocks = structuredClone(existing); let schemaShown = false;
  const html = fs.readFileSync(path.join(__dirname, '../homebridge-ui/public/index.html'), 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'http://localhost/plugin/settings',
    beforeParse(window) {
      window.homebridge = {
        getPluginConfig: async () => structuredClone(blocks),
        updatePluginConfig: async value => { blocks = structuredClone(value); },
        showSchemaForm: () => { schemaShown = true; }, disableSaveButton() {}, enableSaveButton() {},
        request: async (route, payload) => { calls.push({ route, payload }); return handler(route, payload); },
      };
    },
  });
  t.after(() => dom.window.close());
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
  await settle();
  return { dom, calls, settle, el: id => dom.window.document.getElementById(id), getBlocks: () => blocks, schemaShown: () => schemaShown,
    submit: id => dom.window.document.getElementById(id).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
  };
}

test('fresh settings generate a working platform block with no blank device or credential fields', async t => {
  const ui = await setup(t, () => ({ signedIn: false }));
  const config = ui.getBlocks()[0];
  assert.equal(config.platform, 'ResideoNative'); assert.deepEqual(config.devices, []);
  assert.equal('username' in config, false); assert.equal('password' in config, false);
  assert.equal(ui.schemaShown(), true);
});

test('sign-in uses the selected country, clears the password, and escapes discovered device names', async t => {
  const device = { id: 'test', name: '<img src=x onerror=alert(1)>', model: 'Jasper', online: true };
  const ui = await setup(t, route => route === '/status' ? { signedIn: false } : { signedIn: true, devices: [device] }, [{ platform: 'ResideoNative', country: 'DE', _bridge: { username: 'AA:BB:CC:DD:EE:FF' } }]);
  ui.el('username').value = 'private@example.test'; ui.el('password').value = 'one-time-password';
  ui.submit('login-form'); await ui.settle();
  const request = ui.calls.find(c => c.route === '/login');
  assert.equal(request.payload.country, 'DE'); assert.equal(request.payload.password, 'one-time-password');
  assert.equal(ui.el('password').value, ''); assert.equal(ui.el('devices').querySelector('img'), null);
  assert.match(ui.el('devices').textContent, /<img/);
  assert.equal(JSON.stringify(ui.getBlocks()).includes('one-time-password'), false);
  assert.deepEqual(ui.getBlocks()[0]._bridge, { username: 'AA:BB:CC:DD:EE:FF' });
});

test('interactive fallback shows the browser link and retains it after a local callback error', async t => {
  const url = 'https://lyricprod.b2clogin.com/lyricprod.onmicrosoft.com/oauth2/v2.0/authorize?state=test';
  const ui = await setup(t, route => {
    if (route === '/status') return { signedIn: false };
    if (route === '/login') return { browserRequired: true, url };
    if (route === '/callback') throw Object.assign(new Error('Use the current sign-in attempt.'), { error: { code: 'invalid_callback' } });
  });
  ui.el('username').value = 'test@example.test'; ui.el('password').value = 'test'; ui.submit('login-form'); await ui.settle();
  assert.equal(ui.el('browser-details').open, true); assert.equal(ui.el('login-link').href, url);
  ui.el('callback').value = 'bad-url'; ui.submit('callback-form'); await ui.settle();
  assert.equal(ui.el('browser-flow').hidden, false); assert.equal(ui.el('login-link').href, url);
  assert.equal(ui.el('callback').value, '');
});

function standardSchema(schema) {
  const value = structuredClone(schema);
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.properties) {
      const required = [];
      for (const [key, child] of Object.entries(node.properties)) {
        if (child.required === true) { required.push(key); delete child.required; }
        visit(child);
      }
      if (required.length) node.required = required;
    }
    if (node.items) visit(node.items);
  }
  visit(value); return value;
}

test('schema-generated defaults validate, while a device override needs an explicit ID', () => {
  const schema = require('../config.schema.json'); const config = require('../config.example.json');
  const validate = new Ajv({ strict: false }).compile(standardSchema(schema.schema));
  assert.equal(validate(config), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...config, devices: [{ exclude: false }] }), false);
  assert.equal(validate({ ...config, devices: [{ id: 'T6-test', exclude: false }] }), true);
});
