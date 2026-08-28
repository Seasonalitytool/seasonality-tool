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
  const MAX_LINES = 12;

  // Built-in starting points — the sector view stays the default, plus a
  // couple of other widely-relevant baskets people commonly want to compare.
  const DEFAULT_GROUPS = [
    { id: "sectors", name: "Sectors", builtin: true, symbols: SECTORS.map((s) => s.symbol) },
    { id: "mag7", name: "Magnificent 7", builtin: true, symbols: ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"] },
    { id: "semis", name: "Semiconductors", builtin: true, symbols: ["NVDA", "AMD", "TSM", "AVGO", "INTC", "QCOM", "MU", "ASML"] },
    { id: "banks", name: "Big Banks", builtin: true, symbols: ["JPM", "BAC", "WFC", "C", "GS", "MS", "USB", "PNC"] },
  ];
  const CUSTOM_GROUPS_KEY = "rrgCustomGroups";

  function loadCustomGroups() {
    try {
      const raw = localStorage.getItem(CUSTOM_GROUPS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function saveCustomGroups() {
    try {
      localStorage.setItem(CUSTOM_GROUPS_KEY, JSON.stringify(customGroups));
    } catch (e) {}
  }

  let customGroups = loadCustomGroups(); // [{id, name, builtin:false, symbols:[...]}]
  let activeGroupId = "sectors";

  function allGroups() {
    return DEFAULT_GROUPS.concat(customGroups);
  }

  function getGroupById(id) {
    return allGroups().find((g) => g.id === id) || DEFAULT_GROUPS[0];
  }

  // RS-Ratio / RS-Momentum tuning. The exact JdK formula is proprietary and
  // unpublished; this is a standard, widely-used approximation (relative
  // price, smoothed, expressed as a z-score around 100) that produces the
  // same reading: 100 = in-line with the benchmark, >100 = outperforming.
  // Each timeframe gets its own windows (in BAR count, not calendar time) —
  // daily needs more smoothing since each bar is noisier; weekly/monthly
  // bars are already smoother, so shorter windows respond better.
  const RATIO_SCALE = 10; // spreads the z-score into a readable ~90-110 band
  const MOMENTUM_SCALE = 3;
  const TIMEFRAME_PRESETS = {
    daily: { shortSmooth: 10, baseline: 30, momentum: 10, tail: 8 },
    weekly: { shortSmooth: 4, baseline: 12, momentum: 4, tail: 8 },
    monthly: { shortSmooth: 2, baseline: 6, momentum: 3, tail: 6 },
  };
  // One fetch covers every timeframe (no re-fetching on toggle) — ~1500
  // trading days is ~6 years, comfortably enough for monthly's windows too.
  const FETCH_DAYS = 1500;
  let currentTimeframe = "daily";

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

  // Buckets daily {dates, closes} into weekly (Mon-Sun) or monthly bars,
  // keeping the last close in each bucket. No-op for "daily".
  function mondayOf(dateStr) {
    const dt = new Date(dateStr + "T00:00:00Z");
    const day = dt.getUTCDay(); // 0=Sun..6=Sat
    const diff = day === 0 ? -6 : 1 - day;
    dt.setUTCDate(dt.getUTCDate() + diff);
    return dt.toISOString().slice(0, 10);
  }

  function resample(dates, closes, timeframe) {
    if (timeframe === "daily") return { dates, closes };
    const buckets = new Map();
    for (let i = 0; i < dates.length; i++) {
      const key = timeframe === "weekly" ? mondayOf(dates[i]) : dates[i].slice(0, 7);
      buckets.set(key, { date: dates[i], close: closes[i] }); // last write per key wins
    }
    const outDates = [];
    const outCloses = [];
    buckets.forEach((v) => {
      outDates.push(v.date);
      outCloses.push(v.close);
    });
    return { dates: outDates, closes: outCloses };
  }

  // Aligns a symbol's closes against the benchmark by date, then computes
  // the RS-Ratio / RS-Momentum series (see constants above for the method).
  function computeRRG(benchDates, benchCloses, symDates, symCloses, preset) {
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

    const shortSma = sma(clean, preset.shortSmooth);
    const longSma = sma(clean, preset.baseline);
    const longStd = rollingStd(clean, longSma, preset.baseline);

    const rsRatio = clean.map((_, i) => {
      if (shortSma[i] == null || longSma[i] == null || !longStd[i]) return null;
      return 100 + ((shortSma[i] - longSma[i]) / longStd[i]) * RATIO_SCALE;
    });

    const rsMomentum = rsRatio.map((v, i) => {
      if (v == null) return null;
      const prevIdx = i - preset.momentum;
      if (prevIdx < 0 || rsRatio[prevIdx] == null) return null;
      return 100 + (v - rsRatio[prevIdx]) * MOMENTUM_SCALE;
    });

    return { rsRatio, rsMomentum };
  }

  // ---- State --------------------------------------------------------------
  let benchmark = null; // {symbol, dates, closes}
  let series = []; // [{symbol, name, dates, closes, color, removable, allPoints, allDates, tail}]
  let chart = null;
  let initialized = false;

  let isPlaying = false;
  let playIndex = 0;
  let playAnimHandle = null;
  const GLIDE_MS = 450; // time to smoothly glide from one point to the next

  function apiUrl(path) {
    return `${window.API_BASE_URL || ""}${path}`;
  }

  async function fetchPrices(symbol) {
    const res = await fetch(apiUrl(`/api/prices?symbol=${encodeURIComponent(symbol)}&days=${FETCH_DAYS}`));
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  // Same-session cache so switching between groups (or back to one you were
  // just on) doesn't re-fetch a symbol that's already loaded.
  const priceCache = new Map();
  async function fetchPricesCached(symbol) {
    if (priceCache.has(symbol)) return priceCache.get(symbol);
    const data = await fetchPrices(symbol);
    priceCache.set(symbol, data);
    return data;
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

  // Uses each series' FULL history (not just the visible tail) so the fixed
  // initial view already covers everywhere the Play animation will scrub
  // to — otherwise older points during playback render outside the axes.
  // Padded generously (and defaults a bit more zoomed-out) so points never
  // sit right at the edge.
  function computeAxisRange() {
    let maxDev = 8; // minimum half-range so a quiet market doesn't over-zoom
    series.forEach((s) => {
      (s.allPoints || s.tail || []).forEach((p) => {
        maxDev = Math.max(maxDev, Math.abs(p.x - 100), Math.abs(p.y - 100));
      });
    });
    const pad = maxDev * 1.35;
    return { min: 100 - pad, max: 100 + pad };
  }

  // Computes every series' FULL point history (not just the visible tail) —
  // needed so the play/animate feature can scrub back through time, not
  // just show the current snapshot.
  function computeSeriesRRG() {
    const preset = TIMEFRAME_PRESETS[currentTimeframe] || TIMEFRAME_PRESETS.daily;
    const benchResampled = benchmark ? resample(benchmark.dates, benchmark.closes, currentTimeframe) : null;

    series.forEach((s) => {
      if (!benchResampled) {
        s.allPoints = [];
        s.allDates = [];
        s.tail = [];
        return;
      }
      const symResampled = resample(s.dates, s.closes, currentTimeframe);
      const { rsRatio, rsMomentum } = computeRRG(
        benchResampled.dates,
        benchResampled.closes,
        symResampled.dates,
        symResampled.closes,
        preset
      );
      const pts = [];
      const dates = [];
      for (let i = 0; i < rsRatio.length; i++) {
        if (rsRatio[i] != null && rsMomentum[i] != null) {
          pts.push({ x: rsRatio[i], y: rsMomentum[i] });
          dates.push(symResampled.dates[i]);
        }
      }
      s.allPoints = pts;
      s.allDates = dates;
      s.tail = pts.slice(-preset.tail);
    });

    return preset;
  }

  // Rebuilds the Chart.js datasets from each series' CURRENT s.tail —
  // deliberately cheap (no RS-Ratio recomputation) so it can run every
  // animation frame during playback without recalculating anything.
  function renderChartDatasets(mode) {
    const canvas = document.getElementById("rrgChart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    const datasets = series
      .filter((s) => s.tail && s.tail.length)
      .map((s) => ({
        label: s.symbol,
        fullName: s.name,
        data: s.tail,
        hidden: s.visible === false,
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

    if (chart) {
      // Deliberately NOT touching x/y min/max here — the user may have
      // zoomed or panned, and refreshing the axis range on every data
      // update (adding a symbol, switching timeframe) would silently
      // discard that. "Reset zoom" / double-click exists for going back to
      // the auto-fit view.
      chart.data.datasets = datasets;
      chart.options.scales.x.ticks.color = cssVar("--chart-tick");
      chart.options.scales.y.ticks.color = cssVar("--chart-tick");
      chart.options.scales.x.grid.color = cssVar("--chart-grid");
      chart.options.scales.y.grid.color = cssVar("--chart-grid");
      chart.update(mode);
      // Chart.js only reads a dataset's `hidden` flag the first time it
      // creates that dataset's internal meta — reassigning chart.data.datasets
      // above does NOT re-apply it on later updates (toggling a legend chip,
      // adding a symbol, etc.), so visibility has to be set explicitly here
      // every time instead.
      datasets.forEach((ds, i) => chart.setDatasetVisibility(i, !ds.hidden));
      chart.update(mode);
    } else {
      const range = computeAxisRange(); // only used for the initial auto-fit view

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
                title: (items) => {
                  if (!items[0]) return "";
                  const ds = items[0].dataset;
                  return ds.fullName && ds.fullName !== ds.label ? `${ds.label} — ${ds.fullName}` : ds.label;
                },
                label: (item) => `RS-Ratio: ${item.parsed.x.toFixed(2)} · RS-Momentum: ${item.parsed.y.toFixed(2)}`,
              },
            },
            zoom: {
              pan: { enabled: true, mode: "xy" },
              zoom: {
                wheel: { enabled: true },
                pinch: { enabled: true },
                drag: { enabled: false },
                mode: "xy",
              },
              limits: { x: { min: 20, max: 180 }, y: { min: 20, max: 180 } },
            },
          },
        },
        plugins: [quadrantPlugin, labelPlugin],
      });
    }
  }

  // Full pipeline: recompute RS-Ratio/Momentum for every series, redraw the
  // chart from each one's current (latest) tail, and refresh the legend/
  // footer. Called whenever the underlying data or settings change (new
  // group, symbol added/removed, timeframe switched, visibility toggled).
  function buildChart() {
    stopPlay(); // a full rebuild always means "fresh data" — any running animation is now stale
    computeSeriesRRG();
    renderChartDatasets();
    renderLegend();
    setupTimelineRange();

    if (series.length) {
      const tfLabel = currentTimeframe.charAt(0).toUpperCase() + currentTimeframe.slice(1);
      setFooter(
        `Sector Rotation · ${tfLabel} · benchmark ${BENCHMARK_SYMBOL} · ${series.length} sector${series.length === 1 ? "" : "s"} tracked · source: Yahoo Finance`
      );
    }
  }

  function renderLegend() {
    const legendEl = document.getElementById("rrgLegend");
    if (!legendEl) return;
    legendEl.innerHTML = "";
    series.forEach((s) => {
      const chip = document.createElement("span");
      chip.className = "legend-chip legend-chip-toggle";
      chip.classList.toggle("is-hidden", s.visible === false);
      chip.style.setProperty("--chip-color", s.color);
      chip.title = s.visible === false ? `Click to show ${s.symbol}` : `Click to hide ${s.symbol}`;
      chip.addEventListener("click", () => {
        s.visible = s.visible === false ? true : false;
        buildChart();
      });

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

      if (s.removable) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "legend-remove";
        remove.setAttribute("aria-label", `Remove ${s.symbol}`);
        remove.textContent = "×";
        remove.addEventListener("click", (e) => {
          e.stopPropagation();
          removeSymbol(s.symbol);
        });
        chip.appendChild(remove);
      }

      legendEl.appendChild(chip);
    });
  }

  // ---- Load / add / remove --------------------------------------------------
  async function loadGroup(group) {
    activeGroupId = group.id;
    renderGroupBar();
    setFooter(`Loading ${group.name}…`);
    try {
      benchmark = await fetchPricesCached(BENCHMARK_SYMBOL);
      const results = await Promise.allSettled(group.symbols.map((sym) => fetchPricesCached(sym)));
      series = [];
      results.forEach((r, i) => {
        const sym = group.symbols[i];
        if (r.status !== "fulfilled") {
          console.warn("Fetch failed:", sym, r.reason);
          return;
        }
        // The "Sectors" group carries hand-picked sector names (XLK isn't in
        // the ETF-free ticker list, so tickerNameFor() can't resolve it) —
        // every other group's members are regular stocks, resolved normally.
        const sectorDef = group.id === "sectors" ? SECTORS[i] : null;
        series.push({
          symbol: r.value.symbol,
          name: sectorDef ? sectorDef.name : tickerNameFor(sym),
          dates: r.value.dates,
          closes: r.value.closes,
          color: PALETTE[i % PALETTE.length],
          removable: true,
          visible: true,
        });
      });
      if (!series.length) throw new Error("no data available for this group");
      buildChart(); // also sets the footer text with the loaded count
    } catch (err) {
      setFooter(`Couldn't load ${group.name} (${(err && err.message) || err}).`);
    }
  }

  function renderGroupBar() {
    const bar = document.getElementById("rrgGroupBar");
    if (!bar) return;
    bar.innerHTML = "";

    allGroups().forEach((g) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "era-btn rrg-group-btn" + (g.builtin ? "" : " rrg-delete-group-btn");
      btn.classList.toggle("is-active", g.id === activeGroupId);

      if (g.builtin) {
        btn.textContent = g.name;
        btn.addEventListener("click", () => loadGroup(g));
      } else {
        const label = document.createElement("span");
        label.textContent = g.name;
        btn.appendChild(label);
        const del = document.createElement("span");
        del.className = "rrg-group-delete-x";
        del.textContent = "×";
        del.setAttribute("aria-label", `Delete group ${g.name}`);
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          deleteCustomGroup(g.id);
        });
        btn.appendChild(del);
        btn.addEventListener("click", (e) => {
          if (e.target === del) return;
          loadGroup(g);
        });
      }
      bar.appendChild(btn);
    });

    const newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.className = "era-btn rrg-new-group-btn";
    newBtn.textContent = "+ New Group";
    newBtn.addEventListener("click", openNewGroupPanel);
    bar.appendChild(newBtn);
  }

  function deleteCustomGroup(id) {
    customGroups = customGroups.filter((g) => g.id !== id);
    saveCustomGroups();
    if (activeGroupId === id) {
      loadGroup(DEFAULT_GROUPS[0]);
    } else {
      renderGroupBar();
    }
  }

  function removeSymbol(symbol) {
    series = series.filter((s) => s.symbol !== symbol);
    buildChart();
  }

  // ---- Create-a-group panel ---------------------------------------------------
  let pendingGroupSymbols = [];

  function openNewGroupPanel() {
    pendingGroupSymbols = [];
    renderPendingChips();
    const panel = document.getElementById("rrgNewGroupPanel");
    const nameInput = document.getElementById("rrgNewGroupName");
    if (nameInput) nameInput.value = "";
    if (panel) panel.hidden = false;
    if (nameInput) nameInput.focus();
  }

  function closeNewGroupPanel() {
    const panel = document.getElementById("rrgNewGroupPanel");
    if (panel) panel.hidden = true;
    pendingGroupSymbols = [];
  }

  function renderPendingChips() {
    const chipsEl = document.getElementById("rrgNewGroupChips");
    if (!chipsEl) return;
    chipsEl.innerHTML = "";
    pendingGroupSymbols.forEach((sym) => {
      const chip = document.createElement("span");
      chip.className = "legend-chip";
      const label = document.createElement("span");
      label.className = "legend-label";
      label.textContent = sym;
      chip.appendChild(label);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "legend-remove";
      remove.setAttribute("aria-label", `Remove ${sym}`);
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        pendingGroupSymbols = pendingGroupSymbols.filter((s) => s !== sym);
        renderPendingChips();
      });
      chip.appendChild(remove);
      chipsEl.appendChild(chip);
    });
  }

  function setupNewGroupPanel() {
    const input = document.getElementById("rrgNewGroupSymbolInput");
    const dropdown = document.getElementById("rrgNewGroupDropdown");
    const saveBtn = document.getElementById("rrgSaveGroupBtn");
    const cancelBtn = document.getElementById("rrgCancelGroupBtn");
    if (!input || !dropdown) return;

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
          if (!pendingGroupSymbols.includes(t.s)) {
            if (pendingGroupSymbols.length >= MAX_LINES) {
              flashMsg(`A group can hold up to ${MAX_LINES} tickers.`);
            } else {
              pendingGroupSymbols.push(t.s);
              renderPendingChips();
            }
          }
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

    if (saveBtn) {
      saveBtn.addEventListener("click", () => {
        const nameInput = document.getElementById("rrgNewGroupName");
        const name = nameInput ? nameInput.value.trim() : "";
        if (!name) {
          flashMsg("Give the group a name first.");
          return;
        }
        if (!pendingGroupSymbols.length) {
          flashMsg("Add at least one ticker to the group.");
          return;
        }
        const id = "custom-" + Date.now();
        const group = { id, name, builtin: false, symbols: pendingGroupSymbols.slice() };
        customGroups.push(group);
        saveCustomGroups();
        closeNewGroupPanel();
        loadGroup(group);
      });
    }
    if (cancelBtn) {
      cancelBtn.addEventListener("click", closeNewGroupPanel);
    }
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
    renderGroupBar();
    loadGroup(getGroupById(activeGroupId));
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

  // ---- Timeframe toggle (Daily / Weekly / Monthly) ---------------------------
  const timeframeBar = document.getElementById("rrgTimeframeBar");
  if (timeframeBar) {
    timeframeBar.addEventListener("click", (e) => {
      const btn = e.target.closest(".filter-btn");
      if (!btn) return;
      const tf = btn.getAttribute("data-timeframe");
      if (!tf || tf === currentTimeframe) return;
      currentTimeframe = tf;
      timeframeBar.querySelectorAll(".filter-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
      if (initialized) buildChart();
    });
  }

  // ---- Zoom / pan controls ---------------------------------------------------
  const resetZoomBtn = document.getElementById("rrgResetZoomBtn");
  if (resetZoomBtn) {
    resetZoomBtn.addEventListener("click", () => {
      if (chart) chart.resetZoom();
    });
  }
  const rrgCanvas = document.getElementById("rrgChart");
  if (rrgCanvas) {
    rrgCanvas.addEventListener("dblclick", () => {
      if (chart) chart.resetZoom();
    });
  }

  // ---- Play / animate the tail through time -----------------------------------
  // Rather than letting Chart.js animate the whole sliding-window array every
  // step (which makes the entire trail visibly "shift" each frame, since
  // Chart.js interpolates by array index and every index's value changes
  // when the window slides), only the newest point is tweened smoothly
  // between its previous and next position each step; already-settled trail
  // points are drawn at their final position immediately and stay put.
  function playableSeries() {
    return series.filter((s) => s.visible !== false && s.allPoints && s.allPoints.length);
  }

  // ---- Timeline scrubber ------------------------------------------------------
  // Lets someone drag straight to any point in history instead of only
  // watching the auto-play — same underlying "settled tail ending at index"
  // logic Play uses, just applied instantly instead of glided.
  function setupTimelineRange() {
    const slider = document.getElementById("rrgTimelineSlider");
    if (!slider) return;
    const active = playableSeries();
    const preset = TIMEFRAME_PRESETS[currentTimeframe] || TIMEFRAME_PRESETS.daily;
    if (!active.length) {
      slider.min = 0;
      slider.max = 0;
      slider.value = 0;
      slider.disabled = true;
      return;
    }
    const minLen = Math.min(...active.map((s) => s.allPoints.length));
    const lo = preset.tail - 1;
    const hi = minLen - 1;
    slider.min = lo;
    slider.max = Math.max(lo, hi);
    slider.value = hi; // default to "now" — matches the normal (non-scrubbed) view
    slider.disabled = hi <= lo;
    playIndex = hi; // keep in sync so a fresh Play click resumes from "now", not a stale index
    updatePlayDate(active, hi);
  }

  function updateTimelineSlider(idx) {
    const slider = document.getElementById("rrgTimelineSlider");
    if (slider) slider.value = Math.round(idx);
  }

  function seekTo(idx) {
    stopPlay();
    const active = playableSeries();
    if (!active.length) return;
    const preset = TIMEFRAME_PRESETS[currentTimeframe] || TIMEFRAME_PRESETS.daily;
    playIndex = idx;
    series.forEach((s) => {
      if (!s.allPoints || !s.allPoints.length) return;
      const at = Math.min(idx, s.allPoints.length - 1);
      const start = Math.max(0, at - preset.tail + 1);
      s.tail = s.allPoints.slice(start, at + 1);
    });
    renderChartDatasets("none");
    renderLegend();
    updatePlayDate(active, idx);
  }

  const timelineSlider = document.getElementById("rrgTimelineSlider");
  if (timelineSlider) {
    timelineSlider.addEventListener("input", () => seekTo(parseInt(timelineSlider.value, 10)));
  }

  function updatePlayButton() {
    const btn = document.getElementById("rrgPlayBtn");
    if (!btn) return;
    btn.textContent = isPlaying ? "⏸ Pause" : "▶ Play";
    btn.classList.toggle("is-playing", isPlaying);
  }

  function updatePlayDate(active, idx) {
    const dateEl = document.getElementById("rrgPlayDate");
    if (!dateEl || !active.length) return;
    const ref = active.reduce((a, b) => (a.allDates.length <= b.allDates.length ? a : b));
    const i = Math.min(Math.round(idx), ref.allDates.length - 1);
    dateEl.textContent = ref.allDates[i] || "";
  }

  // Advances one step: glides every visible series' lead point from its
  // current position to the next data point over GLIDE_MS, easing in/out,
  // then commits and immediately schedules the next step.
  function playStep() {
    if (!isPlaying) return;
    const active = playableSeries();
    const preset = TIMEFRAME_PRESETS[currentTimeframe] || TIMEFRAME_PRESETS.daily;
    if (!active.length) {
      stopPlay();
      return;
    }
    const minLen = Math.min(...active.map((s) => s.allPoints.length));
    if (playIndex >= minLen - 1) {
      buildChart(); // snap every series back to its own true latest tail
      return;
    }

    const nextIndex = playIndex + 1;
    // Per series: the settled trail (fixed, already-reached points) and the
    // from/to positions the lead point glides between this step.
    const frames = series
      .filter((s) => s.allPoints && s.allPoints.length)
      .map((s) => {
        const at = Math.min(playIndex, s.allPoints.length - 1);
        const to = Math.min(nextIndex, s.allPoints.length - 1);
        const settledStart = Math.max(0, at - preset.tail + 2);
        return {
          s,
          from: s.allPoints[at],
          to: s.allPoints[to],
          settled: s.allPoints.slice(settledStart, at + 1), // includes "from" as its last entry
        };
      });

    const startTime = performance.now();
    // Linear, not eased — easing decelerates to a full stop at the end of
    // every single step and re-accelerates from zero for the next one,
    // which reads as the motion visibly pausing at each point. Constant
    // speed within each step makes consecutive steps blend into one
    // continuous glide instead.
    function tick(now) {
      if (!isPlaying) return;
      const e = Math.min(1, (now - startTime) / GLIDE_MS);
      frames.forEach(({ s, from, to, settled }) => {
        const hx = from.x + (to.x - from.x) * e;
        const hy = from.y + (to.y - from.y) * e;
        s.tail = settled.slice(0, -1).concat([{ x: hx, y: hy }]);
      });
      renderChartDatasets("none"); // no built-in animation — we're driving it ourselves
      updatePlayDate(active, playIndex + e);

      if (e < 1) {
        playAnimHandle = requestAnimationFrame(tick);
      } else {
        playIndex = nextIndex;
        renderLegend(); // once per settled step, not every glide tick
        updateTimelineSlider(playIndex);
        playAnimHandle = requestAnimationFrame(playStep);
      }
    }
    playAnimHandle = requestAnimationFrame(tick);
  }

  function startPlay() {
    const active = playableSeries();
    const preset = TIMEFRAME_PRESETS[currentTimeframe] || TIMEFRAME_PRESETS.daily;
    if (!active.length) {
      flashMsg("Nothing visible to animate — show at least one ticker.");
      return;
    }
    const minLen = Math.min(...active.map((s) => s.allPoints.length));
    if (minLen < preset.tail + 2) {
      flashMsg("Not enough history to animate at this timeframe yet.");
      return;
    }
    if (playIndex <= 0 || playIndex >= minLen - 1) {
      playIndex = preset.tail - 1; // restart from the earliest full tail
    }
    isPlaying = true;
    updatePlayButton();
    cancelAnimationFrame(playAnimHandle);
    playStep();
  }

  function stopPlay() {
    if (!isPlaying && !playAnimHandle) return;
    isPlaying = false;
    cancelAnimationFrame(playAnimHandle);
    playAnimHandle = null;
    updatePlayButton();
    const dateEl = document.getElementById("rrgPlayDate");
    if (dateEl) dateEl.textContent = "";
  }

  const playBtn = document.getElementById("rrgPlayBtn");
  if (playBtn) {
    playBtn.addEventListener("click", () => {
      if (isPlaying) stopPlay();
      else startPlay();
    });
  }

  setupNewGroupPanel();

  // Sync the tab's badge/lock state immediately on load, not just on the
  // next auth change (covers a returning user whose session restores
  // instantly from local storage).
  const initialBadge = document.getElementById("rrgTabProBadge");
  if (initialBadge) initialBadge.hidden = isProUnlocked();
  const initialOverlay = document.getElementById("rrgLockOverlay");
  if (initialOverlay) initialOverlay.hidden = isProUnlocked();
})();
