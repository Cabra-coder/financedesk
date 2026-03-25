# FinanceDesk — React Artifact (v4)

A personal finance application built as a single-file React artifact for Claude's artifact environment. Stock screener, individual stock research, portfolio manager, and event calendar targeting ASX, NYSE, and NASDAQ.

## Features

- **Screener** — Sortable stock table with dual-handle range slider filters (Market Cap, Enterprise Value, Director Holdings %, Top 20 Holdings %, Cash Holdings), sector filter, search, watchlist
- **Stock Lookup** — Individual stock research with interactive recharts price chart (1M–5Y periods) and fundamentals panel (key stats, dividends, ownership, technicals, company info)
- **Portfolio** — Multi-entity portfolio manager (Personal, SMSF, Trust) with cross-exchange holdings, P&L tracking, portfolio weight bars
- **Calendar** — Monthly event calendar for tracking earnings, dividends, conferences, regulatory dates against stock tickers

## Data

- **Mock data** included for ~60 ASX stocks (mega-cap to micro-cap), ~20 NYSE, ~20 NASDAQ
- **EODHD API** integration (delayed live quotes, historical EOD, fundamentals) — requires API key
- ⚠️ **Known issue**: CORS blocks browser-side API calls in the artifact environment. A Python rewrite is planned to resolve this.

## Files

| File | Description |
|------|-------------|
| `finance-app.jsx` | Complete single-file React application (v4) |
| `CLAUDE.md` | Project context file for Claude — architecture, API details, design system, pitfalls |
| `README.md` | This file |

## Status

This is the React/artifact version of FinanceDesk. A Python-based rewrite using Flask + yfinance is planned to eliminate CORS issues and enable reliable Yahoo Finance data for ASX, NYSE, and NASDAQ.

## Usage

This file is designed to run as a Claude artifact (`.jsx` rendered in claude.ai). Upload `finance-app.jsx` as an artifact to use it. For development context, upload `CLAUDE.md` at the start of any Claude conversation.

## Design

- Dark terminal aesthetic with DM Sans + JetBrains Mono typography
- CSS custom properties throughout
- Responsive layout (desktop + mobile)
- Persistent storage via Claude's `window.storage` API

## License

Personal use.
