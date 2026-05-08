#!/usr/bin/env node
'use strict';

/*
Fixes a syntax typo seen in index-v3.8.6-stable-mobile-table.html:
  [.body.querySelectorAll(...)]
should be:
  [...body.querySelectorAll(...)]

Run from repo root:
  node tools/fix-index-v386-syntax.js frontend/index.html
*/

const fs = require('fs');
const file = process.argv[2] || 'frontend/index.html';
if (!fs.existsSync(file)) {
  console.error(`[fix-index-v386-syntax] file not found: ${file}`);
  process.exit(1);
}
let src = fs.readFileSync(file, 'utf8');
const before = src;
src = src.replace(/\[\.body\.querySelectorAll/g, '[...body.querySelectorAll');
if (src !== before) {
  fs.writeFileSync(file, src);
  console.log(`[fix-index-v386-syntax] patched ${file}`);
} else {
  console.log(`[fix-index-v386-syntax] no syntax typo found in ${file}`);
}
