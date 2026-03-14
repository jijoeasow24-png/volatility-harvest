# VolatilityHarvest — Web App

A complete port of the VolatilityHarvest iOS app to a web application, deployable on Vercel for free.

## Features (all 6 tabs from the iOS app)
- **Dashboard** — Portfolio stats, drawdown gauge, circuit breaker, regime summary, active signals
- **Regime** — Monthly 5-question regime check with override modifiers, deployment plan
- **Signals** — Live trade signals (ADD/TRIM/HOLD/STOP-LOSS) with position detail views
- **Portfolio** — Position management, theme allocation, add/edit/delete positions
- **Markets** — Live daily movers, extended hours, volume alerts, news, economic calendar
- **Watchlist** — 27 curated instruments with filtering by theme and role

## Tech Stack
- **Frontend**: React 18 (single HTML file, no build step)
- **API**: Vercel Serverless Functions (proxy for Yahoo Finance)
- **Storage**: Browser localStorage (persists your data)
- **PWA**: Installable on iPhone/Android home screen

## Deploy to Vercel (5 minutes)

### Option 1: Vercel CLI
```bash
npm i -g vercel
cd volatility-harvest
vercel
```
Follow the prompts. Your app will be live at `https://your-project.vercel.app`

### Option 2: GitHub + Vercel Dashboard
1. Push this folder to a GitHub repo
2. Go to [vercel.com](https://vercel.com) and sign in
3. Click "New Project" → Import your GitHub repo
4. Click "Deploy" — no configuration needed

### Option 3: Drag & Drop
1. Go to [vercel.com/new](https://vercel.com/new)
2. Drag the entire `volatility-harvest` folder into the browser
3. Done!

## Install on iPhone (PWA)
After deploying:
1. Open the Vercel URL in Safari on your iPhone
2. Tap the **Share** button (box with arrow)
3. Scroll down and tap **"Add to Home Screen"**
4. Name it "VH" and tap Add

The app will now appear on your home screen and run in full-screen mode, just like a native app — forever.

## How It Works
- **Live Prices**: Fetched via serverless API routes (`/api/quotes` and `/api/news`) that proxy Yahoo Finance
- **Auto-Refresh**: Prices update every 60 seconds automatically
- **Data Persistence**: All your positions, regime settings, and portfolio data are saved in your browser's localStorage
- **No Expiry**: Unlike the free iOS developer account (7-day limit), this web app runs forever on Vercel's free tier

## File Structure
```
volatility-harvest/
├── public/
│   ├── index.html      ← Full React app (all 6 tabs)
│   └── manifest.json   ← PWA config for home screen install
├── api/
│   ├── quotes.js       ← Serverless: Yahoo Finance price quotes
│   └── news.js         ← Serverless: Yahoo Finance news
├── vercel.json         ← Vercel routing config
├── package.json
└── README.md
```
