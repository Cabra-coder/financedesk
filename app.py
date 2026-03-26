"""
FinanceDesk — Flask + yfinance personal finance application.
Dynamically discovers all tickers for ASX / NYSE / NASDAQ via yfinance.
"""

import json, math, time, threading
from pathlib import Path
from flask import Flask, render_template, jsonify, request
import yfinance as yf

app = Flask(__name__)
DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)
CACHE_DIR = Path(__file__).parent / "cache"
CACHE_DIR.mkdir(exist_ok=True)

# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------
def _load(name, default=None):
    p = DATA_DIR / f"{name}.json"
    return json.loads(p.read_text()) if p.exists() else (default if default is not None else [])

def _save(name, data):
    (DATA_DIR / f"{name}.json").write_text(json.dumps(data, indent=2))

# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------
SCREENER_CACHE = {}
CACHE_TTL = 900
_cache_lock = threading.Lock()

def _get_cache(key):
    with _cache_lock:
        c = SCREENER_CACHE.get(key)
        if c and (time.time() - c["ts"]) < CACHE_TTL:
            return c["data"]
    p = CACHE_DIR / f"{key}.json"
    if p.exists():
        try:
            cached = json.loads(p.read_text())
            if (time.time() - cached.get("ts", 0)) < CACHE_TTL:
                with _cache_lock:
                    SCREENER_CACHE[key] = cached
                return cached["data"]
        except Exception:
            pass
    return None

def _get_cache_any_age(key):
    """Return cache regardless of age (for ticker lists that rarely change)."""
    with _cache_lock:
        c = SCREENER_CACHE.get(key)
        if c: return c["data"]
    p = CACHE_DIR / f"{key}.json"
    if p.exists():
        try:
            cached = json.loads(p.read_text())
            with _cache_lock:
                SCREENER_CACHE[key] = cached
            return cached["data"]
        except Exception:
            pass
    return None

def _set_cache(key, data):
    entry = {"data": data, "ts": time.time()}
    with _cache_lock:
        SCREENER_CACHE[key] = entry
    try:
        (CACHE_DIR / f"{key}.json").write_text(json.dumps(entry))
    except Exception:
        pass

# ---------------------------------------------------------------------------
# yfinance helpers
# ---------------------------------------------------------------------------
EXCHANGE_SUFFIX = {"AU": ".AX", "US": ""}

def yf_symbol(ticker, exchange):
    return f"{ticker}{EXCHANGE_SUFFIX.get(exchange, '')}"

def safe_float(v, default=0):
    if v is None: return default
    try:
        f = float(v)
        return default if math.isnan(f) else f
    except (ValueError, TypeError):
        return default

# ---------------------------------------------------------------------------
# Dynamic ticker discovery — downloads full ASX list from asx.com.au CSV
# ---------------------------------------------------------------------------
import csv, io, urllib.request

ASX_CSV_URL = "https://www.asx.com.au/asx/research/ASXListedCompanies.csv"
TICKER_LIST_CACHE_TTL = 86400  # 24 hours

def _download_asx_tickers():
    """Download the full ASX listed companies CSV and extract ticker codes."""
    try:
        req = urllib.request.Request(ASX_CSV_URL, headers={"User-Agent": "FinanceDesk/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        # CSV has 2 header lines then: "Company name","ASX code","GICS industry group"
        lines = raw.splitlines()
        tickers = []
        reader = csv.reader(lines)
        for row in reader:
            if len(row) >= 2:
                code = row[1].strip().strip('"')
                gics = row[2].strip().strip('"') if len(row) >= 3 else ""
                # Skip header, trusts, notes, and "Not Applic" GICS (bonds, LICs, ETFs etc)
                if code == "ASX code" or not code:
                    continue
                if gics == "Not Applic" or gics == "Class Pend":
                    continue
                tickers.append(code)
        return list(dict.fromkeys(tickers))  # deduplicate preserving order
    except Exception as e:
        print(f"[FinanceDesk] Failed to download ASX ticker list: {e}")
        return None

def _discover_tickers(exchange):
    """Return full ticker list for exchange. Downloads from ASX for AU, uses seed for US."""
    cache_key = f"tickers_{exchange}"

    # Check disk cache (valid for 24h for ticker lists)
    p = CACHE_DIR / f"{cache_key}.json"
    if p.exists():
        try:
            cached = json.loads(p.read_text())
            if (time.time() - cached.get("ts", 0)) < TICKER_LIST_CACHE_TTL:
                return cached["data"]
        except Exception:
            pass

    if exchange == "AU":
        # Try live download
        tickers = _download_asx_tickers()
        if tickers and len(tickers) > 100:
            _set_cache(cache_key, tickers)
            print(f"[FinanceDesk] Downloaded {len(tickers)} ASX tickers from asx.com.au")
            return tickers
        # Fallback to seed
        return _SEED_AU

    return _SEED_US

# Fallback seed lists (used only if ASX CSV download fails)
_SEED_AU = [
    "CBA","BHP","CSL","WBC","NAB","ANZ","WES","MQG","FMG","WOW","TLS","RIO","GMG",
    "WDS","TCL","ALL","REA","COL","SHL","JHX","NXT","XRO","STO","QBE","ORG","MIN",
    "AGL","AMC","ASX","BEN","BOQ","BXB","CAR","CCL","CHC","CPU","CWY","DXS","ELD",
    "EVN","FLT","GPT","HUB","IAG","IEL","IGO","ILU","IPL","JBH","LOV","LYC","MGR",
    "MPL","MTS","NCM","NHF","NST","NWS","ORA","ORI","PLS","PME","QAN","QUB","REH",
    "RHC","RMD","RRL","S32","SEK","SGP","SIQ","SKC","SOL","SUN","TAH","TLC","TNE",
    "TPG","TWE","VCX","WEB","WHC","WOR","WPR","WTC","ZIP",
]

_SEED_US = [
    "AAPL","MSFT","GOOGL","AMZN","NVDA","META","TSLA","BRK-B","JPM","V","JNJ","WMT",
    "XOM","PG","MA","UNH","HD","CVX","MRK","ABBV","KO","PEP","AVGO","LLY","COST",
    "TMO","MCD","CSCO","ACN","ABT","DHR","NEE","TXN","WFC","AMD","PM","UNP","MS",
    "INTC","RTX","LOW","AMGN","HON","COP","IBM","BA","GE","CAT","SPGI","AMAT","ISRG",
    "INTU","DE","BLK","MDLZ","GILD","SYK","ADP","TJX","ADI","BKNG","PLD","REGN",
    "VRTX","CI","CB","ZTS","CME","SO","DUK","CL","BDX","PYPL","NOC","ITW","GD",
    "NFLX","DIS","CMCSA","T","VZ","TMUS","CRM","ORCL","NOW","PLTR","UBER","SHOP",
    "BAC","C","GS","AXP","F","GM","DAL","UAL","ABNB","DASH","CRWD","NET","DDOG",
    "MDB","SNOW","SQ","COIN","MELI","SE","JD","BABA","PDD","NIO","RIVN",
]

# ---------------------------------------------------------------------------
# Background live data builder with progress
# ---------------------------------------------------------------------------
_build_progress = {}

def _build_screener_live(exchange):
    tickers = _discover_tickers(exchange)
    total = len(tickers)
    _build_progress[exchange] = {"done": 0, "total": total, "status": "fetching"}
    results = []

    for i, ticker in enumerate(tickers):
        sym = yf_symbol(ticker, exchange)
        try:
            tk = yf.Ticker(sym)
            info = tk.info or {}
            price = safe_float(info.get("currentPrice") or info.get("regularMarketPrice") or info.get("previousClose"))
            if price <= 0:
                _build_progress[exchange]["done"] = i + 1
                continue
            prev = safe_float(info.get("previousClose"), price)
            change_p = ((price - prev) / prev * 100) if prev else 0
            results.append({
                "ticker": ticker,
                "name": info.get("shortName") or info.get("longName") or ticker,
                "price": round(price, 4),
                "change_p": round(change_p, 2),
                "mktcap": safe_float(info.get("marketCap")),
                "ev": safe_float(info.get("enterpriseValue")),
                "pe": round(safe_float(info.get("trailingPE")), 1),
                "volume": int(safe_float(info.get("volume"))),
                "sector": info.get("sector", ""),
                "divYield": round(safe_float(info.get("dividendYield")) * 100, 2),
                "insiderPct": round(safe_float(info.get("heldPercentInsiders")) * 100, 1),
                "instPct": round(safe_float(info.get("heldPercentInstitutions")) * 100, 1),
                "cash": safe_float(info.get("totalCash")),
            })
        except Exception:
            pass
        _build_progress[exchange]["done"] = i + 1
        if (i + 1) % 10 == 0:
            time.sleep(0.3)

    results.sort(key=lambda x: x.get("mktcap", 0), reverse=True)
    _set_cache(f"screener_{exchange}", results)
    _build_progress[exchange] = {"done": total, "total": total, "status": "done"}
    return results

# ---------------------------------------------------------------------------
# Mock data (shown before live fetch)
# ---------------------------------------------------------------------------
MOCK_STOCKS = {
    "AU": [
        {"ticker":"CBA","name":"Commonwealth Bank","price":128.45,"change_p":0.97,"mktcap":218e9,"pe":22.1,"volume":3200000,"sector":"Financials","ev":230e9,"divYield":3.4,"insiderPct":0.1,"instPct":38.0,"cash":45e9},
        {"ticker":"BHP","name":"BHP Group","price":44.50,"change_p":-0.52,"mktcap":195e9,"pe":11.5,"volume":5400000,"sector":"Materials","ev":215e9,"divYield":5.1,"insiderPct":0.2,"instPct":42.0,"cash":12e9},
        {"ticker":"CSL","name":"CSL Limited","price":295.00,"change_p":1.23,"mktcap":142e9,"pe":38.2,"volume":1200000,"sector":"Healthcare","ev":155e9,"divYield":1.0,"insiderPct":0.5,"instPct":55.0,"cash":3.2e9},
        {"ticker":"WBC","name":"Westpac Banking","price":28.90,"change_p":0.35,"mktcap":98e9,"pe":14.8,"volume":4100000,"sector":"Financials","ev":105e9,"divYield":4.8,"insiderPct":0.1,"instPct":35.0,"cash":38e9},
        {"ticker":"NAB","name":"National Australia Bank","price":35.60,"change_p":-0.28,"mktcap":97e9,"pe":13.9,"volume":3700000,"sector":"Financials","ev":110e9,"divYield":4.5,"insiderPct":0.1,"instPct":36.0,"cash":35e9},
        {"ticker":"ANZ","name":"ANZ Group","price":29.25,"change_p":0.68,"mktcap":82e9,"pe":12.5,"volume":3900000,"sector":"Financials","ev":90e9,"divYield":5.0,"insiderPct":0.1,"instPct":34.0,"cash":32e9},
        {"ticker":"WES","name":"Wesfarmers","price":73.10,"change_p":0.42,"mktcap":83e9,"pe":30.5,"volume":1500000,"sector":"Consumer Discretionary","ev":90e9,"divYield":2.8,"insiderPct":1.2,"instPct":48.0,"cash":2.5e9},
        {"ticker":"MQG","name":"Macquarie Group","price":210.00,"change_p":1.15,"mktcap":80e9,"pe":18.7,"volume":800000,"sector":"Financials","ev":95e9,"divYield":2.5,"insiderPct":0.8,"instPct":40.0,"cash":18e9},
        {"ticker":"WOW","name":"Woolworths","price":33.40,"change_p":-0.15,"mktcap":42e9,"pe":25.1,"volume":2200000,"sector":"Consumer Staples","ev":52e9,"divYield":2.9,"insiderPct":0.3,"instPct":45.0,"cash":1.8e9},
        {"ticker":"FMG","name":"Fortescue","price":20.50,"change_p":-1.85,"mktcap":63e9,"pe":8.2,"volume":8200000,"sector":"Materials","ev":72e9,"divYield":8.5,"insiderPct":36.0,"instPct":25.0,"cash":5.5e9},
        {"ticker":"TLS","name":"Telstra","price":3.95,"change_p":0.25,"mktcap":47e9,"pe":22.0,"volume":12000000,"sector":"Communication Services","ev":60e9,"divYield":4.2,"insiderPct":0.1,"instPct":30.0,"cash":1.2e9},
        {"ticker":"RIO","name":"Rio Tinto","price":118.50,"change_p":-0.93,"mktcap":40e9,"pe":9.8,"volume":1800000,"sector":"Materials","ev":48e9,"divYield":6.0,"insiderPct":0.1,"instPct":50.0,"cash":8.5e9},
        {"ticker":"ALL","name":"Aristocrat Leisure","price":48.20,"change_p":0.83,"mktcap":32e9,"pe":26.4,"volume":1100000,"sector":"Consumer Discretionary","ev":38e9,"divYield":1.2,"insiderPct":0.4,"instPct":52.0,"cash":2.1e9},
        {"ticker":"REA","name":"REA Group","price":205.00,"change_p":1.45,"mktcap":27e9,"pe":55.0,"volume":400000,"sector":"Technology","ev":29e9,"divYield":0.8,"insiderPct":0.2,"instPct":60.0,"cash":0.4e9},
        {"ticker":"GMG","name":"Goodman Group","price":36.50,"change_p":0.55,"mktcap":36e9,"pe":28.0,"volume":2500000,"sector":"Real Estate","ev":44e9,"divYield":1.5,"insiderPct":2.0,"instPct":45.0,"cash":1.5e9},
        {"ticker":"TCL","name":"Transurban","price":13.00,"change_p":0.15,"mktcap":40e9,"pe":120.0,"volume":3500000,"sector":"Industrials","ev":62e9,"divYield":3.8,"insiderPct":0.1,"instPct":55.0,"cash":3.8e9},
        {"ticker":"STO","name":"Santos","price":7.20,"change_p":-2.10,"mktcap":24e9,"pe":10.5,"volume":6000000,"sector":"Energy","ev":32e9,"divYield":3.5,"insiderPct":0.3,"instPct":48.0,"cash":2.2e9},
        {"ticker":"WDS","name":"Woodside Energy","price":27.80,"change_p":-1.45,"mktcap":52e9,"pe":11.2,"volume":4500000,"sector":"Energy","ev":60e9,"divYield":7.0,"insiderPct":0.1,"instPct":42.0,"cash":6.0e9},
        {"ticker":"COL","name":"Coles Group","price":18.30,"change_p":0.22,"mktcap":24e9,"pe":23.5,"volume":2800000,"sector":"Consumer Staples","ev":30e9,"divYield":3.2,"insiderPct":0.2,"instPct":40.0,"cash":0.8e9},
        {"ticker":"SHL","name":"Sonic Healthcare","price":27.00,"change_p":0.74,"mktcap":13e9,"pe":19.0,"volume":900000,"sector":"Healthcare","ev":17e9,"divYield":3.0,"insiderPct":2.5,"instPct":35.0,"cash":0.5e9},
        {"ticker":"JHX","name":"James Hardie","price":55.00,"change_p":1.82,"mktcap":24e9,"pe":30.0,"volume":700000,"sector":"Materials","ev":28e9,"divYield":0.0,"insiderPct":0.8,"instPct":65.0,"cash":0.6e9},
        {"ticker":"NXT","name":"NEXTDC","price":18.50,"change_p":2.10,"mktcap":8e9,"pe":0,"volume":2000000,"sector":"Technology","ev":11e9,"divYield":0.0,"insiderPct":1.5,"instPct":55.0,"cash":0.3e9},
        {"ticker":"XRO","name":"Xero","price":145.00,"change_p":1.38,"mktcap":22e9,"pe":180.0,"volume":600000,"sector":"Technology","ev":23e9,"divYield":0.0,"insiderPct":0.5,"instPct":70.0,"cash":1.1e9},
        {"ticker":"ZIP","name":"Zip Co","price":2.10,"change_p":3.45,"mktcap":1.6e9,"pe":0,"volume":4000000,"sector":"Technology","ev":2.0e9,"divYield":0.0,"insiderPct":3.0,"instPct":20.0,"cash":0.2e9},
        {"ticker":"4DS","name":"4DS Memory","price":0.012,"change_p":-4.00,"mktcap":22e6,"pe":0,"volume":500000,"sector":"Technology","ev":18e6,"divYield":0.0,"insiderPct":5.0,"instPct":8.0,"cash":5e6},
    ],
    "US": [
        {"ticker":"AAPL","name":"Apple","price":178.50,"change_p":0.85,"mktcap":2.8e12,"pe":28.5,"volume":52000000,"sector":"Technology","ev":2.85e12,"divYield":0.5,"insiderPct":0.1,"instPct":60.0,"cash":62e9},
        {"ticker":"MSFT","name":"Microsoft","price":420.00,"change_p":1.12,"mktcap":3.1e12,"pe":35.2,"volume":22000000,"sector":"Technology","ev":3.05e12,"divYield":0.7,"insiderPct":0.1,"instPct":72.0,"cash":80e9},
        {"ticker":"GOOGL","name":"Alphabet","price":155.00,"change_p":0.65,"mktcap":1.9e12,"pe":24.8,"volume":25000000,"sector":"Technology","ev":1.8e12,"divYield":0.0,"insiderPct":5.8,"instPct":62.0,"cash":110e9},
        {"ticker":"AMZN","name":"Amazon","price":185.00,"change_p":1.35,"mktcap":1.9e12,"pe":60.5,"volume":35000000,"sector":"Consumer Discretionary","ev":1.95e12,"divYield":0.0,"insiderPct":2.0,"instPct":58.0,"cash":73e9},
        {"ticker":"NVDA","name":"NVIDIA","price":880.00,"change_p":2.50,"mktcap":2.2e12,"pe":68.0,"volume":40000000,"sector":"Technology","ev":2.18e12,"divYield":0.02,"insiderPct":4.0,"instPct":65.0,"cash":26e9},
        {"ticker":"META","name":"Meta Platforms","price":500.00,"change_p":0.92,"mktcap":1.3e12,"pe":26.0,"volume":15000000,"sector":"Technology","ev":1.25e12,"divYield":0.3,"insiderPct":13.0,"instPct":78.0,"cash":41e9},
        {"ticker":"TSLA","name":"Tesla","price":175.00,"change_p":-1.20,"mktcap":550e9,"pe":48.0,"volume":80000000,"sector":"Consumer Discretionary","ev":540e9,"divYield":0.0,"insiderPct":13.0,"instPct":44.0,"cash":22e9},
        {"ticker":"JPM","name":"JPMorgan Chase","price":198.00,"change_p":0.45,"mktcap":570e9,"pe":11.5,"volume":8000000,"sector":"Financials","ev":600e9,"divYield":2.3,"insiderPct":0.5,"instPct":70.0,"cash":580e9},
        {"ticker":"V","name":"Visa","price":280.00,"change_p":0.30,"mktcap":580e9,"pe":30.0,"volume":5000000,"sector":"Financials","ev":575e9,"divYield":0.7,"insiderPct":0.1,"instPct":92.0,"cash":16e9},
        {"ticker":"JNJ","name":"Johnson & Johnson","price":158.00,"change_p":-0.25,"mktcap":380e9,"pe":15.0,"volume":6000000,"sector":"Healthcare","ev":395e9,"divYield":2.9,"insiderPct":0.2,"instPct":68.0,"cash":20e9},
        {"ticker":"WMT","name":"Walmart","price":168.00,"change_p":0.48,"mktcap":450e9,"pe":28.0,"volume":7000000,"sector":"Consumer Staples","ev":490e9,"divYield":1.3,"insiderPct":47.0,"instPct":30.0,"cash":9e9},
        {"ticker":"XOM","name":"ExxonMobil","price":105.00,"change_p":-0.80,"mktcap":420e9,"pe":12.0,"volume":12000000,"sector":"Energy","ev":440e9,"divYield":3.5,"insiderPct":0.1,"instPct":62.0,"cash":32e9},
        {"ticker":"PG","name":"Procter & Gamble","price":162.00,"change_p":0.15,"mktcap":380e9,"pe":26.0,"volume":5500000,"sector":"Consumer Staples","ev":400e9,"divYield":2.4,"insiderPct":0.1,"instPct":65.0,"cash":8e9},
        {"ticker":"MA","name":"Mastercard","price":465.00,"change_p":0.55,"mktcap":435e9,"pe":34.0,"volume":3000000,"sector":"Financials","ev":430e9,"divYield":0.5,"insiderPct":0.1,"instPct":90.0,"cash":7e9},
        {"ticker":"DIS","name":"Walt Disney","price":112.00,"change_p":0.70,"mktcap":205e9,"pe":35.0,"volume":9000000,"sector":"Communication Services","ev":245e9,"divYield":0.0,"insiderPct":0.5,"instPct":66.0,"cash":14e9},
    ],
}

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/tickers")
def api_tickers():
    """Return count & list of known tickers for exchange."""
    exchange = request.args.get("exchange", "AU")
    tickers = _discover_tickers(exchange)
    return jsonify({"exchange": exchange, "count": len(tickers), "tickers": tickers})

@app.route("/api/screener")
def api_screener():
    exchange = request.args.get("exchange", "AU")
    cached = _get_cache(f"screener_{exchange}")
    if cached:
        return jsonify(cached)
    return jsonify(MOCK_STOCKS.get(exchange, []))

@app.route("/api/screener/fetch-live", methods=["POST"])
def screener_fetch_live():
    exchange = (request.json or {}).get("exchange", "AU")
    prog = _build_progress.get(exchange, {})
    if prog.get("status") == "fetching":
        return jsonify({"status": "already_running", "progress": prog})
    tickers = _discover_tickers(exchange)
    t = threading.Thread(target=_build_screener_live, args=(exchange,), daemon=True)
    t.start()
    return jsonify({"status": "started", "progress": {"done": 0, "total": len(tickers)}})

@app.route("/api/screener/progress")
def screener_progress():
    exchange = request.args.get("exchange", "AU")
    prog = _build_progress.get(exchange, {"done": 0, "total": 0, "status": "idle"})
    result = {"progress": prog}
    if prog.get("status") == "done":
        cached = _get_cache(f"screener_{exchange}")
        if cached:
            result["data"] = cached
    return jsonify(result)

@app.route("/api/quote")
def api_quote():
    ticker = request.args.get("ticker", "").upper()
    exchange = request.args.get("exchange", "AU")
    sym = yf_symbol(ticker, exchange)
    try:
        tk = yf.Ticker(sym); info = tk.info
        price = info.get("currentPrice") or info.get("regularMarketPrice") or info.get("previousClose", 0)
        prev = info.get("previousClose", price)
        change = price - prev; change_p = (change / prev * 100) if prev else 0
        return jsonify({"ticker": ticker, "exchange": exchange, "price": round(price, 2), "change": round(change, 2), "change_p": round(change_p, 2), "volume": info.get("volume", 0), "name": info.get("shortName", ticker)})
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
    period_map = {"1m": "1mo", "3m": "3mo", "6m": "6mo", "1y": "1y", "2y": "2y", "5y": "5y"}
    sym = yf_symbol(ticker, exchange)
    try:
        tk = yf.Ticker(sym); hist = tk.history(period=period_map.get(period, "1y"))
        return jsonify([{"date": d.strftime("%Y-%m-%d"), "close": round(float(r["Close"]), 2), "volume": int(r["Volume"])} for d, r in hist.iterrows()])
    except Exception:
        return jsonify([])

@app.route("/api/fundamentals")
def api_fundamentals():
    ticker = request.args.get("ticker", "").upper()
    exchange = request.args.get("exchange", "AU")
    sym = yf_symbol(ticker, exchange)
    try:
        tk = yf.Ticker(sym); info = tk.info
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
        sym = yf_symbol(h["ticker"], h["exchange"])
        try:
            tk = yf.Ticker(sym); info = tk.info
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
