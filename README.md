# FinanceDesk.py

A personal finance application built with **Flask**, **Python**, and **yfinance** — a full rebuild of the original React/EODHD artifact app.

Stock screener, individual stock research tool, portfolio manager, and event calendar targeting **ASX**, **NYSE**, and **NASDAQ** listed securities.

![Dark terminal aesthetic with deep navy-black theme]

## Features

### Screener
- Stock table with sortable columns (Ticker, Price, Change%, Market Cap, EV, P/E, Div Yield, Volume, Sector)
- Range slider filters for Market Cap and P/E ratio
- Sector dropdown filter and text search
- Watchlist toggle (★) per stock
- Click-through to Stock tab for detailed research

### Stock Research
- Ticker lookup with exchange selector (ASX / NYSE+NASDAQ)
- Interactive Chart.js price chart with period selector (1M → 5Y)
- Green/red chart colouring based on price direction
- Fundamentals sidebar: Key Statistics, Dividends & Returns, Shares & Ownership, Technicals, Company Info
- All data sourced live from yfinance

### Portfolio Manager
- Multiple entities (Personal, SMSF, Family Trust, or custom)
- Per-holding tracking: ticker, exchange, shares, avg cost
- Live price lookup with P&L, P&L%, day change%, portfolio weight bars
- Cross-exchange portfolios (ASX + US holdings in same entity)
- Summary cards: Total Value, Cost Basis, Total P&L, Holdings count

### Calendar
- Monthly grid calendar with event dots
- Event types: Earnings, Dividend, Conference, Regulatory, Product Launch, Other
- Colour-coded badges per event type
- Sidebar showing events for selected day
- Add/remove events with ticker association

## Setup

```bash
# 1. Clone or copy the project
cd financedesk

# 2. Create a virtual environment (recommended)
python -m venv venv
source venv/bin/activate        # macOS/Linux
# venv\Scripts\activate         # Windows

# 3. Install dependencies
pip install -r requirements.txt

# 4. Run the app
python app.py
```

Then open **http://localhost:5000** in your browser.

## Project Structure

```
financedesk/
├── app.py                  # Flask application + API routes + yfinance integration
├── requirements.txt        # Python dependencies
├── README.md               # This file
├── data/                   # Auto-created JSON persistence (portfolio, events, watchlist)
│   ├── portfolio.json
│   ├── events.json
│   └── watchlist.json
└── templates/
    └── index.html          # Single-page frontend (HTML + CSS + vanilla JS + Chart.js)
```

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/` | GET | Serve the SPA |
| `/api/screener?exchange=AU&mock=0` | GET | Stock list with live/mock data |
| `/api/quote?ticker=CBA&exchange=AU` | GET | Single live quote |
| `/api/history?ticker=CBA&exchange=AU&period=1y` | GET | Historical EOD prices |
| `/api/fundamentals?ticker=CBA&exchange=AU` | GET | Full company fundamentals |
| `/api/portfolio` | GET/POST | Load/save portfolio entities |
| `/api/portfolio/prices` | POST | Batch price lookup for holdings |
| `/api/events` | GET/POST | Load/save calendar events |
| `/api/watchlist` | GET/POST | Load/save watchlist |

## yfinance vs EODHD

The original app used EODHD (`$19.99/mo`). This rebuild uses **yfinance** (free, no API key required).

| Feature | EODHD | yfinance |
|---------|-------|----------|
| Cost | $19.99/mo | Free |
| API Key | Required | Not required |
| ASX symbol format | `CBA.AU` | `CBA.AX` |
| US symbol format | `AAPL.US` | `AAPL` |
| Rate limits | 20/day free | Unofficial, be polite |
| Fundamentals | Yes | Yes (via `.info`) |
| Historical data | Yes | Yes (via `.history()`) |

## Mock Data Fallback

If yfinance is unavailable or returns errors, the app falls back to built-in mock data covering ~25 ASX stocks (from mega-cap CBA at $218B down to micro-cap 4DS at $22M) and ~15 US stocks.

## Design System

- **Theme**: Dark terminal aesthetic (`#0a0e17` deep navy-black)
- **Typography**: DM Sans (body) + JetBrains Mono (prices, tickers)
- **Accent**: `#3b82f6` (blue), Green `#10b981`, Red `#ef4444`
- **Charts**: Chart.js with gradient fill and green/red colouring

## Key Differences from React Version

1. **Backend**: Flask + Python replaces in-browser-only React artifact
2. **Data**: yfinance replaces EODHD API (no API key needed)
3. **Persistence**: JSON files in `data/` folder replace `window.storage`
4. **Charts**: Chart.js replaces recharts
5. **Frontend**: Vanilla JS replaces React (same dark terminal aesthetic)
6. **Hosting**: Runs locally as a Flask server instead of a Claude artifact
