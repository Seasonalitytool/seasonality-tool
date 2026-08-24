# SeasonalityTool

A clean, minimal fintech dashboard showing the S&P 500's average seasonal
pattern: one composite line plotting the average cumulative % return across
all available historical years, day-by-day from Jan 1 to Dec 31.

## How it works

- **Data**: real daily S&P 500 (`^GSPC`) closes pulled from Yahoo Finance's
  public chart endpoint (`query1.finance.yahoo.com`).
- **Method**: for every full historical calendar year, each day's close is
  normalized against that year's first trading day (= 0%), producing a daily
  cumulative % return path. Non-trading days (weekends/holidays) are
  forward-filled so every year has a value for every calendar day. All years
  are then averaged together, day-by-day, into one composite seasonal line —
  the same approach used by EquityClock-style seasonal charts.
- **Rendering**: the composite is pre-computed into `public/data.js` (plain
  JS, no server/build step needed) and plotted with Chart.js as a smooth,
  interactive line with hover tooltips.

## Running it

No build step, no dependencies to install. Just open the app:

```bash
start public/index.html
```

(or double-click `public/index.html`).

## Refreshing the data

Re-run the fetch/compute script any time to pull the latest prices and
regenerate `public/data.js`:

```bash
powershell -File scripts/update-data.ps1
```

## Structure

```
public/
  index.html      – page shell
  style.css       – dashboard styling
  app.js          – Chart.js setup, tooltip formatting
  data.js         – generated seasonal dataset (do not edit by hand)
scripts/
  update-data.ps1 – fetches Yahoo Finance data & recomputes the seasonal composite
```
