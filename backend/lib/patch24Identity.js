'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const files={
  'lib/v4Brain.js':'v4Brain.js',
  'lib/executionParity.js':'executionParity.js',
  'lib/paperOrderLifecycle.js':'paperOrderLifecycle.js',
  'lib/marketPermission.js':'marketPermission.js',
  'lib/rejectedObservations.js':'rejectedObservations.js',
  'lib/patch24Identity.js':'patch24Identity.js',
  'routes/v4.js':'../routes/v4.js',
  'routes/journal.js':'../routes/journal.js',
  'frontend/index.html':'../../frontend/index.html',
  'frontend/orayan-v4-hotfix.js':'../../frontend/orayan-v4-hotfix.js'
};
const sourceHashes=Object.fromEntries(Object.entries(files).map(([name,file])=>[name,hash(fs.readFileSync(path.join(__dirname,file)))]));
module.exports={patchVersion:'PATCH-2.4.1',sourceHashes,sourceHash:hash(JSON.stringify(sourceHashes)),configHash:settings=>hash(JSON.stringify(settings))};
