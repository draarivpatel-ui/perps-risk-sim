/* Perps Risk Sim - interactive workbench. Zero dependencies. */
(function () {
  'use strict';
  const P = window.Perps;
  const $ = id => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];

  // ---- tooltip ------------------------------------------------------------
  let tip;
  function tooltip() {
    if (!tip) { tip = document.createElement('div'); tip.className = 'tooltip'; tip.style.display = 'none'; document.body.appendChild(tip); }
    return tip;
  }
  function showTip(evt, html) {
    const t = tooltip(); t.innerHTML = html; t.style.display = 'block';
    t.style.left = Math.min(evt.clientX + 14, window.innerWidth - 260) + 'px';
    t.style.top = Math.min(evt.clientY + 14, window.innerHeight - 90) + 'px';
  }
  function hideTip() { if (tip) tip.style.display = 'none'; }
  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function txt(parent, x, y, s, cls) {
    const t = el('text', { x, y, class: cls || 'axis-text' }, parent);
    t.textContent = s; return t;
  }
  function legend(id, items) {
    const c = $(id); c.innerHTML = '';
    for (const it of items) {
      const span = document.createElement('span'); span.className = 'legend-item';
      const sw = document.createElement('span'); sw.className = 'legend-swatch'; sw.style.background = it.color;
      span.appendChild(sw); span.appendChild(document.createTextNode(it.label)); c.appendChild(span);
    }
  }
  function svgRoot(id, w, h) {
    const c = $(id); c.innerHTML = '';
    const s = el('svg', { viewBox: '0 0 ' + w + ' ' + h, width: '100%', height: h, role: 'img' }, c);
    s.style.display = 'block'; s.style.overflow = 'visible'; return s;
  }
  function readout(id, rows) {
    const c = $(id); c.innerHTML = '';
    for (const [k, v] of rows) {
      const d = document.createElement('div');
      d.innerHTML = '<span>' + k + '</span><b>' + v + '</b>';
      c.appendChild(d);
    }
  }
  function setVerdict(id, text, ok) {
    const v = $(id); v.textContent = text;
    v.className = 'verdict ' + (ok === true ? 'good' : ok === false ? 'bad' : '');
  }

  // ---- line chart (impact curve / equity curves) --------------------------
  function lineChart(id, series, opts) {
    opts = opts || {};
    const w = 520, h = opts.h || 210, padL = 46, padR = 12, padT = 12, padB = 28;
    const s = svgRoot(id, w, h);
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const allVals = series.flatMap(se => se.points.map(p => p.y));
    let minV = opts.min !== undefined ? opts.min : Math.min(...allVals);
    let maxV = opts.max !== undefined ? opts.max : Math.max(...allVals);
    if (maxV === minV) { maxV += 1; minV -= 1; }
    const range = maxV - minV;
    const xs = series[0].points.map(p => p.x);
    const minX = opts.minX !== undefined ? opts.minX : Math.min(...xs);
    const maxX = opts.maxX !== undefined ? opts.maxX : Math.max(...xs);
    const xr = (maxX - minX) || 1;
    const X = x => padL + ((x - minX) / xr) * plotW;
    const Y = y => padT + ((maxV - y) / range) * plotH;
    for (let t = 0; t <= 4; t++) {
      const y = padT + (t / 4) * plotH;
      el('line', { x1: padL, y1: y, x2: w - padR, y2: y, class: 'grid-line' }, s);
      const val = maxV - (t / 4) * range;
      txt(s, padL - 6, y + 3, opts.tickFmt ? opts.tickFmt(val) : val.toFixed(0), 'axis-text').setAttribute('text-anchor', 'end');
    }
    if (minV < 0 && maxV > 0) el('line', { x1: padL, y1: Y(0), x2: w - padR, y2: Y(0), class: 'axis-line' }, s);
    if (opts.hline !== undefined) {
      el('line', { x1: padL, y1: Y(opts.hline), x2: w - padR, y2: Y(opts.hline), stroke: 'var(--accent-3)', 'stroke-width': 1.5, 'stroke-dasharray': '5 4' }, s);
    }
    series.forEach(se => {
      const d = se.points.map((p, i) => (i ? 'L' : 'M') + X(p.x).toFixed(2) + ' ' + Y(p.y).toFixed(2)).join(' ');
      el('path', { d, class: 'line-series', stroke: se.color }, s);
      if (se.markers !== false) {
        se.points.forEach(p => {
          const c = el('circle', { cx: X(p.x), cy: Y(p.y), r: 4, fill: se.color, stroke: 'var(--surface-1)', 'stroke-width': 2 }, s);
          c.style.cursor = 'crosshair';
          c.addEventListener('mousemove', e => showTip(e, '<b>' + (opts.xLabel ? opts.xLabel(p.x) : p.x) + '</b><br>' + se.label + ': ' + (opts.valFmt ? opts.valFmt(p.y) : p.y.toFixed(2))));
          c.addEventListener('mouseleave', hideTip);
        });
      }
    });
    // x axis labels
    for (let t = 0; t <= 4; t++) {
      const xv = minX + (t / 4) * xr;
      txt(s, padL + (t / 4) * plotW, h - padB + 15, opts.xFmt ? opts.xFmt(xv) : xv.toFixed(0), 'axis-text').setAttribute('text-anchor', 'middle');
    }
    return s;
  }

  // ---- column / histogram chart -------------------------------------------
  function columns(id, values, opts) {
    opts = opts || {};
    const w = 520, h = opts.h || 210, padL = 40, padR = 10, padT = 12, padB = 28;
    const s = svgRoot(id, w, h);
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const maxV = Math.max(opts.max || 0, ...values);
    for (let t = 0; t <= 4; t++) {
      const y = padT + (t / 4) * plotH;
      el('line', { x1: padL, y1: y, x2: w - padR, y2: y, class: 'grid-line' }, s);
      txt(s, padL - 6, y + 3, (maxV - (t / 4) * maxV).toFixed(0), 'axis-text').setAttribute('text-anchor', 'end');
    }
    const step = plotW / values.length;
    const bw = Math.max(1, step - 2);
    values.forEach((v, i) => {
      const x = padL + i * step + (step - bw) / 2;
      const hh = (v / (maxV || 1)) * plotH;
      el('rect', { x, y: padT + plotH - hh, width: bw, height: Math.max(1, hh), rx: 3, fill: opts.color || SERIES[0] }, s);
      const hit = el('rect', { x: padL + i * step, y: padT, width: step, height: plotH, fill: 'transparent' }, s);
      hit.style.cursor = 'crosshair';
      const lbl = opts.labels ? opts.labels[i] : String(i);
      hit.addEventListener('mousemove', e => showTip(e, '<b>' + lbl + '</b><br>' + (opts.valFmt ? opts.valFmt(v) : v.toFixed(0))));
      hit.addEventListener('mouseleave', hideTip);
    });
    if (opts.xLabels) {
      for (let t = 0; t <= 4; t++) {
        const idx = Math.min(values.length - 1, Math.round((t / 4) * (values.length - 1)));
        txt(s, padL + (t / 4) * plotW, h - padB + 15, opts.xLabels[idx], 'axis-text').setAttribute('text-anchor', 'middle');
      }
    }
    return s;
  }

  // ---- theme --------------------------------------------------------------
  $('theme-toggle').addEventListener('click', () => {
    const root = document.documentElement;
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    $('theme-toggle').textContent = next === 'dark' ? 'Light' : 'Dark';
    renderAll();
  });

  // ---- hero: impact curve -------------------------------------------------
  function heroImpact() {
    const b = P.Orderbook({ mid: 30000, levels: 16, baseSize: 10 });
    const sizes = [1, 5, 10, 20, 40, 60, 80, 100];
    const points = sizes.map(sz => ({ x: sz, y: b.quoteImpact('buy', sz).impactBps }));
    lineChart('hero-chart', [{ label: 'price impact (bps)', color: SERIES[0], points }], {
      h: 200, xFmt: x => x.toFixed(0) + 'u', tickFmt: v => v.toFixed(1),
      valFmt: v => v.toFixed(2) + ' bps', xLabel: x => x.toFixed(0) + ' units'
    });
    legend('hero-legend', [{ label: 'market buy price impact (basis points)', color: SERIES[0] }]);
  }

  // ---- CLOB ---------------------------------------------------------------
  let clobBook = null;
  function renderCLOB(execute) {
    const mid = Number($('clob-mid').value) || 30000;
    if (!clobBook || clobBook.midCache !== mid) {
      clobBook = P.Orderbook({ mid, levels: 12, baseSize: 8, step: mid * 0.00008 });
      clobBook.midCache = mid;
    }
    const side = $('clob-side').value;
    const size = Number($('clob-size').value);
    $('clob-size-out').textContent = String(size);
    // depth ladder chart: bid sizes (negative-ish) and ask sizes
    const snap = P.Orderbook({ mid, levels: 10, baseSize: 8, step: mid * 0.00008 }).snapshot();
    const bidSizes = snap.bids.slice(0, 10).map(l => l.size);
    const askSizes = snap.asks.slice(0, 10).map(l => l.size);
    // cumulative depth from the mid outward
    let cb = 0, ca = 0;
    const bidCum = bidSizes.map(v => (cb += v));
    const askCum = askSizes.map(v => (ca += v));
    lineChart('book-chart', [
      { label: 'cumulative bid depth', color: SERIES[2], points: bidCum.map((v, i) => ({ x: i + 1, y: v })) },
      { label: 'cumulative ask depth', color: SERIES[1], points: askCum.map((v, i) => ({ x: i + 1, y: v })) }
    ], { h: 220, xFmt: x => 'L' + x.toFixed(0), tickFmt: v => v.toFixed(0), valFmt: v => v.toFixed(1) + ' units', xLabel: x => 'level ' + x.toFixed(0) });
    legend('book-legend', [
      { label: 'cumulative bid depth', color: SERIES[2] },
      { label: 'cumulative ask depth', color: SERIES[1] }
    ]);

    let r;
    if (execute) r = clobBook.marketOrder(side, size);
    else r = clobBook.quoteImpact(side, size);
    const s = clobBook.snapshot();
    readout('clob-readout', [
      ['mid / best bid / ask', s.mid + ' / ' + s.bestBid + ' / ' + s.bestAsk],
      ['spread', String(s.spread)],
      ['filled / unfilled', r.filled + ' / ' + r.unfilled],
      ['average fill', r.avgPrice === null ? 'n/a' : String(r.avgPrice)],
      ['slippage', String(r.slippage)],
      ['price impact', r.impactBps + ' bps'],
      ['levels consumed', String(r.levelsHit)]
    ]);
  }
  ['clob-side', 'clob-size', 'clob-mid'].forEach(id => $(id).addEventListener('input', () => renderCLOB(false)));
  $('clob-run').addEventListener('click', () => renderCLOB(true));

  // ---- funding ------------------------------------------------------------
  function renderFunding() {
    const prem = Number($('fund-premium').value);
    const cap = Number($('fund-cap').value);
    const interest = Number($('fund-interest').value);
    $('fund-premium-out').textContent = String(prem);
    $('fund-cap-out').textContent = String(cap);
    const index = 30000;
    const mark = index * (1 + prem / 10000);
    const samples = [
      { price: mark * 0.9995, minutes: 10 },
      { price: mark, minutes: 20 },
      { price: mark * 1.0004, minutes: 30 },
      { price: mark * 1.0008, minutes: 20 }
    ];
    const f = P.fundingTWAP(samples, [{ price: index, weight: 1 }], { clampBps: cap, interestRateBps: interest });
    // premium samples chart
    lineChart('funding-chart', [
      { label: 'mark TWAP sample', color: SERIES[0], points: samples.map((s, i) => ({ x: i, y: s.price })) },
      { label: 'index', color: SERIES[2], points: samples.map((s, i) => ({ x: i, y: index })) }
    ], { h: 210, xFmt: x => 't' + x.toFixed(0), tickFmt: v => (v / 1000).toFixed(1) + 'k', valFmt: v => v.toFixed(0), xLabel: x => 'sample ' + x.toFixed(0) });
    legend('funding-legend', [
      { label: 'mark TWAP samples', color: SERIES[0] },
      { label: 'index price', color: SERIES[2] }
    ]);
    readout('funding-readout', [
      ['mark TWAP', String(f.markTwap)],
      ['index TWAP', String(f.indexTwap)],
      ['premium', f.premiumBps + ' bps'],
      ['interest', f.interestBps + ' bps'],
      ['raw funding', f.rawBps + ' bps'],
      ['clamped funding', f.clampedBps + ' bps'],
      ['annualized', f.annualizedPct + '%']
    ]);
    setVerdict('funding-verdict',
      f.wasClamped
        ? 'Clamped: raw funding of ' + f.rawBps + ' bps exceeded the +/- ' + cap + ' bps cap. Longs pay shorts ' + f.clampedBps + ' bps this interval.'
        : 'Within band. Longs pay shorts ' + f.clampedBps + ' bps this interval (' + f.annualizedPct + '% annualized).',
      !f.wasClamped);
  }
  ['fund-premium', 'fund-cap', 'fund-interest'].forEach(id => $(id).addEventListener('input', renderFunding));

  // ---- margin -------------------------------------------------------------
  function renderMargin() {
    const side = $('marg-side').value;
    const lev = Number($('marg-leverage').value);
    const price = Number($('marg-price').value) || 30000;
    const mmr = Number($('marg-mmr').value) / 100;
    $('marg-leverage-out').textContent = String(lev);
    $('marg-mmr-out').textContent = (mmr * 100).toFixed(2) + '%';
    const collateral = price / lev;
    const pos = P.position({ side, size: 1, entryPrice: price, markPrice: price, leverage: lev, collateral, marginMode: 'cross' });
    const liq = P.liquidationPrice(pos, { maintenanceMarginRate: mmr });
    const range = price * 0.25;
    const lo = side === 'long' ? price - range : price - range * 0.3;
    const hi = side === 'long' ? price + range * 0.3 : price + range;
    const steps = 30;
    const equityPoints = [], mmPoints = [];
    for (let i = 0; i <= steps; i++) {
      const mk = lo + (hi - lo) * (i / steps);
      const p = P.position({ side, size: 1, entryPrice: price, markPrice: mk, leverage: lev, collateral });
      equityPoints.push({ x: mk, y: P.equity(p) });
      mmPoints.push({ x: mk, y: P.maintenanceMargin(p, { maintenanceMarginRate: mmr }) });
    }
    lineChart('margin-chart', [
      { label: 'account equity', color: SERIES[0], points: equityPoints, markers: false },
      { label: 'maintenance margin', color: SERIES[1], points: mmPoints, markers: false }
    ], { h: 220, xFmt: x => (x / 1000).toFixed(1) + 'k', tickFmt: v => (v / 1000).toFixed(1) + 'k', valFmt: v => v.toFixed(0), xLabel: x => 'mark ' + x.toFixed(0) });
    legend('margin-legend', [
      { label: 'account equity', color: SERIES[0] },
      { label: 'maintenance margin', color: SERIES[1] }
    ]);
    readout('margin-readout', [
      ['side / leverage', side + ' / ' + lev + 'x'],
      ['notional', String(P.notional(pos))],
      ['initial margin', String(P.initialMargin(pos))],
      ['maintenance margin', String(P.maintenanceMargin(pos, { maintenanceMarginRate: mmr }))],
      ['liquidation price', liq === null ? 'n/a' : String(liq)],
      ['distance to liquidation', liq === null ? 'n/a' : ((Math.abs(price - liq) / price) * 100).toFixed(2) + '%']
    ]);
    const checks = $('margin-checks'); checks.innerHTML = '';
    const iso = P.isolatedVsCross(pos, { maintenanceMarginRate: mmr });
    const items = [
      { t: 'isolated liq ' + iso.isolated.liqPrice, ok: true },
      { t: 'cross liq ' + iso.cross.liqPrice, ok: true },
      { t: 'max leverage ' + P.maxLeverage() + 'x', ok: true },
      { t: 'liq penalty ' + P.liquidationPenalty(pos), ok: true }
    ];
    for (const it of items) {
      const s = document.createElement('span'); s.className = 'chip ' + (it.ok ? 'ok' : 'bad'); s.textContent = it.t; checks.appendChild(s);
    }
  }
  ['marg-side', 'marg-leverage', 'marg-price', 'marg-mmr'].forEach(id => $(id).addEventListener('input', renderMargin));

  // ---- cascade ------------------------------------------------------------
  function renderCascade() {
    const shock = Number($('casc-shock').value);
    const count = Number($('casc-count').value);
    const lev = Number($('casc-lev').value);
    $('casc-shock-out').textContent = String(shock);
    const mid = 30000;
    const positions = [];
    for (let i = 0; i < count; i++) {
      const size = 2 + (i % 6);
      const collateral = size * mid / lev * (0.9 + (i % 4) * 0.15);
      positions.push(P.position({ side: i % 5 === 4 ? 'short' : 'long', size, entryPrice: mid, leverage: lev, collateral: P.round(collateral, 2), markPrice: mid }));
    }
    const c = P.liquidationCascade({ mid, shockPct: shock, positions, rounds: 8, seed: 'perps-cascade-' + shock + '-' + count + '-' + lev });
    // liquidations per round
    const roundCounts = {};
    for (const e of c.events) roundCounts[e.round] = (roundCounts[e.round] || 0) + 1;
    const rounds = Object.keys(roundCounts).map(Number).sort((a, b) => a - b);
    const vals = rounds.length ? rounds.map(r => roundCounts[r]) : [0];
    columns('cascade-chart', vals, { color: SERIES[1], h: 210, labels: rounds.length ? rounds.map(r => 'round ' + r) : ['none'], xLabels: rounds.length ? rounds.map(r => 'R' + r) : ['-'], valFmt: v => v + ' liquidations' });
    legend('cascade-legend', [{ label: 'positions liquidated per cascade round', color: SERIES[1] }]);
    readout('cascade-readout', [
      ['initial / shocked price', c.initialPrice + ' / ' + c.shockedPrice],
      ['final price', String(c.finalPrice)],
      ['total price move', c.priceMovePct + '%'],
      ['liquidated / surviving', c.liquidatedCount + ' / ' + c.survivingCount],
      ['liquidated volume', String(c.totalLiquidatedVolume)],
      ['insurance fees', String(c.totalPenalty)],
      ['cascade rounds', String(c.rounds)]
    ]);
    const log = $('cascade-log'); log.innerHTML = '';
    if (!c.events.length) {
      const d = document.createElement('div'); d.className = 'event-empty'; d.textContent = 'No position breached its maintenance margin.'; log.appendChild(d);
    } else {
      for (const e of c.events.slice(0, 40)) {
        const d = document.createElement('div'); d.className = 'event-row';
        d.innerHTML = '<span class="event-round">R' + e.round + '</span>' +
          '<span class="event-desc">' + e.side + ' ' + e.size + 'u closed @ ' + e.fillPrice + '</span>' +
          '<span class="event-impact">' + e.impactBps + ' bps</span>';
        log.appendChild(d);
      }
    }
    setVerdict('cascade-verdict',
      c.liquidatedCount
        ? c.liquidatedCount + ' of ' + count + ' positions liquidated across ' + c.rounds + ' round(s). Final price ' + c.finalPrice + ' (' + c.priceMovePct + '% from mid).'
        : 'No liquidations: every position stayed above its maintenance margin at this shock.',
      c.liquidatedCount === 0);
  }
  ['casc-shock', 'casc-count', 'casc-lev'].forEach(id => $(id).addEventListener('input', renderCascade));
  $('casc-run').addEventListener('click', renderCascade);

  // ---- VaR ----------------------------------------------------------------
  function renderVaR() {
    const vol = Number($('var-vol').value) / 100;
    const lambda = Number($('var-jump').value);
    const horizon = Number($('var-horizon').value);
    const jumpOn = $('var-enable-jump').checked;
    $('var-vol-out').textContent = (vol * 100).toFixed(0) + '%';
    $('var-jump-out').textContent = String(lambda);
    const mc = P.monteCarloVaR({
      s0: 30000, sigma: vol, lambda: jumpOn ? lambda : 0, jumpMu: -0.03, jumpSigma: 0.08,
      horizonDays: horizon, stepsPerDay: 12, paths: 2000, confidence: 0.99,
      notional: 100000, seed: 'perps-var-' + vol + '-' + lambda + '-' + horizon + '-' + jumpOn
    });
    const pa = P.parametricVaR({ notional: 100000, sigma: vol, horizonDays: horizon, confidence: 0.99 });
    const stress = P.liquidationStress({
      s0: 30000, sigma: vol, lambda: jumpOn ? lambda : 0, jumpMu: -0.03, jumpSigma: 0.08,
      horizonDays: horizon, stepsPerDay: 12, paths: 800, seed: 'perps-stress-' + vol + '-' + horizon + '-' + jumpOn,
      side: 'long', size: 1, entryPrice: 30000, leverage: 10, collateral: 3000
    });
    // histogram of terminal prices
    const terminals = mc.terminal;
    const minT = Math.min(...terminals), maxT = Math.max(...terminals);
    const bins = 24, hist = new Array(bins).fill(0);
    const span = (maxT - minT) || 1;
    for (const t of terminals) { const i = Math.min(bins - 1, Math.floor((t - minT) / span * bins)); hist[i]++; }
    const labels = hist.map((_, i) => (minT + (i + 0.5) * span / bins).toFixed(0));
    columns('var-chart', hist, { color: SERIES[0], h: 220, xLabels: labels, valFmt: v => v + ' paths' });
    legend('var-legend', [{ label: 'terminal price frequency (2,000 paths)', color: SERIES[0] }]);
    readout('var-readout', [
      ['99% VaR (Monte Carlo)', mc.varPct + '% / ' + mc.varNotional],
      ['expected shortfall (CVaR)', mc.cvarPct + '%'],
      ['parametric VaR', pa.varPct + '% / ' + pa.varAbs],
      ['median / p05 terminal', mc.medianTerminal + ' / ' + mc.p05Terminal],
      ['worst terminal', String(mc.minTerminal)],
      ['jump diffusion', jumpOn ? 'on (' + lambda + '/yr)' : 'off'],
      ['30d liq breach prob', (stress.breachProbability * 100).toFixed(2) + '%']
    ]);
    const checks = $('var-checks'); checks.innerHTML = '';
    const items = [
      { t: 'VaR ' + mc.varPct + '%', ok: true },
      { t: 'CVaR >= VaR: ' + (mc.cvarPct >= mc.varPct), ok: mc.cvarPct >= mc.varPct },
      { t: 'liq price ' + stress.liquidationPrice, ok: true },
      { t: 'paths ' + mc.paths, ok: true }
    ];
    for (const it of items) {
      const s = document.createElement('span'); s.className = 'chip ' + (it.ok ? 'ok' : 'bad'); s.textContent = it.t; checks.appendChild(s);
    }
  }
  ['var-vol', 'var-jump', 'var-horizon', 'var-enable-jump'].forEach(id => $(id).addEventListener('input', renderVaR));
  $('var-run').addEventListener('click', renderVaR);

  // ---- report -------------------------------------------------------------
  let reportJSON = '';
  $('report-run').addEventListener('click', () => {
    reportJSON = JSON.stringify(P.riskReport({ mid: 30000, leverage: 10, collateral: 3000, orderSize: 20 }), null, 2);
    $('report-output').textContent = reportJSON;
  });
  $('report-copy').addEventListener('click', () => {
    if (!reportJSON) { $('report-output').textContent = 'Press "Build report" first.'; return; }
    navigator.clipboard.writeText(reportJSON).catch(() => {});
  });
  $('report-download').addEventListener('click', () => {
    if (!reportJSON) { $('report-output').textContent = 'Press "Build report" first.'; return; }
    const blob = new Blob([reportJSON], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'perps-risk-report.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  function renderAll() {
    heroImpact();
    renderCLOB(false);
    renderFunding();
    renderMargin();
    renderCascade();
    renderVaR();
  }
  renderAll();
})();
