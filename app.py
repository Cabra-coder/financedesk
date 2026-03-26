"""
FinanceDesk — Flask + yfinance personal finance application.
Stock screener, research tool, portfolio manager, and event calendar
targeting ASX, NYSE, and NASDAQ listed securities.
"""

import json, os, math
from datetime import datetime, timedelta
from pathlib import Path

from flask import Flask, render_template, jsonify, request

import yfinance as yf

app = Flask(__name__)
DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)

# ---------------------------------------------------------------------------
# Persistence helpers (JSON files mirroring the React window.storage keys)
# ---------------------------------------------------------------------------

def _load(name, default=None):
    p = DATA_DIR / f"{name}.json"
    if p.exists():
        return json.loads(p.read_text())
    return default if default is not None else []

def _save(name, data):
    (DATA_DIR / f"{name}.json").write_text(json.dumps(data, indent=2))

# ---------------------------------------------------------------------------
# yfinance helpers
# ---------------------------------------------------------------------------

EXCHANGE_SUFFIX = {"AU": ".AX", "US": ""}  # yfinance uses .AX for ASX

def yf_symbol(ticker: str, exchange: str) -> str:
    """Convert our ticker+exchange to a yfinance symbol."""
    suffix = EXCHANGE_SUFFIX.get(exchange, "")
    return f"{ticker}{suffix}"


def fmt_num(val, prefix="", suffix="", decimals=2):
    """Safe number formatter."""
    if val is None or (isinstance(val, float) and math.isnan(val)):
        return "\u2014"
    if isinstance(val, str):
        try:
            val = float(val)
        except ValueError:
            return val
    if abs(val) >= 1e12:
        return f"{prefix}{val/1e12:,.{decimals}f}T{suffix}"
    if abs(val) >= 1e9:
        return f"{prefix}{val/1e9:,.{decimals}f}B{suffix}"
    if abs(val) >= 1e6:
        return f"{prefix}{val/1e6:,.{decimals}f}M{suffix}"
    return f"{prefix}{val:,.{decimals}f}{suffix}"


# ---------------------------------------------------------------------------
# Mock / fallback data
# ---------------------------------------------------------------------------

MOCK_STOCKS = {
    "AU": [
        {"ticker":"CBA","name":"Commonwealth Bank","price":128.45,"change_p":0.97,"mktcap":218e9,"pe":22.1,"volume":3200000,"sector":"Financials","ev":230e9,"divYield":3.4},
        {"ticker":"BHP","name":"BHP Group","price":44.50,"change_p":-0.52,"mktcap":195e9,"pe":11.5,"volume":5400000,"sector":"Materials","ev":215e9,"divYield":5.1},
        {"ticker":"CSL","name":"CSL Limited","price":295.00,"change_p":1.23,"mktcap":142e9,"pe":38.2,"volume":1200000,"sector":"Healthcare","ev":155e9,"divYield":1.0},
        {"ticker":"WBC","name":"Westpac Banking","price":28.90,"change_p":0.35,"mktcap":98e9,"pe":14.8,"volume":4100000,"sector":"Financials","ev":105e9,"divYield":4.8},
        {"ticker":"NAB","name":"National Australia Bank","price":35.60,"change_p":-0.28,"mktcap":97e9,"pe":13.9,"volume":3700000,"sector":"Financials","ev":110e9,"divYield":4.5},
        {"ticker":"ANZ","name":"ANZ Group","price":29.25,"change_p":0.68,"mktcap":82e9,"pe":12.5,"volume":3900000,"sector":"Financials","ev":90e9,"divYield":5.0},
        {"ticker":"WES","name":"Wesfarmers","price":73.10,"change_p":0.42,"mktcap":83e9,"pe":30.5,"volume":1500000,"sector":"Consumer Disc","ev":90e9,"divYield":2.8},
        {"ticker":"MQG","name":"Macquarie Group","price":210.00,"change_p":1.15,"mktcap":80e9,"pe":18.7,"volume":800000,"sector":"Financials","ev":95e9,"divYield":2.5},
        {"ticker":"WOW","name":"Woolworths","price":33.40,"change_p":-0.15,"mktcap":42e9,"pe":25.1,"volume":2200000,"sector":"Consumer Staples","ev":52e9,"divYield":2.9},
        {"ticker":"FMG","name":"Fortescue","price":20.50,"change_p":-1.85,"mktcap":63e9,"pe":8.2,"volume":8200000,"sector":"Materials","ev":72e9,"divYield":8.5},
        {"ticker":"TLS","name":"Telstra","price":3.95,"change_p":0.25,"mktcap":47e9,"pe":22.0,"volume":12000000,"sector":"Telecom","ev":60e9,"divYield":4.2},
        {"ticker":"RIO","name":"Rio Tinto","price":118.50,"change_p":-0.93,"mktcap":40e9,"pe":9.8,"volume":1800000,"sector":"Materials","ev":48e9,"divYield":6.0},
        {"ticker":"ALL","name":"Aristocrat Leisure","price":48.20,"change_p":0.83,"mktcap":32e9,"pe":26.4,"volume":1100000,"sector":"Consumer Disc","ev":38e9,"divYield":1.2},
        {"ticker":"REA","name":"REA Group","price":205.00,"change_p":1.45,"mktcap":27e9,"pe":55.0,"volume":400000,"sector":"Technology","ev":29e9,"divYield":0.8},
        {"ticker":"GMG","name":"Goodman Group","price":36.50,"change_p":0.55,"mktcap":36e9,"pe":28.0,"volume":2500000,"sector":"Real Estate","ev":44e9,"divYield":1.5},
        {"ticker":"TCL","name":"Transurban","price":13.00,"change_p":0.15,"mktcap":40e9,"pe":120.0,"volume":3500000,"sector":"Industrials","ev":62e9,"divYield":3.8},
        {"ticker":"STO","name":"Santos","price":7.20,"change_p":-2.10,"mktcap":24e9,"pe":10.5,"volume":6000000,"sector":"Energy","ev":32e9,"divYield":3.5},
        {"ticker":"WDS","name":"Woodside Energy","price":27.80,"change_p":-1.45,"mktcap":52e9,"pe":11.2,"volume":4500000,"sector":"Energy","ev":60e9,"divYield":7.0},
        {"ticker":"COL","name":"Coles Group","price":18.30,"change_p":0.22,"mktcap":24e9,"pe":23.5,"volume":2800000,"sector":"Consumer Staples","ev":30e9,"divYield":3.2},
        {"ticker":"SHL","name":"Sonic Healthcare","price":27.00,"change_p":0.74,"mktcap":13e9,"pe":19.0,"volume":900000,"sector":"Healthcare","ev":17e9,"divYield":3.0},
        {"ticker":"JHX","name":"James Hardie","price":55.00,"change_p":1.82,"mktcap":24e9,"pe":30.0,"volume":700000,"sector":"Materials","ev":28e9,"divYield":0.0},
        {"ticker":"NXT","name":"NEXTDC","price":18.50,"change_p":2.10,"mktcap":8e9,"pe":0,"volume":2000000,"sector":"Technology","ev":11e9,"divYield":0.0},
        {"ticker":"XRO","name":"Xero","price":145.00,"change_p":1.38,"mktcap":22e9,"pe":180.0,"volume":600000,"sector":"Technology","ev":23e9,"divYield":0.0},
        {"ticker":"4DS","name":"4DS Memory","price":0.012,"change_p":-4.00,"mktcap":22e6,"pe":0,"volume":500000,"sector":"Technology","ev":18e6,"divYield":0.0},
        {"ticker":"ZIP","name":"Zip Co","price":2.10,"change_p":3.45,"mktcap":1.6e9,"pe":0,"volume":4000000,"sector":"Technology","ev":2.0e9,"divYield":0.0},
    ],
    "US": [
        {"ticker":"AAPL","name":"Apple","price":178.50,"change_p":0.85,"mktcap":2.8e12,"pe":28.5,"volume":52000000,"sector":"Technology","ev":2.85e12,"divYield":0.5},
        {"ticker":"MSFT","name":"Microsoft","price":420.00,"change_p":1.12,"mktcap":3.1e12,"pe":35.2,"volume":22000000,"sector":"Technology","ev":3.05e12,"divYield":0.7},
        {"ticker":"GOOGL","name":"Alphabet","price":155.00,"change_p":0.65,"mktcap":1.9e12,"pe":24.8,"volume":25000000,"sector":"Technology","ev":1.8e12,"divYield":0.0},
        {"ticker":"AMZN","name":"Amazon","price":185.00,"change_p":1.35,"mktcap":1.9e12,"pe":60.5,"volume":35000000,"sector":"Consumer Disc","ev":1.95e12,"divYield":0.0},
        {"ticker":"NVDA","name":"NVIDIA","price":880.00,"change_p":2.50,"mktcap":2.2e12,"pe":68.0,"volume":40000000,"sector":"Technology","ev":2.18e12,"divYield":0.02},
        {"ticker":"META","name":"Meta Platforms","price":500.00,"change_p":0.92,"mktcap":1.3e12,"pe":26.0,"volume":15000000,"sector":"Technology","ev":1.25e12,"divYield":0.3},
        {"ticker":"TSLA","name":"Tesla","price":175.00,"change_p":-1.20,"mktcap":550e9,"pe":48.0,"volume":80000000,"sector":"Consumer Disc","ev":540e9,"divYield":0.0},
        {"ticker":"JPM","name":"JPMorgan Chase","price":198.00,"change_p":0.45,"mktcap":570e9,"pe":11.5,"volume":8000000,"sector":"Financials","ev":600e9,"divYield":2.3},
        {"ticker":"V","name":"Visa","price":280.00,"change_p":0.30,"mktcap":580e9,"pe":30.0,"volume":5000000,"sector":"Financials","ev":575e9,"divYield":0.7},
        {"ticker":"JNJ","name":"Johnson & Johnson","price":158.00,"change_p":-0.25,"mktcap":380e9,"pe":15.0,"volume":6000000,"sector":"Healthcare","ev":395e9,"divYield":2.9},
        {"ticker":"WMT","name":"Walmart","price":168.00,"change_p":0.48,"mktcap":450e9,"pe":28.0,"volume":7000000,"sector":"Consumer Staples","ev":490e9,"divYield":1.3},
        {"ticker":"XOM","name":"ExxonMobil","price":105.00,"change_p":-0.80,"mktcap":420e9,"pe":12.0,"volume":12000000,"sector":"Energy","ev":440e9,"divYield":3.5},
        {"ticker":"PG","name":"Procter & Gamble","price":162.00,"change_p":0.15,"mktcap":380e9,"pe":26.0,"volume":5500000,"sector":"Consumer Staples","ev":400e9,"divYield":2.4},
        {"ticker":"MA","name":"Mastercard","price":465.00,"change_p":0.55,"mktcap":435e9,"pe":34.0,"volume":3000000,"sector":"Financials","ev":430e9,"divYield":0.5},
        {"ticker":"DIS","name":"Walt Disney","price":112.00,"change_p":0.70,"mktcap":205e9,"pe":35.0,"volume":9000000,"sector":"Communication","ev":245e9,"divYield":0.0},
    ],
}


# ---------------------------------------------------------------------------
# Page routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# API routes — Screener
# ---------------------------------------------------------------------------

@app.route("/api/screener")
def api_screener():
    """Return stock list for selected exchange. Tries yfinance first, falls back to mock."""
    exchange = request.args.get("exchange", "AU")
    use_mock = request.args.get("mock", "0")

    if use_mock == "1":
        return jsonify(MOCK_STOCKS.get(exchange, []))

    # Try live data via yfinance for the mock tickers
    tickers = MOCK_STOCKS.get(exchange, [])
    results = []
    symbols = [yf_symbol(t["ticker"], exchange) for t in tickers]

    try:
        data = yf.download(symbols, period="2d", group_by="ticker", threads=True, progress=False)
        info_cache = {}
        for stock in tickers:
            sym = yf_symbol(stock["ticker"], exchange)
            try:
                if len(symbols) == 1:
                    hist = data
                else:
                    hist = data[sym] if sym in data.columns.get_level_values(0) else None

                if hist is not None and not hist.empty and len(hist) >= 1:
                    last = hist.iloc[-1]
                    prev = hist.iloc[-2] if len(hist) >= 2 else hist.iloc[-1]
                    price = float(last["Close"])
                    change_p = ((price - float(prev["Close"])) / float(prev["Close"])) * 100 if float(prev["Close"]) != 0 else 0
                    volume = int(last["Volume"])
                else:
                    raise ValueError("no data")

                # Try to get info (cached)
                if sym not in info_cache:
                    try:
                        tk = yf.Ticker(sym)
                        info_cache[sym] = tk.info
                    except Exception:
                        info_cache[sym] = {}

                info = info_cache.get(sym, {})
                results.append({
                    "ticker": stock["ticker"],
                    "name": info.get("shortName", stock.get("name", stock["ticker"])),
                    "price": round(price, 2),
                    "change_p": round(change_p, 2),
                    "mktcap": info.get("marketCap", stock.get("mktcap", 0)),
                    "pe": info.get("trailingPE", stock.get("pe", 0)),
                    "volume": volume,
                    "sector": info.get("sector", stock.get("sector", "")),
                    "ev": info.get("enterpriseValue", stock.get("ev", 0)),
                    "divYield": round((info.get("dividendYield", 0) or 0) * 100, 2),
                })
            except Exception:
                # Fallback to mock for this ticker
                results.append(stock)

        return jsonify(results)

    except Exception:
        return jsonify(MOCK_STOCKS.get(exchange, []))


# ---------------------------------------------------------------------------
# API routes — Stock lookup
# ---------------------------------------------------------------------------

@app.route("/api/quote")
def api_quote():
    ticker = request.args.get("ticker", "").upper()
    exchange = request.args.get("exchange", "AU")
    sym = yf_symbol(ticker, exchange)

    try:
        tk = yf.Ticker(sym)
        info = tk.info
        price = info.get("currentPrice") or info.get("regularMarketPrice") or info.get("previousClose", 0)
        prev = info.get("previousClose", price)
        change = price - prev
        change_p = (change / prev * 100) if prev else 0

        return jsonify({
            "ticker": ticker, "exchange": exchange,
            "price": round(price, 2),
            "change": round(change, 2),
            "change_p": round(change_p, 2),
            "volume": info.get("volume", 0),
            "name": info.get("shortName", ticker),
        })
    except Exception as e:
        # Try mock
        for s in MOCK_STOCKS.get(exchange, []):
            if s["ticker"] == ticker:
                return jsonify({
                    "ticker": ticker, "exchange": exchange,
                    "price": s["price"], "change": 0, "change_p": s["change_p"],
                    "volume": s.get("volume", 0), "name": s.get("name", ticker),
                })
        return jsonify({"error": str(e)}), 404


@app.route("/api/history")
def api_history():
    ticker = request.args.get("ticker", "").upper()
    exchange = request.args.get("exchange", "AU")
    period = request.args.get("period", "1y")

    period_map = {"1m": "1mo", "3m": "3mo", "6m": "6mo", "1y": "1y", "2y": "2y", "5y": "5y"}
    yf_period = period_map.get(period, "1y")
    sym = yf_symbol(ticker, exchange)

    try:
        tk = yf.Ticker(sym)
        hist = tk.history(period=yf_period)
        rows = []
        for date, row in hist.iterrows():
            rows.append({
                "date": date.strftime("%Y-%m-%d"),
                "close": round(float(row["Close"]), 2),
                "volume": int(row["Volume"]),
            })
        return jsonify(rows)
    except Exception:
        return jsonify([])


@app.route("/api/fundamentals")
def api_fundamentals():
    ticker = request.args.get("ticker", "").upper()
    exchange = request.args.get("exchange", "AU")
    sym = yf_symbol(ticker, exchange)

    try:
        tk = yf.Ticker(sym)
        info = tk.info

        return jsonify({
            "general": {
                "name": info.get("shortName", ticker),
                "sector": info.get("sector", "\u2014"),
                "industry": info.get("industry", "\u2014"),
                "country": info.get("country", "\u2014"),
                "exchange": exchange,
                "website": info.get("website", ""),
            },
            "highlights": {
                "marketCap": info.get("marketCap"),
                "enterpriseValue": info.get("enterpriseValue"),
                "pe": info.get("trailingPE"),
                "forwardPE": info.get("forwardPE"),
                "peg": info.get("pegRatio"),
                "eps": info.get("trailingEps"),
                "revenueTTM": info.get("totalRevenue"),
                "ebitda": info.get("ebitda"),
                "profitMargin": info.get("profitMargins"),
                "operatingMargin": info.get("operatingMargins"),
            },
            "dividends": {
                "dividendYield": info.get("dividendYield"),
                "dividendRate": info.get("dividendRate"),
                "payoutRatio": info.get("payoutRatio"),
                "roe": info.get("returnOnEquity"),
                "roa": info.get("returnOnAssets"),
            },
            "shares": {
                "sharesOutstanding": info.get("sharesOutstanding"),
                "floatShares": info.get("floatShares"),
                "insiderPct": info.get("heldPercentInsiders"),
                "institutionPct": info.get("heldPercentInstitutions"),
                "shortRatio": info.get("shortRatio"),
            },
            "technicals": {
                "fiftyTwoWeekHigh": info.get("fiftyTwoWeekHigh"),
                "fiftyTwoWeekLow": info.get("fiftyTwoWeekLow"),
                "fiftyDayAvg": info.get("fiftyDayAverage"),
                "twoHundredDayAvg": info.get("twoHundredDayAverage"),
                "beta": info.get("beta"),
            },
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 404


# ---------------------------------------------------------------------------
# API routes — Portfolio
# ---------------------------------------------------------------------------

@app.route("/api/portfolio", methods=["GET"])
def get_portfolio():
    return jsonify(_load("portfolio", [
        {"name": "Personal", "holdings": []},
        {"name": "SMSF", "holdings": []},
        {"name": "Family Trust", "holdings": []},
    ]))


@app.route("/api/portfolio", methods=["POST"])
def save_portfolio():
    _save("portfolio", request.json)
    return jsonify({"ok": True})


@app.route("/api/portfolio/prices", methods=["POST"])
def portfolio_prices():
    """Fetch live prices for a list of {ticker, exchange} objects."""
    holdings = request.json or []
    results = {}

    for h in holdings:
        key = f"{h['ticker']}.{h['exchange']}"
        if key in results:
            continue
        sym = yf_symbol(h["ticker"], h["exchange"])
        try:
            tk = yf.Ticker(sym)
            info = tk.info
            price = info.get("currentPrice") or info.get("regularMarketPrice") or info.get("previousClose", 0)
            prev = info.get("previousClose", price)
            change_p = ((price - prev) / prev * 100) if prev else 0
            results[key] = {"price": round(price, 2), "change_p": round(change_p, 2)}
        except Exception:
            # Mock fallback
            for ex_stocks in MOCK_STOCKS.values():
                for s in ex_stocks:
                    if s["ticker"] == h["ticker"]:
                        results[key] = {"price": s["price"], "change_p": s["change_p"]}
                        break

    return jsonify(results)


# ---------------------------------------------------------------------------
# API routes — Calendar
# ---------------------------------------------------------------------------

@app.route("/api/events", methods=["GET"])
def get_events():
    return jsonify(_load("events", []))


@app.route("/api/events", methods=["POST"])
def save_events():
    _save("events", request.json)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# API routes — Watchlist
# ---------------------------------------------------------------------------

@app.route("/api/watchlist", methods=["GET"])
def get_watchlist():
    return jsonify(_load("watchlist", []))


@app.route("/api/watchlist", methods=["POST"])
def save_watchlist():
    _save("watchlist", request.json)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    app.run(debug=True, port=5000)
