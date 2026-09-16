'use strict';
// Patch 2.4.2 compact rejected-opportunity research store.
// One bounded summary row per candidate/plan. No sampled price arrays, repeated runtime snapshots,
// anchor arrays, or six nested horizon snapshots. This store is research-only and never accounting eligible.
const store=require('./store'), crypto=require('crypto');
const SCHEMA='REJECTED_OPPORTUNITY_COMPACT_2.4.2';
const CAP=Math.max(5000,Number(process.env.V4_OBSERVATION_CAP||'20000'));
const RETENTION_MS=Math.max(24*3600000,Number(process.env.V4_OBSERVATION_RETENTION_MS||String(7*24*3600000)));
const MAX_OBSERVE_MS=4*60*60000;
const SAVE_THROTTLE_MS=Math.max(5000,Number(process.env.V4_OBSERVATION_SAVE_MS||'30000'));
const clone=x=>JSON.parse(JSON.stringify(x));
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0,24);
const finite=x=>x!=null&&Number.isFinite(Number(x))?Number(x):null;
let state,lastSavedAt=0,dirty=false;
function freshHealth(extra={}){return {dropped:0,writeFailures:0,invalidSamples:0,evictedCompleted:0,compactedRegistrations:0,...extra};}
function migrate(raw){
  if(raw?.schema===SCHEMA&&Array.isArray(raw.rows))return {...raw,health:freshHealth(raw.health||{})};
  // Do not inflate a new compact epoch by translating the old verbose 2.4.1 objects.
  return {schema:SCHEMA,rows:[],health:freshHealth({migratedAt:Date.now(),previousSchema:raw?.schema||null,previousRows:Array.isArray(raw?.rows)?raw.rows.length:0})};
}
function load(){if(state)return state;state=migrate(store.read('v4_rejected_observations',{schema:SCHEMA,rows:[],health:{}}));return state;}
function enabled(){return process.env.V4_OBSERVATIONS_ENABLED!=='false';}
function save(force=false){
  if(!dirty&&!force)return;
  const now=Date.now();if(!force&&now-lastSavedAt<SAVE_THROTTLE_MS)return;
  try{load().health.lastPersistedAt=now;store.write('v4_rejected_observations',load());lastSavedAt=now;dirty=false;}
  catch(e){load().health.writeFailures++;load().health.lastError=e.message;}
}
function safely(fn){if(!enabled())return;try{return fn();}catch(e){load().health.lastError=e.message;dirty=true;}}
function terminal(r){return !!r.terminalAt;}
function prune(now=Date.now()){
  const d=load();
  let before=d.rows.length;
  d.rows=d.rows.filter(r=>!terminal(r)||now-r.terminalAt<=RETENTION_MS);
  d.health.evictedCompleted+=before-d.rows.length;
  while(d.rows.length>=CAP){
    let idx=-1,old=Infinity;
    for(let i=0;i<d.rows.length;i++){const r=d.rows[i];if(!terminal(r))continue;const t=r.terminalAt||r.lastDecisionAt||r.firstDecisionAt||0;if(t<old){old=t;idx=i;}}
    if(idx<0){d.health.dropped++;d.health.lastDropReason='CAPACITY_ALL_ROWS_RUNNING';return false;}
    d.rows.splice(idx,1);d.health.evictedCompleted++;
  }
  return true;
}
function planOf(s){const p=s.originalObservationPlan||s.plan||s;return {entry:finite(p.entry??s.plannedEntry),sl:finite(p.sl),tp:finite(p.tp1??p.tp),atr:finite(s.planner?.keyLevels?.atr??s.atr)};}
function register(s,type,reason,at=Date.now(),market={}){return safely(()=>{
  const d=load(),plan=planOf(s),symbol=s.sym||s.symbol,side=String(s.side||'').toUpperCase();
  if(!symbol||!['BUY','SELL'].includes(side))return;
  const candidateId=s.id||`scanner_${hash([symbol,side,plan])}`,planVersion=hash([symbol,side,plan]),id=hash([candidateId,planVersion]);
  let r=d.rows.find(x=>x.id===id);
  if(!r){if(!prune(at))return;r={id,schema:SCHEMA,recordType:'CANDIDATE_FORENSIC_SUMMARY',accountingEligible:false,candidateId,planVersion,symbol,side,entry:plan.entry,sl:plan.sl,tp:plan.tp,atr:plan.atr,score:finite(s.score),breadthPct:finite(s.marketPermission?.breadthPct),permission:s.marketPermission?.reason||s.marketPermission?.policy||null,firstDecisionAt:at,lastDecisionAt:at,decisionType:type,finalReason:String(reason||''),decisionCount:0,referencePrice:null,referenceSourceAt:null,birthPrice:finite(s.priceAtBirth??s.price),birthDistanceAtr:null,missedDistanceAtr:null,latency:s.forensicTiming||null,entryRevisitAt:null,tpAt:null,slAt:null,firstHit:null,mfeR:null,maeR:null,samples:0,lastSourceAt:null,terminalAt:null,actualTradeLinked:null};d.rows.push(r);}
  r.decisionCount++;r.lastDecisionAt=at;r.decisionType=type;r.finalReason=String(reason||'');
  if(s.forensicTiming)r.latency={...(r.latency||{}),...s.forensicTiming};
  if(type==='ORDER_WITHHELD'&&String(reason)==='MISSED_MOVE_LIVE_PARITY')r.intentAt=at;
  const src=finite(market.sourceAt??s.lastPriceSourceAt),recv=finite(market.receivedAt??s.lastPriceReceivedAt),px=finite(market.lastPrice??s.backendLastPrice??s.price);
  if(px>0&&src>0&&src<=at&&at-src<=30000&&recv>=src&&recv<=at){if(r.referencePrice==null){r.referencePrice=px;r.referenceSourceAt=src;}if(plan.atr>0&&plan.entry>0){const dist=Math.abs(px-plan.entry)/plan.atr;if(type==='ORDER_WITHHELD'&&String(reason)==='MISSED_MOVE_LIVE_PARITY')r.missedDistanceAtr=dist;}}
  if(plan.atr>0&&plan.entry>0&&r.birthPrice>0)r.birthDistanceAtr=Math.abs(r.birthPrice-plan.entry)/plan.atr;
  d.health.compactedRegistrations++;dirty=true;save(true);return id;
});}
function observe(priceMap,now=Date.now()){return safely(()=>{
  const d=load();let changed=false;
  for(const r of d.rows){if(r.terminalAt)continue;if(now>=r.firstDecisionAt+MAX_OBSERVE_MS){r.terminalAt=now;r.terminalReason='FOUR_HOUR_WINDOW_COMPLETE';changed=true;continue;}const m=priceMap.get(r.symbol)||{},p=finite(m.lastPrice),t=finite(m.sourceAt),recv=finite(m.receivedAt);if(!(p>0&&t>0&&t<=now&&now-t<=30000&&recv>=t&&recv<=now)){d.health.invalidSamples++;continue;}if(t<=r.firstDecisionAt||t<=(r.lastSourceAt||0))continue;
    r.lastSourceAt=t;r.samples++;changed=true;const dir=r.side==='BUY'?1:-1,R=r.entry>0&&r.sl>0?Math.abs(r.entry-r.sl):null;
    if(R>0&&r.entry>0){const mv=dir*(p-r.entry)/R;r.mfeR=r.mfeR==null?Math.max(0,mv):Math.max(r.mfeR,mv);r.maeR=r.maeR==null?Math.max(0,-mv):Math.max(r.maeR,-mv);}
    if(!r.entryRevisitAt&&r.entry>0&&(dir===1?p<=r.entry:p>=r.entry))r.entryRevisitAt=t;
    if(!r.tpAt&&r.tp>0&&(dir===1?p>=r.tp:p<=r.tp))r.tpAt=t;
    if(!r.slAt&&r.sl>0&&(dir===1?p<=r.sl:p>=r.sl))r.slAt=t;
    if(!r.firstHit){if(r.tpAt&&r.slAt)r.firstHit=r.tpAt<=r.slAt?'TP_FIRST':'SL_FIRST';else if(r.tpAt)r.firstHit='TP_FIRST';else if(r.slAt)r.firstHit='SL_FIRST';}
    if(t>=r.firstDecisionAt+MAX_OBSERVE_MS){r.terminalAt=t;r.terminalReason='FOUR_HOUR_WINDOW_COMPLETE';}
  }
  if(changed){dirty=true;prune(now);save(false);}return changed;
});}
function link(s){return safely(()=>{let changed=false;for(const r of load().rows)if(r.candidateId===s.id){r.actualTradeLinked={signalId:s.id,intentId:s.executionPosition?.intent?.intentId||null,tradeId:s.tradeId||null,at:s.openedAt||null};changed=true;}if(changed){dirty=true;save(true);}});}
function snapshot(){save(true);return clone({...load(),enabled:enabled(),capacity:CAP,retentionMs:RETENTION_MS,maxObserveMs:MAX_OBSERVE_MS,format:'ONE_COMPACT_ROW_PER_CANDIDATE'});}
function clearResearchHistory(reason='MANUAL_RESEARCH_RESET'){const now=Date.now(),prev=load(),n=prev.rows.length;state={schema:SCHEMA,rows:[],health:freshHealth({resetAt:now,resetReason:String(reason),previousRows:n})};dirty=true;save(true);const disk=store.read('v4_rejected_observations',null);if(!disk||!Array.isArray(disk.rows)||disk.rows.length)throw new Error('RESEARCH_HISTORY_CLEAR_DURABILITY_VERIFY_FAILED');return {ok:true,cleared:n,total:0,resetAt:now,reason:String(reason)};}
module.exports={SCHEMA,register,observe,link,snapshot,clearResearchHistory,flush:()=>save(true),_resetForTests:()=>{state=undefined;dirty=false;lastSavedAt=0;}};
