#!/usr/bin/env node
'use strict';

const { archiveStore } = require('../lib/store');
const result = archiveStore(true);
console.log(JSON.stringify({ ok: true, fresh: true, ...result }, null, 2));
