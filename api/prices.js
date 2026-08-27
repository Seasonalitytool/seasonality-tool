// Vercel serverless function: GET /api/prices?symbol=XLK&days=300
//
// Returns raw daily closes for a symbol over a trailing window — used by
// the Sector Rotation (RRG) view, which needs an actual price time series
// to compute relative strength, not the per-calendar-day seasonal composite
// that /api/history.js produces. Runs server-side for the same reason as
// history.js: avoids the browser's CORS block on Yahoo Finance.

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
};

const easternDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

async function getDailyPrices(symbol, days) {
  // Ask for comfortably more calendar days than trading days needed, since
  // weekends/holidays mean ~30% of calendar days have no bar.
  const period1 = Math.floor(Date.now() / 1000) - Math.ceil(days * 1.6) * 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?period1=${period1}&period2=9999999999&interval=1d`;

  const resp = await fetch(url, { headers: HEADERS });
  if (!resp.ok) throw new Error(`Yahoo Finance HTTP ${resp.status}`);
  const json = await resp.json();
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result || !result.timestamp || !result.timestamp.length) {
    throw new Error(`No data returned for symbol '${symbol}'.`);
  }

  const closes = result.indicators.quote[0].close;
  const byDate = new Map();
  for (let i = 0; i < result.timestamp.length; i++) {
    const c = closes[i];
    if (c === null || c === undefined) continue;
    const dateStr = easternDateFormatter.format(new Date(result.timestamp[i] * 1000));
    byDate.set(dateStr, c);
  }
  const dates = Array.from(byDate.keys()).sort();
  if (!dates.length) throw new Error(`No usable daily closes for symbol '${symbol}'.`);

  const trimmed = dates.slice(-days);
  return {
    symbol: symbol.toUpperCase(),
    dates: trimmed,
    closes: trimmed.map((d) => byDate.get(d)),
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const symbol = (req.query.symbol || "").toString().trim();
  const days = Math.min(500, Math.max(60, parseInt(req.query.days, 10) || 300));
  if (!symbol) {
    res.status(400).json({ error: "missing symbol" });
    return;
  }

  try {
    const data = await getDailyPrices(symbol, days);
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: (err && err.message) || String(err) });
  }
};
