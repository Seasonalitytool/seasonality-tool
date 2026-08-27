(function () {
  // ---- Shared small helpers (own copies — this file is a separate closure
  // from app.js) -------------------------------------------------------------
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  const tickerList = window.TICKER_LIST || [];
  function tickerNameFor(sym) {
    const t = tickerList.find((t) => t.s === sym);
    return t ? t.n : sym;
  }
  function searchTickers(query) {
    const q = query.trim().toUpperCase();
    if (!q) return [];
    const exact = [];
    const startsWith = [];
    const contains = [];
    for (const t of tickerList) {
      if (t.s === q) exact.push(t);
      else if (t.s.startsWith(q)) startsWith.push(t);
      else if (contains.length < 50 && t.n.toUpperCase().includes(q)) contains.push(t);
    }
    return exact.concat(startsWith, contains).slice(0, 8);
  }

  // ---- Constants --------------------------------------------------------------
  const BENCHMARK_SYMBOL = "^GSPC";
  const SECTORS = [
    { symbol: "XLK", name: "Technology" },
    { symbol: "XLF", name: "Financials" },
    { symbol: "XLE", name: "Energy" },
    { symbol: "XLV", name: "Health Care" },
    { symbol: "XLI", name: "Industrials" },
    { symbol: "XLY", name: "Consumer Discretionary" },
    { symbol: "XLP", name: "Consumer Staples" },
    { symbol: "XLU", name: "Utilities" },
    { symbol: "XLB", name: "Materials" },
    { symbol: "XLRE", name: "Real Estate" },
    { symbol: "XLC", name: "Communication Services" },
  ];
  const PALETTE = [
    "#3b82f6", "#f59e0b", "#a855f7", "#ec4899", "#06b6d4", "#84cc16",
    "#f97316", "#eab308", "#14b8a6", "#f43f5e", "#22c55e", "#818cf8",
  ];
  const MAX_LINES = 10;

  // RS-Ratio / RS-Momentum tuning. The exact JdK formula is proprietary and
  // unpublished; this is a standard, widely-used approximation (relative
  // price, smoothed, expressed as a z-score around 100) that produces the
  // same reading: 100 = in-line with the benchmark, >100 = outperforming.
  const SHORT_SMOOTH = 10; // smooths day-to-day noise out of the raw ratio
  const BASELINE_WINDOW = 30; // "normal" relative level to compare against
  const MOMENTUM_WINDOW = 10; // trailing window the ROC is measured over
  const RATIO_SCALE = 10; // spreads the z-score into a readable ~90-110 band
  const MOMENTUM_SCALE = 3;
  const TAIL_LENGTH = 8; // trailing points shown per sector (5-10 requested)
  const FETCH_DAYS = 300; // comfortably covers baseline+momentum+tail windows

  function sma(arr, window) {
    const out = new Array(arr.length).fill(null);
    let sum = 0;
    for (let i = 0; i < arr.length; i++) {
      sum += arr[i];
      if (i >= window) sum -= arr[i - window];
      if (i >= window - 1) out[i] = sum / window;
    }
    return out;
  }

  function rollingStd(arr, smaArr, window) {
    const out = new Array(arr.length).fill(null);
    for (let i = window - 1; i < arr.length; i++) {
      if (smaArr[i] === null) continue;
      let sq = 0;
      for (let k = i - window + 1; k <= i; k++) {
        const d = arr[k] - smaArr[i];
        sq += d * d;
      }
      out[i] = Math.sqrt(sq / window);
    }
    return out;
  }

  // Aligns a symbol's closes against the benchmark by date, then computes
  // the RS-Ratio / RS-Momentum series (see constants above for the method).
  function computeRRG(benchDates, benchCloses, symDates, symCloses) {
    const benchMap = new Map();
    for (let i = 0; i < benchDates.length; i++) benchMap.set(benchDates[i], benchCloses[i]);

    const relative = [];
    for (let i = 0; i < symDates.length; i++) {
      const bClose = benchMap.get(symDates[i]);
      if (bClose) relative.push(symCloses[i] / bClose);
      else relative.push(null);
    }
    // Drop unaligned leading/trailing nulls but keep interior structure simple
    // by just filtering — small day-count mismatches between ETFs and the
    // index are rare and inconsequential for this smoothed computation.
    const clean = relative.filter((v) => v !== null);

    const shortSma = sma(clean, SHORT_SMOOTH);
    const longSma = sma(clean, BASELINE_WINDOW);
    const longStd = rollingStd(clean, longSma, BASELINE_WINDOW);

    const rsRatio = clean.map((_, i) => {
      if (shortSma[i] == null || longSma[i] == null || !longStd[i]) return null;
      return 100 + ((shortSma[i] - longSma[i]) / longStd[i]) * RATIO_SCALE;
    });

    const rsMomentum = rsRatio.map((v, i) => {
      if (v == null) return null;
      const prevIdx = i - MOMENTUM_WINDOW;
      if (prevIdx < 0 || rsRatio[prevIdx] == null) return null;
      return 100 + (v - rsRatio[prevIdx]) * MOMENTUM_SCALE;
    });

    return { rsRatio, rsMomentum };
  }

  function tailPoints(rsRatio, rsMomentum, n) {
    const pts = [];
    for (let i = rsRatio.length - 1; i >= 0 && pts.length < n; i--) {
      if (rsRatio[i] != null && rsMomentum[i] != null) {
        pts.unshift({ x: rsRatio[i], y: rsMomentum[i] });
      }
    }
    return pts;
  }

  // ---- State --------------------------------------------------------------
  let benchmark = null; // {symbol, dates, closes}
  let series = []; // [{symbol, name, dates, closes, color, removable, tail}]
  let chart = null;
  let initialized = false;

  function apiUrl(path) {
    return `${window.API_BASE_URL || ""}${path}`;
  }

  async function fetchPrices(symbol) {
    const res = await fetch(apiUrl(`/api/prices?symbol=${encodeURIComponent(symbol)}&days=${FETCH_DAYS}`));
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  function setFooter(text) {
    const el = document.getElementById("rrgFooterNote");
    if (el) el.textContent = text;
  }

  let msgTimer = null;
  function flashMsg(text) {
    const el = document.getElementById("rrgSearchMsg");
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => {
      el.hidden = true;
    }, 4500);
  }

  // ---- Chart ---------------------------------------------------------------
  const quadrantPlugin = {
    id: "rrgQuadrants",
    beforeDraw(c) {
      const { ctx, chartArea, scales } = c;
      if (!chartArea) return;
      const xMid = scales.x.getPixelForValue(100);
      const yMid = scales.y.getPixelForValue(100);
      ctx.save();

      ctx.fillStyle = cssVar("--accent-soft");
      ctx.fillRect(xMid, chartArea.top, chartArea.right - xMid, yMid - chartArea.top); // Leading
      ctx.fillStyle = cssVar("--overlay-soft") || "rgba(224, 166, 64, 0.1)";
      ctx.fillRect(xMid, yMid, chartArea.right - xMid, chartArea.bottom - yMid); // Weakening
      ctx.fillStyle = cssVar("--negative-soft");
      ctx.fillRect(chartArea.left, yMid, xMid - chartArea.left, chartArea.bottom - yMid); // Lagging
      ctx.fillStyle = "rgba(59, 130, 246, 0.10)";
      ctx.fillRect(chartArea.left, chartArea.top, xMid - chartArea.left, yMid - chartArea.top); // Improving

      ctx.strokeStyle = cssVar("--chart-zero");
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xMid, chartArea.top);
      ctx.lineTo(xMid, chartArea.bottom);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(chartArea.left, yMid);
      ctx.lineTo(chartArea.right, yMid);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.font = "700 10.5px Inter, sans-serif";
      ctx.fillStyle = cssVar("--text-tertiary");
      ctx.textBaseline = "top";
      ctx.fillText("IMPROVING", chartArea.left + 10, chartArea.top + 10);
      ctx.textAlign = "right";
      ctx.fillText("LEADING", chartArea.right - 10, chartArea.top + 10);
      ctx.textBaseline = "bottom";
      ctx.fillText("WEAKENING", chartArea.right - 10, chartArea.bottom - 10);
      ctx.textAlign = "left";
      ctx.fillText("LAGGING", chartArea.left + 10, chartArea.bottom - 10);
      ctx.restore();
    },
  };

  const labelPlugin = {
    id: "rrgLabels",
    afterDatasetsDraw(c) {
      c.data.datasets.forEach((ds, i) => {
        const meta = c.getDatasetMeta(i);
        if (meta.hidden || !meta.data.length) return;
        const last = meta.data[meta.data.length - 1];
        const { x, y } = last.getProps(["x", "y"], true);
        const ctx = c.ctx;
        ctx.save();
        ctx.fillStyle = ds.borderColor;
        ctx.font = "700 11px Inter, sans-serif";
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.fillText(ds.label, x + 8, y);
        ctx.restore();
      });
    },
  };

  function computeAxisRange() {
    let maxDev = 6; // minimum half-range so a quiet market doesn't over-zoom
    series.forEach((s) => {
      (s.tail || []).forEach((p) => {
        maxDev = Math.max(maxDev, Math.abs(p.x - 100), Math.abs(p.y - 100));
      });
    });
    const pad = maxDev * 1.15;
    return { min: 100 - pad, max: 100 + pad };
  }

  function buildChart() {
    const canvas = document.getElementById("rrgChart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    series.forEach((s) => {
      if (!benchmark) return;
      const { rsRatio, rsMomentum } = computeRRG(benchmark.dates, benchmark.closes, s.dates, s.closes);
      s.tail = tailPoints(rsRatio, rsMomentum, TAIL_LENGTH);
    });

    const datasets = series
      .filter((s) => s.tail && s.tail.length)
      .map((s) => ({
        label: s.symbol,
        data: s.tail,
        borderColor: s.color,
        backgroundColor: s.color,
        showLine: true,
        tension: 0,
        borderWidth: 2,
        pointRadius: s.tail.map((_, i) => (i === s.tail.length - 1 ? 6 : 3)),
        pointHoverRadius: 7,
        pointBackgroundColor: s.tail.map((_, i) => (i === s.tail.length - 1 ? s.color : cssVar("--bg-elevated"))),
        pointBorderColor: s.color,
        pointBorderWidth: 2,
      }));

    const range = computeAxisRange();

    if (chart) {
      chart.data.datasets = datasets;
      chart.options.scales.x.min = range.min;
      chart.options.scales.x.max = range.max;
      chart.options.scales.y.min = range.min;
      chart.options.scales.y.max = range.max;
      chart.options.scales.x.ticks.color = cssVar("--chart-tick");
      chart.options.scales.y.ticks.color = cssVar("--chart-tick");
      chart.options.scales.x.grid.color = cssVar("--chart-grid");
      chart.options.scales.y.grid.color = cssVar("--chart-grid");
      chart.update();
    } else {
      chart = new Chart(ctx, {
        type: "line",
        data: { datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 300 },
          parsing: false,
          scales: {
            x: {
              type: "linear",
              min: range.min,
              max: range.max,
              title: { display: true, text: "JdK RS-Ratio", color: cssVar("--text-tertiary"), font: { size: 11 } },
              grid: { color: cssVar("--chart-grid") },
              ticks: { color: cssVar("--chart-tick"), font: { family: "Inter", size: 11 } },
            },
            y: {
              type: "linear",
              min: range.min,
              max: range.max,
              title: { display: true, text: "JdK RS-Momentum", color: cssVar("--text-tertiary"), font: { size: 11 } },
              grid: { color: cssVar("--chart-grid") },
              ticks: { color: cssVar("--chart-tick"), font: { family: "Inter", size: 11 } },
            },
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              enabled: true,
              backgroundColor: cssVar("--bg-elevated"),
              borderColor: cssVar("--panel-border"),
              borderWidth: 1,
              titleColor: cssVar("--text-primary"),
              bodyColor: cssVar("--text-secondary"),
              callbacks: {
                title: (items) => (items[0] ? items[0].dataset.label : ""),
                label: (item) => `RS-Ratio: ${item.parsed.x.toFixed(2)} · RS-Momentum: ${item.parsed.y.toFixed(2)}`,
              },
            },
          },
        },
        plugins: [quadrantPlugin, labelPlugin],
      });
    }

    renderLegend();
  }

  function renderLegend() {
    const legendEl = document.getElementById("rrgLegend");
    if (!legendEl) return;
    legendEl.innerHTML = "";
    series.forEach((s) => {
      const chip = document.createElement("span");
      chip.className = "legend-chip";
      chip.style.setProperty("--chip-color", s.color);

      const dot = document.createElement("span");
      dot.className = "legend-dot";
      chip.appendChild(dot);

      const label = document.createElement("span");
      label.className = "legend-label";
      label.textContent = s.symbol;
      chip.appendChild(label);

      if (s.name) {
        const name = document.createElement("span");
        name.className = "legend-sector-name";
        name.textContent = s.name;
        chip.appendChild(name);
      }

      const value = document.createElement("span");
      value.className = "legend-value";
      const last = s.tail && s.tail[s.tail.length - 1];
      value.textContent = last ? `${last.x.toFixed(1)}, ${last.y.toFixed(1)}` : "—";
      chip.appendChild(value);

      if (s.removable) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "legend-remove";
        remove.setAttribute("aria-label", `Remove ${s.symbol}`);
        remove.textContent = "×";
        remove.addEventListener("click", () => removeSymbol(s.symbol));
        chip.appendChild(remove);
      }

      legendEl.appendChild(chip);
    });
  }

  // ---- Load / add / remove --------------------------------------------------
  async function loadAndRender() {
    setFooter("Loading sector data…");
    try {
      benchmark = await fetchPrices(BENCHMARK_SYMBOL);
      const results = await Promise.allSettled(SECTORS.map((s) => fetchPrices(s.symbol)));
      series = [];
      results.forEach((r, i) => {
        if (r.status !== "fulfilled") {
          console.warn("Sector fetch failed:", SECTORS[i].symbol, r.reason);
          return;
        }
        series.push({
          symbol: r.value.symbol,
          name: SECTORS[i].name,
          dates: r.value.dates,
          closes: r.value.closes,
          color: PALETTE[i % PALETTE.length],
          removable: false,
        });
      });
      if (!series.length) throw new Error("no sector data available");
      buildChart();
      setFooter(
        `Sector Rotation · benchmark ${BENCHMARK_SYMBOL} · ${series.length} of 11 sectors loaded · source: Yahoo Finance`
      );
    } catch (err) {
      setFooter(`Couldn't load sector data (${(err && err.message) || err}).`);
    }
  }

  async function addSymbol(symbolRaw) {
    const symbol = symbolRaw.trim().toUpperCase();
    if (!symbol) return;
    if (series.some((s) => s.symbol === symbol)) {
      flashMsg(`${symbol} is already on the chart.`);
      return;
    }
    if (series.length >= MAX_LINES) {
      flashMsg(`You can compare up to ${MAX_LINES} lines at once — remove one first.`);
      return;
    }
    const input = document.getElementById("rrgSymbolInput");
    const restore = input ? input.placeholder : "";
    if (input) {
      input.disabled = true;
      input.placeholder = `Loading ${symbol}…`;
    }
    try {
      const data = await fetchPrices(symbol);
      series.push({
        symbol,
        name: tickerNameFor(symbol),
        dates: data.dates,
        closes: data.closes,
        color: PALETTE[series.length % PALETTE.length],
        removable: true,
      });
      buildChart();
    } catch (err) {
      flashMsg(`Couldn't load ${symbol}${err && err.message ? " (" + err.message + ")" : ""}.`);
    } finally {
      if (input) {
        input.disabled = false;
        input.placeholder = restore;
      }
    }
  }

  function removeSymbol(symbol) {
    series = series.filter((s) => s.symbol !== symbol);
    buildChart();
  }

  // ---- Search bar (own instance — reuses the same static ticker list) ------
  function setupSearch() {
    const input = document.getElementById("rrgSymbolInput");
    const dropdown = document.getElementById("rrgSymbolDropdown");
    if (!input || !dropdown) return;

    if (location.protocol === "file:" && !window.API_BASE_URL) {
      input.disabled = true;
      input.placeholder = "Run via scripts/serve.ps1 to add custom tickers";
      return;
    }

    function closeDropdown() {
      dropdown.hidden = true;
      dropdown.innerHTML = "";
    }

    function renderDropdown(results) {
      dropdown.innerHTML = "";
      if (!results.length) {
        closeDropdown();
        return;
      }
      results.forEach((t) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "symbol-option";
        const ticker = document.createElement("span");
        ticker.className = "symbol-option-ticker";
        ticker.textContent = t.s;
        const name = document.createElement("span");
        name.className = "symbol-option-name";
        name.textContent = t.n;
        item.appendChild(ticker);
        item.appendChild(name);
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          addSymbol(t.s);
          input.value = "";
          closeDropdown();
        });
        dropdown.appendChild(item);
      });
      dropdown.hidden = false;
    }

    input.addEventListener("input", () => renderDropdown(searchTickers(input.value)));
    input.addEventListener("focus", () => {
      if (input.value.trim()) renderDropdown(searchTickers(input.value));
    });
    input.addEventListener("blur", () => setTimeout(closeDropdown, 120));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDropdown();
    });
  }

  // ---- Tab switching + Pro gating --------------------------------------------
  // Sector Rotation is free for now (temporarily un-gated) — flip this back
  // to `!!(window.SeasonalityAuth && window.SeasonalityAuth.isPro())` to
  // make it Pro-only again.
  function isProUnlocked() {
    return true;
  }

  function activate() {
    const unlocked = isProUnlocked();
    const overlay = document.getElementById("rrgLockOverlay");
    if (overlay) overlay.hidden = unlocked;
    if (!unlocked) return;
    if (initialized) return;
    initialized = true;
    loadAndRender();
  }

  function currentView() {
    const active = document.querySelector(".page-tab.is-active");
    return active ? active.dataset.view : "seasonality";
  }

  document.querySelectorAll(".page-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const view = tab.dataset.view;
      document.querySelectorAll(".page-tab").forEach((t) => {
        t.classList.toggle("is-active", t === tab);
        t.setAttribute("aria-selected", t === tab ? "true" : "false");
      });
      const seasonalityView = document.getElementById("seasonalityView");
      const rrgView = document.getElementById("sectorRotationView");
      if (seasonalityView) seasonalityView.hidden = view !== "seasonality";
      if (rrgView) rrgView.hidden = view !== "sector-rotation";
      if (view === "sector-rotation") activate();
    });
  });

  const upgradeBtn = document.getElementById("rrgUpgradeBtn");
  if (upgradeBtn) {
    upgradeBtn.addEventListener("click", () => {
      window.SeasonalityAuth && window.SeasonalityAuth.promptUpgrade("Sector Rotation is a Pro feature.");
    });
  }

  if (window.SeasonalityAuth) {
    window.SeasonalityAuth.onChange(() => {
      const badge = document.getElementById("rrgTabProBadge");
      if (badge) badge.hidden = isProUnlocked();
      if (currentView() === "sector-rotation") activate();
    });
  }

  setupSearch();

  // Sync the tab's badge/lock state immediately on load, not just on the
  // next auth change (covers a returning user whose session restores
  // instantly from local storage).
  const initialBadge = document.getElementById("rrgTabProBadge");
  if (initialBadge) initialBadge.hidden = isProUnlocked();
  const initialOverlay = document.getElementById("rrgLockOverlay");
  if (initialOverlay) initialOverlay.hidden = isProUnlocked();
})();
