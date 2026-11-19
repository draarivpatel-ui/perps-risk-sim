(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Perps = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ============================================================
  // Module 0: deterministic pseudo random generation
  // A seeded xorshift128+ style generator keeps Monte Carlo runs
  // reproducible without any external dependency.
  // ============================================================
  function hashSeed(str) {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h1 ^= s.charCodeAt(i);
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 ^= s.charCodeAt(s.length - 1 - i);
      h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    }
    return [h1 || 1, h2 || 2, (h1 ^ h2) >>> 0 || 3, (Math.imul(h1, 3) ^ Math.imul(h2, 5) ^ 0x9e3779b9) >>> 0 || 4];
  }

  function RNG(seed) {
    const s = hashSeed(seed === undefined ? 'perps-risk-sim' : seed);
    let a = s[0], b = s[1], c = s[2], d = s[3];
    function next() {
      // xorshift128
      let t = d;
      const s0 = c;
      d = c; c = b; b = a;
      t ^= t << 11; t ^= t >>> 8;
      a = (t ^ s0 ^ (s0 >>> 19)) >>> 0;
      return a / 4294967296;
    }
    function normal() {
      // Box-Muller with a bounded uniform to avoid log(0).
      let u = next(); if (u < 1e-12) u = 1e-12;
      const v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
    return { next, normal, seed: String(seed === undefined ? 'perps-risk-sim' : seed) };
  }

  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
  function round(x, dp) { const f = Math.pow(10, dp === undefined ? 6 : dp); return Math.round(x * f) / f; }

  // ============================================================
  // Module 1: CLOB (central limit order book) depth & impact engine
  // Levels carry a price and a size. Market orders walk the book;
  // limit orders rest at a level. All fills are deterministic.
  // ============================================================
  function Orderbook(options) {
    const opts = options || {};
    const tick = opts.tick || 0.5;
    const mid = opts.mid || 30000;
    const levels = opts.levels || 12;
    const baseSize = opts.baseSize || 8;
    const step = opts.step || 2.5;
    const bids = [], asks = [];
    for (let i = 0; i < levels; i++) {
      const price = round(mid - (i + 1) * step, 4);
      bids.push({ price, size: round(baseSize * (1 + i * 0.35), 4) });
      asks.push({ price: round(mid + (i + 1) * step, 4), size: round(baseSize * (1 + i * 0.35), 4) });
    }
    let lastTrade = mid;
    let volume = 0;

    function sortBook() {
      bids.sort((a, b) => b.price - a.price);
      asks.sort((a, b) => a.price - b.price);
    }

    function bestBid() { return bids.length ? bids[0].price : null; }
    function bestAsk() { return asks.length ? asks[0].price : null; }
    function midPrice() {
      const bb = bestBid(), ba = bestAsk();
      if (bb === null && ba === null) return lastTrade;
      if (bb === null) return ba;
      if (ba === null) return bb;
      return round((bb + ba) / 2, 4);
    }
    function spread() {
      const bb = bestBid(), ba = bestAsk();
      if (bb === null || ba === null) return null;
      return round(ba - bb, 4);
    }
    function depth() {
      return {
        bids: bids.reduce((s, l) => s + l.size, 0),
        asks: asks.reduce((s, l) => s + l.size, 0),
        bidLevels: bids.length,
        askLevels: asks.length
      };
    }

    function addLimit(side, price, size) {
      if (!(size > 0)) throw new RangeError('limit order size must be positive');
      const p = round(price, 4);
      const book = side === 'buy' ? bids : asks;
      const lvl = book.find(l => l.price === p);
      if (lvl) lvl.size = round(lvl.size + size, 4);
      else { book.push({ price: p, size: round(size, 4) }); sortBook(); }
      return snapshot();
    }

    function cancelLevel(side, price) {
      const book = side === 'buy' ? bids : asks;
      const i = book.findIndex(l => l.price === price);
      if (i >= 0) book.splice(i, 1);
      return snapshot();
    }

    // Walk the book for a market order of `size` base units.
    function marketOrder(side, size) {
      if (!(size > 0)) throw new RangeError('market order size must be positive');
      const book = side === 'buy' ? asks : bids; // a buy consumes asks
      const ref = midPrice(); // pre-trade mid, the same reference quoteImpact uses
      let remaining = size, notional = 0, filled = 0, levelsHit = 0;
      const fills = [];
      while (remaining > 1e-9 && book.length) {
        const lvl = book[0];
        const take = Math.min(remaining, lvl.size);
        notional += take * lvl.price;
        remaining -= take;
        filled += take;
        lvl.size = round(lvl.size - take, 6);
        fills.push({ price: lvl.price, size: take });
        levelsHit++;
        if (lvl.size <= 1e-9) book.shift();
      }
      const avgPrice = filled > 0 ? notional / filled : null;
      const slippage = avgPrice === null ? 0 : round(Math.abs(avgPrice - ref), 4);
      const impactBps = avgPrice === null ? 0 : round((Math.abs(avgPrice - ref) / ref) * 10000, 3);
      const unfilled = round(Math.max(0, remaining), 6);
      if (filled > 0) { lastTrade = round(avgPrice, 4); volume += filled; }
      return {
        side, requested: size, filled: round(filled, 6), unfilled,
        avgPrice: avgPrice === null ? null : round(avgPrice, 4),
        notional: round(notional, 4),
        slippage, impactBps, levelsHit, fills,
        newMid: midPrice()
      };
    }

    // Quote the price impact of a market order without mutating the book.
    function quoteImpact(side, size) {
      const book = side === 'buy' ? asks : bids;
      let remaining = size, notional = 0, filled = 0, levelsHit = 0;
      let i = 0;
      while (remaining > 1e-9 && i < book.length) {
        const lvl = book[i];
        const take = Math.min(remaining, lvl.size);
        notional += take * lvl.price;
        remaining -= take; filled += take; levelsHit++; i++;
      }
      const avgPrice = filled > 0 ? notional / filled : null;
      const ref = midPrice();
      return {
        side, size, filled: round(filled, 6), unfilled: round(Math.max(0, remaining), 6),
        avgPrice: avgPrice === null ? null : round(avgPrice, 4),
        slippage: avgPrice === null ? 0 : round(Math.abs(avgPrice - ref), 4),
        impactBps: avgPrice === null ? 0 : round((Math.abs(avgPrice - ref) / ref) * 10000, 3),
        levelsHit
      };
    }

    function depthWithinBps(bps) {
      const ref = midPrice();
      const band = ref * bps / 10000;
      const bid = bids.filter(l => l.price >= ref - band).reduce((s, l) => s + l.size, 0);
      const ask = asks.filter(l => l.price <= ref + band).reduce((s, l) => s + l.size, 0);
      return { bid: round(bid, 4), ask: round(ask, 4), imbalance: round(bid - ask, 4) };
    }

    function snapshot() {
      return {
        tick, mid: midPrice(), bestBid: bestBid(), bestAsk: bestAsk(),
        spread: spread(), lastTrade, volume: round(volume, 4),
        bids: bids.map(l => ({ price: l.price, size: l.size })),
        asks: asks.map(l => ({ price: l.price, size: l.size })),
        depth: depth()
      };
    }

    return { snapshot, addLimit, cancelLevel, marketOrder, quoteImpact, bestBid, bestAsk, midPrice, spread, depth, depthWithinBps };
  }

  // ============================================================
  // Module 2: funding rate TWAP & clamp math
  // Perpetual funding keeps the mark near the index. The premium is a
  // time-weighted average of (mark - index)/index, clamped to a band.
  // ============================================================
  const FUNDING_DEFAULTS = Object.freeze({
    intervalHours: 8,
    clampBps: 50,          // max |funding| per interval (0.50%)
    interestRateBps: 1,    // baseline interest component per interval
    premiumWeight: 1,
    dampener: 0.05        // impact dampener (5 basis points of size)
  });

  function twap(samples) {
    // samples: [{price, weight}] or [{price, minutes}]; if no weights are
    // given every sample has equal weight. Time-weighted average price.
    if (!samples || !samples.length) throw new RangeError('twap needs at least one sample');
    let num = 0, den = 0;
    for (const s of samples) {
      const w = s.weight !== undefined ? s.weight : (s.minutes !== undefined ? s.minutes : 1);
      if (!(w > 0)) throw new RangeError('sample weight must be positive');
      num += s.price * w;
      den += w;
    }
    return round(num / den, 6);
  }

  function premiumBps(mark, index) {
    if (!(index > 0)) throw new RangeError('index price must be positive');
    return round(((mark - index) / index) * 10000, 4);
  }

  function fundingRate(params) {
    // params: {markTwap, indexTwap, clampBps, interestRateBps, premiumWeight, dampener, openInterest, takerVolume}
    const p = Object.assign({}, FUNDING_DEFAULTS, params || {});
    const mark = p.markTwap !== undefined ? p.markTwap : p.mark;
    const index = p.indexTwap !== undefined ? p.indexTwap : p.index;
    if (!(mark > 0) || !(index > 0)) throw new RangeError('mark and index must be positive');
    const prem = premiumBps(mark, index);
    const dampenerBps = p.takerVolume > 0 ? p.dampener * Math.min(1, (p.openInterest || 0) / p.takerVolume) * 10000 : 0;
    const interest = p.interestRateBps;
    const raw = round(prem * p.premiumWeight + interest + dampenerBps, 6);
    const cap = p.clampBps;
    const clamped = clamp(raw, -cap, cap);
    return {
      premiumBps: prem,
      interestBps: interest,
      dampenerBps: round(dampenerBps, 4),
      rawBps: raw,
      clampedBps: clamped,
      wasClamped: raw !== clamped,
      capBps: cap,
      rate: round(clamped / 10000, 8),
      annualizedPct: round((clamped / 10000) * (24 / p.intervalHours) * 365 * 100, 4)
    };
  }

  function fundingTWAP(markSamples, indexSamples, params) {
    const markT = twap(markSamples);
    const indexT = twap(indexSamples);
    const f = fundingRate(Object.assign({}, params, { markTwap: markT, indexTwap: indexT }));
    return Object.assign({ markTwap: markT, indexTwap: indexT }, f);
  }

  function fundingPayment(positionNotional, rateBps, side) {
    // Longs pay when funding is positive, receive when negative.
    const sign = side === 'short' ? -1 : 1;
    return round(-positionNotional * (rateBps / 10000) * sign, 4);
  }

  function fundingArbitrage(params) {
    // Cash-and-carry: short the perp, hold spot, collect funding.
    const p = Object.assign({ notional: 100000, rateBps: 10, spotFeeBps: 5, perpFeeBps: 4, borrowBpsPerInterval: 2, intervals: 3, fundingIntervalsPerDay: 3 }, params || {});
    const perInterval = p.notional * (p.rateBps / 10000);
    const gross = round(perInterval * p.intervals, 4);
    const entryFees = round(p.notional * (p.spotFeeBps + p.perpFeeBps) / 10000, 4);
    const borrow = round(p.notional * (p.borrowBpsPerInterval / 10000) * p.intervals, 4);
    const net = round(gross - entryFees - borrow, 4);
    return { gross, entryFees, borrow, net, breakEvenBps: round((entryFees + borrow) / p.notional / p.intervals * 10000, 4), profitable: net > 0 };
  }

  // ============================================================
  // Module 3: margin, maintenance margin & liquidation solver
  // ============================================================
  const MARGIN_DEFAULTS = Object.freeze({
    initialMarginRate: 0.10,     // 10x max leverage
    maintenanceMarginRate: 0.005,
    maintenanceBase: 0,          // fixed notional floor
    takerFeeRate: 0.0004,
    liquidationFeeRate: 0.0005
  });

  function position(params) {
    return Object.assign({
      side: 'long', size: 1, entryPrice: 30000, leverage: 10,
      collateral: 3000, marginMode: 'cross', markPrice: 30000
    }, params || {});
  }

  function notional(pos) { return pos.size * pos.markPrice; }

  function initialMargin(pos) {
    return round(notional(pos) / Math.max(1, pos.leverage), 4);
  }

  function unrealizedPnl(pos) {
    const dir = pos.side === 'short' ? -1 : 1;
    return round((pos.markPrice - pos.entryPrice) * pos.size * dir, 4);
  }

  function equity(pos, walletBalance) {
    const balance = walletBalance === undefined ? pos.collateral : walletBalance;
    return round(balance + unrealizedPnl(pos), 4);
  }

  function maintenanceMargin(pos, cfg) {
    const c = Object.assign({}, MARGIN_DEFAULTS, cfg || {});
    return round(notional(pos) * c.maintenanceMarginRate + c.maintenanceBase, 4);
  }

  function marginRatio(pos, cfg) {
    const mm = maintenanceMargin(pos, cfg);
    if (mm <= 0) return Infinity;
    return round(equity(pos) / mm, 6);
  }

  function isLiquidatable(pos, cfg) {
    return equity(pos) <= maintenanceMargin(pos, cfg);
  }

  // Bisection solve for the mark price at which equity == maintenance margin.
  function liquidationPrice(pos, cfg) {
    const p = position(pos);
    const c = Object.assign({}, MARGIN_DEFAULTS, cfg || {});
    const dir = p.side === 'short' ? -1 : 1;
    // equity(price) = collateral + dir*(price-entry)*size
    // maintenance = price*size*mmr + base
    // Solve collateral + dir*(P-E)*S = P*S*mmr + base
    const S = p.size, E = p.entryPrice, C = p.collateral, mmr = c.maintenanceMarginRate, base = c.maintenanceBase;
    if (S <= 0) return null;
    // dir*(P-E)*S - P*S*mmr + C - base = 0
    // P*(dir*S - S*mmr) = dir*S*E - C + base
    const denom = dir * S - S * mmr;
    if (Math.abs(denom) < 1e-12) return null;
    const price = (dir * S * E - C + base) / denom;
    return price <= 0 ? null : round(price, 4);
  }

  function maxLeverage(cfg) {
    const c = Object.assign({}, MARGIN_DEFAULTS, cfg || {});
    return round(1 / c.initialMarginRate, 4);
  }

  function liquidationPenalty(pos, cfg) {
    const c = Object.assign({}, MARGIN_DEFAULTS, cfg || {});
    return round(notional(pos) * c.liquidationFeeRate, 4);
  }

  function isolatedVsCross(pos, cfg) {
    // Isolated: only the position's assigned collateral is at risk.
    // Cross: the whole wallet absorbs the loss but also backstops the position.
    const p = position(pos);
    const iso = { mode: 'isolated', collateralAtRisk: p.collateral, liqPrice: liquidationPrice(p, cfg) };
    const crossPos = position(Object.assign({}, p, { marginMode: 'cross' }));
    const cross = { mode: 'cross', collateralAtRisk: p.collateral, liqPrice: liquidationPrice(crossPos, cfg) };
    return {
      isolated: iso, cross,
      note: 'Cross margin shares wallet equity across positions, so a single adverse move can drain the whole account while isolated margin bounds the loss.'
    };
  }

  function accountEquity(positions, walletBalance) {
    let pnl = 0, totalNotional = 0;
    for (const p of positions) { pnl += unrealizedPnl(p); totalNotional += notional(p); }
    return { walletBalance: round(walletBalance, 4), unrealizedPnl: round(pnl, 4), equity: round(walletBalance + pnl, 4), totalNotional: round(totalNotional, 4) };
  }

  // ============================================================
  // Module 4: liquidation cascade engine
  // A price shock triggers liquidations; each liquidation is a market
  // order that moves the price further, possibly triggering more.
  // ============================================================
  function liquidationCascade(opts) {
    const o = Object.assign({
      book: null, mid: 30000, shockPct: -8, positions: [], rounds: 8,
      mmr: 0.005, liqFeeRate: 0.0005, seed: 'cascade'
    }, opts || {});
    const book = o.book || Orderbook({ mid: o.mid, levels: 16, baseSize: 12, step: o.mid * 0.0006 });
    let price = round(o.mid * (1 + o.shockPct / 100), 4);
    const active = o.positions.map(p => position(Object.assign({}, p, { markPrice: price })));
    const events = [];
    let totalLiquidated = 0, totalPenalty = 0, totalVolume = 0;
    for (let roundIdx = 0; roundIdx < o.rounds; roundIdx++) {
      const triggered = [];
      for (let i = 0; i < active.length; i++) {
        const p = active[i];
        if (p.liquidated) continue;
        p.markPrice = price;
        if (isLiquidatable(p, { maintenanceMarginRate: o.mmr })) triggered.push(i);
      }
      if (!triggered.length) break;
      let roundVolume = 0, roundPenalty = 0;
      for (const idx of triggered) {
        const p = active[idx];
        p.liquidated = true;
        const closeSide = p.side === 'long' ? 'sell' : 'buy';
        const fill = book.marketOrder(closeSide, p.size);
        const penalty = round(notional(p) * o.liqFeeRate, 4);
        roundVolume += fill.filled;
        roundPenalty += penalty;
        totalLiquidated++;
        events.push({
          round: roundIdx + 1, side: p.side, size: p.size,
          markPrice: price, fillPrice: fill.avgPrice, impactBps: fill.impactBps, penalty
        });
      }
      totalVolume = round(totalVolume + roundVolume, 4);
      totalPenalty = round(totalPenalty + roundPenalty, 4);
      // Price moves with the net closing pressure (sells push down, buys push up).
      const netSell = triggered.filter(i => active[i].side === 'long').length - triggered.filter(i => active[i].side === 'short').length;
      const drift = netSell >= 0 ? -1 : 1;
      price = round(price * (1 + drift * Math.min(0.02, roundVolume * 0.00008)), 4);
    }
    return {
      initialPrice: o.mid, shockedPrice: round(o.mid * (1 + o.shockPct / 100), 4),
      finalPrice: price,
      priceMovePct: round(((price - o.mid) / o.mid) * 100, 4),
      liquidatedCount: totalLiquidated,
      survivingCount: active.length - totalLiquidated,
      totalLiquidatedVolume: totalVolume,
      totalPenalty,
      rounds: events.length ? events[events.length - 1].round : 0,
      events,
      book: book.snapshot()
    };
  }

  // ============================================================
  // Module 5: Monte Carlo GBM + Merton jump diffusion & VaR
  // ============================================================
  function simulatePaths(params) {
    const o = Object.assign({
      s0: 30000, mu: 0, sigma: 0.6, lambda: 0.5, jumpMu: -0.03, jumpSigma: 0.08,
      horizonDays: 30, stepsPerDay: 8, paths: 400, seed: 'mc'
    }, params || {});
    const rng = RNG(o.seed);
    // sigma and mu are annualized. Convert the intra-day step to a fraction
    // of a year so a horizonDays-day horizon spans exactly horizonDays/365
    // years of Brownian motion (and jumps fire at the annual intensity).
    const dt = 1 / (365 * o.stepsPerDay);
    const steps = Math.round(o.horizonDays * o.stepsPerDay);
    const sqrtDt = Math.sqrt(dt);
    const pathData = [];
    const terminal = [];
    for (let p = 0; p < o.paths; p++) {
      let s = o.s0;
      let minS = s, maxS = s;
      const path = o.keepPaths ? [s] : null;
      for (let t = 0; t < steps; t++) {
        const z = rng.normal();
        let jump = 0;
        if (o.lambda > 0 && rng.next() < o.lambda * dt) jump = o.jumpMu + o.jumpSigma * rng.normal();
        s = s * Math.exp((o.mu - 0.5 * o.sigma * o.sigma) * dt + o.sigma * sqrtDt * z + jump);
        if (s < minS) minS = s;
        if (s > maxS) maxS = s;
        if (path) path.push(s);
      }
      terminal.push(s);
      pathData.push({ terminal: s, min: minS, max: maxS, path });
    }
    return { params: o, terminal, pathData, steps, dt };
  }

  function percentile(sorted, q) {
    if (!sorted.length) return 0;
    const idx = (sorted.length - 1) * q;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  function varFromReturns(returns, confidence) {
    const sorted = returns.slice().sort((a, b) => a - b);
    const q = 1 - confidence;
    const varReturn = percentile(sorted, q);
    const cvarReturn = sorted.filter(r => r <= varReturn).reduce((s, r) => s + r, 0) / Math.max(1, sorted.filter(r => r <= varReturn).length);
    return { varReturn: round(varReturn, 6), cvarReturn: round(cvarReturn, 6), confidence, count: sorted.length };
  }

  function parametricVaR(params) {
    // Variance-covariance VaR for a single position over a horizon.
    const o = Object.assign({ notional: 100000, sigma: 0.6, horizonDays: 1, confidence: 0.99 }, params || {});
    const z = { 0.90: 1.2816, 0.95: 1.6449, 0.975: 1.96, 0.99: 2.3263, 0.995: 2.5758, 0.999: 3.0902 }[o.confidence] || 2.3263;
    const vol = o.sigma * Math.sqrt(o.horizonDays / 365);
    return { varAbs: round(o.notional * z * vol, 4), varPct: round(z * vol * 100, 4), z, vol: round(vol, 6), confidence: o.confidence };
  }

  function monteCarloVaR(params) {
    const o = Object.assign({
      s0: 30000, mu: 0, sigma: 0.6, lambda: 0.5, jumpMu: -0.03, jumpSigma: 0.08,
      horizonDays: 1, stepsPerDay: 24, paths: 2000, confidence: 0.99,
      notional: 100000, seed: 'var', includeJump: true
    }, params || {});
    const sim = simulatePaths({
      s0: o.s0, mu: o.mu, sigma: o.sigma,
      lambda: o.includeJump ? o.lambda : 0, jumpMu: o.jumpMu, jumpSigma: o.jumpSigma,
      horizonDays: o.horizonDays, stepsPerDay: o.stepsPerDay, paths: o.paths, seed: o.seed
    });
    const returns = sim.terminal.map(s => (s - o.s0) / o.s0);
    const v = varFromReturns(returns, o.confidence);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const sd = Math.sqrt(returns.reduce((a, b) => a + (b - mean) * (b - mean), 0) / returns.length);
    const terminalSorted = sim.terminal.slice().sort((a, b) => a - b);
    return {
      paths: o.paths, horizonDays: o.horizonDays, confidence: o.confidence,
      varPct: round(-v.varReturn * 100, 4),
      cvarPct: round(-v.cvarReturn * 100, 4),
      varNotional: round(-v.varReturn * o.notional, 4),
      cvarNotional: round(-v.cvarReturn * o.notional, 4),
      meanReturn: round(mean, 6), stdReturn: round(sd, 6),
      minTerminal: round(terminalSorted[0], 4),
      maxTerminal: round(terminalSorted[terminalSorted.length - 1], 4),
      medianTerminal: round(percentile(terminalSorted, 0.5), 4),
      p05Terminal: round(percentile(terminalSorted, 0.05), 4),
      p95Terminal: round(percentile(terminalSorted, 0.95), 4),
      jumpEnabled: o.includeJump,
      terminal: sim.terminal
    };
  }

  function liquidationStress(params) {
    // Fraction of Monte Carlo paths that breach a position's liquidation price.
    const o = Object.assign({
      s0: 30000, mu: 0, sigma: 0.6, lambda: 0.5, jumpMu: -0.03, jumpSigma: 0.08,
      horizonDays: 30, stepsPerDay: 8, paths: 1000, seed: 'stress',
      side: 'long', size: 1, entryPrice: 30000, leverage: 10, collateral: 3000, mmr: 0.005
    }, params || {});
    const pos = position({ side: o.side, size: o.size, entryPrice: o.entryPrice, leverage: o.leverage, collateral: o.collateral, markPrice: o.s0 });
    const liq = liquidationPrice(pos, { maintenanceMarginRate: o.mmr });
    const sim = simulatePaths({
      s0: o.s0, mu: o.mu, sigma: o.sigma, lambda: o.lambda, jumpMu: o.jumpMu, jumpSigma: o.jumpSigma,
      horizonDays: o.horizonDays, stepsPerDay: o.stepsPerDay, paths: o.paths, seed: o.seed, keepPaths: false
    });
    let breached = 0;
    for (const pd of sim.pathData) {
      const low = pd.min, high = pd.max;
      const hit = o.side === 'long' ? (liq !== null && low <= liq) : (liq !== null && high >= liq);
      if (hit) breached++;
    }
    return {
      liquidationPrice: liq, paths: o.paths, horizonDays: o.horizonDays,
      breached, breachProbability: round(breached / o.paths, 6),
      survivalProbability: round(1 - breached / o.paths, 6),
      side: o.side, leverage: o.leverage
    };
  }

  function historicalVaR(returns, confidence) {
    if (!returns || !returns.length) throw new RangeError('returns must be a non-empty array');
    return varFromReturns(returns, confidence || 0.99);
  }

  // ============================================================
  // Module 6: risk report helper
  // ============================================================
  function riskReport(params) {
    const o = params || {};
    const book = Orderbook({ mid: o.mid || 30000 });
    const impact = book.quoteImpact('buy', o.orderSize || 20);
    const funding = fundingRate({ markTwap: (o.mid || 30000) * 1.0008, indexTwap: o.mid || 30000 });
    const pos = position({ entryPrice: o.mid || 30000, markPrice: o.mid || 30000, leverage: o.leverage || 10, collateral: o.collateral || 3000 });
    const liq = liquidationPrice(pos);
    const var99 = parametricVaR({ notional: notional(pos), sigma: o.sigma || 0.6, confidence: 0.99 });
    return {
      book: book.snapshot(),
      impact,
      funding,
      position: { notional: notional(pos), initialMargin: initialMargin(pos), maintenanceMargin: maintenanceMargin(pos), liquidationPrice: liq, marginRatio: marginRatio(pos) },
      var99,
      maxLeverage: maxLeverage()
    };
  }

  const api = {
    RNG, hashSeed, clamp, round,
    Orderbook,
    FUNDING_DEFAULTS, twap, premiumBps, fundingRate, fundingTWAP, fundingPayment, fundingArbitrage,
    MARGIN_DEFAULTS, position, notional, initialMargin, unrealizedPnl, equity,
    maintenanceMargin, marginRatio, isLiquidatable, liquidationPrice, maxLeverage,
    liquidationPenalty, isolatedVsCross, accountEquity,
    liquidationCascade,
    simulatePaths, percentile, varFromReturns, parametricVaR, monteCarloVaR, liquidationStress, historicalVaR,
    riskReport
  };
  return api;
}));
