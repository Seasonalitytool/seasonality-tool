(function () {
  const days = window.SEASONALITY_DAYS || [];
  const years = window.SEASONALITY_YEARS || []; // [{year, type: "bull"|"bear", values: [366 numbers|null]}]
  const meta = window.SEASONALITY_META || {};
  const dayCount = days.length;

  const allYearNums = years.map((y) => y.year);
  const dataMinYear = allYearNums.length ? Math.min(...allYearNums) : meta.startYear;
  const dataMaxYear = allYearNums.length ? Math.max(...allYearNums) : meta.endYear;

  let currentFilter = "all"; // "all" | "bull" | "bear"
  let rangeMin = dataMinYear;
  let rangeMax = dataMaxYear;

  let data = []; // derived: [{month, day, label, avg, n}, ...] for the active filter+range
  let finalPoint = null;

  // ---- Composite computation (client-side, so filter + slider combine freely) ----
  function matchingYears() {
    return years.filter(
      (y) => (currentFilter === "all" || y.type === currentFilter) && y.year >= rangeMin && y.year <= rangeMax
    );
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

    // Light centered moving-average smoothing (5-day window, clipped at the
    // Jan 1 / Dec 31 edges rather than wrapped) — mirrors scripts/update-data.ps1.
    const window_ = 5;
    const half = Math.floor(window_ / 2);
    const smoothed = new Array(dayCount);
    for (let i = 0; i < dayCount; i++) {
      const lo = Math.max(0, i - half);
      const hi = Math.min(dayCount - 1, i + half);
      let s = 0;
      let n = 0;
      for (let idx = lo; idx <= hi; idx++) {
        if (rawAvg[idx] === null) continue;
        s += rawAvg[idx];
        n++;
      }
      smoothed[i] = n > 0 ? s / n : null;
    }

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
    return subset;
  }

  // ---- Header / meta text -------------------------------------------------
  const topbarMeta = document.getElementById("topbarMeta");
  const panelSub = document.getElementById("panelSub");
  const footerNote = document.getElementById("footerNote");
  const statValue = document.getElementById("statValue");

  const FILTER_WORD = { all: "years", bull: "bull years", bear: "bear years" };

  function phraseYears(filterKey, count) {
    if (filterKey === "all") return `all ${count} years`;
    return `${count} ${filterKey} years`;
  }

  function updateHeaderTexts(subsetCount) {
    const phrase = phraseYears(currentFilter, subsetCount);
    const rangeText = `${rangeMin}–${rangeMax}`;

    topbarMeta.textContent = `S&P 500 · ${rangeText} · ${phrase}`;
    panelSub.textContent = subsetCount
      ? `Average cumulative % return by calendar day, based on ${phrase} (${rangeText}).`
      : `No ${FILTER_WORD[currentFilter]} in ${rangeText}.`;
    footerNote.textContent = `Composite of ${phrase} within ${rangeText} · ${meta.symbol || "S&P 500"} · source: ${meta.source || "Yahoo Finance"} · last price ${meta.lastDataDate || ""}`;

    if (finalPoint && typeof finalPoint.avg === "number") {
      const v = finalPoint.avg;
      statValue.textContent = (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
      statValue.classList.toggle("negative", v < 0);
    } else {
      statValue.textContent = "—";
      statValue.classList.remove("negative");
    }
  }

  // ---- Chart ---------------------------------------------------------------
  const canvas = document.getElementById("seasonalityChart");
  const ctx = canvas.getContext("2d");

  // Plain-text hover readout below the chart — no floating tooltip, no box.
  const hrDate = document.getElementById("hrDate");
  const hrValue = document.getElementById("hrValue");
  const hrSample = document.getElementById("hrSample");

  function renderReadout(point, subsetCount) {
    if (!point || typeof point.avg !== "number") {
      hrDate.textContent = "—";
      hrValue.textContent = "—";
      hrValue.classList.remove("negative");
      hrSample.textContent = subsetCount === 0 ? "no years match the current filter" : "";
      return;
    }
    const sign = point.avg >= 0 ? "+" : "";
    hrDate.textContent = point.label;
    hrValue.textContent = `${sign}${point.avg.toFixed(2)}%`;
    hrValue.classList.toggle("negative", point.avg < 0);
    hrSample.textContent = `based on ${point.n} of ${subsetCount} years`;
  }

  function updateReadoutFromChart(context) {
    const tooltipModel = context.tooltip;
    if (!tooltipModel || tooltipModel.opacity === 0 || !tooltipModel.dataPoints || !tooltipModel.dataPoints.length) {
      return; // keep showing the last value rather than blanking on tiny gaps
    }
    renderReadout(data[tooltipModel.dataPoints[0].dataIndex], matchingYears().length);
  }

  function buildGradient() {
    const g = ctx.createLinearGradient(0, 0, 0, canvas.height || 460);
    g.addColorStop(0, "rgba(53, 208, 186, 0.28)");
    g.addColorStop(1, "rgba(53, 208, 186, 0.0)");
    return g;
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
      c.strokeStyle = "rgba(139, 150, 168, 0.35)";
      c.setLineDash([4, 4]);
      c.stroke();
      c.restore();
    },
  };

  const initialSubset = recompute();

  const chart = new Chart(ctx, {
    type: "line",
    data: {
      labels: data.map((d) => d.label),
      datasets: [
        {
          label: "Avg cumulative return",
          data: data.map((d) => d.avg),
          borderColor: "#35d0ba",
          backgroundColor: buildGradient(),
          borderWidth: 2.25,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: "#0a0e14",
          pointHoverBorderColor: "#35d0ba",
          pointHoverBorderWidth: 2.5,
          fill: true,
          tension: 0.25,
          cubicInterpolationMode: "monotone",
          spanGaps: true,
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
            color: "#1a2130",
            drawTicks: false,
          },
          border: { color: "#1c2433" },
          ticks: {
            color: "#5a6478",
            font: { family: "JetBrains Mono", size: 11 },
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
          grid: { color: "#1a2130" },
          border: { display: false },
          ticks: {
            color: "#5a6478",
            font: { family: "JetBrains Mono", size: 11 },
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
    plugins: [zeroLinePlugin],
  });

  updateHeaderTexts(initialSubset.length);
  renderReadout(finalPoint, initialSubset.length);

  window.addEventListener("resize", () => {
    chart.data.datasets[0].backgroundColor = buildGradient();
    chart.update("none");
  });

  // Reset the readout back to the year-end default once the cursor leaves.
  canvas.addEventListener("mouseleave", () => renderReadout(finalPoint, matchingYears().length));

  function refreshChart() {
    const subset = recompute();
    chart.data.labels = data.map((d) => d.label);
    chart.data.datasets[0].data = data.map((d) => d.avg);
    chart.update();
    updateHeaderTexts(subset.length);
    renderReadout(finalPoint, subset.length);
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

  // ---- Year-range dual slider -----------------------------------------------
  const rangeMinInput = document.getElementById("rangeMin");
  const rangeMaxInput = document.getElementById("rangeMax");
  const rangeFill = document.getElementById("rangeFill");
  const rangeLabel = document.getElementById("rangeLabel");

  function updateFillAndLabel() {
    const span = dataMaxYear - dataMinYear || 1;
    const leftPct = ((rangeMin - dataMinYear) / span) * 100;
    const rightPct = ((dataMaxYear - rangeMax) / span) * 100;
    rangeFill.style.left = leftPct + "%";
    rangeFill.style.right = rightPct + "%";
    rangeLabel.textContent = `${rangeMin}–${rangeMax}`;
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
})();
