// Vercel serverless function: GET /api/history?symbol=AAPL
//
// Runs server-side (not in the browser), so it can call Yahoo Finance
// directly without hitting the browser's CORS block that stops the
// frontend from doing this itself. This is the same logic as
// scripts/serve.ps1's Get-SeasonalHistory function / scripts/update-data.ps1
// — ported to JavaScript so it can run on Vercel instead of only on a local
// machine. Keep the three in sync if the seasonal-computation logic changes.

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
};

// Canonical Jan 1 - Dec 31 "MM-DD" key list (2024 is a leap year, so Feb 29
// is included) — every year's values array lines up against this list.
const REF_DAYS = (() => {
  const days = [];
  const d = new Date(Date.UTC(2024, 0, 1));
  const end = new Date(Date.UTC(2024, 11, 31));
  while (d <= end) {
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    days.push(`${mm}-${dd}`);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
})();

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

const easternDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

async function getSeasonalHistory(symbol) {
  const period1 = -2208988800; // 1900-01-01 — Yahoo clamps to the real first trade date
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?period1=${period1}&period2=9999999999&interval=1d&events=history`;

  const resp = await fetch(url, { headers: HEADERS });
  if (!resp.ok) throw new Error(`Yahoo Finance HTTP ${resp.status}`);
  const json = await resp.json();
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result || !result.timestamp || !result.timestamp.length) {
    throw new Error(`No data returned for symbol '${symbol}'.`);
  }

  const closes = result.indicators.quote[0].close;
  const byDate = new Map(); // "YYYY-MM-DD" (US/Eastern) -> close
  for (let i = 0; i < result.timestamp.length; i++) {
    const c = closes[i];
    if (c === null || c === undefined) continue;
    const dateStr = easternDateFormatter.format(new Date(result.timestamp[i] * 1000));
    byDate.set(dateStr, c);
  }
  const sortedDates = Array.from(byDate.keys()).sort();
  if (!sortedDates.length) throw new Error(`No usable daily closes for symbol '${symbol}'.`);

  const byYear = new Map();
  for (const ds of sortedDates) {
    const y = parseInt(ds.slice(0, 4), 10);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(ds);
  }

  const lastFullDataDate = sortedDates[sortedDates.length - 1];
  const currentYear = parseInt(lastFullDataDate.slice(0, 4), 10);
  const fullYears = Array.from(byYear.keys())
    .filter((y) => y < currentYear)
    .sort((a, b) => a - b);
  if (!fullYears.length) throw new Error(`Not enough full-year history for symbol '${symbol}'.`);

  let bullCount = 0;
  let bearCount = 0;
  const yearsOut = [];

  for (const y of fullYears) {
    const daysInYear = byYear.get(y);
    const tradingClose = new Map();
    for (const ds of daysInYear) tradingClose.set(ds.slice(5), byDate.get(ds));

    const baseline = byDate.get(daysInYear[0]);
    if (!baseline) continue;
    const lastClose = byDate.get(daysInYear[daysInYear.length - 1]);
    const type = lastClose > baseline ? "bull" : "bear";
    if (type === "bull") bullCount++;
    else bearCount++;

    const leap = isLeapYear(y);
    let lastVal = 0;
    const values = [];
    for (const key of REF_DAYS) {
      if (key === "02-29" && !leap) {
        values.push(null);
        continue;
      }
      if (tradingClose.has(key)) {
        lastVal = (tradingClose.get(key) / baseline - 1) * 100;
      }
      values.push(Math.round(lastVal * 10000) / 10000);
    }
    yearsOut.push({ year: y, type, values });
  }

  return {
    symbol: symbol.toUpperCase(),
    years: yearsOut,
    meta: {
      startYear: fullYears[0],
      endYear: fullYears[fullYears.length - 1],
      yearsUsed: yearsOut.length,
      bullYears: bullCount,
      bearYears: bearCount,
      lastDataDate: lastFullDataDate,
    },
  };
}

module.exports = async (req, res) => {
  // The frontend (GitHub Pages) is a different origin from this function
  // (Vercel), so it needs an explicit CORS allow — this endpoint only ever
  // returns public market data, nothing user-specific, so a wide-open
  // Access-Control-Allow-Origin is fine here.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const symbol = (req.query.symbol || "").toString().trim();
  if (!symbol) {
    res.status(400).json({ error: "missing symbol" });
    return;
  }

  try {
    const data = await getSeasonalHistory(symbol);
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: (err && err.message) || String(err) });
  }
};
