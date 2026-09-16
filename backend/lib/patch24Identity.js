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
const sourceHashes=Object.fromEntries(Object.entries(files).map(([name,file])=>{
  const target=path.join(__dirname,file);
  // The frontend is deployed as a separate service in production and is outside
  // Northflank's /backend Docker build context. Missing sibling frontend files
  // must not prevent the backend from booting. Backend/runtime files remain strict.
  if(!fs.existsSync(target)){
    if(name.startsWith('frontend/')) return [name,'SEPARATE_FRONTEND_NOT_IN_BACKEND_IMAGE'];
    throw new Error(`Required Patch 2.4.1 source file missing: ${name} (${target})`);
  }
  return [name,hash(fs.readFileSync(target))];
}));
module.exports={patchVersion:'PATCH-2.4.2',sourceHashes,sourceHash:hash(JSON.stringify(sourceHashes)),configHash:settings=>hash(JSON.stringify(settings))};
