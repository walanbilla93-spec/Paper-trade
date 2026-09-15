'use strict';
// Independent research store: no imports of order, sizing, strategy or accounting code.
const store=require('./store'), crypto=require('crypto');
const SCHEMA='REJECTED_OPPORTUNITY_2.4', HORIZONS=[5,15,30,60,120,240], TOLERANCE_MS=10000, CAP=2000;
const clone=x=>JSON.parse(JSON.stringify(x));
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0,24);
const finite=x=>x!=null && Number.isFinite(Number(x)) ? Number(x) : null;
let state;
function load(){return state||(state=store.read('v4_rejected_observations',{schema:SCHEMA,rows:[],health:{dropped:0,writeFailures:0,invalidSamples:0}}));}
function enabled(){return process.env.V4_OBSERVATIONS_ENABLED!=='false';}
function save(){try{store.write('v4_rejected_observations',load());load().health.lastPersistedAt=Date.now();}catch(e){load().health.writeFailures++;load().health.lastError=e.message;}}
function safely(fn){if(!enabled())return;try{return fn();}catch(e){load().health.lastError=e.message;}}
function norm(v,r,atr,reference=null){return {price:v,pct:reference>0?100*v/reference:null,originalR:r>0?v/r:null,atr:atr>0?v/atr:null};}
function register(s,type,reason,at=Date.now(),market={}){return safely(()=>{
  const data=load(), plan=s.originalObservationPlan||s.plan||s;
  const originalPlan={entry:finite(plan.entry),sl:finite(plan.sl),tp:finite(plan.tp1),atr:finite(s.planner?.keyLevels?.atr ?? s.atr)};
  const symbol=s.sym||s.symbol, side=s.side;
  if(!symbol||!['BUY','SELL'].includes(side))return;
  const planVersion=hash([symbol,side,originalPlan]);
  const candidateId=s.id||`scanner_${hash([symbol,side,originalPlan,reason])}`;
  const key=hash([candidateId,planVersion]);
  let row=data.rows.find(x=>x.id===key);
  if(!row){
    if(data.rows.length>=CAP){data.health.dropped++;return;}
    row={id:key,schema:SCHEMA,recordType:'COUNTERFACTUAL_PRICE_PATH',accountingEligible:false,candidateId,planVersion,symbol,side,originalPlan,anchors:[],actualTradeLinked:null};
    data.rows.push(row);
  }
  let anchor=row.anchors.find(a=>a.type===type && a.reason===reason);
  if(anchor){if(anchor.lastSeenAt!==at){anchor.count++;anchor.lastSeenAt=at;}return row.id;}
  if(row.anchors.length>=32){data.health.dropped++;row.anchorOverflow=true;return row.id;}
  const sourceAt=finite(market.sourceAt ?? s.lastPriceSourceAt), receivedAt=finite(market.receivedAt ?? s.lastPriceReceivedAt);
  const raw=finite(market.lastPrice ?? s.backendLastPrice ?? s.price);
  const valid=raw>0 && sourceAt>0 && sourceAt<=at && at-sourceAt<=30000 && receivedAt>=sourceAt && receivedAt<=at;
  const price=valid?raw:null;
  const buy=side==='BUY',tp=originalPlan.tp,sl=originalPlan.sl;
  const alreadyTp=price!=null && tp>0 && (buy?price>=tp:price<=tp), alreadySl=price!=null && sl>0 && (buy?price<=sl:price>=sl);
  anchor={id:hash([key,type,reason,at]),type,reason,count:1,at,lastSeenAt:at,
    reference:{price,kind:'LAST',sourceAt,receivedAt,source:market.priceSource||'REST_TICKER',status:valid?'SAMPLED':'MISSING'},
    decisionSnapshot:{runtime:s.observationContext||null,score:s.score,scoreAdmission:s.scoreAdmission||null,marketPermission:s.marketPermission||null,timing:s.entryTiming||null,timingDiagnostics:s.timingDiagnostics||null,missedMove:s.missedMoveDiagnostics||null,reasons:s.rejectReasons||[reason]},
    horizons:HORIZONS.map(minutes=>({minutes,targetAt:at+minutes*60000,status:'PENDING'})),
    observationState:'RUNNING',coverage:{status:'PARTIAL',convention:'SAMPLED_LAST_PRICE_LOWER_BOUNDS',samples:0,gaps:0,lastSourceAt:null},
    mfe:{...norm(0,0,0),at:null},mae:{...norm(0,0,0),at:null},planMfe:{...norm(0,0,0),at:null},planMae:{...norm(0,0,0),at:null},
    levels:{atAnchor:alreadyTp||alreadySl?'ALREADY_BEYOND_AT_ANCHOR':price==null?'UNKNOWN':'BETWEEN_LEVELS',alreadyTp,alreadySl,tpAt:null,slAt:null,firstObservedHit:null,firstHit:'INSUFFICIENT_COVERAGE'},entryRevisitAt:null};
  if(price==null){anchor.mfe=null;anchor.mae=null;}
  row.anchors.push(anchor);save();return row.id;
});}
function capture(a){return clone({mfe:a.mfe,mae:a.mae,planMfe:a.planMfe,planMae:a.planMae,levels:a.levels,coverage:a.coverage});}
function observe(priceMap,now=Date.now()){return safely(()=>{
  const data=load();
  for(const row of data.rows){
    const m=priceMap.get(row.symbol)||{},p=finite(m.lastPrice),t=finite(m.sourceAt),received=finite(m.receivedAt);
    const valid=p>0 && t>0 && t<=now && now-t<=30000 && received>=t && received<=now;
    const d=row.side==='BUY'?1:-1,plan=row.originalPlan,r=plan.entry>0&&plan.sl>0?Math.abs(plan.entry-plan.sl):null,atr=plan.atr;
    for(const a of row.anchors){
      if(a.observationState!=='RUNNING')continue;
      // Mature overdue horizons before considering later prices; never borrow future extrema.
      for(const h of a.horizons)if(h.status==='PENDING' && now>h.targetAt+TOLERANCE_MS && (!valid||t>h.targetAt+TOLERANCE_MS))Object.assign(h,capture(a),{status:'MISSING',price:null,actualAt:null});
      if(valid && t>a.at && t>(a.coverage.lastSourceAt||a.at) && t<=a.at+240*60000+TOLERANCE_MS){
        const beforeSample=capture(a);
        const previous=a.coverage.lastSourceAt||a.at;
        if(t-previous>TOLERANCE_MS)a.coverage.gaps++;
        a.coverage.lastSourceAt=t;a.coverage.samples++;
        const update=(key,v)=>{if(a[key] && v>a[key].price)a[key]={...norm(v,r,atr,key.startsWith('plan')?plan.entry:a.reference.price),at:t};};
        // Extrema stop at 4h; endpoint tolerance applies only to the horizon price.
        if(t<=a.at+240*60000){
          if(a.reference.price!=null){const move=d*(p-a.reference.price);update('mfe',Math.max(0,move));update('mae',Math.max(0,-move));}
          if(plan.entry>0){const move=d*(p-plan.entry);update('planMfe',Math.max(0,move));update('planMae',Math.max(0,-move));}
          const tpHit=plan.tp>0 && (d===1?p>=plan.tp:p<=plan.tp),slHit=plan.sl>0 && (d===1?p<=plan.sl:p>=plan.sl);
          if(tpHit&&!a.levels.alreadyTp&&!a.levels.tpAt){a.levels.tpAt=t;a.levels.firstObservedHit ||= 'TP_FIRST';}
          if(slHit&&!a.levels.alreadySl&&!a.levels.slAt){a.levels.slAt=t;a.levels.firstObservedHit ||= 'SL_FIRST';}
          if(!a.entryRevisitAt && plan.entry>0 && (d===1?p<=plan.entry:p>=plan.entry))a.entryRevisitAt=t;
        }
        for(const h of a.horizons)if(h.status==='PENDING' && t>=h.targetAt && t<=h.targetAt+TOLERANCE_MS){
          Object.assign(h,t===h.targetAt?capture(a):beforeSample,{status:'PARTIAL',price:p,actualAt:t,receivedAt:received,latenessMs:t-h.targetAt,
            move:a.reference.price!=null?norm(d*(p-a.reference.price),r,atr,a.reference.price):null});
        }
      }
      if(a.horizons.every(h=>h.status!=='PENDING')){a.observationState='CENSORED';a.terminalAt=now;a.censorReason='SAMPLED_STREAM_NOT_CONTINUOUS';}
      if(a.reference.price==null){a.mfe=null;a.mae=null;}
    }
  }
  save();
});}
function link(s){return safely(()=>{for(const r of load().rows)if(r.candidateId===s.id)r.actualTradeLinked={signalId:s.id,intentId:s.executionPosition?.intent?.intentId||null,tradeId:s.tradeId||null,at:s.openedAt||null};});}
function snapshot(){return clone({...load(),enabled:enabled(),horizonsMinutes:HORIZONS,toleranceMs:TOLERANCE_MS,capacity:CAP});}
module.exports={SCHEMA,register,observe,link,snapshot,flush:()=>safely(save)};
