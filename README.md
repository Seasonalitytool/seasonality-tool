# SeasonalityTool

A seasonal S&P 500 chart: the average cumulative % return by calendar day,
computed across historical years, with Bull/Bear filtering and a year-range
slider.

**Free**: S&P 500 chart, year-range slider, Bull/Bear years filter.
**Pro (coming soon)**: election-cycle filter (Election/Post-Election/Midterm/
Pre-Election year), era presets, current-year overlay, and multi-symbol
comparison (search any US ticker and add it to the chart).

## Running locally

```bash
powershell -File scripts/serve.ps1
```

Then open `http://localhost:8080`. Opening `public/index.html` directly
(file://) also works for the free tier, but the ticker-search feature needs
the server running (it proxies Yahoo Finance requests server-side to avoid
the browser's CORS restriction).

## Refreshing data

```bash
powershell -File scripts/update-data.ps1      # S&P 500 seasonal data
powershell -File scripts/build-tickers.ps1    # ticker search list
```

## Accounts & Pro features

Auth is handled by Supabase (`public/supabase-config.js` holds the project
URL and public/anon key — safe to be public, protected by Row Level
Security). Run `scripts/supabase-setup.sql` once in the Supabase SQL editor
to create the `profiles` table used to track Pro status.

Stripe billing isn't wired up yet — the "Upgrade to Pro" button currently
shows a "coming soon" message. To manually grant Pro to an account for
testing, set `is_pro = true` on that user's row in the `profiles` table.

## Deployment

Pushing to `main`/`master` deploys `public/` to GitHub Pages automatically
via `.github/workflows/deploy.yml`. One-time setup in the repo: **Settings →
Pages → Source → GitHub Actions**.
