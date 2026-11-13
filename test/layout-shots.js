'use strict';

// Screenshots of the real page in headless Chrome (no window), to look at a layout:
//   node test/layout-shots.js <directory> [schema[@WIDTHxHEIGHT]…]
// The schemas are those of layout-corpus.js (default: rental shop star50 heights40). Each is
// opened through a share link, which lays it out and fits it to the window (not below 25 %).
// CHROME names the browser if it is not where macOS or Linux usually has it.
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib'), { execFileSync } = require('child_process');
const corpus = require('./layout-corpus')(require('./layout-load')().EXAMPLES);
const chrome = process.env.CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find(p => fs.existsSync(p));
const [dir, ...wanted] = process.argv.slice(2);
if (!dir || !chrome) {
  console.error(chrome ? 'usage: node test/layout-shots.js <directory> [schema[@WIDTHxHEIGHT]…]' : 'Chrome not found: set CHROME');
  process.exit(1);
}
fs.mkdirSync(dir, { recursive: true });
for (const want of wanted.length ? wanted : ['rental', 'shop', 'star50', 'heights40']) {
  const [name, size = '1500x1000'] = want.split('@'), schema = corpus.find(s => s.name === name);
  if (!schema) { console.error(`no schema ${name}: ${corpus.map(s => s.name).join(' ')}`); process.exit(1); }
  const link = zlib.deflateRawSync(JSON.stringify({ n: name, m: 'text', s: schema.text })).toString('base64url');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlviz-shot-')), out = path.resolve(dir, name + '.png');
  execFileSync(chrome, ['--headless=new', `--user-data-dir=${profile}`, `--window-size=${size.replace('x', ',')}`, '--hide-scrollbars',
    '--virtual-time-budget=8000', `--screenshot=${out}`, `file://${path.resolve(__dirname, '../index.html')}#d=${link}`], { stdio: 'ignore' });
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(out);
}
