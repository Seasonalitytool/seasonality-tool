(function () {
  // ---- Theme (light/dark) ---------------------------------------------------
  const THEME_KEY = "seasonalityTheme";
  const themeToggleBtn = document.getElementById("themeToggle");

  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  }

  function setTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch (e) {}
    if (themeToggleBtn) {
      themeToggleBtn.setAttribute("aria-label", t === "dark" ? "Switch to light theme" : "Switch to dark theme");
    }
    applyChartColors(); // re-derive canvas colors from the new CSS custom properties
  }

  // Note: the initial theme attribute is already set by the inline script in
  // <head> (before first paint), and the light/dark icon swap is pure CSS —
  // so nothing to do here on load. setTheme() below is only for user toggles,
  // called after the chart exists.
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", () => setTheme(currentTheme() === "dark" ? "light" : "dark"));
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function hexToRgb(hex) {
    const m = hex.replace("#", "");
    const bigint = parseInt(m.length === 3 ? m.split("").map((c) => c + c).join("") : m, 16);
    return { r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255 };
  }

  const days = window.SEASONALITY_DAYS || [];
  const years = window.SEASONALITY_YEARS || []; // [{year, type: "bull"|"bear", values: [366 numbers|null]}]
  const meta = window.SEASONALITY_META || {};
  const currentYearData = window.CURRENT_YEAR_DATA || null; // {year, lastDataDate, values: [366 numbers|null]}
  const dayCount = days.length;
  let overlayEnabled = false;

  // Smoothed the same way as the composite line so the overlay reads as a
  // clean curve instead of the raw day-to-day noise (stops at the last
  // trading day rather than being forward-filled/projected — nulls after
  // that point pass straight through smoothSeries unchanged).
  const currentYearValues = currentYearData
    ? smoothSeries(currentYearData.values, 5).map((v) => (v === null ? null : Math.round(v * 10000) / 10000))
    : null;

  const allYearNums = years.map((y) => y.year);
  const dataMinYear = allYearNums.length ? Math.min(...allYearNums) : meta.startYear;
  const dataMaxYear = allYearNums.length ? Math.max(...allYearNums) : meta.endYear;

  let currentFilter = "all"; // "all" | "bull" | "bear"
  let currentCycle = "all"; // "all" | "election" | "post" | "midterm" | "pre"
  let currentFedRegime = "all"; // "all" | "cut" | "hike" | "stable"
  const FED_POLICY_BY_YEAR = window.FED_POLICY_BY_YEAR || {};

  // ---- Multi-symbol comparison -----------------------------------------------
  const MAX_LINES = 10; // including S&P 500
  const SYMBOL_PALETTE = ["#3b82f6", "#a855f7", "#ec4899", "#06b6d4", "#f97316", "#84cc16", "#eab308", "#14b8a6", "#f43f5e"];
  const tickerList = window.TICKER_LIST || [];
  let extraSymbols = []; // [{ symbol, name, years, color, dataset, data, finalPoint, subsetCount }]
  let spxHidden = false;

  function tickerNameFor(sym) {
    const t = tickerList.find((t) => t.s === sym);
    return t ? t.n : sym;
  }

  function nextSymbolColor() {
    return SYMBOL_PALETTE[extraSymbols.length % SYMBOL_PALETTE.length];
  }

  // ---- Pro gating ---------------------------------------------------------------
  // Free: S&P 500 chart, year-range slider, Bull/Bear filter, era presets,
  // current-year overlay. Pro: election-cycle filter, multi-symbol
  // comparison. Defaults to locked until auth.js confirms a Pro session.
  function isProUnlocked() {
    return !!(window.SeasonalityAuth && window.SeasonalityAuth.isPro());
  }

  function updateLockedUI() {
    const unlocked = isProUnlocked();
    [cycleBarRowEl, symbolSearchRowEl, symbolLegendEl].forEach((el) => {
      if (el) el.classList.toggle("is-locked", !unlocked);
    });
    // One "🔒 Pro" badge per locked section, pinned to that section's own
    // top-right corner.
    [cycleProBadgeEl, searchProBadgeEl].forEach((el) => {
      if (el) el.hidden = unlocked;
    });
  }

  const cycleBarRowEl = document.querySelector(".cycle-bar-row");
  const symbolSearchRowEl = document.querySelector(".symbol-search-row");
  const symbolLegendEl = document.getElementById("symbolLegend");
  const cycleProBadgeEl = document.getElementById("cycleProBadge");
  const searchProBadgeEl = document.getElementById("searchProBadge");

  if (window.SeasonalityAuth) {
    window.SeasonalityAuth.onChange(updateLockedUI);
  }
  updateLockedUI();
  // Default to the most recent 20 years (e.g. 2005–2025) rather than the
  // whole history.
  const DEFAULT_LOOKBACK_YEARS = 20;
  let rangeMin = Math.max(dataMinYear, dataMaxYear - DEFAULT_LOOKBACK_YEARS);
  let rangeMax = dataMaxYear;

  let data = []; // derived: [{month, day, label, avg, n}, ...] for the active filter+range
  let finalPoint = null;

  // ---- U.S. presidential election cycle -------------------------------------
  // U.S. presidential elections have landed on a year divisible by 4 every
  // time since 1788 (1932, 1960, 2008, 2024, ...), with no exceptions or
  // skips — so this single, exact rule correctly classifies every year in
  // the dataset without needing a lookup table.
  function cycleTypeForYear(year) {
    switch (((year % 4) + 4) % 4) {
      case 0:
        return "election"; // e.g. 2024, 2020, 2016 — the president is elected
      case 1:
        return "post"; // e.g. 2025, 2021, 2017 — new/re-elected term begins
      case 2:
        return "midterm"; // e.g. 2026, 2022, 2018 — midterm congressional elections
      default:
        return "pre"; // e.g. 2027, 2023, 2019 — year before the next election
    }
  }

  // ---- Composite computation (client-side, so filter + slider combine freely) ----
  // Shared by S&P 500 and every added symbol — each is filtered the same way
  // (bull/bear, election cycle, year range) using its OWN bull/bear years, so
  // "bull years" always means "years that symbol itself finished up".
  function matchingYearsFrom(yearsList) {
    return yearsList.filter(
      (y) =>
        (currentFilter === "all" || y.type === currentFilter) &&
        (currentCycle === "all" || cycleTypeForYear(y.year) === currentCycle) &&
        (currentFedRegime === "all" || FED_POLICY_BY_YEAR[String(y.year)] === currentFedRegime) &&
        y.year >= rangeMin &&
        y.year <= rangeMax
    );
  }

  function matchingYears() {
    return matchingYearsFrom(years);
  }

  // Light centered moving-average smoothing (5-day window, clipped at the
  // Jan 1 / Dec 31 edges rather than wrapped, gaps/nulls skipped rather than
  // treated as 0) — mirrors scripts/update-data.ps1. Shared by the composite
  // line and the current-year overlay so both render equally smooth.
  function smoothSeries(rawArr, windowSize) {
    const half = Math.floor((windowSize || 5) / 2);
    const smoothed = new Array(rawArr.length);
    for (let i = 0; i < rawArr.length; i++) {
      const lo = Math.max(0, i - half);
      const hi = Math.min(rawArr.length - 1, i + half);
      let s = 0;
      let n = 0;
      for (let idx = lo; idx <= hi; idx++) {
        if (rawArr[idx] === null || rawArr[idx] === undefined) continue;
        s += rawArr[idx];
        n++;
      }
      smoothed[i] = n > 0 ? s / n : null;
    }
    return smoothed;
  }

  function computeComposite(yearsSubset) {
    const sum = new Array(dayCount).fill(0);
    const count = new Array(dayCount).fill(0);
    for (const y of yearsSubset) {
      const vals = y.values;
      for (let i = 0; i < dayCount; i++) {
        const v = vals[i];
        if (v === null || v === undefined) continue; // Feb 29 in a non-leap year
        sum[i] += v;
        count[i] += 1;
      }
    }
    const rawAvg = new Array(dayCount);
    for (let i = 0; i < dayCount; i++) {
      rawAvg[i] = count[i] > 0 ? sum[i] / count[i] : null;
    }

    const smoothed = smoothSeries(rawAvg, 5);

    return days.map((d, i) => ({
      month: d.month,
      day: d.day,
      label: d.label,
      avg: smoothed[i] === null ? null : Math.round(smoothed[i] * 10000) / 10000,
      n: count[i],
    }));
  }

  function recompute() {
    const subset = matchingYears();
    data = computeComposite(subset);
    finalPoint = data.length ? data[data.length - 1] : null;

    extraSymbols.forEach((sym) => {
      const symSubset = matchingYearsFrom(sym.years);
      sym.data = computeComposite(symSubset);
      sym.subsetCount = symSubset.length;
      sym.finalPoint = sym.data.length ? sym.data[sym.data.length - 1] : null;
    });

    return subset;
  }

  // ---- Header / meta text -------------------------------------------------
  const topbarMeta = document.getElementById("topbarMeta");
  const panelSub = document.getElementById("panelSub");
  const footerNote = document.getElementById("footerNote");
  const statValue = document.getElementById("statValue");
  const statPill = document.getElementById("statPill");

  const FILTER_ADJ = { all: "", bull: "bull ", bear: "bear " };
  const CYCLE_ADJ = { all: "", election: "election ", post: "post-election ", midterm: "midterm ", pre: "pre-election " };
  const FED_ADJ = { all: "", cut: "rate-cut ", hike: "rate-hike ", stable: "stable-rate " };

  // Combines the bull/bear filter, election-cycle filter, and Fed policy
  // regime filter into one phrase, e.g. "21 years", "6 bull years",
  // "8 midterm years", "3 bull pre-election rate-hike years".
  function phraseYears(filterKey, cycleKey, fedKey, count) {
    const adj = FILTER_ADJ[filterKey] + CYCLE_ADJ[cycleKey] + FED_ADJ[fedKey];
    return adj ? `${count} ${adj}years` : `all ${count} years`;
  }

  function updateHeaderTexts(subsetCount) {
    const phrase = phraseYears(currentFilter, currentCycle, currentFedRegime, subsetCount);
    const rangeText = `${rangeMin}–${rangeMax}`;
    const noMatchPhrase = `${FILTER_ADJ[currentFilter]}${CYCLE_ADJ[currentCycle]}${FED_ADJ[currentFedRegime]}years` || "years";

    topbarMeta.textContent = `S&P 500 · ${rangeText} · ${phrase}`;
    panelSub.textContent = subsetCount
      ? `Average cumulative % return by calendar day, based on ${phrase} (${rangeText}).`
      : `No ${noMatchPhrase} in ${rangeText}.`;
    footerNote.textContent = `Composite of ${phrase} within ${rangeText} · ${meta.symbol || "S&P 500"} · source: ${meta.source || "Yahoo Finance"} · last price ${meta.lastDataDate || ""}`;

    if (finalPoint && typeof finalPoint.avg === "number") {
      const v = finalPoint.avg;
      statValue.textContent = (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
      statValue.classList.toggle("negative", v < 0);
      if (statPill) statPill.classList.toggle("negative", v < 0);
    } else {
      statValue.textContent = "—";
      statValue.classList.remove("negative");
      if (statPill) statPill.classList.remove("negative");
    }
  }

  // ---- Chart ---------------------------------------------------------------
  const canvas = document.getElementById("seasonalityChart");
  const ctx = canvas.getContext("2d");

  // Plain-text hover readout below the chart — no floating tooltip, no box.
  const hrDate = document.getElementById("hrDate");
  const hrValue = document.getElementById("hrValue");
  const hrSample = document.getElementById("hrSample");
  const hrOverlaySep = document.getElementById("hrOverlaySep");
  const hrOverlay = document.getElementById("hrOverlay");

  // The current-year (YTD) figure always renders in the distinct amber
  // overlay color, so it never reads as the same number as the green/red
  // composite value next to it.
  function setOverlayText(text) {
    if (!text) {
      hrOverlaySep.hidden = true;
      hrOverlay.hidden = true;
      hrOverlay.textContent = "";
      return;
    }
    hrOverlaySep.hidden = false;
    hrOverlay.hidden = false;
    hrOverlay.textContent = text;
  }

  // Compact "SYM: +1.2% · SYM2: -0.4%" fragment for whatever extra symbols
  // are currently added, at a given day index.
  function extrasTextForIndex(idx) {
    if (!extraSymbols.length || idx === undefined || idx === null) return "";
    const parts = extraSymbols
      .map((sym) => {
        const p = sym.data[idx];
        if (!p || typeof p.avg !== "number") return null;
        const sign = p.avg >= 0 ? "+" : "";
        return `${sym.symbol}: ${sign}${p.avg.toFixed(2)}%`;
      })
      .filter(Boolean);
    return parts.length ? " · " + parts.join(" · ") : "";
  }

  function overlayTextForPoint(idx) {
    if (!overlayEnabled || !currentYearData || idx === undefined || idx === null) return null;
    const cv = currentYearValues[idx];
    if (typeof cv !== "number") return null;
    const sign = cv >= 0 ? "+" : "";
    return `${currentYearData.year} YTD: ${sign}${cv.toFixed(2)}%`;
  }

  function renderReadout(point, subsetCount, idx) {
    if (!point || typeof point.avg !== "number") {
      hrDate.textContent = "—";
      hrValue.textContent = "—";
      hrValue.classList.remove("negative");
      hrSample.textContent = subsetCount === 0 ? "no years match the current filter" : "";
      setOverlayText(null);
      return;
    }
    const sign = point.avg >= 0 ? "+" : "";
    hrDate.textContent = point.label;
    hrValue.textContent = `${sign}${point.avg.toFixed(2)}%`;
    hrValue.classList.toggle("negative", point.avg < 0);
    hrSample.textContent = `based on ${point.n} of ${subsetCount} years${extrasTextForIndex(idx)}`;
    setOverlayText(overlayTextForPoint(idx));
  }

  function updateReadoutFromChart(context) {
    if (isDragging || hasSelection) return; // a drag-selection owns the readout for now
    const tooltipModel = context.tooltip;
    if (!tooltipModel || tooltipModel.opacity === 0 || !tooltipModel.dataPoints || !tooltipModel.dataPoints.length) {
      return; // keep showing the last value rather than blanking on tiny gaps
    }
    const idx = tooltipModel.dataPoints[0].dataIndex;
    renderReadout(data[idx], matchingYears().length, idx);
  }

  // ---- Click-and-drag range selection ---------------------------------------
  // Lets the user drag across the line to see the cumulative-return change
  // between any two dates, instead of just a single hovered point.
  let isDragging = false;
  let hasSelection = false;
  let dragMoved = false;
  let dragStartIndex = 0;
  let dragEndIndex = 0;
  let downClientX = 0;
  let downClientY = 0;

  function indexFromEvent(e) {
    const pos = Chart.helpers.getRelativePosition(e, chart);
    let idx = chart.scales.x.getValueForPixel(pos.x);
    if (idx === undefined || idx === null || Number.isNaN(idx)) idx = 0;
    idx = Math.round(idx);
    return Math.max(0, Math.min(dayCount - 1, idx));
  }

  function renderSelection(i1, i2) {
    const lo = Math.min(i1, i2);
    const hi = Math.max(i1, i2);
    const p1 = data[lo];
    const p2 = data[hi];
    if (lo === hi || !p1 || !p2 || typeof p1.avg !== "number" || typeof p2.avg !== "number") {
      hrDate.textContent = "—";
      hrValue.textContent = "—";
      hrValue.classList.remove("negative");
      hrSample.textContent = "drag across the line to compare two dates";
      setOverlayText(null);
      return;
    }
    const diff = p2.avg - p1.avg;
    const sign = diff >= 0 ? "+" : "";
    hrDate.textContent = `${p1.label} → ${p2.label}`;
    hrValue.textContent = `${sign}${diff.toFixed(2)}%`;
    hrValue.classList.toggle("negative", diff < 0);
    const spanDays = hi - lo;
    const extrasParts = extraSymbols
      .map((sym) => {
        const s1 = sym.data[lo];
        const s2 = sym.data[hi];
        if (!s1 || !s2 || typeof s1.avg !== "number" || typeof s2.avg !== "number") return null;
        const d = s2.avg - s1.avg;
        return `${sym.symbol}: ${d >= 0 ? "+" : ""}${d.toFixed(2)}%`;
      })
      .filter(Boolean);
    const extrasSuffix = extrasParts.length ? " · " + extrasParts.join(" · ") : "";
    hrSample.textContent = `${spanDays} day${spanDays === 1 ? "" : "s"} apart · click the chart to clear${extrasSuffix}`;

    // Show how much the actual current year moved over that same date
    // range, but only when the overlay toggle is on.
    let overlayText = null;
    if (overlayEnabled && currentYearData) {
      const cv1 = currentYearValues[lo];
      const cv2 = currentYearValues[hi];
      if (typeof cv1 === "number" && typeof cv2 === "number") {
        const cyDiff = cv2 - cv1;
        const cySign = cyDiff >= 0 ? "+" : "";
        overlayText = `${currentYearData.year} YTD over same span: ${cySign}${cyDiff.toFixed(2)}%`;
      }
    }
    setOverlayText(overlayText);
  }

  function clearSelection() {
    hasSelection = false;
    isDragging = false;
    chart.update("none");
    renderReadout(finalPoint, matchingYears().length, data.length - 1);
  }

  const selectionPlugin = {
    id: "rangeSelection",
    afterDraw(chart) {
      if (!isDragging && !hasSelection) return;
      const lo = Math.min(dragStartIndex, dragEndIndex);
      const hi = Math.max(dragStartIndex, dragEndIndex);
      if (lo === hi) return;
      const xScale = chart.scales.x;
      const area = chart.chartArea;
      const xLo = xScale.getPixelForValue(lo);
      const xHi = xScale.getPixelForValue(hi);
      const p1 = data[lo];
      const p2 = data[hi];
      const diffNegative = p1 && p2 && typeof p1.avg === "number" && typeof p2.avg === "number" && p2.avg - p1.avg < 0;
      const fill = diffNegative ? cssVar("--negative-soft") : cssVar("--accent-soft");
      const edge = diffNegative ? cssVar("--negative-border") : cssVar("--accent-border");
      const c = chart.ctx;
      c.save();
      c.fillStyle = fill;
      c.fillRect(xLo, area.top, xHi - xLo, area.bottom - area.top);
      c.strokeStyle = edge;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(xLo, area.top);
      c.lineTo(xLo, area.bottom);
      c.stroke();
      c.beginPath();
      c.moveTo(xHi, area.top);
      c.lineTo(xHi, area.bottom);
      c.stroke();
      c.restore();
    },
  };

  // True green when the composite ends at/above 0%, true red when it ends
  // below — same convention as the stat pill and hover readout.
  function lineColorForSign(v) {
    return typeof v === "number" && v < 0 ? cssVar("--negative") : cssVar("--accent");
  }

  let currentLineColor = lineColorForSign(null);

  function buildGradient(hexColor) {
    const { r, g, b } = hexToRgb(hexColor);
    const alpha = parseFloat(cssVar("--chart-fill-alpha")) || 0.2;
    // canvas.height is the DPR-scaled backing-store height Chart.js sets for
    // crisp rendering (often 2x+ the visible size), not the actual CSS
    // pixel height — using it here made the gradient fade out far below the
    // visible plot area, so only a solid-looking band near the top ever
    // showed, and inconsistently so depending on when this ran relative to
    // layout/DPR. getBoundingClientRect().height is the true rendered size.
    const h = canvas.getBoundingClientRect().height || canvas.clientHeight || 460;
    const g1 = ctx.createLinearGradient(0, 0, 0, h);
    g1.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha})`);
    g1.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    return g1;
  }

  // Two standing fill gradients (green/red), rebuilt whenever colors or
  // chart size might have changed — segment.backgroundColor below just
  // picks whichever one applies to that segment, so the fill itself
  // switches to red wherever the line dips below zero instead of using one
  // fixed color for the whole area.
  let positiveFillGradient, negativeFillGradient;
  function rebuildFillGradients() {
    positiveFillGradient = buildGradient(cssVar("--accent"));
    negativeFillGradient = buildGradient(cssVar("--negative"));
  }

  const zeroLinePlugin = {
    id: "zeroLine",
    afterDraw(chart) {
      const yScale = chart.scales.y;
      const xScale = chart.scales.x;
      const y0 = yScale.getPixelForValue(0);
      const c = chart.ctx;
      c.save();
      c.beginPath();
      c.moveTo(xScale.left, y0);
      c.lineTo(xScale.right, y0);
      c.lineWidth = 1;
      c.strokeStyle = cssVar("--chart-zero");
      c.setLineDash([4, 4]);
      c.stroke();
      c.restore();
    },
  };

  const initialSubset = recompute();
  currentLineColor = lineColorForSign(finalPoint ? finalPoint.avg : null);
  rebuildFillGradients();

  // Picks the fill/stroke for whichever segment this is, based on that
  // segment's own value — not the overall year-end sign — so the line and
  // its fill turn red for any stretch that dips below zero, green
  // wherever it's above, regardless of how the full year ends up.
  function segmentIsBelowZero(segCtx) {
    // In multi-symbol mode the line uses one fixed identity color (see
    // applyChartColors) so it stays consistent with the legend — don't let
    // sign-based per-segment coloring override that.
    if (extraSymbols.length > 0) return false;
    return (segCtx.p0.parsed.y + segCtx.p1.parsed.y) / 2 < 0;
  }

  const chart = new Chart(ctx, {
    type: "line",
    data: {
      labels: data.map((d) => d.label),
      datasets: [
        {
          label: "Avg cumulative return",
          data: data.map((d) => d.avg),
          borderColor: currentLineColor,
          backgroundColor: positiveFillGradient,
          segment: {
            borderColor: (segCtx) => cssVar(segmentIsBelowZero(segCtx) ? "--negative" : "--accent"),
            backgroundColor: (segCtx) => (segmentIsBelowZero(segCtx) ? negativeFillGradient : positiveFillGradient),
          },
          borderWidth: 2.25,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: cssVar("--bg-elevated"),
          pointHoverBorderColor: currentLineColor,
          pointHoverBorderWidth: 2.5,
          fill: "origin", // fills down to the value 0 (since 0 sits within the visible range), not the chart's bottom edge
          tension: 0.25,
          cubicInterpolationMode: "monotone",
          spanGaps: true,
        },
        {
          label: currentYearData ? `${currentYearData.year} (YTD)` : "Current year",
          data: currentYearValues ? currentYearValues.slice() : new Array(dayCount).fill(null),
          borderColor: cssVar("--overlay-color"),
          backgroundColor: "transparent",
          borderWidth: 2.25,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: cssVar("--bg-elevated"),
          pointHoverBorderColor: cssVar("--overlay-color"),
          pointHoverBorderWidth: 2,
          fill: false,
          tension: 0.25,
          cubicInterpolationMode: "monotone",
          spanGaps: false,
          hidden: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: "index",
        intersect: false,
      },
      layout: {
        padding: { top: 8, right: 12, bottom: 0, left: 0 },
      },
      scales: {
        x: {
          grid: {
            // Only draw a vertical line at the start of each month, not for
            // every single day.
            color: (ctx) => {
              const point = data[ctx.index];
              return point && point.day === 1 ? cssVar("--chart-grid") : "transparent";
            },
            drawTicks: false,
          },
          border: { color: cssVar("--chart-axis") },
          ticks: {
            color: cssVar("--chart-tick"),
            font: { family: "Inter", size: 11 },
            maxRotation: 0,
            autoSkip: false,
            callback: function (value, index) {
              const point = data[index];
              if (point && point.day === 1) return point.label.split(" ")[0];
              return "";
            },
          },
        },
        y: {
          grid: { color: cssVar("--chart-grid") },
          border: { display: false },
          ticks: {
            color: cssVar("--chart-tick"),
            font: { family: "Inter", size: 11 },
            callback: (value) => (value > 0 ? "+" : "") + value + "%",
          },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: false,
          external: updateReadoutFromChart,
        },
      },
    },
    plugins: [zeroLinePlugin, selectionPlugin],
  });

  updateHeaderTexts(initialSubset.length);
  renderReadout(finalPoint, initialSubset.length, data.length - 1);

  // The very first gradient build above (before the chart even existed) can
  // be sized off the canvas's pre-layout height on some loads — a stale
  // viewport size, layout not yet settled, fonts still swapping in — which
  // is why the green/red fade sometimes looked inconsistent right after a
  // refresh until something else (a filter click, a window resize) forced
  // it to rebuild. Rebuilding once more on the next frame, once layout has
  // definitely settled, fixes it without waiting on user interaction.
  requestAnimationFrame(() => applyChartColors());

  // Re-derives every canvas color (line, fill, grid, ticks, axis, zero line)
  // from the current CSS custom properties — called on theme toggle and
  // whenever the composite's end-of-year sign might have flipped.
  function applyChartColors() {
    // With no comparison symbols added, S&P 500 keeps its original dynamic
    // green/red-by-sign behavior. Once any symbol is added, S&P 500 gets a
    // fixed identity color instead, since a legend needs stable colors per
    // line rather than one that flips with the value's sign.
    currentLineColor = extraSymbols.length > 0 ? cssVar("--accent") : lineColorForSign(finalPoint ? finalPoint.avg : null);
    rebuildFillGradients(); // colors and/or the canvas's rendered size may have changed
    const ds = chart.data.datasets[0];
    ds.borderColor = currentLineColor; // base/fallback — segment.borderColor overrides per-point when applicable
    ds.backgroundColor = positiveFillGradient; // base/fallback — segment.backgroundColor overrides per-point
    ds.pointHoverBorderColor = currentLineColor;
    ds.pointHoverBackgroundColor = cssVar("--bg-elevated");

    const overlayDs = chart.data.datasets[1];
    if (overlayDs) {
      overlayDs.borderColor = cssVar("--overlay-color");
      overlayDs.pointHoverBorderColor = cssVar("--overlay-color");
      overlayDs.pointHoverBackgroundColor = cssVar("--bg-elevated");
    }

    extraSymbols.forEach((sym) => {
      sym.dataset.pointHoverBackgroundColor = cssVar("--bg-elevated");
    });

    // x-axis grid.color is a scriptable function (see chart options above)
    // that re-reads --chart-grid itself on every draw, so it doesn't need
    // to be reassigned here — only the non-scriptable options do.
    chart.options.scales.x.border.color = cssVar("--chart-axis");
    chart.options.scales.x.ticks.color = cssVar("--chart-tick");
    chart.options.scales.y.grid.color = cssVar("--chart-grid");
    chart.options.scales.y.ticks.color = cssVar("--chart-tick");

    chart.update("none");
  }

  window.addEventListener("resize", () => {
    rebuildFillGradients(); // canvas's rendered height changed, so the gradients must be rebuilt to match
    chart.update("none");
  });

  // Reset the readout back to the year-end default once the cursor leaves —
  // but not while a drag-selection is in progress or being displayed.
  canvas.addEventListener("mouseleave", () => {
    if (isDragging || hasSelection) return;
    renderReadout(finalPoint, matchingYears().length, data.length - 1);
  });

  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== undefined && e.button !== 0) return; // left click only
    isDragging = true;
    dragMoved = false;
    hasSelection = false;
    downClientX = e.clientX;
    downClientY = e.clientY;
    dragStartIndex = indexFromEvent(e);
    dragEndIndex = dragStartIndex;
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const dx = Math.abs(e.clientX - downClientX);
    const dy = Math.abs(e.clientY - downClientY);
    if (!dragMoved && (dx > 3 || dy > 3)) dragMoved = true;
    if (!dragMoved) return;
    dragEndIndex = indexFromEvent(e);
    renderSelection(dragStartIndex, dragEndIndex);
    chart.update("none");
  });

  window.addEventListener("mouseup", () => {
    if (!isDragging) return;
    isDragging = false;
    if (dragMoved && dragStartIndex !== dragEndIndex) {
      hasSelection = true;
      renderSelection(dragStartIndex, dragEndIndex);
    } else {
      // A plain click (no drag) clears any existing selection.
      hasSelection = false;
      renderReadout(finalPoint, matchingYears().length, data.length - 1);
    }
    chart.update("none");
  });

  function refreshChart() {
    const subset = recompute();
    chart.data.labels = data.map((d) => d.label);
    chart.data.datasets[0].data = data.map((d) => d.avg);
    extraSymbols.forEach((sym) => {
      sym.dataset.data = sym.data.map((d) => d.avg);
    });
    isDragging = false;
    hasSelection = false;
    updateHeaderTexts(subset.length);
    renderReadout(finalPoint, subset.length, data.length - 1);
    renderYearGrid();
    applyChartColors(); // also calls chart.update()
    renderLegend();
  }

  // ---- Filter (segmented control) ------------------------------------------
  const filterBar = document.getElementById("filterBar");
  if (filterBar) {
    filterBar.addEventListener("click", (e) => {
      const btn = e.target.closest(".filter-btn");
      if (!btn) return;
      const key = btn.getAttribute("data-filter");
      if (!key || key === currentFilter) return;

      currentFilter = key;
      filterBar.querySelectorAll(".filter-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
      refreshChart();
    });
  }

  // ---- Election-cycle filter --------------------------------------------------
  const cycleBar = document.getElementById("cycleBar");
  if (cycleBar) {
    cycleBar.addEventListener("click", (e) => {
      const btn = e.target.closest(".filter-btn");
      if (!btn) return;
      if (!isProUnlocked()) {
        window.SeasonalityAuth && window.SeasonalityAuth.promptUpgrade("The election-cycle filter is a Pro feature.");
        return;
      }
      const key = btn.getAttribute("data-cycle");
      if (!key || key === currentCycle) return;

      currentCycle = key;
      cycleBar.querySelectorAll(".filter-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
      refreshChart();
    });
  }

  // ---- Fed policy regime filter -----------------------------------------------
  const fedPolicyBar = document.getElementById("fedPolicyBar");
  if (fedPolicyBar) {
    fedPolicyBar.addEventListener("click", (e) => {
      const btn = e.target.closest(".filter-btn");
      if (!btn) return;
      const key = btn.getAttribute("data-fed");
      if (!key || key === currentFedRegime) return;

      currentFedRegime = key;
      fedPolicyBar.querySelectorAll(".filter-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
      refreshChart();
    });
  }

  // ---- Year-range dual slider -----------------------------------------------
  const rangeMinInput = document.getElementById("rangeMin");
  const rangeMaxInput = document.getElementById("rangeMax");
  const rangeLabel = document.getElementById("rangeLabel");
  const yearGrid = document.getElementById("yearGrid");

  // A native range input maps its value linearly across (max - min) steps —
  // i.e. N-1 for N years — while the year-grid draws N equal-width boxes.
  // Left unfixed, the handle drifts away from its box's true edge everywhere
  // except the two extremes. Stretch each input to span N boxes instead of
  // N-1 (and, for the max handle, shift it right by one box) so the min
  // handle always sits exactly on its box's left edge and the max handle on
  // its box's right edge — the thumb-width halves below match the 7px
  // handle set in style.css.
  function layoutRangeInputs() {
    if (!rangeMinInput || !rangeMaxInput) return;
    const yearCount = dataMaxYear - dataMinYear + 1;
    if (yearCount < 1) return;
    const thumbHalf = 3.5;
    const stretchedWidth = `calc(${((yearCount - 1) / yearCount) * 100}% + 7px)`;
    rangeMinInput.style.left = `-${thumbHalf}px`;
    rangeMinInput.style.width = stretchedWidth;
    rangeMaxInput.style.left = `calc(${100 / yearCount}% - ${thumbHalf}px)`;
    rangeMaxInput.style.width = stretchedWidth;
  }

  // One small box per calendar year in the dataset, highlighted only when
  // that year satisfies every active filter (Bull/Bear, election cycle, Fed
  // policy regime) AND falls inside the selected year range — so a narrow
  // filter (e.g. "Stable Rates" matching only 16 of 100 years) is obvious at
  // a glance instead of hidden behind a plain range bar.
  function renderYearGrid() {
    if (!yearGrid) return;
    yearGrid.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (let year = dataMinYear; year <= dataMaxYear; year++) {
      const yearEntry = years.find((y) => y.year === year);
      const box = document.createElement("div");
      box.className = "year-box";
      const active =
        !!yearEntry &&
        year >= rangeMin &&
        year <= rangeMax &&
        (currentFilter === "all" || yearEntry.type === currentFilter) &&
        (currentCycle === "all" || cycleTypeForYear(year) === currentCycle) &&
        (currentFedRegime === "all" || FED_POLICY_BY_YEAR[String(year)] === currentFedRegime);
      if (active) box.classList.add("is-active");
      box.title = active ? `${year} — included` : `${year} — excluded`;
      frag.appendChild(box);
    }
    yearGrid.appendChild(frag);
  }

  function updateFillAndLabel() {
    rangeLabel.textContent = `${rangeMin}–${rangeMax}`;
    renderYearGrid();

    // The two <input type="range"> thumbs sit on top of each other when
    // dragged to the same value (e.g. both pushed to the far edge) — without
    // this, whichever one is on top in the DOM permanently wins every click
    // there, trapping the other thumb underneath with no way to grab it
    // again. Give whichever thumb is on the "far" side of the midpoint the
    // higher z-index, since that's the one more likely to need picking back
    // up out of a collision.
    const midpoint = (dataMinYear + dataMaxYear) / 2;
    if (rangeMin > midpoint) {
      rangeMinInput.style.zIndex = 3;
      rangeMaxInput.style.zIndex = 2;
    } else {
      rangeMinInput.style.zIndex = 2;
      rangeMaxInput.style.zIndex = 3;
    }
  }

  // Shared entry point for any range change — manual drag or an era preset —
  // so both stay perfectly in sync.
  function applyRange(min, max) {
    rangeMin = min;
    rangeMax = max;
    rangeMinInput.value = rangeMin;
    rangeMaxInput.value = rangeMax;
    updateFillAndLabel();
    refreshChart();
    syncEraActiveState();
  }

  if (rangeMinInput && rangeMaxInput) {
    rangeMinInput.min = dataMinYear;
    rangeMinInput.max = dataMaxYear;
    rangeMinInput.value = rangeMin;
    rangeMaxInput.min = dataMinYear;
    rangeMaxInput.max = dataMaxYear;
    rangeMaxInput.value = rangeMax;

    layoutRangeInputs();
    updateFillAndLabel();

    rangeMinInput.addEventListener("input", () => {
      let v = parseInt(rangeMinInput.value, 10);
      if (v > rangeMax) v = rangeMax; // keep handles from crossing
      rangeMinInput.value = v;
      applyRange(v, rangeMax);
    });

    rangeMaxInput.addEventListener("input", () => {
      let v = parseInt(rangeMaxInput.value, 10);
      if (v < rangeMin) v = rangeMin; // keep handles from crossing
      rangeMaxInput.value = v;
      applyRange(rangeMin, v);
    });
  }

  // ---- Era presets ------------------------------------------------------------
  // Long, named windows a user can jump to directly instead of dragging the
  // slider by hand. Bounds are clipped to whatever the dataset actually covers.
  const ERA_DEFS = [
    { label: "All History", start: dataMinYear, end: dataMaxYear },
    { label: "Early Era", start: dataMinYear, end: 1945 },
    { label: "Post-War Boom", start: 1946, end: 1966 },
    { label: "Stagflation Era", start: 1966, end: 1982 },
    { label: "The Great Bull Run", start: 1982, end: 2000 },
    { label: "2000s: Dot-Com to Financial Crisis", start: 2000, end: 2009 },
    { label: "Post-GFC Bull Market", start: 2009, end: 2020 },
    { label: "Post-COVID Era", start: 2020, end: dataMaxYear },
  ];

  const eraBar = document.getElementById("eraBar");
  const eraButtons = [];

  function syncEraActiveState() {
    eraButtons.forEach((b) => {
      const s = parseInt(b.dataset.start, 10);
      const e = parseInt(b.dataset.end, 10);
      b.classList.toggle("is-active", s === rangeMin && e === rangeMax);
    });
  }

  if (eraBar) {
    ERA_DEFS.forEach((era) => {
      const start = Math.max(dataMinYear, era.start);
      const end = Math.min(dataMaxYear, era.end);
      if (start > end) return; // entirely outside the available data

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "era-btn";
      btn.textContent = era.label;
      btn.dataset.start = start;
      btn.dataset.end = end;
      btn.addEventListener("click", () => applyRange(start, end));
      eraBar.appendChild(btn);
      eraButtons.push(btn);
    });
    syncEraActiveState();
  }

  // ---- Current-year overlay toggle -------------------------------------------
  const overlayWrap = document.getElementById("overlayToggleWrap");
  const overlayCheckbox = document.getElementById("overlayToggle");
  const overlayLabel = document.getElementById("overlayLabel");

  if (overlayWrap && overlayCheckbox && currentYearData && currentYearValues.some((v) => typeof v === "number")) {
    overlayLabel.textContent = `Overlay ${currentYearData.year} (YTD)`;
    overlayWrap.hidden = false;

    overlayCheckbox.addEventListener("change", () => {
      overlayEnabled = overlayCheckbox.checked;
      chart.setDatasetVisibility(1, overlayEnabled);
      chart.update();
      // Refresh whatever's currently shown below the chart so the overlay
      // value appears/disappears immediately, without waiting for the next hover.
      if (hasSelection) {
        renderSelection(dragStartIndex, dragEndIndex);
      } else {
        const idx = data.length - 1;
        renderReadout(finalPoint, matchingYears().length, idx);
      }
    });
  }

  // ---- Hide S&P 500 toggle -----------------------------------------------------
  const hideSpxBtn = document.getElementById("hideSpxBtn");
  if (hideSpxBtn) {
    hideSpxBtn.addEventListener("click", () => {
      spxHidden = !spxHidden;
      chart.setDatasetVisibility(0, !spxHidden);
      chart.update();
      hideSpxBtn.textContent = spxHidden ? "Show S&P 500" : "Hide S&P 500";
      hideSpxBtn.classList.toggle("is-active", spxHidden);
    });
  }

  // ---- Symbol legend ------------------------------------------------------------
  const symbolLegend = document.getElementById("symbolLegend");

  function renderLegend() {
    if (!symbolLegend) return;
    if (extraSymbols.length === 0) {
      symbolLegend.hidden = true;
      symbolLegend.innerHTML = "";
      return;
    }
    symbolLegend.hidden = false;
    symbolLegend.innerHTML = "";
    extraSymbols.forEach((sym) => {
      const chip = document.createElement("span");
      chip.className = "legend-chip";
      chip.style.setProperty("--chip-color", sym.color);

      const dot = document.createElement("span");
      dot.className = "legend-dot";
      chip.appendChild(dot);

      const label = document.createElement("span");
      label.className = "legend-label";
      label.textContent = sym.symbol;
      chip.appendChild(label);

      const value = document.createElement("span");
      value.className = "legend-value";
      const fp = sym.finalPoint;
      value.textContent = fp && typeof fp.avg === "number" ? `${fp.avg >= 0 ? "+" : ""}${fp.avg.toFixed(2)}%` : "—";
      chip.appendChild(value);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "legend-remove";
      remove.setAttribute("aria-label", `Remove ${sym.symbol}`);
      remove.textContent = "×";
      remove.addEventListener("click", () => removeSymbol(sym.symbol));
      chip.appendChild(remove);

      symbolLegend.appendChild(chip);
    });
  }

  // ---- Symbol search + add/remove ----------------------------------------------
  function makeExtraDataset(color) {
    return {
      label: "",
      data: new Array(dayCount).fill(null),
      borderColor: color,
      backgroundColor: "transparent",
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBackgroundColor: cssVar("--bg-elevated"),
      pointHoverBorderColor: color,
      pointHoverBorderWidth: 2,
      fill: false,
      tension: 0.25,
      cubicInterpolationMode: "monotone",
      spanGaps: true,
    };
  }

  const symbolInput = document.getElementById("symbolInput");
  const symbolDropdown = document.getElementById("symbolDropdown");
  const symbolSearchMsg = document.getElementById("symbolSearchMsg");
  let searchMsgTimer = null;

  function flashSearchMessage(text) {
    if (!symbolSearchMsg) return;
    symbolSearchMsg.textContent = text;
    symbolSearchMsg.hidden = false;
    clearTimeout(searchMsgTimer);
    searchMsgTimer = setTimeout(() => {
      symbolSearchMsg.hidden = true;
    }, 4500);
  }

  function searchTickers(query) {
    const q = query.trim().toUpperCase();
    if (!q) return [];
    const exact = [];
    const startsWith = [];
    const contains = [];
    // Always scan the full list for exact/prefix matches — bailing out early
    // here could skip a real match that sorts late alphabetically (e.g. a
    // single-letter query like "V" for Visa). Only the low-priority
    // "name contains this" bucket is capped, since it's the least useful
    // match type and the result set gets sliced down to 8 anyway.
    for (const t of tickerList) {
      if (t.s === q) exact.push(t);
      else if (t.s.startsWith(q)) startsWith.push(t);
      else if (contains.length < 50 && t.n.toUpperCase().includes(q)) contains.push(t);
    }
    return exact.concat(startsWith, contains).slice(0, 8);
  }

  function closeDropdown() {
    if (symbolDropdown) {
      symbolDropdown.hidden = true;
      symbolDropdown.innerHTML = "";
    }
  }

  function renderDropdown(results) {
    if (!symbolDropdown) return;
    symbolDropdown.innerHTML = "";
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
      // mousedown (not click) fires before the input's blur closes the dropdown.
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        addSymbol(t.s);
        symbolInput.value = "";
        closeDropdown();
      });
      symbolDropdown.appendChild(item);
    });
    symbolDropdown.hidden = false;
  }

  async function addSymbol(symbolRaw) {
    const symbol = symbolRaw.trim().toUpperCase();
    if (!symbol) return;
    if (!isProUnlocked()) {
      closeDropdown();
      window.SeasonalityAuth && window.SeasonalityAuth.promptUpgrade("Comparing extra tickers is a Pro feature.");
      return;
    }
    if (extraSymbols.some((s) => s.symbol === symbol)) {
      flashSearchMessage(`${symbol} is already on the chart.`);
      return;
    }
    if (1 + extraSymbols.length >= MAX_LINES) {
      flashSearchMessage(`You can compare up to ${MAX_LINES} lines at once (including S&P 500) — remove one first.`);
      return;
    }

    const restorePlaceholder = symbolInput ? symbolInput.placeholder : "";
    if (symbolInput) {
      symbolInput.disabled = true;
      symbolInput.placeholder = `Loading ${symbol}…`;
    }

    try {
      const apiBase = window.API_BASE_URL || "";
      const res = await fetch(`${apiBase}/api/history?symbol=${encodeURIComponent(symbol)}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      if (!json.years || !json.years.length) {
        throw new Error("no historical data returned");
      }

      const color = nextSymbolColor();
      const dataset = makeExtraDataset(color);
      dataset.label = symbol;
      const entry = {
        symbol,
        name: tickerNameFor(symbol),
        years: json.years,
        color,
        dataset,
        data: [],
        finalPoint: null,
        subsetCount: 0,
      };
      extraSymbols.push(entry);
      chart.data.datasets.push(dataset);
      refreshChart();
    } catch (err) {
      flashSearchMessage(`Couldn't load ${symbol}${err && err.message ? " (" + err.message + ")" : ""}.`);
    } finally {
      if (symbolInput) {
        symbolInput.disabled = false;
        symbolInput.placeholder = restorePlaceholder;
      }
    }
  }

  function removeSymbol(symbol) {
    const idx = extraSymbols.findIndex((s) => s.symbol === symbol);
    if (idx === -1) return;
    const [entry] = extraSymbols.splice(idx, 1);
    const dsIdx = chart.data.datasets.indexOf(entry.dataset);
    if (dsIdx !== -1) chart.data.datasets.splice(dsIdx, 1);
    refreshChart();
  }

  if (symbolInput) {
    if (location.protocol === "file:" && !window.API_BASE_URL) {
      // Adding a new symbol needs a fetch to /api/history (see
      // scripts/serve.ps1 or api/history.js on Vercel) to avoid the
      // browser's CORS block on Yahoo Finance — with no server running and
      // no configured API_BASE_URL, that route isn't reachable from file://.
      symbolInput.disabled = true;
      symbolInput.placeholder = "Run via scripts/serve.ps1 to search & compare other tickers";
    } else {
      symbolInput.addEventListener("focus", () => {
        if (!isProUnlocked()) {
          symbolInput.blur();
          window.SeasonalityAuth && window.SeasonalityAuth.promptUpgrade("Comparing extra tickers is a Pro feature.");
          return;
        }
        if (symbolInput.value.trim()) renderDropdown(searchTickers(symbolInput.value));
      });
      symbolInput.addEventListener("input", () => {
        if (!isProUnlocked()) return;
        renderDropdown(searchTickers(symbolInput.value));
      });
      symbolInput.addEventListener("blur", () => {
        setTimeout(closeDropdown, 120); // let a pending option mousedown fire first
      });
      symbolInput.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeDropdown();
      });
    }
  }
})();
