"""
FinanceDesk — Flask + yfinance personal finance application.

Two-tier data strategy:
  TIER 1 — Prices: bulk yf.download(), refreshed every 15 min (~30-60s)
  TIER 2 — Fundamentals: per-ticker .info, cached 24h (run separately)
"""

import json, math, time, threading, csv, urllib.request, traceback
from pathlib import Path
from flask import Flask, render_template, jsonify, request
import yfinance as yf
import pandas as pd

app = Flask(__name__)
DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)
CACHE_DIR = Path(__file__).parent / "cache"
CACHE_DIR.mkdir(exist_ok=True)

# ---------------------------------------------------------------------------
# Persistence & Cache
# ---------------------------------------------------------------------------
def _load(name, default=None):
    p = DATA_DIR / f"{name}.json"
    return json.loads(p.read_text()) if p.exists() else (default if default is not None else [])

def _save(name, data):
    (DATA_DIR / f"{name}.json").write_text(json.dumps(data, indent=2))

_cache_file_lock = threading.Lock()

def _cache_read(key):
    with _cache_file_lock:
        p = CACHE_DIR / f"{key}.json"
        if p.exists():
            try:
                c = json.loads(p.read_text())
                return c.get("data"), c.get("ts", 0)
            except Exception as e:
                print(f"[FD] Cache read error for {key}: {e}")
        return None, 0

def _cache_write(key, data):
    with _cache_file_lock:
        try:
            p = CACHE_DIR / f"{key}.json"
            content = json.dumps({"data": data, "ts": time.time()})
            p.write_text(content)
        except Exception as e:
            print(f"[FD] Cache write error for {key}: {e}")

EXCHANGE_SUFFIX = {"AU": ".AX", "US": ""}
PRICE_TTL = 900   # 15 min
FUND_TTL = 86400  # 24 hours

def yf_sym(ticker, exchange):
    return f"{ticker}{EXCHANGE_SUFFIX.get(exchange, '')}"

def safe_float(v, default=0):
    if v is None: return default
    try:
        f = float(v)
        return default if (math.isnan(f) or math.isinf(f)) else f
    except (ValueError, TypeError):
        return default

# ---------------------------------------------------------------------------
# TIER 0 — Ticker list from ASX CSV
# ---------------------------------------------------------------------------
ASX_CSV_URL = "https://www.asx.com.au/asx/research/ASXListedCompanies.csv"
_ticker_meta = {"AU": {"names": {}, "sectors": {}}, "US": {"names": {}, "sectors": {}}}

def _download_asx_tickers():
    try:
        req = urllib.request.Request(ASX_CSV_URL, headers={"User-Agent": "FinanceDesk/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        tickers, names, sectors = [], {}, {}
        for row in csv.reader(raw.splitlines()):
            if len(row) < 2: continue
            code = row[1].strip().strip('"')
            gics = row[2].strip().strip('"') if len(row) >= 3 else ""
            name = row[0].strip().strip('"')
            if code == "ASX code" or not code: continue
            if gics in ("Not Applic", "Class Pend"): continue
            tickers.append(code)
            names[code] = name.title()
            sectors[code] = gics
        tickers = list(dict.fromkeys(tickers))
        return tickers, names, sectors
    except Exception as e:
        print(f"[FD] ASX CSV download failed: {e}")
        return None, {}, {}

_SEED_AU = ["CBA","BHP","CSL","WBC","NAB","ANZ","WES","MQG","FMG","WOW","TLS","RIO","GMG","WDS","TCL","ALL","REA","COL","SHL","JHX","NXT","XRO","STO","QBE","ORG"]
_SEED_US = ["AAPL","MSFT","GOOGL","AMZN","NVDA","META","TSLA","BRK-B","JPM","V","JNJ","WMT","XOM","PG","MA","UNH","HD","CVX","MRK","ABBV","KO","PEP","AVGO","LLY","COST","NFLX","DIS","CRM","ORCL","PLTR","UBER","BAC","C","GS","F","GM"]

def _discover_tickers(exchange):
    cached, ts = _cache_read(f"tickers_{exchange}")
    if cached and (time.time() - ts) < 86400:
        # Reload meta if available
        if exchange == "AU" and not _ticker_meta["AU"]["names"]:
            _, names, sectors = _download_asx_tickers()
            if names:
                _ticker_meta["AU"]["names"] = names
                _ticker_meta["AU"]["sectors"] = sectors
        return cached
    if exchange == "AU":
        tickers, names, sectors = _download_asx_tickers()
        if tickers and len(tickers) > 100:
            _cache_write(f"tickers_{exchange}", tickers)
            _ticker_meta["AU"]["names"] = names
            _ticker_meta["AU"]["sectors"] = sectors
            print(f"[FD] Downloaded {len(tickers)} ASX tickers")
            return tickers
        return _SEED_AU
    return _SEED_US

# ---------------------------------------------------------------------------
# TIER 1 — Bulk prices via yf.download()
# ---------------------------------------------------------------------------
_progress = {}  # {exchange: {done, total, status, phase}}

def _bulk_fetch_prices(exchange):
    """Fetch prices for all tickers using yf.download(). Handles various yfinance column formats."""
    tickers = _discover_tickers(exchange)
    symbols = [yf_sym(t, exchange) for t in tickers]
    total = len(symbols)
    _progress[exchange] = {"done": 0, "total": total, "status": "prices", "phase": "Downloading prices..."}

    prices = {}
    batch_size = 200  # Smaller batches for reliability

    for i in range(0, total, batch_size):
        batch_syms = symbols[i:i+batch_size]
        batch_tickers = tickers[i:i+batch_size]
        batch_num = i // batch_size + 1
        _progress[exchange]["phase"] = f"Prices batch {batch_num} of {math.ceil(total/batch_size)}..."

        try:
            # Use group_by="ticker" so columns are organized by ticker symbol
            df = yf.download(
                batch_syms,
                period="5d",  # 5 days for safety (weekends/holidays)
                progress=False,
                threads=True,
                group_by="ticker",
                auto_adjust=True,
            )

            if df is None or df.empty:
                print(f"[FD] Batch {batch_num}: empty DataFrame")
                _progress[exchange]["done"] = min(i + batch_size, total)
                continue

            is_multi = isinstance(df.columns, pd.MultiIndex)
            col_level_0 = list(df.columns.get_level_values(0).unique()) if is_multi else []

            for j, sym in enumerate(batch_syms):
                ticker = batch_tickers[j]
                try:
                    # For single ticker, df is flat (Close, Open, etc.)
                    if len(batch_syms) == 1:
                        sub = df
                    elif not is_multi:
                        sub = df
                    else:
                        # Try full symbol first (CBA.AX), then just ticker (CBA)
                        if sym in col_level_0:
                            sub = df[sym]
                        elif ticker in col_level_0:
                            sub = df[ticker]
                        else:
                            continue

                    # Drop NaN rows for this ticker
                    if "Close" not in sub.columns:
                        continue
                    sub = sub.dropna(subset=["Close"])
                    if len(sub) < 1:
                        continue

                    last_close = float(sub["Close"].iloc[-1])
                    prev_close = float(sub["Close"].iloc[-2]) if len(sub) >= 2 else last_close
                    if last_close <= 0 or pd.isna(last_close):
                        continue

                    vol = 0
                    try:
                        if "Volume" in sub.columns:
                            v = sub["Volume"].iloc[-1]
                            if not pd.isna(v): vol = int(v)
                    except: pass

                    change_p = ((last_close - prev_close) / prev_close * 100) if prev_close > 0 else 0
                    prices[ticker] = {"price": round(last_close, 4), "change_p": round(change_p, 2), "volume": vol}
                except Exception as ex:
                    pass  # Skip individual ticker errors silently

        except Exception as e:
            print(f"[FD] Batch {batch_num} error: {e}")
            traceback.print_exc()

        _progress[exchange]["done"] = min(i + batch_size, total)
        time.sleep(0.5)  # Brief pause between batches

    _cache_write(f"prices_{exchange}", prices)
    print(f"[FD] Prices done: {len(prices)} of {total} tickers for {exchange}")
    return prices


def _get_prices(exchange):
    """Return cached prices (even if stale). None only if no cache at all."""
    cached, _ = _cache_read(f"prices_{exchange}")
    return cached

# ---------------------------------------------------------------------------
# TIER 2 — Fundamentals (slow, cached 24h, runs separately)
# ---------------------------------------------------------------------------
def _fetch_fundamentals_batch(exchange):
    tickers = _discover_tickers(exchange)
    cached_funds, _ = _cache_read(f"funds_{exchange}")
    existing = cached_funds or {}
    total = len(tickers)
    _progress[exchange] = {"done": 0, "total": total, "status": "fundamentals", "phase": "Fetching fundamentals..."}

    count = 0
    errors = 0
    rate_limited = False
    for i, ticker in enumerate(tickers):
        if ticker in existing and existing[ticker].get("mktcap", 0) > 0:
            _progress[exchange]["done"] = i + 1
            continue

        if rate_limited:
            _progress[exchange]["phase"] = f"Rate limited \u2014 pausing 60s... ({count} done)"
            _cache_write(f"funds_{exchange}", existing)
            time.sleep(60)
            rate_limited = False

        try:
            info = yf.Ticker(yf_sym(ticker, exchange)).info or {}
            mktcap = safe_float(info.get("marketCap"))
            if mktcap > 0 or info.get("sector"):
                existing[ticker] = {
                    "name": info.get("shortName") or info.get("longName") or ticker,
                    "sector": info.get("sector", ""),
                    "mktcap": mktcap,
                    "ev": safe_float(info.get("enterpriseValue")),
                    "pe": round(safe_float(info.get("trailingPE")), 1),
                    "divYield": round(safe_float(info.get("dividendYield")) * 100, 2),
                    "insiderPct": round(safe_float(info.get("heldPercentInsiders")) * 100, 1),
                    "instPct": round(safe_float(info.get("heldPercentInstitutions")) * 100, 1),
                    "cash": safe_float(info.get("totalCash")),
                }
                count += 1
                if count <= 3 or count % 100 == 0:
                    print(f"[FD] Fund {count}: {ticker} mktcap={mktcap}")
        except Exception as e:
            err_str = str(e)
            if "Rate" in err_str or "Too Many" in err_str or "429" in err_str or "401" in err_str:
                rate_limited = True
            errors += 1

        _progress[exchange]["done"] = i + 1
        _progress[exchange]["phase"] = f"Fundamentals: {count} fetched, {i+1}/{total}..."
        if count > 0 and count % 50 == 0:
            _cache_write(f"funds_{exchange}", existing)
        time.sleep(1)  # 1 second between each request

    _cache_write(f"funds_{exchange}", existing)
    print(f"[FD] Fundamentals: {count} new, {errors} errors, {len(existing)} total for {exchange}")
    return existing

def _get_fundamentals(exchange):
    cached, _ = _cache_read(f"funds_{exchange}")
    if not cached:
        return {}
    # Sanitize: remove any inf/nan values that snuck into cache
    for ticker, data in cached.items():
        if isinstance(data, dict):
            for k, v in data.items():
                if isinstance(v, float) and (math.isinf(v) or math.isnan(v)):
                    data[k] = 0
    return cached

# ---------------------------------------------------------------------------
# Combine into screener rows
# ---------------------------------------------------------------------------
def _build_screener_data(exchange):
    tickers = _discover_tickers(exchange)
    prices = _get_prices(exchange) or {}
    funds = _get_fundamentals(exchange) or {}
    meta = _ticker_meta.get(exchange, {"names": {}, "sectors": {}})

    # Debug: log data availability
    price_count = len(prices)
    fund_count = len(funds)
    fund_with_mktcap = sum(1 for f in funds.values() if f.get("mktcap", 0) > 0)
    print(f"[FD] Building screener: {len(tickers)} tickers, {price_count} prices, {fund_count} funds ({fund_with_mktcap} with mktcap)")

    rows = []
    for ticker in tickers:
        p = prices.get(ticker)
        f = funds.get(ticker, {})
        if not p and not f:
            continue
        price = p["price"] if p else 0
        rows.append({
            "ticker": ticker,
            "name": f.get("name") or meta["names"].get(ticker, ticker),
            "price": price,
            "change_p": p["change_p"] if p else 0,
            "volume": p["volume"] if p else 0,
            "mktcap": f.get("mktcap", 0),
            "ev": f.get("ev", 0),
            "pe": f.get("pe", 0),
            "divYield": f.get("divYield", 0),
            "insiderPct": f.get("insiderPct", 0),
            "instPct": f.get("instPct", 0),
            "cash": f.get("cash", 0),
            "sector": f.get("sector") or meta["sectors"].get(ticker, ""),
        })

    rows.sort(key=lambda x: x.get("mktcap", 0) or x.get("price", 0), reverse=True)
    return rows

# ---------------------------------------------------------------------------
# Background fetch — prices and fundamentals run as SEPARATE operations
# ---------------------------------------------------------------------------
_fetch_lock = threading.Lock()

def _do_price_fetch(exchange):
    """Prices only — fast. After completion, kicks off fundamentals for all tickers in background."""
    if not _fetch_lock.acquire(blocking=False):
        _progress[exchange] = {"done": 0, "total": 0, "status": "blocked", "phase": "Another fetch is running..."}
        return
    try:
        _bulk_fetch_prices(exchange)
        total = len(_discover_tickers(exchange))
        _progress[exchange] = {"done": total, "total": total, "status": "done", "phase": "Prices updated"}
    except Exception as e:
        print(f"[FD] Price fetch crashed: {e}")
        traceback.print_exc()
        _progress[exchange] = {"done": 0, "total": 0, "status": "done", "phase": f"Error: {e}"}
    finally:
        _fetch_lock.release()

    # After prices done, start fetching fundamentals for ALL tickers that don't have them yet
    # Runs in a separate thread, doesn't block the UI, saves checkpoints every 50 tickers
    _, fund_ts = _cache_read(f"funds_{exchange}")
    if (time.time() - fund_ts) > FUND_TTL or not fund_ts:
        threading.Thread(target=_fetch_all_fundamentals_bg, args=(exchange,), daemon=True).start()
    else:
        print(f"[FD] Fundamentals cache still fresh ({round((time.time()-fund_ts)/3600,1)}h old), skipping")

def _fetch_all_fundamentals_bg(exchange):
    """Wrapper that sets running flag."""
    _fundamentals_running[exchange] = True
    try:
        _fetch_all_fundamentals_inner(exchange)
    finally:
        _fundamentals_running[exchange] = False
        print(f"[FD] Fundamentals thread finished for {exchange}")

def _fetch_all_fundamentals_inner(exchange):
    """Fetch fundamentals for ALL tickers missing from cache. Runs in background with rate-limit handling."""
    tickers = _discover_tickers(exchange)
    funds_cache, _ = _cache_read(f"funds_{exchange}")
    existing = funds_cache or {}

    need = [t for t in tickers if t not in existing or existing[t].get("mktcap", 0) == 0]
    if not need:
        print(f"[FD] All {len(existing)} tickers already have fundamentals cached")
        return

    print(f"[FD] Background fundamentals: {len(need)} tickers to fetch ({len(existing)} already cached)...")
    count = 0
    errors = 0
    rate_limited = False

    for i, ticker in enumerate(need):
        # If we got rate limited, wait longer before retrying
        if rate_limited:
            print(f"[FD] Rate limited — pausing 60s before continuing (at {count} fetched, {errors} errors)...")
            _cache_write(f"funds_{exchange}", existing)  # Save what we have
            time.sleep(60)
            rate_limited = False

        try:
            info = yf.Ticker(yf_sym(ticker, exchange)).info or {}
            mktcap = safe_float(info.get("marketCap"))
            existing[ticker] = {
                "name": info.get("shortName") or info.get("longName") or ticker,
                "sector": info.get("sector", ""),
                "mktcap": mktcap,
                "ev": safe_float(info.get("enterpriseValue")),
                "pe": round(safe_float(info.get("trailingPE")), 1),
                "divYield": round(safe_float(info.get("dividendYield")) * 100, 2),
                "insiderPct": round(safe_float(info.get("heldPercentInsiders")) * 100, 1),
                "instPct": round(safe_float(info.get("heldPercentInstitutions")) * 100, 1),
                "cash": safe_float(info.get("totalCash")),
            }
            count += 1
            if count <= 5 or count % 100 == 0:
                print(f"[FD] Fund {count}/{len(need)}: {ticker} mktcap={mktcap}")
        except Exception as e:
            err_str = str(e)
            if "Rate" in err_str or "Too Many" in err_str or "429" in err_str:
                rate_limited = True
                errors += 1
            elif "401" in err_str or "Unauthorized" in err_str:
                rate_limited = True
                errors += 1
            else:
                errors += 1
                if errors <= 5:
                    print(f"[FD] Fund error {ticker}: {e}")

        # Save checkpoint every 50 successful fetches
        if count > 0 and count % 50 == 0:
            _cache_write(f"funds_{exchange}", existing)
            print(f"[FD] Checkpoint: {count} fetched, {len(existing)} total cached")

        # Polite delay: 1 second between each request to avoid rate limits
        time.sleep(1)

    _cache_write(f"funds_{exchange}", existing)
    print(f"[FD] Background fundamentals complete: {count} fetched, {errors} errors, {len(existing)} total")

def _do_full_fetch(exchange):
    """Prices first (fast), then ALL fundamentals (slow). UI keeps polling throughout."""
    if not _fetch_lock.acquire(blocking=False):
        _progress[exchange] = {"done": 0, "total": 0, "status": "blocked", "phase": "Another fetch is running..."}
        return
    try:
        # Phase 1: Prices (fast)
        _bulk_fetch_prices(exchange)
        total = len(_discover_tickers(exchange))
        print(f"[FD] Full fetch: prices done, starting fundamentals for {total} tickers...")

        # Phase 2: Fundamentals (slow) — go straight into it, don't set "done" in between
        _fetch_fundamentals_batch(exchange)
        _progress[exchange] = {"done": total, "total": total, "status": "done", "phase": "Complete"}
    except Exception as e:
        print(f"[FD] Full fetch crashed: {e}")
        traceback.print_exc()
        total = len(_discover_tickers(exchange))
        _progress[exchange] = {"done": total, "total": total, "status": "done", "phase": f"Error: {e}"}
    finally:
        _fetch_lock.release()

# Auto-refresh prices every 60 seconds (pauses while fundamentals are running)
PRICE_REFRESH = 60
_auto_refresh_started = {}
_fundamentals_running = {}  # Track if fundamentals thread is active

def _start_auto_refresh(exchange):
    if _auto_refresh_started.get(exchange): return
    def _loop():
        while True:
            time.sleep(PRICE_REFRESH)
            if _fundamentals_running.get(exchange):
                continue  # Don't compete with fundamentals for rate limits
            try:
                if _fetch_lock.acquire(blocking=False):
                    try: _bulk_fetch_prices(exchange)
                    finally: _fetch_lock.release()
            except Exception as e: print(f"[FD] Auto-refresh error: {e}")
    _auto_refresh_started[exchange] = True
    threading.Thread(target=_loop, daemon=True).start()
    print(f"[FD] Price auto-refresh started for {exchange} (every {PRICE_REFRESH}s)")

# ---------------------------------------------------------------------------
# Mock data
# ---------------------------------------------------------------------------
MOCK_STOCKS = {
    "AU": [
        {"ticker":"CBA","name":"Commonwealth Bank","price":128.45,"change_p":0.97,"mktcap":218e9,"pe":22.1,"volume":3200000,"sector":"Financials","ev":230e9,"divYield":3.4,"insiderPct":0.1,"instPct":38.0,"cash":45e9},
        {"ticker":"BHP","name":"BHP Group","price":44.50,"change_p":-0.52,"mktcap":195e9,"pe":11.5,"volume":5400000,"sector":"Materials","ev":215e9,"divYield":5.1,"insiderPct":0.2,"instPct":42.0,"cash":12e9},
        {"ticker":"CSL","name":"CSL Limited","price":295.00,"change_p":1.23,"mktcap":142e9,"pe":38.2,"volume":1200000,"sector":"Healthcare","ev":155e9,"divYield":1.0,"insiderPct":0.5,"instPct":55.0,"cash":3.2e9},
        {"ticker":"WBC","name":"Westpac","price":28.90,"change_p":0.35,"mktcap":98e9,"pe":14.8,"volume":4100000,"sector":"Financials","ev":105e9,"divYield":4.8,"insiderPct":0.1,"instPct":35.0,"cash":38e9},
        {"ticker":"NAB","name":"National Australia Bank","price":35.60,"change_p":-0.28,"mktcap":97e9,"pe":13.9,"volume":3700000,"sector":"Financials","ev":110e9,"divYield":4.5,"insiderPct":0.1,"instPct":36.0,"cash":35e9},
        {"ticker":"FMG","name":"Fortescue","price":20.50,"change_p":-1.85,"mktcap":63e9,"pe":8.2,"volume":8200000,"sector":"Materials","ev":72e9,"divYield":8.5,"insiderPct":36.0,"instPct":25.0,"cash":5.5e9},
        {"ticker":"WES","name":"Wesfarmers","price":73.10,"change_p":0.42,"mktcap":83e9,"pe":30.5,"volume":1500000,"sector":"Consumer Discretionary","ev":90e9,"divYield":2.8,"insiderPct":1.2,"instPct":48.0,"cash":2.5e9},
        {"ticker":"MQG","name":"Macquarie Group","price":210.00,"change_p":1.15,"mktcap":80e9,"pe":18.7,"volume":800000,"sector":"Financials","ev":95e9,"divYield":2.5,"insiderPct":0.8,"instPct":40.0,"cash":18e9},
        {"ticker":"WOW","name":"Woolworths","price":33.40,"change_p":-0.15,"mktcap":42e9,"pe":25.1,"volume":2200000,"sector":"Consumer Staples","ev":52e9,"divYield":2.9,"insiderPct":0.3,"instPct":45.0,"cash":1.8e9},
        {"ticker":"TLS","name":"Telstra","price":3.95,"change_p":0.25,"mktcap":47e9,"pe":22.0,"volume":12000000,"sector":"Communication Services","ev":60e9,"divYield":4.2,"insiderPct":0.1,"instPct":30.0,"cash":1.2e9},
    ],
    "US": [
        {"ticker":"AAPL","name":"Apple","price":178.50,"change_p":0.85,"mktcap":2.8e12,"pe":28.5,"volume":52000000,"sector":"Technology","ev":2.85e12,"divYield":0.5,"insiderPct":0.1,"instPct":60.0,"cash":62e9},
        {"ticker":"MSFT","name":"Microsoft","price":420.00,"change_p":1.12,"mktcap":3.1e12,"pe":35.2,"volume":22000000,"sector":"Technology","ev":3.05e12,"divYield":0.7,"insiderPct":0.1,"instPct":72.0,"cash":80e9},
        {"ticker":"NVDA","name":"NVIDIA","price":880.00,"change_p":2.50,"mktcap":2.2e12,"pe":68.0,"volume":40000000,"sector":"Technology","ev":2.18e12,"divYield":0.02,"insiderPct":4.0,"instPct":65.0,"cash":26e9},
        {"ticker":"GOOGL","name":"Alphabet","price":155.00,"change_p":0.65,"mktcap":1.9e12,"pe":24.8,"volume":25000000,"sector":"Technology","ev":1.8e12,"divYield":0.0,"insiderPct":5.8,"instPct":62.0,"cash":110e9},
        {"ticker":"TSLA","name":"Tesla","price":175.00,"change_p":-1.20,"mktcap":550e9,"pe":48.0,"volume":80000000,"sector":"Consumer Discretionary","ev":540e9,"divYield":0.0,"insiderPct":13.0,"instPct":44.0,"cash":22e9},
        {"ticker":"JPM","name":"JPMorgan Chase","price":198.00,"change_p":0.45,"mktcap":570e9,"pe":11.5,"volume":8000000,"sector":"Financials","ev":600e9,"divYield":2.3,"insiderPct":0.5,"instPct":70.0,"cash":580e9},
    ],
}

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.route("/")
def index(): return render_template("index.html")

@app.route("/api/tickers")
def api_tickers():
    exchange = request.args.get("exchange", "AU")
    return jsonify({"exchange": exchange, "count": len(_discover_tickers(exchange))})

@app.route("/api/screener")
def api_screener():
    exchange = request.args.get("exchange", "AU")
    prices = _get_prices(exchange)
    if prices:
        try:
            data = _build_screener_data(exchange)
            return jsonify(data)
        except Exception as e:
            print(f"[FD] ERROR in /api/screener: {e}")
            traceback.print_exc()
    return jsonify(MOCK_STOCKS.get(exchange, []))

@app.route("/api/screener/fetch-live", methods=["POST"])
def screener_fetch_live():
    data = request.json or {}
    exchange = data.get("exchange", "AU")
    mode = data.get("mode", "prices")

    prog = _progress.get(exchange, {})
    if prog.get("status") in ("prices", "fundamentals"):
        return jsonify({"status": "already_running", "progress": prog})

    tickers = _discover_tickers(exchange)
    if mode == "full":
        threading.Thread(target=_do_full_fetch, args=(exchange,), daemon=True).start()
    else:
        threading.Thread(target=_do_price_fetch, args=(exchange,), daemon=True).start()

    _start_auto_refresh(exchange)
    return jsonify({"status": "started", "progress": {"done": 0, "total": len(tickers), "status": "starting", "phase": "Starting..."}})

@app.route("/api/screener/progress")
def screener_progress():
    exchange = request.args.get("exchange", "AU")
    prog = _progress.get(exchange, {"done": 0, "total": 0, "status": "idle", "phase": ""})
    result = {"progress": prog}
    if prog.get("status") == "done":
        result["data"] = _build_screener_data(exchange)
    return jsonify(result)

@app.route("/api/screener/fetch-funds", methods=["POST"])
def screener_fetch_funds():
    """Fetch fundamentals for a specific list of tickers (on-demand, for current page)."""
    data = request.json or {}
    exchange = data.get("exchange", "AU")
    tickers_needed = data.get("tickers", [])
    if not tickers_needed:
        return jsonify({"fetched": 0})

    cached_funds, _ = _cache_read(f"funds_{exchange}")
    existing = cached_funds or {}

    count = 0
    for ticker in tickers_needed:
        # Skip only if we already have meaningful data
        if ticker in existing and existing[ticker].get("mktcap", 0) > 0:
            continue
        try:
            info = yf.Ticker(yf_sym(ticker, exchange)).info or {}
            mktcap = safe_float(info.get("marketCap"))
            print(f"[FD] On-demand fund {ticker}: mktcap={mktcap}, pe={info.get('trailingPE')}, keys={len(info)}")
            existing[ticker] = {
                "name": info.get("shortName") or info.get("longName") or ticker,
                "sector": info.get("sector", ""),
                "mktcap": mktcap,
                "ev": safe_float(info.get("enterpriseValue")),
                "pe": round(safe_float(info.get("trailingPE")), 1),
                "divYield": round(safe_float(info.get("dividendYield")) * 100, 2),
                "insiderPct": round(safe_float(info.get("heldPercentInsiders")) * 100, 1),
                "instPct": round(safe_float(info.get("heldPercentInstitutions")) * 100, 1),
                "cash": safe_float(info.get("totalCash")),
            }
            count += 1
        except Exception as e:
            print(f"[FD] On-demand fund error {ticker}: {e}")

    if count > 0:
        _cache_write(f"funds_{exchange}", existing)
    print(f"[FD] On-demand: fetched {count} of {len(tickers_needed)} requested")

    return jsonify({"fetched": count, "total_cached": len(existing)})

@app.route("/api/debug/cache")
def debug_cache():
    """Debug endpoint - shows sample cache data and raw file info."""
    exchange = request.args.get("exchange", "AU")
    prices, p_ts = _cache_read(f"prices_{exchange}")
    funds, f_ts = _cache_read(f"funds_{exchange}")
    tickers, t_ts = _cache_read(f"tickers_{exchange}")

    # Raw file checks
    import os
    files_info = {}
    for name in [f"tickers_{exchange}", f"prices_{exchange}", f"funds_{exchange}"]:
        p = CACHE_DIR / f"{name}.json"
        if p.exists():
            size = os.path.getsize(p)
            files_info[name] = f"{size} bytes"
        else:
            files_info[name] = "FILE NOT FOUND"

    sample_prices = dict(list((prices or {}).items())[:5])
    sample_funds = dict(list((funds or {}).items())[:5])
    price_keys = set((prices or {}).keys())
    fund_keys = set((funds or {}).keys())

    # Check if any fund entries actually have mktcap > 0
    funds_with_data = {k: v for k, v in (funds or {}).items() if v.get("mktcap", 0) > 0}

    return jsonify({
        "files_on_disk": files_info,
        "ticker_count": len(tickers) if tickers else 0,
        "price_count": len(prices) if prices else 0,
        "fund_count": len(funds) if funds else 0,
        "funds_with_mktcap": len(funds_with_data),
        "sample_prices": sample_prices,
        "sample_funds": sample_funds,
        "sample_funds_with_mktcap": dict(list(funds_with_data.items())[:3]),
        "sample_tickers": (tickers or [])[:10],
        "price_keys_sample": list(price_keys)[:10],
        "fund_keys_sample": list(fund_keys)[:10],
    })

@app.route("/api/screener/cache-status")
def cache_status():
    exchange = request.args.get("exchange", "AU")
    now = time.time()
    _, t_ts = _cache_read(f"tickers_{exchange}")
    _, p_ts = _cache_read(f"prices_{exchange}")
    _, f_ts = _cache_read(f"funds_{exchange}")
    p_data, _ = _cache_read(f"prices_{exchange}")
    f_data, _ = _cache_read(f"funds_{exchange}")
    return jsonify({
        "tickers_age_min": round((now - t_ts) / 60) if t_ts else None,
        "prices_age_min": round((now - p_ts) / 60) if p_ts else None,
        "prices_count": len(p_data) if p_data else 0,
        "funds_age_min": round((now - f_ts) / 60) if f_ts else None,
        "funds_count": len(f_data) if f_data else 0,
        "prices_stale": (now - p_ts) > PRICE_TTL if p_ts else True,
        "funds_stale": (now - f_ts) > FUND_TTL if f_ts else True,
    })

@app.route("/api/quote")
def api_quote():
    ticker = request.args.get("ticker", "").upper()
    exchange = request.args.get("exchange", "AU")
    prices = _get_prices(exchange)
    if prices and ticker in prices:
        p = prices[ticker]
        funds = _get_fundamentals(exchange)
        meta = _ticker_meta.get(exchange, {"names": {}})
        name = (funds.get(ticker, {}).get("name")) or meta.get("names", {}).get(ticker, ticker)
        return jsonify({"ticker": ticker, "exchange": exchange, "price": p["price"], "change": 0, "change_p": p["change_p"], "volume": p["volume"], "name": name})
    try:
        info = yf.Ticker(yf_sym(ticker, exchange)).info
        price = info.get("currentPrice") or info.get("regularMarketPrice") or info.get("previousClose", 0)
        prev = info.get("previousClose", price)
        return jsonify({"ticker": ticker, "exchange": exchange, "price": round(price, 2), "change": round(price - prev, 2), "change_p": round(((price - prev) / prev * 100) if prev else 0, 2), "volume": info.get("volume", 0), "name": info.get("shortName", ticker)})
    except Exception as e:
        for s in MOCK_STOCKS.get(exchange, []):
            if s["ticker"] == ticker:
                return jsonify({"ticker": ticker, "exchange": exchange, "price": s["price"], "change": 0, "change_p": s["change_p"], "volume": s.get("volume", 0), "name": s.get("name", ticker)})
        return jsonify({"error": str(e)}), 404

@app.route("/api/history")
def api_history():
    ticker = request.args.get("ticker", "").upper()
    exchange = request.args.get("exchange", "AU")
    period = request.args.get("period", "1y")
    pm = {"1m": "1mo", "3m": "3mo", "6m": "6mo", "1y": "1y", "2y": "2y", "5y": "5y"}
    try:
        hist = yf.Ticker(yf_sym(ticker, exchange)).history(period=pm.get(period, "1y"))
        return jsonify([{"date": d.strftime("%Y-%m-%d"), "close": round(float(r["Close"]), 2), "volume": int(r["Volume"])} for d, r in hist.iterrows()])
    except Exception:
        return jsonify([])

@app.route("/api/fundamentals")
def api_fundamentals():
    ticker = request.args.get("ticker", "").upper()
    exchange = request.args.get("exchange", "AU")
    try:
        info = yf.Ticker(yf_sym(ticker, exchange)).info
        return jsonify({
            "general": {"name": info.get("shortName", ticker), "sector": info.get("sector", "\u2014"), "industry": info.get("industry", "\u2014"), "country": info.get("country", "\u2014"), "exchange": exchange, "website": info.get("website", "")},
            "highlights": {"marketCap": info.get("marketCap"), "enterpriseValue": info.get("enterpriseValue"), "pe": info.get("trailingPE"), "forwardPE": info.get("forwardPE"), "peg": info.get("pegRatio"), "eps": info.get("trailingEps"), "revenueTTM": info.get("totalRevenue"), "ebitda": info.get("ebitda"), "profitMargin": info.get("profitMargins"), "operatingMargin": info.get("operatingMargins")},
            "dividends": {"dividendYield": info.get("dividendYield"), "dividendRate": info.get("dividendRate"), "payoutRatio": info.get("payoutRatio"), "roe": info.get("returnOnEquity"), "roa": info.get("returnOnAssets")},
            "shares": {"sharesOutstanding": info.get("sharesOutstanding"), "floatShares": info.get("floatShares"), "insiderPct": info.get("heldPercentInsiders"), "institutionPct": info.get("heldPercentInstitutions"), "shortRatio": info.get("shortRatio")},
            "technicals": {"fiftyTwoWeekHigh": info.get("fiftyTwoWeekHigh"), "fiftyTwoWeekLow": info.get("fiftyTwoWeekLow"), "fiftyDayAvg": info.get("fiftyDayAverage"), "twoHundredDayAvg": info.get("twoHundredDayAverage"), "beta": info.get("beta")},
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 404

@app.route("/api/portfolio", methods=["GET"])
def get_portfolio():
    return jsonify(_load("portfolio", [{"name": "Personal", "holdings": []}, {"name": "SMSF", "holdings": []}, {"name": "Family Trust", "holdings": []}]))
@app.route("/api/portfolio", methods=["POST"])
def save_portfolio(): _save("portfolio", request.json); return jsonify({"ok": True})
@app.route("/api/portfolio/prices", methods=["POST"])
def portfolio_prices():
    holdings = request.json or []; results = {}
    for h in holdings:
        key = f"{h['ticker']}.{h['exchange']}"
        if key in results: continue
        prices = _get_prices(h["exchange"])
        if prices and h["ticker"] in prices:
            results[key] = prices[h["ticker"]]; continue
        try:
            info = yf.Ticker(yf_sym(h["ticker"], h["exchange"])).info
            price = info.get("currentPrice") or info.get("regularMarketPrice") or info.get("previousClose", 0)
            prev = info.get("previousClose", price)
            results[key] = {"price": round(price, 2), "change_p": round(((price - prev) / prev * 100) if prev else 0, 2)}
        except Exception:
            for ex_stocks in MOCK_STOCKS.values():
                for s in ex_stocks:
                    if s["ticker"] == h["ticker"]: results[key] = {"price": s["price"], "change_p": s["change_p"]}; break
    return jsonify(results)

@app.route("/api/events", methods=["GET"])
def get_events(): return jsonify(_load("events", []))
@app.route("/api/events", methods=["POST"])
def save_events(): _save("events", request.json); return jsonify({"ok": True})
@app.route("/api/watchlist", methods=["GET"])
def get_watchlist(): return jsonify(_load("watchlist", []))
@app.route("/api/watchlist", methods=["POST"])
def save_watchlist(): _save("watchlist", request.json); return jsonify({"ok": True})

if __name__ == "__main__":
    app.run(debug=True, port=5000)
