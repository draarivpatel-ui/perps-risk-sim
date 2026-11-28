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
  function roundNonzero(x, dp) { const r = round(x, dp); return r === 0 && x > 0 ? x : r; }

  // ============================================================
  // Module 1: CLOB (central limit order book) depth & impact engine
  // Levels carry a price and a size. Market orders walk the book;
  // limit orders rest at a level. All fills are deterministic.
  // ============================================================
  function Orderbook(options) {
    const opts = options || {};
    // Explicit values are honored, including zero and NaN, so invalid
    // parameters reach the validators instead of silently defaulting.
    const pick = (v, d) => v === undefined ? d : v;
    const tick = pick(opts.tick, 0.5);
    const mid = pick(opts.mid, 30000);
    const levels = pick(opts.levels, 12);
    const baseSize = pick(opts.baseSize, 8);
    const step = pick(opts.step, 2.5);
    if (!(mid > 0) || !Number.isFinite(mid)) throw new RangeError('orderbook mid must be a positive finite number');
    if (!(tick > 0) || !Number.isFinite(tick)) throw new RangeError('orderbook tick must be a positive finite number');
    if (!(step > 0) || !Number.isFinite(step)) throw new RangeError('orderbook step must be a positive finite number');
    if (!(baseSize > 0) || !Number.isFinite(baseSize)) throw new RangeError('orderbook baseSize must be a positive finite number');
    const lvlCount = Math.floor(levels);
    if (!(lvlCount >= 1)) throw new RangeError('orderbook levels must be at least one');
    if (!(lvlCount <= 10000)) throw new RangeError('orderbook levels must not exceed 10000');
    if (!(mid - lvlCount * step > 0)) throw new RangeError('orderbook levels reach a nonpositive bid price');
    const bids = [], asks = [];
    for (let i = 0; i < lvlCount; i++) {
      const price = round(mid - (i + 1) * step, 4);
      bids.push({ price, size: round(baseSize * (1 + i * 0.35), 4) });
      asks.push({ price: round(mid + (i + 1) * step, 4), size: round(baseSize * (1 + i * 0.35), 4) });
    }
    let lastTrade = mid;
    let anchorMid = mid; // last two-sided mid; fallback when a side is fully drained
    let volume = 0;

    function checkSide(side) {
      if (side !== 'buy' && side !== 'sell') throw new RangeError('side must be buy or sell');
    }
    function checkSize(size, what) {
      if (!Number.isFinite(size) || !(size > 0)) throw new RangeError(what + ' size must be a positive finite number');
    }

    function sortBook() {
      bids.sort((a, b) => b.price - a.price);
      asks.sort((a, b) => a.price - b.price);
    }

    function bestBid() { return bids.length ? bids[0].price : null; }
    function bestAsk() { return asks.length ? asks[0].price : null; }
    function midPrice() {
      const bb = bestBid(), ba = bestAsk();
      if (bb === null || ba === null) return anchorMid;
      const m = round((bb + ba) / 2, 4);
      anchorMid = m;
      return m;
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
      checkSide(side);
      checkSize(size, 'limit order');
      const p = round(price, 4);
      if (!(p > 0) || !Number.isFinite(p)) throw new RangeError('limit order price must round to a positive finite number');
      if (Math.abs(p / tick - Math.round(p / tick)) > 1e-6) throw new RangeError('limit order price is off the ' + tick + ' tick grid');
      const rs = round(size, 4);
      if (!(rs > 0)) throw new RangeError('limit order size is below the book size resolution');
      if (side === 'buy' && bestAsk() !== null && p >= bestAsk()) throw new RangeError('buy limit crosses the best ask');
      if (side === 'sell' && bestBid() !== null && p <= bestBid()) throw new RangeError('sell limit crosses the best bid');
      const book = side === 'buy' ? bids : asks;
      const lvl = book.find(l => l.price === p);
      if (lvl) lvl.size = round(lvl.size + rs, 4);
      else { book.push({ price: p, size: rs }); sortBook(); }
      return snapshot();
    }

    function cancelLevel(side, price) {
      checkSide(side);
      if (!Number.isFinite(price) || !(price > 0)) throw new RangeError('cancel price must be a positive finite number');
      const book = side === 'buy' ? bids : asks;
      const i = book.findIndex(l => l.price === round(price, 4));
      if (i >= 0) book.splice(i, 1);
      return snapshot();
    }

    // Walk the book for a market order of `size` base units.
    function marketOrder(side, size) {
      checkSide(side);
      checkSize(size, 'market order');
      const book = side === 'buy' ? asks : bids; // a buy consumes asks
      // Capture the pre-trade mid before consuming any level. Slippage and
      // impact are measured against the decision price, so they must agree
      // with a non-mutating quoteImpact() taken on the same book state.
      const ref = midPrice();
      let remaining = size, notional = 0, filled = 0, levelsHit = 0;
      const fills = [];
      // Sub-micro fills never mutate the book: below the reporting floor a
      // take would consume liquidity the report cannot show.
      while (remaining >= 1e-6 && book.length) {
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
      const unfilled = Math.max(0, remaining);
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
      checkSide(side);
      checkSize(size, 'quote');
      const book = side === 'buy' ? asks : bids;
      let remaining = size, notional = 0, filled = 0, levelsHit = 0;
      let i = 0;
      while (remaining >= 1e-6 && i < book.length) {
        const lvl = book[i];
        const take = Math.min(remaining, lvl.size);
        notional += take * lvl.price;
        remaining -= take; filled += take; levelsHit++; i++;
      }
      const avgPrice = filled > 0 ? notional / filled : null;
      const ref = midPrice();
      return {
        side, size, filled: round(filled, 6), unfilled: Math.max(0, remaining),
        avgPrice: avgPrice === null ? null : round(avgPrice, 4),
        slippage: avgPrice === null ? 0 : round(Math.abs(avgPrice - ref), 4),
        impactBps: avgPrice === null ? 0 : round((Math.abs(avgPrice - ref) / ref) * 10000, 3),
        levelsHit
      };
    }

    function depthWithinBps(bps) {
      if (!Number.isFinite(bps) || bps < 0) throw new RangeError('depth band must be a nonnegative finite number of basis points');
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
      if (!(w > 0) || !Number.isFinite(w)) throw new RangeError('sample weight must be a positive finite number');
      if (!Number.isFinite(s.price)) throw new RangeError('sample price must be a finite number');
      num += s.price * w;
      den += w;
    }
    if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) throw new RangeError('twap inputs overflow the representable range');
    return round(num / den, 6);
  }

  function premiumBps(mark, index) {
    if (!(index > 0) || !Number.isFinite(index)) throw new RangeError('index price must be a positive finite number');
    if (!(mark > 0) || !Number.isFinite(mark)) throw new RangeError('mark price must be a positive finite number');
    const v = ((mark - index) / index) * 10000;
    if (!Number.isFinite(v)) throw new RangeError('premium overflows the representable range');
    return round(v, 4);
  }

  function fundingRate(params) {
    // params: {markTwap, indexTwap, clampBps, interestRateBps, premiumWeight, dampener, openInterest, takerVolume}
    const p = Object.assign({}, FUNDING_DEFAULTS, params || {});
    const mark = p.markTwap !== undefined ? p.markTwap : p.mark;
    const index = p.indexTwap !== undefined ? p.indexTwap : p.index;
    if (!(mark > 0) || !(index > 0)) throw new RangeError('mark and index must be positive');
    if (!(p.intervalHours > 0) || !Number.isFinite(p.intervalHours)) throw new RangeError('funding intervalHours must be a positive finite number');
    if (!(p.clampBps >= 0) || !Number.isFinite(p.clampBps)) throw new RangeError('funding clampBps must be a nonnegative finite number');
    if (!Number.isFinite(p.premiumWeight)) throw new RangeError('funding premiumWeight must be a finite number');
    if (!Number.isFinite(p.interestRateBps)) throw new RangeError('funding interestRateBps must be a finite number');
    if (!(p.dampener >= 0) || !Number.isFinite(p.dampener)) throw new RangeError('funding dampener must be a nonnegative finite number');
    if (p.openInterest !== undefined && !Number.isFinite(p.openInterest)) throw new RangeError('openInterest must be finite when provided');
    if (p.takerVolume !== undefined && !(p.takerVolume >= 0)) throw new RangeError('takerVolume must be nonnegative when provided');
    const prem = premiumBps(mark, index);
    // dampener is a fraction of one percent (0.05 -> 5 bps), scaled by the
    // capped open-interest to taker-volume ratio.
    const oiRatio = p.takerVolume > 0 ? Math.min(1, Math.max(0, (p.openInterest || 0) / p.takerVolume)) : 0;
    const dampenerBps = p.dampener * oiRatio * 100;
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
      annualizedPct: (() => {
        const ann = (clamped / 10000) * (24 / p.intervalHours) * 365 * 100;
        if (!Number.isFinite(ann)) throw new RangeError('funding annualization overflows for the given intervalHours');
        return round(ann, 4);
      })()
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
    if (side !== 'long' && side !== 'short') throw new RangeError('funding payment side must be long or short');
    if (!(positionNotional >= 0) || !Number.isFinite(positionNotional)) throw new RangeError('position notional must be a nonnegative finite number');
    if (!Number.isFinite(rateBps)) throw new RangeError('funding rateBps must be a finite number');
    const sign = side === 'short' ? -1 : 1;
    return round(-positionNotional * (rateBps / 10000) * sign, 4);
  }

  function fundingArbitrage(params) {
    // Cash-and-carry: short the perp, hold spot, collect funding.
    const p = Object.assign({ notional: 100000, rateBps: 10, spotFeeBps: 5, perpFeeBps: 4, borrowBpsPerInterval: 2, intervals: 3 }, params || {});
    if (!(p.notional > 0) || !Number.isFinite(p.notional)) throw new RangeError('arbitrage notional must be a positive finite number');
    if (!Number.isFinite(p.rateBps)) throw new RangeError('arbitrage rateBps must be a finite number');
    if (!Number.isFinite(p.spotFeeBps)) throw new RangeError('arbitrage spotFeeBps must be a finite number');
    if (!Number.isFinite(p.perpFeeBps)) throw new RangeError('arbitrage perpFeeBps must be a finite number');
    if (!Number.isFinite(p.borrowBpsPerInterval)) throw new RangeError('arbitrage borrowBpsPerInterval must be a finite number');
    if (!Number.isFinite(p.intervals) || !(p.intervals >= 1) || !(p.intervals <= 1e6)) throw new RangeError('arbitrage intervals must be finite between 1 and 1000000');
    const ivl = Math.floor(p.intervals);
    const perInterval = p.notional * (p.rateBps / 10000);
    const gross = round(perInterval * ivl, 4);
    const entryFees = round(p.notional * (p.spotFeeBps + p.perpFeeBps) / 10000, 4);
    const borrow = round(p.notional * (p.borrowBpsPerInterval / 10000) * ivl, 4);
    const net = round(gross - entryFees - borrow, 4);
    return { gross, entryFees, borrow, net, breakEvenBps: round((entryFees + borrow) / p.notional / ivl * 10000, 4), profitable: net > 0 };
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
    if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) throw new RangeError('position params must be an object');
    const p = Object.assign({
      side: 'long', size: 1, entryPrice: 30000, leverage: 10,
      collateral: 3000, marginMode: 'cross', markPrice: 30000
    }, params || {});
    if (p.side !== 'long' && p.side !== 'short') throw new RangeError('position side must be long or short');
    if (p.marginMode !== 'cross' && p.marginMode !== 'isolated') throw new RangeError('marginMode must be cross or isolated');
    if (!(p.size > 0) || !Number.isFinite(p.size)) throw new RangeError('position size must be a positive finite number');
    if (!(p.entryPrice > 0) || !Number.isFinite(p.entryPrice)) throw new RangeError('entryPrice must be a positive finite number');
    if (!(p.markPrice > 0) || !Number.isFinite(p.markPrice)) throw new RangeError('markPrice must be a positive finite number');
    if (!(p.leverage >= 1) || !Number.isFinite(p.leverage)) throw new RangeError('leverage must be a finite number of at least one');
    if (!(p.leverage <= 1 / MARGIN_DEFAULTS.initialMarginRate)) throw new RangeError('leverage exceeds the maximum of ' + round(1 / MARGIN_DEFAULTS.initialMarginRate, 4));
    if (!(p.collateral >= 0) || !Number.isFinite(p.collateral)) throw new RangeError('collateral must be a nonnegative finite number');
    if (!Number.isFinite(p.size * p.markPrice) || !Number.isFinite(p.size * p.entryPrice)) throw new RangeError('position notional overflows the representable range');
    return p;
  }

  // Shape check for the margin readers below: position() builds valid
  // objects, but a caller can hand a partial or crafted literal.
  function requirePosition(pos) {
    if (!pos || typeof pos !== 'object' || Array.isArray(pos)) throw new RangeError('expected a position object');
    if (pos.side !== 'long' && pos.side !== 'short') throw new RangeError('position side must be long or short');
    if (!(pos.size > 0) || !Number.isFinite(pos.size)) throw new RangeError('position size must be a positive finite number');
    if (!(pos.entryPrice > 0) || !Number.isFinite(pos.entryPrice)) throw new RangeError('entryPrice must be a positive finite number');
    if (!(pos.markPrice > 0) || !Number.isFinite(pos.markPrice)) throw new RangeError('markPrice must be a positive finite number');
    if (!(pos.collateral >= 0) || !Number.isFinite(pos.collateral)) throw new RangeError('collateral must be a nonnegative finite number');
    if (!(pos.leverage >= 1) || !Number.isFinite(pos.leverage)) throw new RangeError('leverage must be a finite number of at least one');
    return pos;
  }

  function notional(pos) { requirePosition(pos); return pos.size * pos.markPrice; }

  function initialMargin(pos) {
    requirePosition(pos);
    return round(notional(pos) / Math.max(1, pos.leverage), 4);
  }

  function unrealizedPnl(pos) {
    requirePosition(pos);
    const dir = pos.side === 'short' ? -1 : 1;
    return round((pos.markPrice - pos.entryPrice) * pos.size * dir, 4);
  }

  function equity(pos, walletBalance) {
    requirePosition(pos);
    if (walletBalance !== undefined && !Number.isFinite(walletBalance)) throw new RangeError('walletBalance must be a finite number');
    const balance = walletBalance === undefined ? pos.collateral : walletBalance;
    return round(balance + unrealizedPnl(pos), 4);
  }

  function checkMarginCfg(c) {
    if (!(c.maintenanceMarginRate >= 0) || !Number.isFinite(c.maintenanceMarginRate)) throw new RangeError('maintenanceMarginRate must be a nonnegative finite number');
    if (!(c.maintenanceBase >= 0) || !Number.isFinite(c.maintenanceBase)) throw new RangeError('maintenanceBase must be a nonnegative finite number');
    return c;
  }

  function maintenanceMargin(pos, cfg) {
    requirePosition(pos);
    const c = checkMarginCfg(Object.assign({}, MARGIN_DEFAULTS, cfg || {}));
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
    const c = checkMarginCfg(Object.assign({}, MARGIN_DEFAULTS, cfg || {}));
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
    if (!Number.isFinite(price) || price <= 0) return null;
    // The displayed price must still liquidate: a long root below the first
    // positive tick is zero at display resolution, otherwise step one tick toward the boundary.
    let out = round(price, 4);
    for (let i = 0; i < 8; i += 1) {
      if (!(out > 0)) {
        if (dir === 1) return 0;
        out = 0.0001;
      }
      if (isLiquidatable(Object.assign({}, p, { markPrice: out }), c)) break;
      out = round(out + (dir === 1 ? -0.0001 : 0.0001), 4);
    }
    return out;
  }

  function maxLeverage(cfg) {
    const c = Object.assign({}, MARGIN_DEFAULTS, cfg || {});
    if (!(c.initialMarginRate > 0) || !Number.isFinite(c.initialMarginRate)) throw new RangeError('initialMarginRate must be a positive finite number');
    return round(1 / c.initialMarginRate, 4);
  }

  function liquidationPenalty(pos, cfg) {
    const c = Object.assign({}, MARGIN_DEFAULTS, cfg || {});
    if (!(c.liquidationFeeRate >= 0) || !Number.isFinite(c.liquidationFeeRate)) throw new RangeError('liquidationFeeRate must be a nonnegative finite number');
    return round(notional(pos) * c.liquidationFeeRate, 4);
  }

  function isolatedVsCross(pos, cfg, sharedCollateral) {
    // Isolated: only the position's assigned collateral is at risk.
    // Cross: the rest of the wallet also backstops the position, so the
    // liquidation price sits further out whenever sharedCollateral > 0.
    const p = position(pos);
    const shared = Number.isFinite(sharedCollateral) ? Math.max(0, sharedCollateral) : 0;
    const iso = { mode: 'isolated', collateralAtRisk: p.collateral, liqPrice: liquidationPrice(p, cfg) };
    const crossPos = position(Object.assign({}, p, { marginMode: 'cross', collateral: p.collateral + shared }));
    const cross = { mode: 'cross', collateralAtRisk: round(p.collateral + shared, 4), liqPrice: liquidationPrice(crossPos, cfg) };
    return {
      isolated: iso, cross,
      note: 'Cross margin pools ' + (shared > 0 ? 'the position collateral plus ' + round(shared, 4) + ' of shared wallet balance' : 'only the position collateral (pass sharedCollateral to model the rest of the wallet)') + ', so a single adverse move can drain the whole account while isolated margin bounds the loss.'
    };
  }

  function accountEquity(positions, walletBalance) {
    if (!Array.isArray(positions)) throw new RangeError('accountEquity positions must be an array');
    if (!Number.isFinite(walletBalance)) throw new RangeError('accountEquity walletBalance must be a finite number');
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
      mmr: 0.005, liqFeeRate: 0.0005
    }, opts || {});
    if (!(o.mid > 0) || !Number.isFinite(o.mid)) throw new RangeError('cascade mid must be a positive finite number');
    if (!Number.isFinite(o.shockPct) || !(o.shockPct > -100)) throw new RangeError('shockPct must be finite and greater than -100 percent');
    if (!Array.isArray(o.positions)) throw new RangeError('cascade positions must be an array');
    if (!(o.mmr >= 0) || !Number.isFinite(o.mmr)) throw new RangeError('cascade mmr must be a nonnegative finite number');
    if (!(o.liqFeeRate >= 0) || !Number.isFinite(o.liqFeeRate)) throw new RangeError('cascade liqFeeRate must be a nonnegative finite number');
    if (!Number.isFinite(o.rounds) || !(o.rounds >= 0)) throw new RangeError('cascade rounds must be a nonnegative finite number');
    if (o.book && typeof o.book.marketOrder !== 'function') throw new RangeError('cascade book must expose marketOrder()');
    const maxRounds = Math.max(0, Math.floor(o.rounds));
    let book = o.book || Orderbook({ mid: o.mid, levels: 16, baseSize: 12, step: o.mid * 0.0006 });
    let price = round(o.mid * (1 + o.shockPct / 100), 4);
    if (!(price > 0) || !Number.isFinite(price)) throw new RangeError('cascade shock produces a nonpositive or nonfinite mark price');
    const active = o.positions.map((p, i) => {
      if (!p || typeof p !== 'object' || Array.isArray(p)) throw new RangeError('cascade positions[' + i + '] must be an object');
      const pos = position(Object.assign({}, p, { markPrice: price }));
      pos.liquidated = false; // ignore a caller-supplied liquidated flag
      pos.closedSize = 0;
      return pos;
    });
    const events = [];
    let totalPenalty = 0, totalVolume = 0;
    for (let roundIdx = 0; roundIdx < maxRounds; roundIdx++) {
      const triggered = [];
      for (let i = 0; i < active.length; i++) {
        const p = active[i];
        if (p.liquidated) continue;
        p.markPrice = price;
        if (isLiquidatable(p, { maintenanceMarginRate: o.mmr })) triggered.push(i);
      }
      if (!triggered.length) break;
      // The synthetic book re-pegs to the current mark each round so forced
      // fills execute near the cascading price, not the pre-shock mid.
      if (!o.book) book = Orderbook({ mid: price, levels: 16, baseSize: 12, step: price * 0.0006 });
      let roundVolume = 0, roundPenalty = 0;
      const filledByIndex = {};
      for (const idx of triggered) {
        const p = active[idx];
        const requestedSize = p.size;
        const closeSide = p.side === 'long' ? 'sell' : 'buy';
        const fill = book.marketOrder(closeSide, requestedSize);
        filledByIndex[idx] = fill.filled;
        // Penalty is charged on executed notional only; the unfilled residual
        // stays open with the same fraction of the position collateral.
        const executedNotional = fill.filled * (fill.avgPrice || price);
        const penalty = round(executedNotional * o.liqFeeRate, 4);
        roundVolume += fill.filled;
        roundPenalty += penalty;
        p.closedSize = (p.closedSize || 0) + fill.filled;
        if (fill.unfilled > 0) {
          p.size = fill.unfilled;
          p.collateral = p.collateral * (fill.unfilled / requestedSize);
          p.liquidated = false;
        } else if (fill.filled > 0) {
          p.size = 0;
          p.collateral = 0;
          p.liquidated = true;
        } else {
          p.size = requestedSize;
          p.liquidated = false;
        }
        events.push({
          round: roundIdx + 1, side: p.side, size: requestedSize,
          markPrice: price, fillPrice: fill.avgPrice, impactBps: fill.impactBps, penalty,
          filled: fill.filled, unfilled: fill.unfilled, remainingSize: p.size,
          liquidated: p.liquidated
        });
      }
      totalVolume = round(totalVolume + roundVolume, 4);
      totalPenalty = round(totalPenalty + roundPenalty, 4);
      // Price moves with the net closing *volume* (sells down, buys up).
      const netSell = triggered.reduce((s, i) => {
        const closed = filledByIndex[i] || 0;
        return s + (active[i].side === 'long' ? closed : -closed);
      }, 0);
      const drift = netSell > 0 ? -1 : (netSell < 0 ? 1 : 0);
      price = round(price * (1 + drift * Math.min(0.02, roundVolume * 0.00008)), 4);
    }
    const finalPositions = active.map((p, i) => ({
      index: i, side: p.side, size: roundNonzero(p.size, 9), entryPrice: p.entryPrice,
      markPrice: price, collateral: roundNonzero(p.collateral, 6), leverage: p.leverage,
      marginMode: p.marginMode, liquidated: p.liquidated,
      closedSize: roundNonzero(p.closedSize || 0, 9)
    }));
    const fullyLiquidatedCount = active.filter(p => p.liquidated).length;
    const partiallyLiquidatedCount = active.filter(p => !p.liquidated && (p.closedSize || 0) > 0).length;
    return {
      initialPrice: o.mid, shockedPrice: round(o.mid * (1 + o.shockPct / 100), 4),
      finalPrice: price,
      priceMovePct: round(((price - o.mid) / o.mid) * 100, 4),
      liquidatedCount: fullyLiquidatedCount,
      fullyLiquidatedCount,
      partiallyLiquidatedCount,
      survivingCount: active.length - fullyLiquidatedCount,
      totalLiquidatedVolume: totalVolume,
      totalPenalty,
      rounds: events.length ? events[events.length - 1].round : 0,
      events,
      positions: finalPositions,
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
    if (!(o.s0 > 0) || !Number.isFinite(o.s0)) throw new RangeError('simulatePaths s0 must be a positive finite number');
    if (!(Math.abs(o.mu) <= 100) || !Number.isFinite(o.mu)) throw new RangeError('simulatePaths mu must be a finite number within +-100');
    if (!(o.sigma >= 0 && o.sigma <= 100) || !Number.isFinite(o.sigma)) throw new RangeError('simulatePaths sigma must be a finite number in [0, 100]');
    if (!(o.lambda >= 0) || !Number.isFinite(o.lambda)) throw new RangeError('simulatePaths lambda must be a nonnegative finite number');
    if (!(Math.abs(o.jumpMu) <= 100) || !Number.isFinite(o.jumpMu)) throw new RangeError('simulatePaths jumpMu must be a finite number within +-100');
    if (!(o.jumpSigma >= 0 && o.jumpSigma <= 100) || !Number.isFinite(o.jumpSigma)) throw new RangeError('simulatePaths jumpSigma must be a finite number in [0, 100]');
    if (!(o.horizonDays >= 0) || !Number.isFinite(o.horizonDays)) throw new RangeError('simulatePaths horizonDays must be a nonnegative finite number');
    if (!(o.stepsPerDay > 0) || !Number.isFinite(o.stepsPerDay)) throw new RangeError('simulatePaths stepsPerDay must be a positive finite number');
    if (!Number.isFinite(o.paths)) throw new RangeError('simulatePaths paths must be a finite number');
    const pathCount = Math.floor(o.paths);
    if (!(pathCount >= 1)) throw new RangeError('simulatePaths paths must be at least one');
    if (!(pathCount <= 1e6)) throw new RangeError('simulatePaths paths must not exceed 1000000');
    const rng = RNG(o.seed);
    // sigma and mu are annualized. Convert the intra-day step to a fraction
    // of a year so a horizonDays-day horizon spans exactly horizonDays/365
    // years of Brownian motion (and jumps fire at the annual intensity).
    const dt = 1 / (365 * o.stepsPerDay);
    const steps = Math.round(o.horizonDays * o.stepsPerDay);
    if (!(steps <= 1e6)) throw new RangeError('simulatePaths step count exceeds the work budget');
    const sqrtDt = Math.sqrt(dt);
    const pathData = [];
    const terminal = [];
    for (let p = 0; p < pathCount; p++) {
      let s = o.s0;
      let minS = s, maxS = s;
      const path = o.keepPaths ? [s] : null;
      for (let t = 0; t < steps; t++) {
        const z = rng.normal();
        let jump = 0;
        if (o.lambda > 0 && rng.next() < o.lambda * dt) jump = o.jumpMu + o.jumpSigma * rng.normal();
        // Floor at the smallest positive double so an extreme drawdown
        // cannot underflow a GBM price to exactly zero.
        s = Math.min(Math.max(s * Math.exp((o.mu - 0.5 * o.sigma * o.sigma) * dt + o.sigma * sqrtDt * z + jump), Number.MIN_VALUE), Number.MAX_VALUE);
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
    const qq = clamp(Number.isFinite(q) ? q : 0, 0, 1);
    const idx = (sorted.length - 1) * qq;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  // Acklam's rational approximation of the standard normal quantile,
  // accurate to about 1e-9 in absolute error across (0, 1).
  function normalQuantile(p) {
    const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    const pl = 0.02425, ph = 1 - pl;
    let q, r;
    if (p < pl) {
      q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p > ph) {
      q = Math.sqrt(-2 * Math.log(1 - p));
      return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }

  function varFromReturns(returns, confidence) {
    if (!Array.isArray(returns) || !returns.length) throw new RangeError('returns must be a non-empty array');
    const c = confidence === undefined ? 0.99 : confidence;
    if (!(c > 0 && c < 1) || !Number.isFinite(c)) throw new RangeError('confidence must be a finite number strictly between zero and one');
    for (const r of returns) {
      if (!Number.isFinite(r)) throw new RangeError('returns must contain only finite numbers');
    }
    const sorted = returns.slice().sort((a, b) => a - b);
    const q = 1 - c;
    const varReturn = percentile(sorted, q);
    const cvarReturn = sorted.filter(r => r <= varReturn).reduce((s, r) => s + r, 0) / Math.max(1, sorted.filter(r => r <= varReturn).length);
    return { varReturn: round(varReturn, 6), cvarReturn: round(cvarReturn, 6), confidence: c, count: sorted.length };
  }

  function parametricVaR(params) {
    // Variance-covariance VaR for a single position over a horizon.
    const o = Object.assign({ notional: 100000, sigma: 0.6, horizonDays: 1, confidence: 0.99 }, params || {});
    if (!(o.notional >= 0) || !Number.isFinite(o.notional)) throw new RangeError('parametricVaR notional must be a nonnegative finite number');
    if (!(o.sigma >= 0) || !Number.isFinite(o.sigma)) throw new RangeError('parametricVaR sigma must be a nonnegative finite number');
    if (!(o.horizonDays > 0) || !Number.isFinite(o.horizonDays)) throw new RangeError('parametricVaR horizonDays must be a positive finite number');
    const c = o.confidence === undefined ? 0.99 : o.confidence;
    if (!(c > 0 && c < 1) || !Number.isFinite(c)) throw new RangeError('parametricVaR confidence must be a finite number strictly between zero and one');
    const z = normalQuantile(c);
    const vol = o.sigma * Math.sqrt(o.horizonDays / 365);
    return { varAbs: round(o.notional * z * vol, 4), varPct: round(z * vol * 100, 4), z: round(z, 6), vol: round(vol, 6), confidence: c };
  }

  function monteCarloVaR(params) {
    const o = Object.assign({
      s0: 30000, mu: 0, sigma: 0.6, lambda: 0.5, jumpMu: -0.03, jumpSigma: 0.08,
      horizonDays: 1, stepsPerDay: 24, paths: 2000, confidence: 0.99,
      notional: 100000, seed: 'var', includeJump: true
    }, params || {});
    if (!(o.notional >= 0) || !Number.isFinite(o.notional)) throw new RangeError('monteCarloVaR notional must be a nonnegative finite number');
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
      paths: sim.terminal.length, horizonDays: o.horizonDays, confidence: o.confidence,
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
      liquidationPrice: liq, paths: sim.pathData.length, horizonDays: o.horizonDays,
      breached, breachProbability: round(breached / sim.pathData.length, 6),
      survivalProbability: round(1 - breached / sim.pathData.length, 6),
      side: o.side, leverage: o.leverage
    };
  }

  function historicalVaR(returns, confidence) {
    if (!Array.isArray(returns) || !returns.length) throw new RangeError('returns must be a non-empty array');
    return varFromReturns(returns, confidence === undefined ? 0.99 : confidence);
  }

  // ============================================================
  // Module 6: risk report helper
  // ============================================================
  function riskReport(params) {
    const o = params || {};
    const pick = (v, d) => v === undefined ? d : v;
    const mid = pick(o.mid, 30000);
    const book = Orderbook({ mid });
    const impact = book.quoteImpact('buy', pick(o.orderSize, 20));
    const funding = fundingRate({ markTwap: mid * 1.0008, indexTwap: mid });
    const pos = position({ entryPrice: mid, markPrice: mid, leverage: pick(o.leverage, 10), collateral: pick(o.collateral, 3000) });
    const liq = liquidationPrice(pos);
    const var99 = parametricVaR({ notional: notional(pos), sigma: pick(o.sigma, 0.6), confidence: 0.99 });
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
