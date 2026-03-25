import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

// ─── Storage ───
async function load(key, fb) {
  try { const r = await window.storage.get(key); return r ? JSON.parse(r.value) : fb; } catch { return fb; }
}
async function save(key, d) {
  try { await window.storage.set(key, JSON.stringify(d)); } catch {}
}

// ─── EODHD API ───
// Docs: https://eodhd.com/financial-apis/
// Symbol format: {TICKER}.{EXCHANGE_CODE}  —  AU for ASX, US for NYSE/NASDAQ
// Free plan: 20 API calls/day. $19.99/mo plan: unlimited EOD + live delayed for all exchanges.
// ASX data sourced directly from ASX under contract.
const EODHD_BASE = "https://eodhd.com/api";
const EODHD_EX = { ASX: "AU", NYSE: "US", NASDAQ: "US" };

async function eodhFetch(path, apiKey) {
  if (!apiKey) return null;
  const sep = path.includes("?") ? "&" : "?";
  const url = `${EODHD_BASE}${path}${sep}api_token=${apiKey}&fmt=json`;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      console.warn(`EODHD ${r.status}: ${path}`);
      return null;
    }
    const text = await r.text();
    try { return JSON.parse(text); }
    catch { console.warn("EODHD non-JSON response:", path, text.slice(0, 200)); return null; }
  } catch (e) { console.warn("EODHD fetch error:", path, e.message); return null; }
}

// Live (delayed) quote for a single symbol
// Returns: { code, timestamp, open, high, low, close, volume, previousClose, change, change_p }
async function fetchQuoteSingle(ticker, exchange, apiKey) {
  const ex = EODHD_EX[exchange];
  return eodhFetch(`/real-time/${ticker}.${ex}`, apiKey);
}

// Batch fetch quotes — parallelise in groups of 5 to stay within rate limits
async function fetchQuotes(symbols, apiKey, exchange) {
  if (!apiKey || symbols.length === 0) return {};
  const ex = EODHD_EX[exchange] || "US";
  const results = {};
  const batchSize = 5;
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const promises = batch.map(async (ticker) => {
      const d = await eodhFetch(`/real-time/${ticker}.${ex}`, apiKey);
      if (d && d.close && !d.error) results[ticker] = d;
    });
    await Promise.allSettled(promises);
    if (i + batchSize < symbols.length) await new Promise(r => setTimeout(r, 600));
  }
  return results;
}

// EOD Bulk — all tickers for an exchange in 1 call (paid plans)
// GET /eod-bulk-last-day/{EX}?api_token=KEY&fmt=json
async function fetchBulkEOD(exchange, apiKey) {
  const ex = EODHD_EX[exchange];
  const d = await eodhFetch(`/eod-bulk-last-day/${ex}`, apiKey);
  if (!Array.isArray(d)) return {};
  const map = {};
  d.forEach(row => { if (row.code) map[row.code] = row; });
  return map;
}

// Exchange symbol list
// GET /exchange-symbol-list/{EX}?api_token=KEY&fmt=json
async function fetchStocksList(exchange, apiKey) {
  const ex = EODHD_EX[exchange];
  const d = await eodhFetch(`/exchange-symbol-list/${ex}`, apiKey);
  return Array.isArray(d) ? d : [];
}

// EOD Historical prices for charting
// GET /eod/{TICKER}.{EX}?from=YYYY-MM-DD&to=YYYY-MM-DD&period=d
// Returns array of: { date, open, high, low, close, adjusted_close, volume }
async function fetchEODHistory(ticker, exchange, apiKey, period = "6m") {
  const ex = EODHD_EX[exchange] || "US";
  const to = new Date();
  const from = new Date();
  const pMap = { "1m": 30, "3m": 90, "6m": 180, "1y": 365, "2y": 730, "5y": 1825 };
  from.setDate(from.getDate() - (pMap[period] || 180));
  const fStr = from.toISOString().split("T")[0];
  const tStr = to.toISOString().split("T")[0];
  const d = await eodhFetch(`/eod/${ticker}.${ex}?from=${fStr}&to=${tStr}&period=d`, apiKey);
  return Array.isArray(d) ? d : [];
}

// Fundamental data — full company profile, financials, valuation
// GET /fundamentals/{TICKER}.{EX}
// Returns: { General: {Name, Sector, Industry, ...}, Highlights: {MarketCapitalization, EBITDA, PERatio, ...}, Valuation: {...}, ... }
async function fetchFundamentals(ticker, exchange, apiKey) {
  const ex = EODHD_EX[exchange] || "US";
  const d = await eodhFetch(`/fundamentals/${ticker}.${ex}`, apiKey);
  return (d && !d.error) ? d : null;
}

// ─── Market Hours ───
function isMarketOpen(exchange) {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;

  if (exchange === "ASX") {
    // ASX: 10:00-16:00 AEST (UTC+10) = 00:00-06:00 UTC
    const aestH = (now.getUTCHours() + 10) % 24;
    return aestH >= 10 && aestH < 16;
  } else {
    // NYSE/NASDAQ: 9:30-16:00 EST (UTC-5) = 14:30-21:00 UTC
    const etH = now.getUTCHours() - 5;
    const etM = now.getUTCMinutes();
    const mins = etH * 60 + etM;
    return mins >= 570 && mins < 960; // 9:30=570, 16:00=960
  }
}

function getMarketStatus(exchange) {
  if (isMarketOpen(exchange)) return { open: true, label: "OPEN", color: "var(--grn)" };
  return { open: false, label: "CLOSED", color: "var(--t3)" };
}

// ─── CSS ───
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg0:#080c14;--bg1:#0f1520;--bg2:#141c2b;--bg2h:#1a2540;--bgi:#0b1019;
  --brd:#1c2842;--brdf:#3b82f6;
  --t1:#e4eaf4;--t2:#8594b2;--t3:#556380;
  --acc:#3b82f6;--acch:#2563eb;--accd:rgba(59,130,246,.1);
  --grn:#22c55e;--grnd:rgba(34,197,94,.1);
  --red:#ef4444;--redd:rgba(239,68,68,.1);
  --amb:#f59e0b;--ambd:rgba(245,158,11,.1);
  --pur:#a78bfa;--purd:rgba(167,139,250,.1);
  --cyn:#22d3ee;--cynd:rgba(34,211,238,.1);
  --r:8px;--rl:12px;
  --f:'Outfit',sans-serif;--m:'IBM Plex Mono',monospace;
}
.app{font-family:var(--f);background:var(--bg0);color:var(--t1);min-height:100vh;display:flex;flex-direction:column}
.tn{display:flex;align-items:center;justify-content:space-between;padding:8px 14px;background:var(--bg1);border-bottom:1px solid var(--brd);position:sticky;top:0;z-index:100;flex-wrap:wrap;gap:6px}
.tn-b{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tn-logo{width:28px;height:28px;background:linear-gradient(135deg,#3b82f6,#22d3ee);border-radius:7px;display:flex;align-items:center;justify-content:center;font-family:var(--m);font-weight:700;font-size:14px;color:#fff;flex-shrink:0}
.tn-t{font-weight:700;font-size:16px;letter-spacing:-.5px}
.tabs{display:flex;gap:1px;background:var(--bg0);border-radius:var(--r);padding:2px}
.tab{display:flex;align-items:center;gap:4px;padding:6px 13px;border-radius:7px;border:none;background:transparent;color:var(--t2);font-family:var(--f);font-size:12px;font-weight:500;cursor:pointer;transition:.15s;white-space:nowrap}
.tab:hover{color:var(--t1);background:var(--bg2)}
.tab.on{color:#fff;background:var(--bg2);box-shadow:0 1px 4px rgba(0,0,0,.3)}
.exc{display:flex;gap:3px;align-items:center;margin-left:6px}
.exc button{display:flex;align-items:center;gap:3px;padding:4px 10px;border-radius:6px;border:1px solid var(--brd);background:transparent;color:var(--t2);font-family:var(--f);font-size:11px;font-weight:500;cursor:pointer;transition:.15s}
.exc button:hover{border-color:var(--t3);color:var(--t1)}
.exc button.on{border-color:var(--acc);background:var(--accd);color:var(--acc);font-weight:600}
.ct{flex:1;padding:14px;max-width:1440px;width:100%;margin:0 auto}
.cd{background:var(--bg2);border:1px solid var(--brd);border-radius:var(--rl);overflow:hidden}
.cdh{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--brd);gap:8px;flex-wrap:wrap}
.cdt{font-weight:600;font-size:13px;letter-spacing:-.2px}
.bg{display:inline-flex;align-items:center;padding:2px 7px;border-radius:99px;font-size:10px;font-weight:600;font-family:var(--m)}
.bg-g{background:var(--grnd);color:var(--grn)}.bg-r{background:var(--redd);color:var(--red)}
.bg-a{background:var(--ambd);color:var(--amb)}.bg-b{background:var(--accd);color:var(--acc)}
.bg-p{background:var(--purd);color:var(--pur)}.bg-c{background:var(--cynd);color:var(--cyn)}
.bn{display:inline-flex;align-items:center;gap:4px;padding:5px 11px;border-radius:var(--r);border:1px solid var(--brd);background:var(--bg2);color:var(--t1);font-family:var(--f);font-size:11px;font-weight:500;cursor:pointer;transition:.15s}
.bn:hover{background:var(--bg2h)}.bn-p{background:var(--acc);border-color:var(--acc);color:#fff}.bn-p:hover{background:var(--acch)}
.bn-s{padding:3px 8px;font-size:10px}
.bi{padding:4px;display:inline-flex;align-items:center;justify-content:center;border-radius:5px;border:none;background:transparent;color:var(--t2);cursor:pointer;font-size:13px}
.bi:hover{background:var(--bg2h);color:var(--t1)}
.inp{padding:6px 10px;border-radius:var(--r);border:1px solid var(--brd);background:var(--bgi);color:var(--t1);font-family:var(--f);font-size:12px;outline:none;transition:border-color .15s;width:100%}
.inp:focus{border-color:var(--brdf)}.inp::placeholder{color:var(--t3)}
select.inp{appearance:none;background-image:url("data:image/svg+xml,%3Csvg width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23556380' stroke-width='2.5' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 8px center;padding-right:28px;cursor:pointer}
.pos{color:var(--grn)}.neg{color:var(--red)}
::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--brd);border-radius:3px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:7px 10px;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.4px;color:var(--t3);border-bottom:1px solid var(--brd);white-space:nowrap;cursor:pointer;user-select:none;transition:.15s}
th:hover{color:var(--t2)}th.so{color:var(--acc)}
td{padding:6px 10px;border-bottom:1px solid var(--brd);white-space:nowrap;font-family:var(--m);font-size:11px}
tr:hover td{background:var(--bg2h)}tr:last-child td{border-bottom:none}
.pl{display:grid;grid-template-columns:200px 1fr;gap:12px}
@media(max-width:768px){.pl{grid-template-columns:1fr}}
.ei{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;cursor:pointer;border-left:3px solid transparent;transition:.15s}
.ei:hover{background:var(--bg2h)}.ei.on{background:var(--bg2h);border-left-color:var(--acc)}
.en{font-weight:500;font-size:12px}
.hs{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-bottom:12px}
.sc{padding:10px 12px;background:var(--bg1);border:1px solid var(--brd);border-radius:var(--r)}
.sl{font-size:9px;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px;font-weight:600}
.sv{font-family:var(--m);font-size:15px;font-weight:600}
.cl{display:grid;grid-template-columns:1fr 260px;gap:12px}
@media(max-width:900px){.cl{grid-template-columns:1fr}}
.clh{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--brd)}
.cln{display:flex;align-items:center;gap:8px}.clm{font-weight:600;font-size:14px;min-width:140px;text-align:center}
.cg{display:grid;grid-template-columns:repeat(7,1fr)}
.cdh2{padding:7px 0;text-align:center;font-size:10px;font-weight:600;color:var(--t3);text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid var(--brd)}
.cc{min-height:72px;padding:4px;border-right:1px solid var(--brd);border-bottom:1px solid var(--brd);cursor:pointer;transition:background .15s}
.cc:nth-child(7n){border-right:none}.cc:hover{background:var(--bg2h)}.cc.tod{background:var(--accd)}.cc.om{opacity:.25}
.ccd{font-size:11px;font-weight:500;margin-bottom:2px;font-family:var(--m)}
.ce{font-size:9px;padding:1px 4px;border-radius:3px;margin-bottom:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}
.ce.Earnings{background:var(--grnd);color:var(--grn)}.ce.Dividend{background:var(--cynd);color:var(--cyn)}
.ce.Conference{background:var(--purd);color:var(--pur)}.ce.Regulatory{background:var(--ambd);color:var(--amb)}
.ce.Product{background:var(--accd);color:var(--acc)}.ce.Other{background:var(--accd);color:var(--t2)}
.es{display:flex;flex-direction:column;gap:6px;padding:10px;overflow-y:auto;max-height:480px}
.ec{padding:9px 11px;background:var(--bg1);border:1px solid var(--brd);border-radius:var(--r);display:flex;flex-direction:column;gap:4px}
.ech{display:flex;align-items:center;justify-content:space-between}
.ect{font-weight:600;font-size:12px}.ecd{font-family:var(--m);font-size:10px;color:var(--t3)}.ecn{font-size:11px;color:var(--t2);line-height:1.4}
.fr{display:flex;flex-direction:column;gap:3px}
.fl{font-size:10px;font-weight:600;color:var(--t3);text-transform:uppercase;letter-spacing:.4px}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:var(--acc);border:2px solid var(--bg0);cursor:pointer;pointer-events:all;box-shadow:0 0 6px rgba(59,130,246,.5)}
input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:var(--acc);border:2px solid var(--bg0);cursor:pointer;pointer-events:all}
.api-cfg{padding:12px 14px;border-bottom:1px solid var(--brd);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.api-cfg label{font-size:10px;font-weight:600;color:var(--t3);text-transform:uppercase;letter-spacing:.5px}
.api-cfg input{max-width:320px}
.mkt-status{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:600;font-family:var(--m)}
.mkt-dot{width:6px;height:6px;border-radius:50%;display:inline-block}
.loader{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;font-size:11px;color:var(--t2)}
.loader::after{content:'';width:12px;height:12px;border:2px solid var(--brd);border-top-color:var(--acc);border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes fi{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.fi{animation:fi .2s ease-out}
.pager{display:flex;align-items:center;justify-content:center;gap:8px;padding:10px;border-top:1px solid var(--brd)}
/* Stock tab */
.stk-search{display:flex;gap:8px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--brd)}
.stk-layout{display:grid;grid-template-columns:1fr 320px;gap:14px;padding:14px}
@media(max-width:900px){.stk-layout{grid-template-columns:1fr}}
.stk-chart{background:var(--bg1);border:1px solid var(--brd);border-radius:var(--rl);padding:16px}
.stk-chart-head{display:flex;align-items:flex-end;gap:12px;margin-bottom:14px;flex-wrap:wrap}
.stk-price{font-family:var(--m);font-size:28px;font-weight:700;letter-spacing:-1px}
.stk-name{font-size:13px;color:var(--t2);margin-bottom:2px}
.stk-period{display:flex;gap:3px}
.stk-period button{padding:3px 9px;border-radius:5px;border:1px solid var(--brd);background:var(--bg2);color:var(--t2);font-family:var(--f);font-size:10px;font-weight:500;cursor:pointer;transition:.15s}
.stk-period button:hover{border-color:var(--t3);color:var(--t1)}
.stk-period button.on{border-color:var(--acc);background:var(--accd);color:var(--acc);font-weight:600}
.stk-funds{display:flex;flex-direction:column;gap:8px}
.stk-fund-card{background:var(--bg1);border:1px solid var(--brd);border-radius:var(--rl);padding:14px}
.stk-fund-card h4{font-size:12px;font-weight:600;margin-bottom:10px;color:var(--t1);display:flex;align-items:center;gap:6px}
.stk-fund-row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--brd);font-size:11px}
.stk-fund-row:last-child{border-bottom:none}
.stk-fund-row .fl2{color:var(--t3)}.stk-fund-row .fv2{font-family:var(--m);font-weight:500;color:var(--t1);text-align:right}
.stk-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 20px;color:var(--t3)}
.stk-empty svg{margin-bottom:12px;opacity:.4}
.stk-loading{display:flex;align-items:center;justify-content:center;padding:40px;color:var(--t3);gap:8px}
@media(max-width:640px){.tn{justify-content:center}.ct{padding:8px}.cc{min-height:50px}}
`;

// ─── Exchange Config ───
const EXC = {
  ASX: { cur: "AUD", flag: "\u{1F1E6}\u{1F1FA}" },
  NYSE: { cur: "USD", flag: "\u{1F1FA}\u{1F1F8}" },
  NASDAQ: { cur: "USD", flag: "\u{1F1FA}\u{1F1F8}" },
};

// ─── Expanded Mock Data (used when no API key) ───
// ASX: ~100 stocks from mega to micro cap
const ASX_MOCK = [
  {t:"CBA",n:"Commonwealth Bank",s:"Financials",p:128.45,c:0.97,mc:218500,ev:225000,dh:0.12,t20:78.4,ca:42300,pe:20.1,v:3200000},
  {t:"BHP",n:"BHP Group",s:"Materials",p:43.21,c:-1.28,mc:218000,ev:235400,dh:0.03,t20:62.1,ca:12800,pe:12.8,v:8900000},
  {t:"CSL",n:"CSL Limited",s:"Healthcare",p:298.76,c:1.40,mc:143200,ev:155600,dh:0.08,t20:71.3,ca:5200,pe:38.2,v:1100000},
  {t:"WBC",n:"Westpac Banking",s:"Financials",p:28.94,c:1.12,mc:98400,ev:102000,dh:0.15,t20:72.8,ca:28900,pe:15.2,v:5600000},
  {t:"NAB",n:"National Aust. Bank",s:"Financials",p:35.67,c:-0.50,mc:112500,ev:118000,dh:0.09,t20:74.1,ca:31200,pe:16.8,v:4200000},
  {t:"ANZ",n:"ANZ Group",s:"Financials",p:29.12,c:1.53,mc:87300,ev:91000,dh:0.07,t20:70.5,ca:25600,pe:13.9,v:4800000},
  {t:"WDS",n:"Woodside Energy",s:"Energy",p:27.89,c:-3.29,mc:53400,ev:61200,dh:0.04,t20:58.9,ca:6100,pe:8.5,v:6700000},
  {t:"FMG",n:"Fortescue",s:"Materials",p:19.84,c:3.49,mc:61200,ev:66800,dh:36.30,t20:82.4,ca:4300,pe:7.2,v:9800000},
  {t:"WES",n:"Wesfarmers",s:"Consumer Disc.",p:68.42,c:1.32,mc:77500,ev:82100,dh:0.21,t20:68.7,ca:2100,pe:32.5,v:1500000},
  {t:"TLS",n:"Telstra Group",s:"Communication",p:3.98,c:0.51,mc:47200,ev:62300,dh:0.05,t20:55.2,ca:1800,pe:22.1,v:18200000},
  {t:"RIO",n:"Rio Tinto",s:"Materials",p:114.56,c:-1.06,mc:42100,ev:48900,dh:0.02,t20:65.8,ca:8400,pe:9.1,v:980000},
  {t:"MQG",n:"Macquarie Group",s:"Financials",p:198.34,c:1.31,mc:76100,ev:82000,dh:0.18,t20:52.3,ca:18700,pe:18.4,v:620000},
  {t:"ALL",n:"Aristocrat Leisure",s:"Consumer Disc.",p:48.92,c:2.82,mc:32100,ev:36500,dh:0.06,t20:61.4,ca:3200,pe:28.7,v:1800000},
  {t:"STO",n:"Santos",s:"Energy",p:7.12,c:-1.11,mc:24800,ev:31200,dh:0.11,t20:54.6,ca:2800,pe:11.4,v:7200000},
  {t:"WOW",n:"Woolworths",s:"Consumer Staples",p:31.45,c:0.67,mc:38700,ev:46200,dh:0.04,t20:58.9,ca:1600,pe:25.8,v:2800000},
  {t:"COL",n:"Coles Group",s:"Consumer Staples",p:18.23,c:0.77,mc:24200,ev:30100,dh:0.03,t20:56.4,ca:980,pe:24.1,v:3100000},
  {t:"REA",n:"REA Group",s:"Communication",p:198.90,c:1.76,mc:26400,ev:27800,dh:0.02,t20:73.6,ca:420,pe:62.1,v:340000},
  {t:"MIN",n:"Mineral Resources",s:"Materials",p:38.90,c:5.76,mc:7500,ev:13200,dh:11.40,t20:45.8,ca:580,pe:-4.2,v:4200000},
  {t:"LYC",n:"Lynas Rare Earths",s:"Materials",p:7.45,c:3.18,mc:6800,ev:6400,dh:0.08,t20:41.2,ca:820,pe:28.4,v:5100000},
  {t:"PLS",n:"Pilbara Minerals",s:"Materials",p:2.68,c:3.47,mc:8100,ev:7500,dh:0.14,t20:38.9,ca:1200,pe:15.8,v:18500000},
  {t:"TCL",n:"Transurban",s:"Industrials",p:13.42,c:0.22,mc:51200,ev:78400,dh:0.02,t20:62.8,ca:3400,pe:188.0,v:4200000},
  {t:"GMG",n:"Goodman Group",s:"Real Estate",p:34.56,c:1.88,mc:65200,ev:71800,dh:0.08,t20:54.2,ca:2800,pe:28.4,v:2800000},
  {t:"WTC",n:"WiseTech Global",s:"Technology",p:108.24,c:2.45,mc:35200,ev:34800,dh:33.20,t20:58.4,ca:680,pe:92.1,v:980000},
  {t:"XRO",n:"Xero Limited",s:"Technology",p:142.80,c:-0.87,mc:21800,ev:22400,dh:0.04,t20:52.8,ca:1200,pe:-128.0,v:620000},
  {t:"SHL",n:"Sonic Healthcare",s:"Healthcare",p:27.34,c:0.44,mc:12900,ev:18200,dh:0.08,t20:48.2,ca:860,pe:18.8,v:1800000},
  {t:"QBE",n:"QBE Insurance",s:"Financials",p:18.92,c:1.08,mc:27800,ev:26400,dh:0.04,t20:58.9,ca:4200,pe:12.4,v:2400000},
  {t:"ORG",n:"Origin Energy",s:"Energy",p:10.45,c:-0.38,mc:18400,ev:24200,dh:0.02,t20:52.1,ca:2100,pe:8.8,v:5200000},
  {t:"JHX",n:"James Hardie",s:"Materials",p:52.18,c:0.92,mc:23200,ev:27800,dh:0.06,t20:62.4,ca:680,pe:24.8,v:1200000},
  {t:"SGP",n:"Stockland",s:"Real Estate",p:4.82,c:0.63,mc:11200,ev:18400,dh:0.01,t20:48.8,ca:580,pe:16.2,v:4800000},
  {t:"S32",n:"South32",s:"Materials",p:3.28,c:-2.38,mc:15200,ev:14800,dh:0.02,t20:52.4,ca:1800,pe:9.8,v:12400000},
  {t:"AGL",n:"AGL Energy",s:"Utilities",p:11.56,c:1.22,mc:7800,ev:12400,dh:0.03,t20:42.8,ca:1200,pe:14.2,v:3200000},
  {t:"TWE",n:"Treasury Wine",s:"Consumer Staples",p:11.24,c:-0.44,mc:8100,ev:11200,dh:0.04,t20:48.2,ca:420,pe:22.4,v:2800000},
  {t:"SUN",n:"Suncorp Group",s:"Financials",p:17.82,c:0.56,mc:22400,ev:21800,dh:0.03,t20:56.8,ca:8200,pe:16.8,v:2100000},
  {t:"IAG",n:"Insurance Aust.",s:"Financials",p:7.45,c:0.81,mc:17200,ev:16800,dh:0.02,t20:54.2,ca:5600,pe:18.2,v:5400000},
  {t:"ORI",n:"Orica Ltd",s:"Materials",p:17.68,c:1.14,mc:7200,ev:10800,dh:0.04,t20:44.8,ca:680,pe:22.8,v:1200000},
  {t:"BXB",n:"Brambles",s:"Industrials",p:17.92,c:0.34,mc:25600,ev:32400,dh:0.02,t20:58.4,ca:420,pe:28.2,v:1800000},
  {t:"ASX",n:"ASX Limited",s:"Financials",p:62.45,c:-0.16,mc:12100,ev:11800,dh:0.02,t20:68.4,ca:2800,pe:32.4,v:420000},
  {t:"ALD",n:"Ampol",s:"Energy",p:28.34,c:-1.42,mc:7200,ev:9800,dh:0.06,t20:42.8,ca:680,pe:8.2,v:1200000},
  {t:"CPU",n:"Computershare",s:"Technology",p:28.92,c:0.69,mc:17100,ev:21200,dh:0.04,t20:52.8,ca:1800,pe:18.4,v:1400000},
  {t:"RMD",n:"ResMed Inc",s:"Healthcare",p:34.56,c:1.74,mc:50800,ev:54200,dh:0.08,t20:62.4,ca:380,pe:32.4,v:680000},
  {t:"PME",n:"Pro Medicus",s:"Healthcare",p:224.50,c:3.22,mc:18600,ev:18200,dh:12.80,t20:42.8,ca:280,pe:178.0,v:280000},
  {t:"CAR",n:"CAR Group",s:"Communication",p:37.80,c:0.80,mc:27400,ev:32100,dh:0.02,t20:58.2,ca:220,pe:52.4,v:820000},
  {t:"SEK",n:"SEEK Limited",s:"Communication",p:22.45,c:-0.89,mc:7800,ev:12400,dh:0.06,t20:44.2,ca:420,pe:42.8,v:1400000},
  {t:"EVN",n:"Evolution Mining",s:"Materials",p:5.42,c:4.62,mc:9800,ev:11200,dh:0.04,t20:38.4,ca:680,pe:18.2,v:8200000},
  {t:"NST",n:"Northern Star",s:"Materials",p:16.78,c:3.28,mc:19800,ev:22400,dh:0.02,t20:48.2,ca:1200,pe:22.4,v:4200000},
  {t:"NCM",n:"Newcrest Mining",s:"Materials",p:28.45,c:2.14,mc:24200,ev:28400,dh:0.02,t20:52.8,ca:2400,pe:28.8,v:2800000},
  {t:"JBH",n:"JB Hi-Fi",s:"Consumer Disc.",p:78.90,c:1.28,mc:8100,ev:8400,dh:0.08,t20:52.4,ca:420,pe:14.2,v:680000},
  {t:"DRR",n:"Deterra Royalties",s:"Materials",p:4.12,c:-0.72,mc:2200,ev:2100,dh:0.02,t20:72.8,ca:180,pe:12.8,v:1800000},
  {t:"SFR",n:"Sandfire Resources",s:"Materials",p:8.92,c:2.42,mc:4200,ev:5800,dh:0.04,t20:38.8,ca:420,pe:18.4,v:3200000},
  {t:"ILU",n:"Iluka Resources",s:"Materials",p:6.24,c:-1.58,mc:2800,ev:3200,dh:0.02,t20:42.4,ca:680,pe:8.8,v:2400000},
  {t:"CWY",n:"Cleanaway Waste",s:"Industrials",p:2.72,c:0.37,mc:5600,ev:8200,dh:0.02,t20:48.2,ca:220,pe:32.4,v:4800000},
  {t:"IGO",n:"IGO Limited",s:"Materials",p:5.12,c:-3.22,mc:3800,ev:3400,dh:0.04,t20:42.8,ca:880,pe:-12.4,v:5200000},
  {t:"ALX",n:"Atlas Arteria",s:"Industrials",p:5.04,c:0.20,mc:3200,ev:8800,dh:0.02,t20:58.4,ca:420,pe:24.2,v:2200000},
  {t:"HUB",n:"Hub24",s:"Financials",p:68.90,c:2.08,mc:5200,ev:5000,dh:4.80,t20:38.4,ca:280,pe:68.4,v:420000},
  {t:"NHF",n:"nib Holdings",s:"Financials",p:7.24,c:0.56,mc:3300,ev:3800,dh:0.08,t20:44.2,ca:680,pe:14.8,v:1800000},
  {t:"TPG",n:"TPG Telecom",s:"Communication",p:4.68,c:-0.43,mc:8600,ev:16200,dh:0.02,t20:62.4,ca:420,pe:42.8,v:3200000},
  {t:"VCX",n:"Vicinity Centres",s:"Real Estate",p:2.12,c:0.47,mc:5100,ev:11200,dh:0.02,t20:52.4,ca:280,pe:16.2,v:5400000},
  {t:"MGR",n:"Mirvac Group",s:"Real Estate",p:2.18,c:0.92,mc:8600,ev:14800,dh:0.02,t20:48.8,ca:420,pe:18.4,v:6200000},
  {t:"CHN",n:"Chalice Mining",s:"Materials",p:1.24,c:-4.62,mc:580,ev:420,dh:8.20,t20:28.4,ca:180,pe:-2.8,v:3800000},
  {t:"LTR",n:"Liontown Res.",s:"Materials",p:0.82,c:-2.38,mc:1900,ev:2400,dh:0.04,t20:32.8,ca:680,pe:-4.2,v:12400000},
  {t:"DEG",n:"De Grey Mining",s:"Materials",p:1.68,c:5.00,mc:2800,ev:2600,dh:0.02,t20:34.2,ca:220,pe:-28.4,v:8200000},
  {t:"BRN",n:"Brainchip",s:"Technology",p:0.28,c:7.69,mc:520,ev:480,dh:0.12,t20:22.4,ca:42,pe:-4.8,v:22400000},
  {t:"ZIP",n:"Zip Co",s:"Financials",p:2.34,c:4.48,mc:1800,ev:2200,dh:0.06,t20:28.8,ca:180,pe:-8.2,v:14200000},
  {t:"NIC",n:"Nickel Industries",s:"Materials",p:0.68,c:-2.86,mc:1800,ev:2400,dh:12.40,t20:42.8,ca:220,pe:4.8,v:8800000},
  {t:"AZJ",n:"Aurizon Holdings",s:"Industrials",p:3.72,c:0.27,mc:7400,ev:14200,dh:0.02,t20:58.4,ca:420,pe:12.8,v:4200000},
  {t:"WHC",n:"Whitehaven Coal",s:"Energy",p:6.42,c:-2.72,mc:5200,ev:4800,dh:0.06,t20:42.8,ca:1800,pe:4.2,v:6800000},
  {t:"PDN",n:"Paladin Energy",s:"Energy",p:10.24,c:4.08,mc:4200,ev:4800,dh:0.04,t20:38.4,ca:420,pe:52.4,v:5200000},
  {t:"BOE",n:"Boss Energy",s:"Energy",p:2.88,c:3.60,mc:1200,ev:1100,dh:0.08,t20:32.4,ca:280,pe:-22.4,v:4800000},
  {t:"SYA",n:"Sayona Mining",s:"Materials",p:0.032,c:-3.03,mc:220,ev:280,dh:0.04,t20:22.8,ca:82,pe:-1.2,v:42000000},
  {t:"VUL",n:"Vulcan Energy",s:"Materials",p:2.84,c:2.16,mc:480,ev:420,dh:2.40,t20:28.4,ca:120,pe:-8.4,v:1200000},
  {t:"NVX",n:"NOVONIX",s:"Materials",p:0.78,c:-1.27,mc:380,ev:320,dh:0.12,t20:24.2,ca:42,pe:-4.2,v:2800000},
  {t:"AVZ",n:"AVZ Minerals",s:"Materials",p:0.018,c:0.00,mc:120,ev:80,dh:0.08,t20:18.4,ca:12,pe:-0.4,v:8200000},
  {t:"LKE",n:"Lake Resources",s:"Materials",p:0.042,c:-4.55,mc:82,ev:62,dh:0.04,t20:18.8,ca:28,pe:-0.8,v:18400000},
  {t:"RLT",n:"Ramelius Res.",s:"Materials",p:2.48,c:3.77,mc:2400,ev:2200,dh:0.04,t20:38.2,ca:420,pe:12.4,v:4200000},
  {t:"RED",n:"Red 5 Ltd",s:"Materials",p:0.38,c:2.70,mc:880,ev:1200,dh:0.02,t20:28.4,ca:120,pe:8.8,v:8200000},
  {t:"ELD",n:"Elders Ltd",s:"Consumer Staples",p:7.82,c:-1.14,mc:1200,ev:1800,dh:4.20,t20:32.4,ca:180,pe:14.2,v:420000},
  {t:"GQG",n:"GQG Partners",s:"Financials",p:2.42,c:1.68,mc:7200,ev:7000,dh:0.08,t20:42.8,ca:420,pe:12.4,v:4800000},
  {t:"LNW",n:"Light & Wonder",s:"Consumer Disc.",p:152.80,c:1.34,mc:13200,ev:18400,dh:0.06,t20:52.4,ca:880,pe:32.8,v:280000},
  {t:"APA",n:"APA Group",s:"Utilities",p:7.68,c:0.26,mc:8400,ev:18200,dh:0.02,t20:48.8,ca:420,pe:28.4,v:2200000},
  {t:"MPL",n:"Medibank Private",s:"Financials",p:3.74,c:0.54,mc:10300,ev:10100,dh:0.02,t20:54.2,ca:1200,pe:18.2,v:4200000},
  {t:"ORA",n:"Orora Ltd",s:"Materials",p:2.12,c:-0.47,mc:2800,ev:4200,dh:0.04,t20:42.8,ca:180,pe:12.4,v:2400000},
  {t:"360",n:"Life360 Inc",s:"Technology",p:18.42,c:2.78,mc:3200,ev:3100,dh:2.80,t20:38.4,ca:220,pe:-42.8,v:680000},
  {t:"LOV",n:"Lovisa Holdings",s:"Consumer Disc.",p:28.90,c:1.05,mc:3100,ev:3400,dh:1.20,t20:42.4,ca:120,pe:32.8,v:420000},
  {t:"PPT",n:"Perpetual",s:"Financials",p:22.45,c:0.45,mc:3800,ev:5200,dh:0.08,t20:48.2,ca:220,pe:14.8,v:420000},
  {t:"NWS",n:"News Corp B",s:"Communication",p:38.90,c:0.78,mc:22400,ev:24200,dh:0.06,t20:52.4,ca:2800,pe:32.4,v:680000},
  {t:"BEN",n:"Bendigo Bank",s:"Financials",p:12.24,c:0.82,mc:7200,ev:7400,dh:0.04,t20:42.8,ca:12400,pe:12.4,v:1800000},
  {t:"ABB",n:"Aussie Broadband",s:"Communication",p:3.42,c:1.48,mc:980,ev:1400,dh:6.20,t20:32.4,ca:82,pe:28.4,v:820000},
  {t:"TYR",n:"Tyro Payments",s:"Technology",p:1.12,c:-2.61,mc:580,ev:520,dh:0.08,t20:28.4,ca:120,pe:-18.4,v:2400000},
  {t:"AD8",n:"Audinate Group",s:"Technology",p:12.80,c:1.59,mc:1200,ev:1100,dh:0.14,t20:34.8,ca:120,pe:-82.4,v:280000},
  {t:"SQ2",n:"Block Inc (CDI)",s:"Technology",p:98.42,c:2.12,mc:56200,ev:58400,dh:8.40,t20:42.8,ca:4200,pe:42.8,v:420000},
  {t:"APX",n:"Appen Ltd",s:"Technology",p:0.98,c:-3.92,mc:280,ev:320,dh:0.04,t20:24.2,ca:42,pe:-2.4,v:4200000},
  {t:"PXA",n:"Pexa Group",s:"Technology",p:14.20,c:0.71,mc:2400,ev:3200,dh:0.04,t20:52.4,ca:180,pe:68.4,v:420000},
  {t:"DRO",n:"DroneShield",s:"Industrials",p:1.42,c:6.77,mc:1100,ev:1000,dh:8.40,t20:28.4,ca:120,pe:-42.8,v:8200000},
  {t:"WBT",n:"Weebit Nano",s:"Technology",p:2.68,c:3.48,mc:580,ev:520,dh:0.12,t20:22.4,ca:82,pe:-8.4,v:2400000},
  {t:"4DS",n:"4DS Memory",s:"Technology",p:0.022,c:4.76,mc:42,ev:28,dh:0.04,t20:14.8,ca:8,pe:-0.4,v:12400000},
  {t:"88E",n:"88 Energy",s:"Energy",p:0.003,c:-14.29,mc:28,ev:22,dh:0.02,t20:12.4,ca:4,pe:-0.2,v:82000000},
  {t:"IVZ",n:"Invictus Energy",s:"Energy",p:0.018,c:-5.26,mc:32,ev:28,dh:0.08,t20:18.4,ca:6,pe:-0.4,v:18200000},
  {t:"PEN",n:"Peninsula Energy",s:"Energy",p:0.052,c:4.00,mc:62,ev:82,dh:0.04,t20:22.8,ca:12,pe:-1.2,v:4200000},
].map(s => ({ ticker: s.t, name: s.n, sector: s.s, price: s.p, change: s.c, mktCap: s.mc, ev: s.ev, dirHold: s.dh, top20: s.t20, cash: s.ca, pe: s.pe, vol: s.v }));

const NYSE_MOCK = [
  {t:"JPM",n:"JPMorgan Chase",s:"Financials",p:196.42,c:0.44,mc:572000,ev:590000,dh:0.32,t20:45.2,ca:615000,pe:12.1,v:9800000},
  {t:"JNJ",n:"Johnson & Johnson",s:"Healthcare",p:156.74,c:-0.29,mc:378000,ev:395000,dh:0.08,t20:52.1,ca:23400,pe:15.8,v:7200000},
  {t:"V",n:"Visa Inc.",s:"Financials",p:279.34,c:0.56,mc:558000,ev:574000,dh:0.04,t20:48.7,ca:16800,pe:31.2,v:6100000},
  {t:"XOM",n:"Exxon Mobil",s:"Energy",p:104.87,c:-1.99,mc:438000,ev:472000,dh:0.06,t20:44.8,ca:31200,pe:10.5,v:15300000},
  {t:"PG",n:"Procter & Gamble",s:"Consumer Staples",p:152.31,c:0.22,mc:358000,ev:388000,dh:0.11,t20:51.4,ca:8900,pe:25.4,v:5400000},
  {t:"UNH",n:"UnitedHealth",s:"Healthcare",p:527.18,c:0.81,mc:486000,ev:528000,dh:0.14,t20:56.2,ca:28600,pe:22.9,v:3800000},
  {t:"HD",n:"Home Depot",s:"Consumer Disc.",p:342.56,c:-0.52,mc:340000,ev:382000,dh:0.09,t20:49.8,ca:3100,pe:23.1,v:4200000},
  {t:"CVX",n:"Chevron",s:"Energy",p:152.89,c:-0.87,mc:282000,ev:310000,dh:0.05,t20:42.9,ca:8100,pe:11.8,v:8100000},
  {t:"BAC",n:"Bank of America",s:"Financials",p:34.12,c:1.34,mc:268000,ev:280000,dh:0.22,t20:51.8,ca:312000,pe:10.9,v:32100000},
  {t:"KO",n:"Coca-Cola",s:"Consumer Staples",p:59.87,c:0.25,mc:258000,ev:298000,dh:0.02,t20:48.3,ca:9500,pe:24.7,v:11200000},
  {t:"MRK",n:"Merck & Co.",s:"Healthcare",p:108.35,c:0.86,mc:274000,ev:296000,dh:0.07,t20:53.6,ca:6800,pe:18.6,v:9500000},
  {t:"PFE",n:"Pfizer",s:"Healthcare",p:28.45,c:-2.30,mc:160000,ev:191000,dh:0.05,t20:47.1,ca:3200,pe:42.8,v:28700000},
  {t:"CAT",n:"Caterpillar",s:"Industrials",p:278.90,c:1.25,mc:138000,ev:158000,dh:0.08,t20:50.4,ca:7200,pe:16.8,v:3500000},
  {t:"DIS",n:"Walt Disney",s:"Communication",p:92.14,c:1.23,mc:168000,ev:218000,dh:0.06,t20:52.7,ca:5800,pe:35.4,v:11200000},
  {t:"GS",n:"Goldman Sachs",s:"Financials",p:478.90,c:1.13,mc:158000,ev:168000,dh:0.45,t20:62.1,ca:244000,pe:14.2,v:2100000},
  {t:"T",n:"AT&T",s:"Communication",p:17.23,c:0.47,mc:123000,ev:260000,dh:0.04,t20:42.5,ca:3600,pe:7.8,v:35400000},
  {t:"LIN",n:"Linde plc",s:"Materials",p:412.30,c:0.51,mc:198000,ev:218000,dh:0.03,t20:54.9,ca:4800,pe:33.4,v:2100000},
  {t:"BRK.B",n:"Berkshire Hathaway B",s:"Financials",p:442.56,c:0.43,mc:892000,ev:850000,dh:15.2,t20:38.4,ca:334000,pe:9.8,v:3400000},
  {t:"NEE",n:"NextEra Energy",s:"Utilities",p:72.45,c:0.39,mc:149000,ev:201000,dh:0.03,t20:55.8,ca:2100,pe:20.1,v:8600000},
  {t:"AMT",n:"American Tower",s:"Real Estate",p:198.75,c:-0.46,mc:92800,ev:138000,dh:0.02,t20:58.3,ca:2400,pe:41.2,v:3200000},
].map(s => ({ ticker: s.t, name: s.n, sector: s.s, price: s.p, change: s.c, mktCap: s.mc, ev: s.ev, dirHold: s.dh, top20: s.t20, cash: s.ca, pe: s.pe, vol: s.v }));

const NASDAQ_MOCK = [
  {t:"AAPL",n:"Apple Inc.",s:"Technology",p:178.52,c:1.33,mc:2780000,ev:2820000,dh:0.07,t20:42.8,ca:62500,pe:28.5,v:58200000},
  {t:"MSFT",n:"Microsoft",s:"Technology",p:378.91,c:-0.32,mc:2810000,ev:2780000,dh:0.03,t20:48.5,ca:111000,pe:35.2,v:22100000},
  {t:"GOOGL",n:"Alphabet Inc.",s:"Technology",p:141.80,c:2.49,mc:1760000,ev:1680000,dh:5.80,t20:52.1,ca:110000,pe:25.1,v:31500000},
  {t:"AMZN",n:"Amazon.com",s:"Consumer Disc.",p:178.25,c:1.07,mc:1860000,ev:1890000,dh:9.40,t20:38.9,ca:73000,pe:62.3,v:44800000},
  {t:"NVDA",n:"NVIDIA Corp.",s:"Technology",p:495.22,c:2.63,mc:1220000,ev:1200000,dh:3.50,t20:44.2,ca:26000,pe:65.8,v:41200000},
  {t:"META",n:"Meta Platforms",s:"Technology",p:353.96,c:-1.45,mc:908000,ev:882000,dh:13.60,t20:46.8,ca:58900,pe:29.7,v:18900000},
  {t:"TSLA",n:"Tesla Inc.",s:"Consumer Disc.",p:248.42,c:3.72,mc:792000,ev:780000,dh:12.90,t20:35.4,ca:29100,pe:78.4,v:112500000},
  {t:"AVGO",n:"Broadcom",s:"Technology",p:168.45,c:1.41,mc:786000,ev:812000,dh:2.10,t20:50.2,ca:12400,pe:37.8,v:8400000},
  {t:"COST",n:"Costco",s:"Consumer Staples",p:748.90,c:0.76,mc:332000,ev:342000,dh:0.18,t20:55.8,ca:13700,pe:52.4,v:2100000},
  {t:"NFLX",n:"Netflix",s:"Communication",p:628.34,c:-1.33,mc:270000,ev:282000,dh:1.40,t20:58.4,ca:7200,pe:42.8,v:5600000},
  {t:"AMD",n:"Adv. Micro Devices",s:"Technology",p:152.67,c:3.08,mc:247000,ev:244000,dh:0.42,t20:52.6,ca:5800,pe:48.2,v:52800000},
  {t:"ADBE",n:"Adobe Inc.",s:"Technology",p:478.90,c:-0.67,mc:210000,ev:215000,dh:0.15,t20:56.2,ca:7600,pe:34.5,v:3200000},
  {t:"INTC",n:"Intel Corp.",s:"Technology",p:22.45,c:-1.49,mc:96000,ev:128000,dh:0.09,t20:60.4,ca:21200,pe:-8.4,v:42200000},
  {t:"QCOM",n:"Qualcomm",s:"Technology",p:168.34,c:1.14,mc:188000,ev:195000,dh:0.06,t20:54.8,ca:8400,pe:18.2,v:6800000},
  {t:"SBUX",n:"Starbucks",s:"Consumer Disc.",p:82.45,c:0.95,mc:94200,ev:112000,dh:0.04,t20:52.1,ca:3400,pe:24.8,v:8400000},
  {t:"GILD",n:"Gilead Sciences",s:"Healthcare",p:98.12,c:1.27,mc:122000,ev:142000,dh:0.08,t20:58.9,ca:5100,pe:14.8,v:7200000},
  {t:"PANW",n:"Palo Alto Networks",s:"Technology",p:312.45,c:2.22,mc:105000,ev:104000,dh:0.22,t20:62.8,ca:3200,pe:52.1,v:4200000},
  {t:"CRWD",n:"CrowdStrike",s:"Technology",p:298.45,c:1.94,mc:72400,ev:71800,dh:2.80,t20:48.2,ca:3400,pe:92.4,v:3800000},
  {t:"MRVL",n:"Marvell Technology",s:"Technology",p:78.90,c:3.06,mc:68200,ev:72400,dh:0.35,t20:56.4,ca:1100,pe:-78.9,v:12400000},
  {t:"DXCM",n:"DexCom Inc.",s:"Healthcare",p:72.34,c:-1.67,mc:28400,ev:30200,dh:0.48,t20:62.4,ca:2800,pe:48.2,v:5600000},
].map(s => ({ ticker: s.t, name: s.n, sector: s.s, price: s.p, change: s.c, mktCap: s.mc, ev: s.ev, dirHold: s.dh, top20: s.t20, cash: s.ca, pe: s.pe, vol: s.v }));

const MOCK = { ASX: ASX_MOCK, NYSE: NYSE_MOCK, NASDAQ: NASDAQ_MOCK };

const DEFAULT_EVENTS = [
  {id:"e1",date:"2026-03-25",ticker:"CBA",type:"Earnings",title:"CBA Half-Year Results",notes:"Expected dividend ~$2.25",exchange:"ASX"},
  {id:"e2",date:"2026-03-27",ticker:"MSFT",type:"Earnings",title:"MSFT Q3 Earnings",notes:"Cloud revenue focus",exchange:"NASDAQ"},
  {id:"e3",date:"2026-04-01",ticker:"TSLA",type:"Product Launch",title:"Tesla Delivery Numbers",notes:"Q1 2026 deliveries",exchange:"NASDAQ"},
  {id:"e4",date:"2026-04-08",ticker:"BHP",type:"Earnings",title:"BHP Operational Review",notes:"Q3 iron ore production",exchange:"ASX"},
  {id:"e5",date:"2026-04-15",ticker:"JPM",type:"Earnings",title:"JPM Q1 Earnings",notes:"Banking bellwether",exchange:"NYSE"},
  {id:"e6",date:"2026-04-22",ticker:"GOOGL",type:"Regulatory",title:"GOOGL Antitrust Ruling",notes:"DOJ case decision",exchange:"NASDAQ"},
  {id:"e7",date:"2026-05-01",ticker:"CSL",type:"Earnings",title:"CSL Full Year Results",notes:"Seqirus revenue key",exchange:"ASX"},
  {id:"e8",date:"2026-04-12",ticker:"FMG",type:"Dividend",title:"FMG Ex-Dividend",notes:"Final div ~$0.88",exchange:"ASX"},
];

// ─── Formatters ───
const FM = {
  p: (n, c) => (c === "AUD" ? "A$" : "$") + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  pct: (n) => (n >= 0 ? "+" : "") + n.toFixed(2) + "%",
  vol: (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(0) + "K" : n.toString(),
  cap: (n) => { if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "T"; if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "B"; return "$" + n.toFixed(0) + "M"; },
  capS: (n) => { if (n >= 1e6) return (n / 1e6).toFixed(2) + "T"; if (n >= 1e3) return (n / 1e3).toFixed(1) + "B"; return n.toFixed(0) + "M"; },
  n: (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
};

// ─── Range Slider ───
function RangeSlider({ label, min, max, lo, hi, onChange, fmt }) {
  const span = max - min || 1;
  const pL = ((lo - min) / span) * 100;
  const pH = ((hi - min) / span) * 100;
  return (
    <div style={{ flex: 1, minWidth: 180, maxWidth: 250 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
        <span style={{ fontSize: 9, fontWeight: 600, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".5px" }}>{label}</span>
        <span style={{ fontFamily: "var(--m)", color: "var(--acc)", fontWeight: 500, fontSize: 9 }}>{fmt(lo)} \u2014 {fmt(hi)}</span>
      </div>
      <div style={{ position: "relative", height: 4, background: "var(--brd)", borderRadius: 2, margin: "8px 0 4px" }}>
        <div style={{ position: "absolute", height: "100%", background: "var(--acc)", borderRadius: 2, opacity: 0.5, left: pL + "%", width: (pH - pL) + "%" }} />
        <input type="range" min={min} max={max} value={lo} step={(max - min) / 200 || 1}
          onChange={e => { const v = +e.target.value; if (v <= hi) onChange(v, hi); }}
          style={{ position: "absolute", top: -6, width: "100%", height: 16, WebkitAppearance: "none", appearance: "none", background: "transparent", pointerEvents: "none", margin: 0 }} />
        <input type="range" min={min} max={max} value={hi} step={(max - min) / 200 || 1}
          onChange={e => { const v = +e.target.value; if (v >= lo) onChange(lo, v); }}
          style={{ position: "absolute", top: -6, width: "100%", height: 16, WebkitAppearance: "none", appearance: "none", background: "transparent", pointerEvents: "none", margin: 0 }} />
      </div>
    </div>
  );
}

// ─── Modal ───
function Modal({ title, onClose, children, footer }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, backdropFilter: "blur(4px)" }} onClick={onClose}>
      <div className="fi" style={{ background: "var(--bg2)", border: "1px solid var(--brd)", borderRadius: "var(--rl)", width: "90%", maxWidth: 440, boxShadow: "0 8px 32px rgba(0,0,0,.5)" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid var(--brd)" }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>{title}</span>
          <button className="bi" onClick={onClose}>{"\u2715"}</button>
        </div>
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
        {footer && <div style={{ padding: "10px 16px", borderTop: "1px solid var(--brd)", display: "flex", justifyContent: "flex-end", gap: 6 }}>{footer}</div>}
      </div>
    </div>
  );
}

// ════════════════════════════════════
// SCREENER
// ════════════════════════════════════
function Screener({ ex, wl, setWl, addToPf, apiKey, liveData }) {
  const mockStocks = MOCK[ex] || [];
  const cur = EXC[ex].cur;
  const PAGE_SIZE = 50;

  // Merge live data into mock + add API-only stocks if bulk data available
  const stocks = useMemo(() => {
    const base = [...mockStocks];

    if (!liveData || Object.keys(liveData).length === 0) return base;

    // Update mock stocks with live prices
    const updated = base.map(s => {
      const live = liveData[s.ticker];
      if (live && (live.close || live.close === 0)) {
        return {
          ...s,
          price: parseFloat(live.close) || s.price,
          change: parseFloat(live.change_p) || s.change,
          vol: parseInt(live.volume) || s.vol,
        };
      }
      return s;
    });

    // Add stocks from bulk API data that aren't already in mock list
    const mockTickers = new Set(base.map(s => s.ticker));
    const exCode = EODHD_EX[ex] || "US";
    for (const [code, d] of Object.entries(liveData)) {
      if (mockTickers.has(code)) continue;
      if (!d.close || parseFloat(d.close) <= 0) continue;
      // Only include if it looks like a real stock (has volume, reasonable price)
      const vol = parseInt(d.volume) || 0;
      if (vol < 1) continue;
      const price = parseFloat(d.close);
      const prevClose = parseFloat(d.previousClose) || price;
      const changePct = prevClose > 0 ? ((price - prevClose) / prevClose * 100) : 0;
      updated.push({
        ticker: code,
        name: code, // Will show ticker as name for API-sourced stocks
        sector: "Unknown",
        price,
        change: parseFloat(d.change_p) || changePct,
        mktCap: 0,
        ev: 0,
        dirHold: 0,
        top20: 0,
        cash: 0,
        pe: 0,
        vol,
      });
    }

    return updated;
  }, [mockStocks, liveData, ex]);

  const [q, setQ] = useState("");
  const [sec, setSec] = useState("All");
  const [sk, setSk] = useState("mktCap");
  const [sa, setSa] = useState(false);
  const [fo, setFo] = useState(true);
  const [page, setPage] = useState(0);

  const rngs = useMemo(() => {
    const r = (k) => { const vs = stocks.map(s => s[k]).filter(v => v != null && isFinite(v)); return vs.length ? [Math.min(...vs), Math.max(...vs)] : [0, 1]; };
    return { mktCap: r("mktCap"), ev: r("ev"), dirHold: r("dirHold"), top20: r("top20"), cash: r("cash") };
  }, [stocks]);

  const [fl, setFl] = useState(null);
  useEffect(() => {
    setFl({ mktCap: [...rngs.mktCap], ev: [...rngs.ev], dirHold: [...rngs.dirHold], top20: [...rngs.top20], cash: [...rngs.cash] });
    setQ(""); setSec("All"); setPage(0);
  }, [ex]);

  const sectors = useMemo(() => [...new Set(stocks.map(s => s.sector))].sort(), [stocks]);
  const doSort = (k) => { sk === k ? setSa(!sa) : (setSk(k), setSa(true)); setPage(0); };
  const mktStatus = getMarketStatus(ex);

  const filtered = useMemo(() => {
    if (!fl) return stocks;
    let l = [...stocks];
    if (q) { const s = q.toLowerCase(); l = l.filter(x => x.ticker.toLowerCase().includes(s) || x.name.toLowerCase().includes(s)); }
    if (sec !== "All") l = l.filter(x => x.sector === sec);
    l = l.filter(x =>
      x.mktCap >= fl.mktCap[0] && x.mktCap <= fl.mktCap[1] &&
      x.ev >= fl.ev[0] && x.ev <= fl.ev[1] &&
      x.dirHold >= fl.dirHold[0] && x.dirHold <= fl.dirHold[1] &&
      x.top20 >= fl.top20[0] && x.top20 <= fl.top20[1] &&
      x.cash >= fl.cash[0] && x.cash <= fl.cash[1]
    );
    l.sort((a, b) => { const av = a[sk], bv = b[sk]; if (typeof av === "string") return sa ? av.localeCompare(bv) : bv.localeCompare(av); return sa ? av - bv : bv - av; });
    return l;
  }, [q, sec, sk, sa, fl, stocks]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  if (!fl) return null;

  const TH = ({ l, k }) => (
    <th className={sk === k ? "so" : ""} onClick={() => doSort(k)}>
      {l}{sk === k && <span style={{ marginLeft: 3 }}>{sa ? "\u2191" : "\u2193"}</span>}
    </th>
  );

  return (
    <div className="cd fi">
      <div className="cdh">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="cdt">Stock Screener \u2014 {EXC[ex].flag} {ex}</div>
          <div className="mkt-status"><div className="mkt-dot" style={{ background: mktStatus.color }} /><span style={{ color: mktStatus.color }}>{mktStatus.label}</span></div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span className="bg bg-b">{filtered.length} of {stocks.length}</span>
          <button className="bn bn-s" onClick={() => setFo(!fo)}>{fo ? "Hide" : "Show"} Filters</button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "8px 14px", borderBottom: "1px solid var(--brd)" }}>
        <div style={{ position: "relative", flex: 1, minWidth: 160, maxWidth: 260 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "var(--t3)" }}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>
          <input className="inp" style={{ paddingLeft: 28 }} placeholder="Search ticker or name\u2026" value={q} onChange={e => { setQ(e.target.value); setPage(0); }} />
        </div>
        <select className="inp" style={{ width: "auto", minWidth: 120 }} value={sec} onChange={e => { setSec(e.target.value); setPage(0); }}>
          <option value="All">All Sectors</option>
          {sectors.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        {apiKey && liveData && Object.keys(liveData).length > 0 && <span style={{ fontSize: 10, color: "var(--grn)", fontFamily: "var(--m)" }}>{"\u2713"} {Object.keys(liveData).length} live tickers</span>}
        {apiKey && (!liveData || Object.keys(liveData).length === 0) && <span style={{ fontSize: 10, color: "var(--amb)", fontFamily: "var(--m)" }}>{"\u23F3"} Fetching{"\u2026"}</span>}
        {!apiKey && <span style={{ fontSize: 10, color: "var(--t3)" }}>Mock data {"\u2014"} connect EODHD API for live prices</span>}
      </div>
      {fo && (
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--brd)", display: "flex", gap: 10, flexWrap: "wrap" }}>
          <RangeSlider label="Market Cap" min={rngs.mktCap[0]} max={rngs.mktCap[1]} lo={fl.mktCap[0]} hi={fl.mktCap[1]} onChange={(l, h) => { setFl({ ...fl, mktCap: [l, h] }); setPage(0); }} fmt={FM.capS} />
          <RangeSlider label="Enterprise Value" min={rngs.ev[0]} max={rngs.ev[1]} lo={fl.ev[0]} hi={fl.ev[1]} onChange={(l, h) => { setFl({ ...fl, ev: [l, h] }); setPage(0); }} fmt={FM.capS} />
          <RangeSlider label="Director Holdings %" min={rngs.dirHold[0]} max={rngs.dirHold[1]} lo={fl.dirHold[0]} hi={fl.dirHold[1]} onChange={(l, h) => { setFl({ ...fl, dirHold: [l, h] }); setPage(0); }} fmt={v => v.toFixed(1) + "%"} />
          <RangeSlider label="Top 20 Holdings %" min={rngs.top20[0]} max={rngs.top20[1]} lo={fl.top20[0]} hi={fl.top20[1]} onChange={(l, h) => { setFl({ ...fl, top20: [l, h] }); setPage(0); }} fmt={v => v.toFixed(1) + "%"} />
          <RangeSlider label="Cash Holdings" min={rngs.cash[0]} max={rngs.cash[1]} lo={fl.cash[0]} hi={fl.cash[1]} onChange={(l, h) => { setFl({ ...fl, cash: [l, h] }); setPage(0); }} fmt={FM.capS} />
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        <table><thead><tr>
          <th style={{ width: 28 }}></th>
          <TH l="Ticker" k="ticker" /><TH l="Price" k="price" /><TH l="Chg%" k="change" /><TH l="Mkt Cap" k="mktCap" /><TH l="EV" k="ev" /><TH l="Dir%" k="dirHold" /><TH l="Top20%" k="top20" /><TH l="Cash" k="cash" /><TH l="P/E" k="pe" /><TH l="Vol" k="vol" /><TH l="Sector" k="sector" /><th></th>
        </tr></thead><tbody>
          {paged.map(s => (
            <tr key={s.ticker}>
              <td><button className="bi" onClick={() => setWl(w => w.includes(s.ticker) ? w.filter(t => t !== s.ticker) : [...w, s.ticker])} style={{ color: wl.includes(s.ticker) ? "var(--amb)" : "var(--t3)" }}>{wl.includes(s.ticker) ? "\u2605" : "\u2606"}</button></td>
              <td style={{ fontFamily: "var(--f)" }}><div style={{ fontWeight: 700, fontFamily: "var(--m)", fontSize: 11, color: "var(--acc)" }}>{s.ticker}</div><div style={{ color: "var(--t2)", fontSize: 10 }}>{s.name}</div></td>
              <td>{FM.p(s.price, cur)}</td>
              <td><span className={s.change >= 0 ? "pos" : "neg"}>{FM.pct(s.change)}</span></td>
              <td>{FM.cap(s.mktCap)}</td>
              <td>{s.ev > 0 ? FM.cap(s.ev) : "\u2014"}</td>
              <td>{s.dirHold.toFixed(2)}%</td>
              <td>{s.top20.toFixed(1)}%</td>
              <td>{FM.cap(s.cash)}</td>
              <td>{s.pe > 0 ? s.pe.toFixed(1) : "N/A"}</td>
              <td>{FM.vol(s.vol)}</td>
              <td style={{ fontFamily: "var(--f)", fontSize: 10 }}>{s.sector}</td>
              <td><button className="bn bn-s bn-p" onClick={() => addToPf(s.ticker)}>+ Add</button></td>
            </tr>
          ))}
          {paged.length === 0 && <tr><td colSpan={13} style={{ textAlign: "center", padding: 24, color: "var(--t3)", fontFamily: "var(--f)", fontSize: 12 }}>No stocks match your filters.</td></tr>}
        </tbody></table>
      </div>
      {totalPages > 1 && (
        <div className="pager">
          <button className="bn bn-s" disabled={page === 0} onClick={() => setPage(page - 1)}>{"\u25C0"} Prev</button>
          <span style={{ fontFamily: "var(--m)", fontSize: 11, color: "var(--t2)" }}>Page {page + 1} of {totalPages}</span>
          <button className="bn bn-s" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>Next {"\u25B6"}</button>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════
// PORTFOLIO (same as before, just uses MOCK for price lookup)
// ════════════════════════════════════
function Portfolio({ pfs, setPfs, pft, ex, liveData, apiKey }) {
  const [sel, setSel] = useState(0);
  const [showE, setShowE] = useState(false);
  const [showH, setShowH] = useState(false);
  const [nn, setNn] = useState("");
  const [hf, setHf] = useState({ ticker: "", shares: "", cost: "", exchange: ex });
  const [pfLive, setPfLive] = useState({}); // portfolio-specific live data
  const cur = EXC[ex].cur;
  useEffect(() => { if (pft) setHf(f => ({ ...f, ticker: pft, exchange: ex })); }, [pft]);
  const ent = pfs[sel] || null;

  // Fetch live quotes for all holdings in the selected entity
  useEffect(() => {
    if (!apiKey || !ent || ent.holdings.length === 0) return;
    let cancelled = false;
    (async () => {
      const results = {};
      // Group holdings by exchange and fetch
      const byExc = {};
      ent.holdings.forEach(h => {
        const e = h.exchange || ex;
        if (!byExc[e]) byExc[e] = [];
        byExc[e].push(h.ticker);
      });
      for (const [exc, tickers] of Object.entries(byExc)) {
        const exCode = EODHD_EX[exc] || "US";
        for (const tk of tickers) {
          const d = await eodhFetch(`/real-time/${tk}.${exCode}`, apiKey);
          if (d && d.close && !d.error) results[tk] = d;
          await new Promise(r => setTimeout(r, 300));
        }
      }
      if (!cancelled) setPfLive(results);
    })();
    return () => { cancelled = true; };
  }, [apiKey, sel, ent?.holdings?.length]);

  // Price lookup: portfolio live data -> global live data -> mock data across ALL exchanges
  const gp = (tk, exc) => {
    if (pfLive[tk]?.close) return parseFloat(pfLive[tk].close);
    if (liveData?.[tk]?.close) return parseFloat(liveData[tk].close);
    // Search mock data — first in the specified exchange, then all
    const s = (MOCK[exc] || []).find(x => x.ticker === tk);
    if (s) return s.price;
    for (const stocks of Object.values(MOCK)) {
      const found = stocks.find(x => x.ticker === tk);
      if (found) return found.price;
    }
    return 0;
  };
  const gc = (tk, exc) => {
    if (pfLive[tk]?.change_p) return parseFloat(pfLive[tk].change_p);
    if (liveData?.[tk]?.change_p) return parseFloat(liveData[tk].change_p);
    const s = (MOCK[exc] || []).find(x => x.ticker === tk);
    if (s) return s.change;
    for (const stocks of Object.values(MOCK)) {
      const found = stocks.find(x => x.ticker === tk);
      if (found) return found.change;
    }
    return 0;
  };
  const addE = () => { if (!nn.trim()) return; const u = [...pfs, { name: nn.trim(), holdings: [] }]; setPfs(u); setSel(u.length - 1); setNn(""); setShowE(false); };
  const addH = () => { const tk = hf.ticker.toUpperCase().trim(); const sh = parseFloat(hf.shares); const co = parseFloat(hf.cost); if (!tk || isNaN(sh) || isNaN(co)) return; const u = [...pfs]; const x = u[sel].holdings.find(h => h.ticker === tk); if (x) { const ts = x.shares + sh; x.cost = ((x.cost * x.shares) + (co * sh)) / ts; x.shares = ts; } else u[sel].holdings.push({ ticker: tk, shares: sh, cost: co, exchange: hf.exchange }); setPfs(u); setHf({ ticker: "", shares: "", cost: "", exchange: ex }); setShowH(false); };
  const remH = (tk) => { const u = [...pfs]; u[sel].holdings = u[sel].holdings.filter(h => h.ticker !== tk); setPfs(u); };
  const remE = (i) => { const u = pfs.filter((_, j) => j !== i); setPfs(u); if (sel >= u.length) setSel(Math.max(0, u.length - 1)); };
  const eV = ent ? ent.holdings.reduce((s, h) => s + h.shares * gp(h.ticker, h.exchange || ex), 0) : 0;
  const eC = ent ? ent.holdings.reduce((s, h) => s + h.shares * h.cost, 0) : 0;
  const ePnl = eV - eC; const ePct = eC > 0 ? (ePnl / eC) * 100 : 0;

  return (
    <div className="fi">
      <div className="pl">
        <div className="cd">
          <div className="cdh"><span className="cdt">Entities</span><button className="bn bn-s bn-p" onClick={() => setShowE(true)}>+ New</button></div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {pfs.map((p, i) => (<div key={i} className={`ei ${sel === i ? "on" : ""}`} onClick={() => setSel(i)}><div><div className="en">{p.name}</div><div style={{ fontSize: 10, color: "var(--t3)", fontFamily: "var(--m)" }}>{p.holdings.length} holdings</div></div><button className="bi" onClick={e => { e.stopPropagation(); remE(i); }} style={{ color: "var(--t3)" }}>{"\u{1F5D1}"}</button></div>))}
            {pfs.length === 0 && <div style={{ padding: 20, textAlign: "center", color: "var(--t3)", fontSize: 12 }}>No entities yet.</div>}
          </div>
        </div>
        <div className="cd">
          {ent ? (<>
            <div className="cdh"><span className="cdt">{ent.name}</span><button className="bn bn-s bn-p" onClick={() => { setHf({ ...hf, exchange: ex }); setShowH(true); }}>+ Add Holding</button></div>
            <div style={{ padding: 12 }}>
              <div className="hs">
                <div className="sc"><div className="sl">Market Value</div><div className="sv">{FM.p(eV, cur)}</div></div>
                <div className="sc"><div className="sl">Cost Basis</div><div className="sv">{FM.p(eC, cur)}</div></div>
                <div className="sc"><div className="sl">Total P&L</div><div className={`sv ${ePnl >= 0 ? "pos" : "neg"}`}>{FM.p(Math.abs(ePnl), cur)}{ePnl < 0 ? " loss" : ""} ({FM.pct(ePct)})</div></div>
                <div className="sc"><div className="sl">Positions</div><div className="sv">{ent.holdings.length}</div></div>
              </div>
              {ent.holdings.length > 0 ? (<div style={{ overflowX: "auto" }}><table><thead><tr><th>Ticker</th><th>Exch</th><th>Shares</th><th>Avg Cost</th><th>Price</th><th>Day</th><th>Value</th><th>P&L</th><th>P&L%</th><th>Wt</th><th></th></tr></thead><tbody>
                {ent.holdings.map(h => { const exc = h.exchange || ex; const pr = gp(h.ticker, exc); const ch = gc(h.ticker, exc); const mv = h.shares * pr; const co = h.shares * h.cost; const pl = mv - co; const pp = co > 0 ? (pl / co) * 100 : 0; const wt = eV > 0 ? (mv / eV) * 100 : 0; const c = EXC[exc]?.cur || "USD";
                  return (<tr key={h.ticker}><td><span style={{ fontWeight: 700, fontFamily: "var(--m)", color: "var(--acc)", fontSize: 11 }}>{h.ticker}</span></td><td style={{ fontFamily: "var(--f)" }}><span className="bg bg-b">{exc}</span></td><td>{FM.n(h.shares)}</td><td>{FM.p(h.cost, c)}</td><td>{FM.p(pr, c)}</td><td><span className={ch >= 0 ? "pos" : "neg"}>{FM.pct(ch)}</span></td><td>{FM.p(mv, c)}</td><td><span className={pl >= 0 ? "pos" : "neg"}>{FM.p(pl, c)}</span></td><td><span className={pp >= 0 ? "pos" : "neg"}>{FM.pct(pp)}</span></td><td><div style={{ display: "flex", alignItems: "center", gap: 4 }}><div style={{ width: 36, height: 3, background: "var(--brd)", borderRadius: 2, overflow: "hidden" }}><div style={{ width: wt + "%", height: "100%", background: "var(--acc)", borderRadius: 2 }} /></div><span style={{ fontSize: 10, color: "var(--t3)" }}>{wt.toFixed(1)}%</span></div></td><td><button className="bi" onClick={() => remH(h.ticker)} style={{ color: "var(--red)" }}>{"\u{1F5D1}"}</button></td></tr>);
                })}
              </tbody></table></div>) : <div style={{ padding: 24, textAlign: "center", color: "var(--t3)", fontSize: 12 }}>No holdings. Add from the screener.</div>}
            </div>
          </>) : <div style={{ padding: 50, textAlign: "center", color: "var(--t3)", fontSize: 12 }}>Select or create an entity.</div>}
        </div>
      </div>
      {showE && <Modal title="New Entity" onClose={() => setShowE(false)} footer={<><button className="bn" onClick={() => setShowE(false)}>Cancel</button><button className="bn bn-p" onClick={addE}>Create</button></>}><div className="fr"><label className="fl">Entity Name</label><input className="inp" placeholder="e.g. Personal, SMSF, Trust\u2026" value={nn} onChange={e => setNn(e.target.value)} onKeyDown={e => e.key === "Enter" && addE()} autoFocus /></div></Modal>}
      {showH && <Modal title="Add Holding" onClose={() => setShowH(false)} footer={<><button className="bn" onClick={() => setShowH(false)}>Cancel</button><button className="bn bn-p" onClick={addH}>Add</button></>}>
        <div style={{ display: "flex", gap: 8 }}><div className="fr" style={{ flex: 1 }}><label className="fl">Ticker</label><input className="inp" placeholder="e.g. BHP, AAPL" value={hf.ticker} onChange={e => setHf({ ...hf, ticker: e.target.value.toUpperCase() })} autoFocus /></div><div className="fr" style={{ flex: 1 }}><label className="fl">Exchange</label><select className="inp" value={hf.exchange} onChange={e => setHf({ ...hf, exchange: e.target.value })}>{Object.keys(EXC).map(k => <option key={k} value={k}>{k}</option>)}</select></div></div>
        <div style={{ display: "flex", gap: 8 }}><div className="fr" style={{ flex: 1 }}><label className="fl">Shares</label><input className="inp" type="number" step="any" placeholder="100" value={hf.shares} onChange={e => setHf({ ...hf, shares: e.target.value })} /></div><div className="fr" style={{ flex: 1 }}><label className="fl">Avg Cost</label><input className="inp" type="number" step="any" placeholder="45.00" value={hf.cost} onChange={e => setHf({ ...hf, cost: e.target.value })} /></div></div>
      </Modal>}
    </div>
  );
}

// ════════════════════════════════════
// CALENDAR (same structure)
// ════════════════════════════════════
/*----------------------------------------------
  STOCK TAB — individual stock lookup with chart + fundamentals
----------------------------------------------*/
function StockTab({ ex, apiKey }) {
  const [ticker, setTicker] = useState("");
  const [exchange, setExchange] = useState(ex);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [quote, setQuote] = useState(null);
  const [history, setHistory] = useState([]);
  const [funds, setFunds] = useState(null);
  const [period, setPeriod] = useState("6m");
  const [activeTicker, setActiveTicker] = useState("");
  const [activeExchange, setActiveExchange] = useState("");
  const cur = EXC[exchange]?.cur || "USD";

  useEffect(() => { setExchange(ex); }, [ex]);

  const doLookup = async () => {
    const tk = ticker.trim().toUpperCase();
    if (!tk) return;
    if (!apiKey) { setError("Enter your EODHD API key in the bar above to fetch live data."); return; }
    setLoading(true); setError(""); setQuote(null); setHistory([]); setFunds(null);
    setActiveTicker(tk); setActiveExchange(exchange);

    // Fetch quote, history, and fundamentals in parallel
    const [q, h, f] = await Promise.all([
      fetchQuoteSingle(tk, exchange, apiKey),
      fetchEODHistory(tk, exchange, apiKey, period),
      fetchFundamentals(tk, exchange, apiKey),
    ]);

    if (!q || q.error || (!q.close && !h.length)) {
      setError(`No data found for ${tk} on ${exchange}. Check the ticker and exchange.`);
      setLoading(false);
      return;
    }

    setQuote(q);
    setHistory(h.map(d => ({
      date: d.date,
      close: parseFloat(d.adjusted_close || d.close),
      volume: parseInt(d.volume) || 0,
    })));
    setFunds(f);
    setLoading(false);
  };

  // Re-fetch history when period changes (if we have an active ticker)
  useEffect(() => {
    if (!activeTicker || !apiKey) return;
    let cancelled = false;
    (async () => {
      const h = await fetchEODHistory(activeTicker, activeExchange, apiKey, period);
      if (!cancelled && Array.isArray(h)) {
        setHistory(h.map(d => ({
          date: d.date,
          close: parseFloat(d.adjusted_close || d.close),
          volume: parseInt(d.volume) || 0,
        })));
      }
    })();
    return () => { cancelled = true; };
  }, [period]);

  // Extract fundamentals into display groups
  const general = funds?.General || {};
  const highlights = funds?.Highlights || {};
  const valuation = funds?.Valuation || {};
  const technicals = funds?.Technicals || {};
  const sharesStats = funds?.SharesStats || {};

  const fmtB = (v) => {
    if (v == null || v === "N/A" || v === 0) return "\u2014";
    const n = typeof v === "string" ? parseFloat(v) : v;
    if (isNaN(n)) return "\u2014";
    if (Math.abs(n) >= 1e12) return "$" + (n / 1e12).toFixed(2) + "T";
    if (Math.abs(n) >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
    if (Math.abs(n) >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
    return "$" + n.toLocaleString();
  };
  const fmtP = (v) => {
    if (v == null || v === "N/A") return "\u2014";
    const n = typeof v === "string" ? parseFloat(v) : v;
    return isNaN(n) ? "\u2014" : n.toFixed(2) + "%";
  };
  const fmtN = (v) => {
    if (v == null || v === "N/A" || v === 0) return "\u2014";
    const n = typeof v === "string" ? parseFloat(v) : v;
    return isNaN(n) ? "\u2014" : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  };

  const FRow = ({ label, value }) => (
    <div className="stk-fund-row"><span className="fl2">{label}</span><span className="fv2">{value}</span></div>
  );

  const chartColor = quote && parseFloat(quote.change_p) >= 0 ? "var(--grn)" : "var(--red)";

  return (
    <div className="cd fi">
      <div className="cdh">
        <div className="cdt">{"\u{1F4C8}"} Stock Lookup</div>
      </div>
      <div className="stk-search">
        <input className="inp" style={{ maxWidth: 180 }} placeholder="Ticker e.g. CBA, AAPL" value={ticker}
          onChange={e => setTicker(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === "Enter" && doLookup()} />
        <select className="inp" style={{ width: "auto", minWidth: 110 }} value={exchange} onChange={e => setExchange(e.target.value)}>
          {Object.entries(EXC).map(([k, v]) => <option key={k} value={k}>{v.flag} {k}</option>)}
        </select>
        <button className="bn bn-p" onClick={doLookup}>Lookup</button>
        {error && <span style={{ fontSize: 11, color: "var(--red)", marginLeft: 8 }}>{error}</span>}
      </div>

      {loading && (
        <div className="stk-loading">
          <span className="loader" style={{ width: 14, height: 14 }} /> Loading {activeTicker} data{"\u2026"}
        </div>
      )}

      {!loading && !quote && !error && (
        <div className="stk-empty">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 3v18h18"/><path d="m7 14 4-4 4 4 5-5"/></svg>
          <div style={{ fontSize: 13, marginBottom: 4 }}>Enter a ticker to view price chart and fundamentals</div>
          <div style={{ fontSize: 11 }}>Supports ASX, NYSE, and NASDAQ listed securities</div>
        </div>
      )}

      {!loading && quote && (
        <div className="stk-layout">
          {/* Left: Chart */}
          <div>
            <div className="stk-chart">
              <div className="stk-chart-head">
                <div>
                  <div className="stk-name">{general.Name || activeTicker} {general.Exchange ? `\u00B7 ${general.Exchange}` : ""}</div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                    <span className="stk-price">{FM.p(parseFloat(quote.close), cur)}</span>
                    <span className={parseFloat(quote.change_p) >= 0 ? "pos" : "neg"} style={{ fontFamily: "var(--m)", fontSize: 14, fontWeight: 600 }}>
                      {parseFloat(quote.change) >= 0 ? "+" : ""}{parseFloat(quote.change).toFixed(2)} ({FM.pct(parseFloat(quote.change_p))})
                    </span>
                  </div>
                </div>
                <div className="stk-period">
                  {["1m", "3m", "6m", "1y", "2y", "5y"].map(p => (
                    <button key={p} className={period === p ? "on" : ""} onClick={() => setPeriod(p)}>{p.toUpperCase()}</button>
                  ))}
                </div>
              </div>
              {history.length > 0 ? (
                <ResponsiveContainer width="100%" height={280}>
                  <AreaChart data={history} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={chartColor} stopOpacity={0.25} />
                        <stop offset="100%" stopColor={chartColor} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="var(--brd)" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="date" tick={{ fill: "var(--t3)", fontSize: 9, fontFamily: "var(--m)" }} tickLine={false} axisLine={{ stroke: "var(--brd)" }}
                      tickFormatter={v => { const d = new Date(v); return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }); }}
                      interval={Math.max(1, Math.floor(history.length / 6))} />
                    <YAxis tick={{ fill: "var(--t3)", fontSize: 9, fontFamily: "var(--m)" }} tickLine={false} axisLine={false}
                      domain={["auto", "auto"]} tickFormatter={v => (cur === "AUD" ? "A$" : "$") + v.toFixed(v >= 100 ? 0 : 2)} width={58} />
                    <Tooltip
                      contentStyle={{ background: "var(--bg2)", border: "1px solid var(--brd)", borderRadius: 8, fontSize: 11, fontFamily: "var(--m)" }}
                      labelStyle={{ color: "var(--t3)", fontSize: 10, marginBottom: 4 }}
                      formatter={(val) => [FM.p(val, cur), "Close"]}
                      labelFormatter={(v) => new Date(v).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })} />
                    <Area type="monotone" dataKey="close" stroke={chartColor} strokeWidth={1.5} fill="url(#chartFill)" dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ height: 280, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--t3)", fontSize: 12 }}>
                  No historical data available for this period.
                </div>
              )}
            </div>
          </div>

          {/* Right: Fundamentals */}
          <div className="stk-funds">
            {/* Key Stats */}
            <div className="stk-fund-card">
              <h4>{"\u{1F4CA}"} Key Statistics</h4>
              <FRow label="Market Cap" value={fmtB(highlights.MarketCapitalization)} />
              <FRow label="Enterprise Value" value={fmtB(valuation.EnterpriseValue)} />
              <FRow label="P/E Ratio" value={fmtN(highlights.PERatio)} />
              <FRow label="Forward P/E" value={fmtN(valuation.ForwardPE)} />
              <FRow label="PEG Ratio" value={fmtN(highlights.PEGRatio)} />
              <FRow label="EPS" value={fmtN(highlights.EarningsShare)} />
              <FRow label="Revenue (TTM)" value={fmtB(highlights.RevenueTTM)} />
              <FRow label="EBITDA" value={fmtB(highlights.EBITDA)} />
              <FRow label="Profit Margin" value={fmtP(highlights.ProfitMargin ? highlights.ProfitMargin * 100 : null)} />
              <FRow label="Operating Margin" value={fmtP(highlights.OperatingMarginTTM ? highlights.OperatingMarginTTM * 100 : null)} />
            </div>

            {/* Dividends & Yield */}
            <div className="stk-fund-card">
              <h4>{"\u{1F4B0}"} Dividends & Yield</h4>
              <FRow label="Dividend Yield" value={fmtP(highlights.DividendYield ? highlights.DividendYield * 100 : null)} />
              <FRow label="Dividend/Share" value={fmtN(highlights.DividendShare)} />
              <FRow label="Payout Ratio" value={fmtP(highlights.PayoutRatio ? highlights.PayoutRatio * 100 : null)} />
              <FRow label="Return on Equity" value={fmtP(highlights.ReturnOnEquityTTM ? highlights.ReturnOnEquityTTM * 100 : null)} />
              <FRow label="Return on Assets" value={fmtP(highlights.ReturnOnAssetsTTM ? highlights.ReturnOnAssetsTTM * 100 : null)} />
            </div>

            {/* Shares & Ownership */}
            <div className="stk-fund-card">
              <h4>{"\u{1F465}"} Shares & Ownership</h4>
              <FRow label="Shares Outstanding" value={fmtN(sharesStats.SharesOutstanding)} />
              <FRow label="Shares Float" value={fmtN(sharesStats.SharesFloat)} />
              <FRow label="% Insiders" value={fmtP(sharesStats.PercentInsiders)} />
              <FRow label="% Institutions" value={fmtP(sharesStats.PercentInstitutions)} />
              <FRow label="Short Ratio" value={fmtN(sharesStats.ShortRatio)} />
            </div>

            {/* Technicals */}
            <div className="stk-fund-card">
              <h4>{"\u{1F4C9}"} Technicals</h4>
              <FRow label="52-Week High" value={FM.p(parseFloat(technicals["52WeekHigh"]) || 0, cur)} />
              <FRow label="52-Week Low" value={FM.p(parseFloat(technicals["52WeekLow"]) || 0, cur)} />
              <FRow label="50-Day MA" value={FM.p(parseFloat(technicals["50DayMA"]) || 0, cur)} />
              <FRow label="200-Day MA" value={FM.p(parseFloat(technicals["200DayMA"]) || 0, cur)} />
              <FRow label="Beta" value={fmtN(technicals.Beta)} />
            </div>

            {/* Company Info */}
            {general.Sector && (
              <div className="stk-fund-card">
                <h4>{"\u{1F3E2}"} Company Info</h4>
                <FRow label="Sector" value={general.Sector || "\u2014"} />
                <FRow label="Industry" value={general.Industry || "\u2014"} />
                <FRow label="Country" value={general.CountryName || general.Country || "\u2014"} />
                <FRow label="Exchange" value={general.Exchange || activeExchange} />
                {general.WebURL && (
                  <div style={{ marginTop: 6 }}>
                    <a href={general.WebURL} target="_blank" rel="noopener noreferrer" style={{ color: "var(--acc)", textDecoration: "none", fontSize: 11, fontWeight: 500 }}>{general.WebURL.replace(/https?:\/\/(www\.)?/, "")} {"\u2192"}</a>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CalendarTab({ events, setEvents }) {
  const now = new Date();
  const [vY, sY] = useState(now.getFullYear()); const [vM, sM] = useState(now.getMonth());
  const [sd, sSd] = useState(null); const [show, setShow] = useState(false);
  const [ef, setEf] = useState({ date: "", ticker: "", type: "Earnings", title: "", notes: "", exchange: "ASX" });
  const TS = ["Earnings", "Dividend", "Conference", "Regulatory", "Product Launch", "Other"];
  const dim = new Date(vY, vM + 1, 0).getDate(); const fd = new Date(vY, vM, 1).getDay(); const pd = new Date(vY, vM, 0).getDate();
  const ds = (y, m, d) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const tds = ds(now.getFullYear(), now.getMonth(), now.getDate());
  const efd = (d) => events.filter(e => e.date === d);
  const cells = []; for (let i = fd - 1; i >= 0; i--) { const d = pd - i; const m = vM === 0 ? 11 : vM - 1; const y = vM === 0 ? vY - 1 : vY; cells.push({ d, ds: ds(y, m, d), om: true }); } for (let d = 1; d <= dim; d++) cells.push({ d, ds: ds(vY, vM, d), om: false }); const rm = 42 - cells.length; for (let d = 1; d <= rm; d++) { const m = vM === 11 ? 0 : vM + 1; const y = vM === 11 ? vY + 1 : vY; cells.push({ d, ds: ds(y, m, d), om: true }); }
  const ae = () => { if (!ef.date || !ef.title) return; setEvents([...events, { ...ef, id: "e" + Date.now() }]); setEf({ date: "", ticker: "", type: "Earnings", title: "", notes: "", exchange: "ASX" }); setShow(false); };
  const se = sd ? efd(sd) : events.filter(e => { const d = new Date(e.date); return d.getMonth() === vM && d.getFullYear() === vY; }).sort((a, b) => a.date.localeCompare(b.date));
  const ec = (t) => t === "Product Launch" ? "Product" : TS.includes(t) ? t : "Other";
  const mn = new Date(vY, vM).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const tcMap = { Earnings: "bg-g", Dividend: "bg-c", Conference: "bg-p", Regulatory: "bg-a" };
  return (
    <div className="fi"><div className="cl">
      <div className="cd">
        <div className="clh"><div className="cln"><button className="bi" onClick={() => { vM === 0 ? (sM(11), sY(vY - 1)) : sM(vM - 1); }}>{"\u25C0"}</button><div className="clm">{mn}</div><button className="bi" onClick={() => { vM === 11 ? (sM(0), sY(vY + 1)) : sM(vM + 1); }}>{"\u25B6"}</button></div><div style={{ display: "flex", gap: 6 }}><button className="bn bn-s" onClick={() => { sM(now.getMonth()); sY(now.getFullYear()); }}>Today</button><button className="bn bn-s bn-p" onClick={() => { setEf({ ...ef, date: sd || tds }); setShow(true); }}>+ Event</button></div></div>
        <div className="cg">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d => <div key={d} className="cdh2">{d}</div>)}
          {cells.map((c, i) => { const de = efd(c.ds); return (<div key={i} className={`cc ${c.om ? "om" : ""} ${c.ds === tds ? "tod" : ""}`} onClick={() => sSd(c.ds === sd ? null : c.ds)} style={c.ds === sd ? { background: "var(--accd)" } : {}}><div className="ccd">{c.d}</div>{de.slice(0, 2).map(ev => <div key={ev.id} className={`ce ${ec(ev.type)}`}>{ev.ticker ? ev.ticker + " " : ""}{ev.title.length > 10 ? ev.title.slice(0, 10) + "\u2026" : ev.title}</div>)}{de.length > 2 && <div style={{ fontSize: 9, color: "var(--t3)", paddingLeft: 3 }}>+{de.length - 2}</div>}</div>); })}
        </div>
      </div>
      <div className="cd">
        <div className="cdh"><span className="cdt">{sd ? new Date(sd + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : mn + " Events"}</span><span className="bg bg-b">{se.length}</span></div>
        <div className="es">{se.length > 0 ? se.map(ev => (<div key={ev.id} className="ec"><div className="ech"><div style={{ display: "flex", alignItems: "center", gap: 5 }}>{ev.ticker && <span style={{ fontWeight: 700, fontFamily: "var(--m)", fontSize: 11, color: "var(--acc)" }}>{ev.ticker}</span>}{ev.exchange && <span className="bg bg-b">{ev.exchange}</span>}<span className={`bg ${tcMap[ev.type] || "bg-b"}`}>{ev.type}</span></div><button className="bi" onClick={() => setEvents(events.filter(e => e.id !== ev.id))} style={{ color: "var(--t3)" }}>{"\u{1F5D1}"}</button></div><div className="ect">{ev.title}</div><div className="ecd">{new Date(ev.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</div>{ev.notes && <div className="ecn">{ev.notes}</div>}</div>)) : <div style={{ padding: 20, textAlign: "center", color: "var(--t3)", fontSize: 12 }}>{sd ? "No events." : "No events this month."}</div>}</div>
      </div>
    </div>
    {show && <Modal title="New Event" onClose={() => setShow(false)} footer={<><button className="bn" onClick={() => setShow(false)}>Cancel</button><button className="bn bn-p" onClick={ae}>Add Event</button></>}>
      <div style={{ display: "flex", gap: 8 }}><div className="fr" style={{ flex: 1 }}><label className="fl">Date</label><input className="inp" type="date" value={ef.date} onChange={e => setEf({ ...ef, date: e.target.value })} /></div><div className="fr" style={{ flex: 1 }}><label className="fl">Type</label><select className="inp" value={ef.type} onChange={e => setEf({ ...ef, type: e.target.value })}>{TS.map(t => <option key={t} value={t}>{t}</option>)}</select></div></div>
      <div style={{ display: "flex", gap: 8 }}><div className="fr" style={{ flex: 1 }}><label className="fl">Ticker</label><input className="inp" placeholder="e.g. CBA" value={ef.ticker} onChange={e => setEf({ ...ef, ticker: e.target.value.toUpperCase() })} /></div><div className="fr" style={{ flex: 1 }}><label className="fl">Exchange</label><select className="inp" value={ef.exchange} onChange={e => setEf({ ...ef, exchange: e.target.value })}>{Object.keys(EXC).map(k => <option key={k} value={k}>{k}</option>)}</select></div></div>
      <div className="fr"><label className="fl">Title</label><input className="inp" placeholder="Event title" value={ef.title} onChange={e => setEf({ ...ef, title: e.target.value })} /></div>
      <div className="fr"><label className="fl">Notes</label><input className="inp" placeholder="Details\u2026" value={ef.notes} onChange={e => setEf({ ...ef, notes: e.target.value })} /></div>
    </Modal>}
    </div>
  );
}

// ════════════════════════════════════
// MAIN APP
// ════════════════════════════════════
export default function App() {
  const [tab, setTab] = useState("screener");
  const [ex, setEx] = useState("ASX");
  const [pfs, setPfs] = useState([]);
  const [evts, setEvts] = useState([]);
  const [wl, setWl] = useState([]);
  const [ld, setLd] = useState(true);
  const [pft, setPft] = useState("");
  const [clk, setClk] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiInput, setApiInput] = useState("");
  const [liveData, setLiveData] = useState({});
  const [fetching, setFetching] = useState(false);
  const [fetchStatus, setFetchStatus] = useState("");
  const fetchRef = useRef(null);

  useEffect(() => {
    (async () => {
      const [p, e, w, k] = await Promise.all([
        load("fd-pf", [{ name: "Personal", holdings: [] }, { name: "SMSF", holdings: [] }, { name: "Family Trust", holdings: [] }]),
        load("fd-ev", DEFAULT_EVENTS),
        load("fd-wl", ["CBA", "BHP", "AAPL", "NVDA"]),
        load("fd-apikey", ""),
      ]);
      setPfs(p); setEvts(e); setWl(w); setApiKey(k); setApiInput(k); setLd(false);
    })();
  }, []);

  useEffect(() => { if (!ld) save("fd-pf", pfs); }, [pfs, ld]);
  useEffect(() => { if (!ld) save("fd-ev", evts); }, [evts, ld]);
  useEffect(() => { if (!ld) save("fd-wl", wl); }, [wl, ld]);
  useEffect(() => {
    const u = () => setClk(new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    u(); const id = setInterval(u, 1000); return () => clearInterval(id);
  }, []);

  // Fetch live quotes when apiKey changes or exchange changes
  // Always fetch on connect/exchange-change. Only gate the AUTO-REFRESH on market hours.
  const doFetch = useCallback(async () => {
    if (!apiKey) return;
    setFetching(true);
    setFetchStatus("Fetching data\u2026");

    // Strategy 1: Try bulk EOD endpoint (returns ALL tickers for exchange in 1 call, paid plans)
    try {
      const bulkData = await fetchBulkEOD(ex, apiKey);
      if (bulkData && Object.keys(bulkData).length > 0) {
        const normalized = {};
        for (const [code, row] of Object.entries(bulkData)) {
          const prevClose = parseFloat(row.previous_close) || parseFloat(row.close) || 0;
          const close = parseFloat(row.close) || parseFloat(row.adjusted_close) || 0;
          normalized[code] = {
            code,
            close,
            open: parseFloat(row.open) || 0,
            high: parseFloat(row.high) || 0,
            low: parseFloat(row.low) || 0,
            volume: parseInt(row.volume) || 0,
            previousClose: prevClose,
            change: close - prevClose,
            change_p: prevClose > 0 ? ((close - prevClose) / prevClose * 100) : 0,
          };
        }
        setLiveData(prev => ({ ...prev, ...normalized }));
        setFetchStatus(`Bulk EOD: ${Object.keys(normalized).length} tickers loaded`);
        setFetching(false);
        return;
      }
    } catch (e) {
      console.warn("Bulk EOD failed, trying individual quotes:", e);
    }

    // Strategy 2: Fall back to individual real-time quotes for mock tickers
    setFetchStatus("Bulk unavailable, fetching individual quotes\u2026");
    const stocks = MOCK[ex] || [];
    const syms = stocks.map(s => s.ticker);
    const data = await fetchQuotes(syms, apiKey, ex);
    const count = Object.keys(data).length;
    if (count > 0) {
      setLiveData(prev => ({ ...prev, ...data }));
      setFetchStatus(`Live quotes: ${count}/${syms.length} tickers updated`);
    } else {
      setFetchStatus("No data returned \u2014 check API key or plan");
    }
    setFetching(false);
  }, [apiKey, ex]);

  useEffect(() => {
    if (apiKey) doFetch(); // Always fetch immediately on connect
    // Auto-refresh every 5 minutes ONLY during market hours
    if (fetchRef.current) clearInterval(fetchRef.current);
    if (apiKey) {
      fetchRef.current = setInterval(() => { if (isMarketOpen(ex)) doFetch(); }, 5 * 60 * 1000);
    }
    return () => { if (fetchRef.current) clearInterval(fetchRef.current); };
  }, [apiKey, ex, doFetch]);

  const saveApiKey = () => { setApiKey(apiInput.trim()); save("fd-apikey", apiInput.trim()); };

  if (ld) return <div className="app"><style>{CSS}</style><div style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1, color: "var(--t3)" }}>Loading{"\u2026"}</div></div>;

  return (
    <div className="app">
      <style>{CSS}</style>
      <nav className="tn">
        <div className="tn-b">
          <div className="tn-logo">F</div>
          <div className="tn-t">FinanceDesk</div>
          <div className="exc">
            {Object.entries(EXC).map(([k, v]) => (
              <button key={k} className={ex === k ? "on" : ""} onClick={() => setEx(k)}>{v.flag} {k}</button>
            ))}
          </div>
          {fetching && <span className="loader">Fetching</span>}
        </div>
        <div className="tabs">
          {[["screener", "\u{1F50D} Screener"], ["stock", "\u{1F4C8} Stock"], ["portfolio", "\u{1F4BC} Portfolio"], ["calendar", "\u{1F4C5} Calendar"]].map(([k, l]) => (
            <button key={k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        <div style={{ fontFamily: "var(--m)", fontSize: 11, color: "var(--t3)" }}>{clk}</div>
      </nav>

      {/* API Key Config Bar */}
      <div className="api-cfg">
        <label>EODHD API Key</label>
        <input className="inp" style={{ maxWidth: 280 }} type="password" placeholder="Paste your API key here\u2026" value={apiInput} onChange={e => setApiInput(e.target.value)} onKeyDown={e => e.key === "Enter" && saveApiKey()} />
        <button className="bn bn-s bn-p" onClick={saveApiKey}>Connect</button>
        {apiKey && <button className="bn bn-s" onClick={doFetch} disabled={fetching}>{fetching ? "\u23F3" : "\u{1F504}"} Refresh</button>}
        {apiKey && <span style={{ fontSize: 10, color: "var(--grn)", fontFamily: "var(--m)" }}>{"\u2713"} Connected</span>}
        {fetchStatus && <span style={{ fontSize: 10, color: "var(--t2)", fontFamily: "var(--m)" }}>{fetchStatus}</span>}
        {!apiKey && <span style={{ fontSize: 10, color: "var(--t3)" }}>Free key at <a href="https://eodhd.com/register" target="_blank" rel="noopener noreferrer" style={{ color: "var(--acc)", textDecoration: "none" }}>eodhd.com</a> \u2014 Free: 20 calls/day. $19.99/mo: unlimited EOD + live delayed for ASX, NYSE, NASDAQ</span>}
      </div>

      <div className="ct">
        {tab === "screener" && <Screener ex={ex} wl={wl} setWl={setWl} addToPf={tk => { setPft(tk); setTab("portfolio"); }} apiKey={apiKey} liveData={liveData} />}
        {tab === "stock" && <StockTab ex={ex} apiKey={apiKey} />}
        {tab === "portfolio" && <Portfolio pfs={pfs} setPfs={setPfs} pft={pft} ex={ex} liveData={liveData} apiKey={apiKey} />}
        {tab === "calendar" && <CalendarTab events={evts} setEvents={setEvts} />}
      </div>
    </div>
  );
}
