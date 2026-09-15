'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const files=['v4Brain.js','executionParity.js','paperOrderLifecycle.js','marketPermission.js','rejectedObservations.js','patch24Identity.js'];
const sourceHashes=Object.fromEntries(files.map(file=>[file,hash(fs.readFileSync(path.join(__dirname,file)))]));
module.exports={patchVersion:'PATCH-2.4',sourceHashes,sourceHash:hash(JSON.stringify(sourceHashes)),configHash:settings=>hash(JSON.stringify(settings))};
