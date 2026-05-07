from pathlib import Path
p=Path('/mnt/data/orayan-v3-work')
# Patch backend config
cfg=p/'backend/lib/config.js'
s=cfg.read_text()
s=s.replace("version: '2.0.0-safe-testnet'", "confirmLiveTrading: parseBool(process.env.CONFIRM_LIVE_TRADING, false),\n  version: '3.0.0-frontend-settings'")
s=s.replace("out.tradingEnabled = !!out.tradingEnabled;\n  out.testnet = out.botMode === 'LIVE_REAL_BYBIT' ? false : true;", "out.tradingEnabled = !!out.tradingEnabled;\n  const allowedModes = ['PAPER_REAL_PRICE','TESTNET_BYBIT_PRICE','LIVE_REAL_BYBIT'];\n  if(!allowedModes.includes(out.botMode)) out.botMode = DEFAULTS.botMode;\n  if(out.botMode === 'LIVE_REAL_BYBIT' && !DEFAULTS.confirmLiveTrading){\n    out.botMode = 'PAPER_REAL_PRICE';\n    out.tradingEnabled = false;\n    out.liveBlockedReason = 'LIVE_REAL_BYBIT requires CONFIRM_LIVE_TRADING=true on the backend host.';\n  }\n  out.testnet = out.botMode === 'LIVE_REAL_BYBIT' ? false : true;")
cfg.write_text(s)

bot=p/'backend/routes/bot.js'
s=bot.read_text()
insert="""
router.get('/settings', auth, (req, res) => {
  res.json({
    ok: true,
    settings: getSettings(),
    editable: [
      'botMode','tradingEnabled','orderType','marketOrdersOnTestnet',
      'maxTradeUsdt','leverage','maxOpenTrades','minScoreToTrade',
      'cooldownMinutes','pendingTimeoutMinutes','defaultRiskPct',
      'defaultRewardPct','useSignalTpSlPercent'
    ],
    secretKeys: {
      bybitApiKey: keySet(),
      bybitApiSecret: keySet(),
      note: 'API keys are never returned to the frontend. Keep them in Northflank env variables.'
    }
  });
});

"""
s=s.replace("router.get('/logs', auth, (req, res) => {", insert+"router.get('/logs', auth, (req, res) => {")
bot.write_text(s)

# Patch frontend HTML
html=p/'frontend/index.html'
s=html.read_text()
# add bot settings section before save button
marker='''    </div>\n    <!-- /AUTO-TRADER -->\n\n    <button class="panel-btn save" onclick="saveSettings()">💾 SAVE & TEST TELEGRAM</button>'''
section=r'''    </div>
    <!-- /AUTO-TRADER -->

    <!-- BACKEND BOT SETTINGS SECTION -->
    <div style="border-top:1px solid var(--border);padding-top:14px;margin-top:12px">
      <div class="settings-label" style="color:var(--green);font-size:11px;letter-spacing:1px;margin-bottom:10px">🧠 BACKEND BOT SETTINGS</div>
      <div class="settings-hint" style="margin-bottom:8px;color:var(--dim)">These are saved to the backend. API keys are not stored here.</div>

      <div class="settings-row">
        <div class="settings-label">BOT MODE</div>
        <select class="settings-input" id="botModeSelect">
          <option value="PAPER_REAL_PRICE">Paper trading · real prices · no Bybit orders</option>
          <option value="TESTNET_BYBIT_PRICE">Bybit testnet · testnet prices · fake funds</option>
          <option value="LIVE_REAL_BYBIT">LIVE Bybit · real money</option>
        </select>
        <div class="settings-hint" style="color:var(--orange)">LIVE mode is blocked unless CONFIRM_LIVE_TRADING=true is set in backend env.</div>
      </div>

      <div class="settings-row">
        <div class="settings-label">TRADING ENABLED</div>
        <select class="settings-input" id="botTradingEnabled">
          <option value="false">OFF · dashboard only</option>
          <option value="true">ON · allow backend to execute</option>
        </select>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div class="settings-row">
          <div class="settings-label">MAX TRADE USDT</div>
          <input class="settings-input" id="botMaxTradeUsdt" type="number" min="1" max="1000" step="1" value="10">
        </div>
        <div class="settings-row">
          <div class="settings-label">LEVERAGE</div>
          <input class="settings-input" id="botLeverage" type="number" min="1" max="25" step="1" value="3">
        </div>
        <div class="settings-row">
          <div class="settings-label">MAX OPEN TRADES</div>
          <input class="settings-input" id="botMaxOpenTrades" type="number" min="1" max="50" step="1" value="10">
        </div>
        <div class="settings-row">
          <div class="settings-label">MIN SCORE TO TRADE</div>
          <input class="settings-input" id="botMinScore" type="number" min="0" max="100" step="1" value="55">
        </div>
        <div class="settings-row">
          <div class="settings-label">COOLDOWN MINUTES</div>
          <input class="settings-input" id="botCooldownMinutes" type="number" min="0" max="1440" step="1" value="30">
        </div>
        <div class="settings-row">
          <div class="settings-label">PENDING TIMEOUT MIN</div>
          <input class="settings-input" id="botPendingTimeoutMinutes" type="number" min="5" max="1440" step="1" value="360">
        </div>
      </div>

      <div class="settings-row">
        <div class="settings-label">ORDER TYPE</div>
        <select class="settings-input" id="botOrderType">
          <option value="Market">Market</option>
          <option value="Limit">Limit</option>
        </select>
        <div class="settings-hint">For testnet, Market is recommended because testnet prices differ from real prices.</div>
      </div>

      <div class="settings-row">
        <div class="settings-label">MARKET ORDERS ON TESTNET</div>
        <select class="settings-input" id="botMarketOrdersOnTestnet">
          <option value="true">ON · force market orders on testnet</option>
          <option value="false">OFF · use configured order type</option>
        </select>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <button onclick="loadBotSettingsFromBackend(true)" style="flex:1;font-family:'Share Tech Mono',monospace;font-size:10px;padding:9px;border-radius:5px;border:1px solid var(--border2);background:var(--bg3);color:var(--dim);cursor:pointer">⬇ Load Backend Settings</button>
        <button onclick="saveBotSettingsToBackendFromUI()" style="flex:1;font-family:'Share Tech Mono',monospace;font-size:10px;padding:9px;border-radius:5px;border:1px solid rgba(0,255,136,0.35);background:rgba(0,255,136,0.07);color:var(--green);cursor:pointer">💾 Save Bot Settings</button>
      </div>
      <div id="botSettingsSaveMsg" style="font-family:'Share Tech Mono',monospace;font-size:9px;color:var(--dim);margin-top:6px;min-height:14px"></div>
    </div>

    <button class="panel-btn save" onclick="saveSettings()">💾 SAVE LOCAL SETTINGS</button>'''
if marker not in s:
    raise SystemExit('marker not found')
s=s.replace(marker, section)
# Remove API key fields? Instead add warning and hide values? Replace hint to mention env-only and disable inputs.
s=s.replace('''          <input class="settings-input" id="bybitApiKey" type="password" placeholder="Testnet API Key...">''','''          <input class="settings-input" id="bybitApiKey" type="password" placeholder="API keys are backend env only" disabled>''')
s=s.replace('''          <input class="settings-input" id="bybitApiSecret" type="password" placeholder="Testnet API Secret...">''','''          <input class="settings-input" id="bybitApiSecret" type="password" placeholder="API secret is backend env only" disabled>''')
s=s.replace('Northflank backend server ට API keys save කරනවා. Browser නැතිව server side execute කරනවා.','API keys are not saved from the frontend. Keep BYBIT_API_KEY and BYBIT_API_SECRET only in Northflank backend environment variables.')
# Init settings defaults add bot ui cache
s=s.replace("autoTradeBackendUrl: ORAYAN_DEFAULT_BACKEND_URL\n  }, compact", "autoTradeBackendUrl: ORAYAN_DEFAULT_BACKEND_URL,\n    botMode:'PAPER_REAL_PRICE', botMaxTradeUsdt:10, botLeverage:3, botMinScoreToTrade:55, botCooldownMinutes:30\n  }, compact")
# openSettings: after updateAutoTradeUI(); add loadBotSettingsFromBackend false
s=s.replace("  updateAutoTradeUI();\n  updateAiProviderHint();", "  updateAutoTradeUI();\n  fillBotSettingsUI(ST.botStatus?.settings || ST.settings);\n  loadBotSettingsFromBackend(false);\n  updateAiProviderHint();")
# saveSettings: prevent API key local save
s=s.replace("  if(atKey) ST.settings.bybitApiKey    = atKey.value.trim();\n  if(atSec) ST.settings.bybitApiSecret = atSec.value.trim();", "  // API keys are intentionally NOT saved from frontend. Keep them in backend env only.\n  if(atKey) ST.settings.bybitApiKey    = '';\n  if(atSec) ST.settings.bybitApiSecret = '';")
# Add functions before fetchBotStatus
funcs=r'''
function botSettingsMsg(msg, color='var(--dim)'){
  const el=document.getElementById('botSettingsSaveMsg');
  if(el){ el.textContent=msg; el.style.color=color; }
}
function fillBotSettingsUI(settings){
  if(!settings) return;
  const set=(id,val)=>{ const el=document.getElementById(id); if(el && val!==undefined && val!==null) el.value=String(val); };
  set('botModeSelect', settings.botMode || 'PAPER_REAL_PRICE');
  set('botTradingEnabled', !!(settings.tradingEnabled ?? ST.settings.autoTradeEnabled));
  set('botMaxTradeUsdt', settings.maxTradeUsdt ?? ST.settings.botMaxTradeUsdt ?? 10);
  set('botLeverage', settings.leverage ?? ST.settings.botLeverage ?? 3);
  set('botMaxOpenTrades', settings.maxOpenTrades ?? ST.settings.autoTradeMaxOpen ?? 10);
  set('botMinScore', settings.minScoreToTrade ?? ST.settings.botMinScoreToTrade ?? 55);
  set('botCooldownMinutes', settings.cooldownMinutes ?? ST.settings.botCooldownMinutes ?? 30);
  set('botPendingTimeoutMinutes', settings.pendingTimeoutMinutes ?? 360);
  set('botOrderType', settings.orderType || 'Market');
  set('botMarketOrdersOnTestnet', settings.marketOrdersOnTestnet !== false);
  if(settings.liveBlockedReason) botSettingsMsg('LIVE blocked: ' + settings.liveBlockedReason, 'var(--orange)');
}
function readBotSettingsUI(){
  const val=id=>document.getElementById(id)?.value;
  return {
    botMode: val('botModeSelect') || 'PAPER_REAL_PRICE',
    tradingEnabled: val('botTradingEnabled') === 'true',
    maxTradeUsdt: Number(val('botMaxTradeUsdt') || 10),
    leverage: Number(val('botLeverage') || 3),
    maxOpenTrades: Number(val('botMaxOpenTrades') || 10),
    minScoreToTrade: Number(val('botMinScore') || 55),
    cooldownMinutes: Number(val('botCooldownMinutes') || 30),
    pendingTimeoutMinutes: Number(val('botPendingTimeoutMinutes') || 360),
    orderType: val('botOrderType') || 'Market',
    marketOrdersOnTestnet: val('botMarketOrdersOnTestnet') !== 'false'
  };
}
async function loadBotSettingsFromBackend(showMsg=false){
  const url=getATBackendUrl();
  if(!url){ if(showMsg) botSettingsMsg('Backend URL missing.', 'var(--orange)'); return null; }
  try{
    if(showMsg) botSettingsMsg('Loading backend bot settings...', 'var(--yellow)');
    const resp=await fetch(url + '/bot/settings', {headers: buildBackendGetHeaders(), signal: AbortSignal.timeout(8000)});
    const data=await resp.json();
    if(!data.ok) throw new Error(data.error || 'load failed');
    ST.botStatus = {...(ST.botStatus||{}), settings:data.settings};
    fillBotSettingsUI(data.settings);
    if(showMsg) botSettingsMsg('Loaded backend settings ✓', 'var(--green)');
    return data.settings;
  }catch(e){ if(showMsg) botSettingsMsg('Load failed: ' + e.message, 'var(--red)'); return null; }
}
async function saveBotSettingsToBackendFromUI(){
  const url=getATBackendUrl();
  if(!url){ botSettingsMsg('Backend URL missing.', 'var(--orange)'); return null; }
  const patch=readBotSettingsUI();
  if(patch.botMode==='LIVE_REAL_BYBIT'){
    const ok=confirm('LIVE_REAL_BYBIT uses real money. It will still be blocked unless backend CONFIRM_LIVE_TRADING=true. Continue saving this mode?');
    if(!ok) return null;
  }
  try{
    botSettingsMsg('Saving backend bot settings...', 'var(--yellow)');
    const resp=await fetch(url + '/bot/settings', {method:'POST', headers: buildBackendHeaders(), body:JSON.stringify(patch), signal: AbortSignal.timeout(8000)});
    const data=await resp.json();
    if(!data.ok) throw new Error(data.error || 'save failed');
    ST.botStatus = {...(ST.botStatus||{}), settings:data.settings};
    ST.settings.autoTradeEnabled = !!data.settings.tradingEnabled;
    ST.settings.bybitTestnet = data.settings.testnet !== false;
    ST.settings.autoTradeMaxOpen = data.settings.maxOpenTrades || ST.settings.autoTradeMaxOpen;
    fillBotSettingsUI(data.settings);
    updateAutoTradeUI();
    botSettingsMsg('Saved to backend ✓', 'var(--green)');
    await fetchBotStatus().catch(()=>null);
    return data.settings;
  }catch(e){ botSettingsMsg('Save failed: ' + e.message, 'var(--red)'); return null; }
}
'''
s=s.replace("async function fetchBotStatus(){", funcs+"\nasync function fetchBotStatus(){")
# update fetchBotStatus to store more settings and fill if open
s=s.replace("        ST.settings.autoTradeMaxOpen = data.settings.maxOpenTrades || ST.settings.autoTradeMaxOpen;\n      }\n      updateAutoTradeUI();", "        ST.settings.autoTradeMaxOpen = data.settings.maxOpenTrades || ST.settings.autoTradeMaxOpen;\n        ST.settings.botMode = data.settings.botMode;\n        ST.settings.botMaxTradeUsdt = data.settings.maxTradeUsdt;\n        ST.settings.botLeverage = data.settings.leverage;\n        if(document.getElementById('settingsPanel')?.classList.contains('open')) fillBotSettingsUI(data.settings);\n      }\n      updateAutoTradeUI();")
# pushBotSettingsToBackend currently? ensure uses UI maybe grep
html.write_text(s)
