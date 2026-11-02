// Inlines styles.css and the scripts into single-file pages:
//   dist/index.html  a full document, for any static host
//   dist/dipin.html  the same page without the document skeleton, for a claude.ai artifact
// Usage: node build.js
const fs = require('fs');
const path = require('path');

const here = __dirname;
const read = (f) => fs.readFileSync(path.join(here, f), 'utf8');

let html = read('index.html');
html = html.replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${read('styles.css')}</style>`);
html = html.replace(/<script src="([\w./-]+\.js)"><\/script>/g, (_, file) => `<script>\n${read(file)}</script>`);

const out = path.join(here, 'dist');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), html);

const head = html.match(/<head>([\s\S]*?)<\/head>/)[1]
  .replace(/<meta charset[^>]*>\s*/, '')
  .replace(/<meta name="viewport"[^>]*>\s*/, '');
const body = html.match(/<body>([\s\S]*)<\/body>/)[1];
fs.writeFileSync(path.join(out, 'dipin.html'), `${head.trim()}\n${body.trim()}\n`);

console.log(`dist/index.html ${(html.length / 1024).toFixed(1)} KB, dist/dipin.html written`);
