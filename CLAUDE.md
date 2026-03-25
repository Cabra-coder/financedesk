# CLAUDE.md — FinanceDesk Project

## Project Overview

FinanceDesk is a personal finance application built as a single-file React artifact (.jsx) for use in Claude's artifact environment. It serves as a stock screener, individual stock research tool, portfolio manager, and event calendar targeting ASX, NYSE, and NASDAQ listed securities.

The primary user is based in Brisbane, Australia and manages holdings across multiple entities (Personal, SMSF, Family Trust).

## Architecture

### Single-File React App
- Everything lives in one `.jsx` file rendered as a Claude artifact
- CSS is defined as a module-scope string constant (`const CSS`) injected via `<style>{CSS}</style>`
- **Critical**: CSS must be defined at module scope, NOT inside component render functions — this caused a blank-screen bug in v2
- No external CSS frameworks. All styling is hand-written using CSS custom properties (variables)
- Uses `window.storage` API for cross-session persistence (Claude artifact storage)
- Charts use `recharts` library (AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid)

### Storage Keys
| Key | Contents |
|-----|----------|
| `fd-pf` | Portfolio entities array `[{name, holdings: [{ticker, shares, cost, exchange}]}]` |
| `fd-ev` | Calendar events array `[{id, date, ticker, type, title, notes, exchange}]` |
| `fd-wl` | Watchlist ticker array `["CBA", "BHP", "AAPL"]` |
| `fd-apikey` | EODHD API key string |

### Component Structure
```
App (main)
├── Screener     — stock table with filters, range sliders, sort, watchlist, "Add to portfolio" button
├── StockTab     — individual stock lookup with interactive price chart + fundamentals panel
├── Portfolio    — entity sidebar + holdings table with P&L, weight bars
├── CalendarTab  — monthly grid calendar + event sidebar
└── (API key config bar is inline in App, not a separate tab)
```

### Tab Order in Nav
`Screener → Stock → Portfolio → Calendar`

## Data API — EODHD

### Why EODHD (not Twelve Data)
- ASX data sourced directly from ASX under contract — no trial symbol restrictions
- Simple symbol format: `{TICKER}.{EXCHANGE_CODE}` — `CBA.AU`, `AAPL.US`
- $19.99/mo plan covers all three exchanges with unlimited EOD + live delayed
- Free plan: 20 calls/day (enough to test)
- Has Stock Market Screener API and Fundamental Data API for market cap, EV, insider holdings
- Twelve Data was rejected because ASX required a $29/mo Grow plan just for basic coverage

### Exchange Codes
| Exchange | EODHD Code | Currency |
|----------|-----------|----------|
| ASX | `AU` | AUD |
| NYSE | `US` | USD |
| NASDAQ | `US` | USD |

### Endpoints Used
| Endpoint | Purpose | Plan |
|----------|---------|------|
| `GET /api/real-time/{TICKER}.{EX}` | Live delayed quote (close, change_p, volume) | Free (limited) / All paid |
| `GET /api/eod/{TICKER}.{EX}?from=...&to=...&period=d` | Historical EOD prices for charting | All plans |
| `GET /api/eod-bulk-last-day/{EX}` | All tickers EOD in 1 call | Paid plans |
| `GET /api/exchange-symbol-list/{EX}` | Full ticker list for exchange | Free / All |
| `GET /api/fundamentals/{TICKER}.{EX}` | Full company profile, financials, valuation, technicals | Paid plans |
| `GET /api/stock-market-screener` | Server-side screening | All-in-One plan |

### API Response Fields

**Real-time quote** (`/real-time`):
```json
{
  "code": "CBA",
  "timestamp": 1711324800,
  "open": 127.50, "high": 129.10, "low": 127.20, "close": 128.45,
  "volume": 3200000, "previousClose": 127.21,
  "change": 1.24, "change_p": 0.97
}
```

**EOD Historical** (`/eod`):
```json
[
  { "date": "2026-03-24", "open": 127.50, "high": 129.10, "low": 127.20, "close": 128.45, "adjusted_close": 128.45, "volume": 3200000 }
]
```

**Fundamentals** (`/fundamentals`) — key nested objects:
- `General` — Name, Sector, Industry, Country, Exchange, WebURL
- `Highlights` — MarketCapitalization, PERatio, PEGRatio, EarningsShare, RevenueTTM, EBITDA, DividendYield, DividendShare, ProfitMargin, OperatingMarginTTM, ReturnOnEquityTTM, ReturnOnAssetsTTM, PayoutRatio
- `Valuation` — EnterpriseValue, ForwardPE
- `Technicals` — 52WeekHigh, 52WeekLow, 50DayMA, 200DayMA, Beta
- `SharesStats` — SharesOutstanding, SharesFloat, PercentInsiders, PercentInstitutions, ShortRatio

### API Functions Defined
| Function | Signature | Notes |
|----------|-----------|-------|
| `eodhFetch` | `(path, apiKey)` | Base fetch wrapper, appends api_token and fmt=json |
| `fetchQuoteSingle` | `(ticker, exchange, apiKey)` | Single live quote |
| `fetchQuotes` | `(symbols, apiKey, exchange)` | Batch quotes, groups of 5 with 600ms delay |
| `fetchBulkEOD` | `(exchange, apiKey)` | All tickers EOD in 1 call (paid) |
| `fetchStocksList` | `(exchange, apiKey)` | Exchange symbol list |
| `fetchEODHistory` | `(ticker, exchange, apiKey, period)` | Historical prices, period: 1m/3m/6m/1y/2y/5y |
| `fetchFundamentals` | `(ticker, exchange, apiKey)` | Full company fundamentals |

### Rate Limiting Strategy
- **Market-hours-aware fetching**: Only call API when the relevant exchange is open
  - ASX: 10:00–16:00 AEST (Australia/Sydney)
  - NYSE/NASDAQ: 9:30–16:00 EST (America/New_York)
- Screener fetches in batches of 5 symbols with 600ms delay between batches
- Auto-refresh every 5 minutes during market hours
- Portfolio fetches its own quotes independently (grouped by exchange)
- Stock tab fetches on-demand only (user presses Lookup)

## Stock Tab

### Layout
- Top: search bar with ticker input, exchange selector, Lookup button
- Left (wide): interactive recharts AreaChart with period selector buttons (1M–5Y)
- Right (320px sidebar): fundamentals cards

### Chart
- Uses `recharts` AreaChart with gradient fill
- Color: green (`var(--grn)`) if change_p >= 0, red (`var(--red)`) if negative
- X-axis: dates formatted as "MMM 'YY"
- Y-axis: prices with currency prefix
- Tooltip: full date + formatted close price
- Period buttons: 1M, 3M, 6M, 1Y, 2Y, 5Y — changing period re-fetches history only (not fundamentals)

### Fundamentals Cards (right sidebar)
1. **Key Statistics** — Market Cap, EV, P/E, Forward P/E, PEG, EPS, Revenue TTM, EBITDA, Profit Margin, Operating Margin
2. **Dividends & Yield** — Dividend Yield, Dividend/Share, Payout Ratio, ROE, ROA
3. **Shares & Ownership** — Shares Outstanding, Float, % Insiders, % Institutions, Short Ratio
4. **Technicals** — 52-Week High/Low, 50-Day MA, 200-Day MA, Beta
5. **Company Info** — Sector, Industry, Country, Exchange, Website link

### Data Flow
1. User types ticker + selects exchange → clicks Lookup (or presses Enter)
2. Three parallel API calls: `/real-time`, `/eod`, `/fundamentals`
3. Quote displayed as large price with change
4. History mapped to `[{date, close, volume}]` for recharts
5. Fundamentals destructured into General, Highlights, Valuation, Technicals, SharesStats
6. Period change triggers re-fetch of `/eod` only

### CSS Classes (Stock tab specific)
- `.stk-search` — search bar container
- `.stk-layout` — 2-column grid (chart + fundamentals)
- `.stk-chart` — chart card with header
- `.stk-price` — large price display (28px, mono, bold)
- `.stk-period` — period button group
- `.stk-funds` — fundamentals sidebar
- `.stk-fund-card` — individual fundamentals card
- `.stk-fund-row` — key-value row inside card (`.fl2` label, `.fv2` value)
- `.stk-empty` — empty state with chart icon
- `.stk-loading` — loading spinner state

## Screener Metrics & Filters

### Range Slider Filters (dual-handle high/low)
1. **Market Cap** — displayed in $M / $B / $T format
2. **Enterprise Value** — same format
3. **Director Holdings %** — percentage of shares held by directors
4. **Top 20 Holdings %** — concentration of top 20 shareholders
5. **Cash Holdings** — cash on balance sheet in $M

### Table Columns
Ticker, Price, Change%, Market Cap, EV, Director%, Top20%, Cash, P/E, Volume, Sector

All columns are sortable (click header to toggle asc/desc).

### Data Notes
- ASX mock data includes ~60 stocks spanning mega-cap ($218B CBA) down to micro-cap ($22M 4DS Memory)
- Market cap starts near zero to reflect the full ASX universe (2000+ stocks on the real exchange)
- NYSE and NASDAQ each have ~20 representative stocks
- Mock data is used as fallback when API is not connected or market is closed

## Portfolio

### Entity Model
- Multiple entities: Personal, SMSF, Family Trust (or user-created)
- Each entity holds an array of holdings
- Each holding stores: `{ticker, shares, cost (avg cost basis), exchange}`
- Holdings can span multiple exchanges within one entity

### Price Lookup (three-tier fallback)
1. Portfolio-specific live data (fetched per-holding via EODHD, grouped by exchange)
2. Global screener live data (from the currently selected exchange)
3. Mock data — searches specified exchange first, then ALL exchanges

### Calculated Fields
- Market Value, Cost Basis, Total P&L, P&L %, Day Change %, Portfolio Weight (with visual bar)

## Calendar

### Event Types
Earnings, Dividend, Conference, Regulatory, Product Launch, Other

### Event Colors
| Type | Badge Class | Color |
|------|------------|-------|
| Earnings | bg-g | Green |
| Dividend | bg-c | Cyan |
| Conference | bg-p | Purple |
| Regulatory | bg-a | Amber |
| Product Launch | bg-b | Blue |
| Other | bg-b | Blue (muted) |

## Design System

### Theme — Dark Terminal Aesthetic
- Background: `#0a0e17` (deep navy-black)
- Cards: `#151d2e` with `#1e2a42` borders
- Accent: `#3b82f6` (blue)
- Positive: `#10b981` (green), Negative: `#ef4444` (red)

### Typography
- Body: `DM Sans` (Google Fonts)
- Monospace: `JetBrains Mono` (prices, tickers, timestamps)

### CSS Class Naming (compact)
Due to artifact size constraints, CSS classes use short names:
- `.cd` = card, `.cdh` = card header, `.cdt` = card title
- `.bn` = button, `.bn-p` = primary, `.bn-s` = small
- `.bi` = icon button
- `.bg` = badge, `.bg-g` = green, `.bg-r` = red, etc.
- `.inp` = input field
- `.pos` / `.neg` = positive/negative color classes
- `.fi` = fade-in animation
- `.tn` = top nav, `.tab` = tab button
- `.exc` = exchange selector group
- `.stk-*` = stock tab classes (see Stock Tab section)

### Market Status Indicator
- Green pulsing dot (`.mkt-open`) = market open
- Red dot (`.mkt-closed`) = market closed
- Displayed in screener header

### Available Libraries (artifact environment)
- `recharts` — AreaChart, LineChart, BarChart, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid
- `lucide-react` — icon library
- `lodash` — utility functions
- `d3` — data visualization (not currently used, recharts preferred for simplicity)

## Common Pitfalls / Lessons Learned

1. **CSS must be at module scope** — defining it inside the render function (especially after an early return for loading state) causes the app to crash with a blank screen
2. **Don't use `localStorage`** — Claude artifacts don't support it. Use `window.storage.get/set` instead
3. **Unicode escapes** — use `"\u2014"` not `—` in JSX strings for consistent rendering
4. **Emoji flags** — use unicode escapes like `"\u{1F1E6}\u{1F1FA}"` for 🇦🇺
5. **File creation** — always delete old file before creating new one at same path (or use a new filename)
6. **Portfolio price lookup** must search across ALL exchanges, not just the currently selected one — users hold cross-exchange portfolios
7. **EODHD field names** — use `change_p` (not `percent_change`), `adjusted_close` (not `adjClose`) for historical data
8. **recharts import** — must import specific components: `{ AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid }`
9. **Stock tab period change** — only re-fetch history, not fundamentals (saves API calls)
10. **Fundamentals null handling** — many fields can be null, 0, or "N/A" — always use defensive formatting functions

## Version History
| Version | Key Changes |
|---------|------------|
| v1 | Initial app with screener, portfolio, calendar. Mock data only. |
| v2 | Added ASX/NYSE/NASDAQ exchange selector, range slider filters. CSS-in-render bug caused blank screen. |
| v3 | Twelve Data API integration, market-hours-aware fetching, expanded ASX universe (~60 stocks). |
| v4 | Switched to EODHD API. Fixed portfolio cross-exchange price lookup. Added Stock tab with recharts chart + fundamentals. |

## Future Enhancements (discussed but not yet built)
- Wire up EODHD `/exchange-symbol-list/AU` to dynamically load all 2000+ ASX tickers
- Use EODHD Stock Market Screener API for server-side filtering
- Use EODHD Fundamental Data API to populate screener market cap, EV, cash, director holdings dynamically
- Add EODHD Calendar API for automatic earnings/dividend date population
- Sector allocation pie chart in portfolio view
- Stock tab: add volume bars below price chart
- Stock tab: "Add to Portfolio" and "Add to Watchlist" buttons
- Stock tab: compare multiple tickers on same chart
- Stock tab: news feed from EODHD Financial News API
