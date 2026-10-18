'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Script } = require('node:vm');
const root = path.join(__dirname, '..');
function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const p = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(p) : [p];
  });
}
const files = ['index.js', 'lib', 'bin', 'homebridge-ui', 'test', 'tools'].flatMap(name => {
  const p = path.join(root, name); return fs.statSync(p).isDirectory() ? walk(p) : [p];
});
for (const file of files.filter(name => name.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(1); }
}
for (const name of ['package.json', 'package-lock.json', 'config.schema.json', 'config.example.json']) JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const html = fs.readFileSync(path.join(root, 'homebridge-ui/public/index.html'), 'utf8');
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new Script(match[1]);
const pkg = require('../package.json');
if (!pkg.keywords.includes('homebridge-plugin') || !fs.existsSync(path.join(root, pkg.main))) throw new Error('Invalid Homebridge package metadata.');
for (const required of ['README.md', 'LICENSE', 'homebridge-ui/server.js', 'lib/platform.js', 'bin/login.js']) if (!fs.existsSync(path.join(root, required))) throw new Error(`Missing release file: ${required}`);
console.log('JavaScript syntax, settings script, JSON, and required package files checked.');
