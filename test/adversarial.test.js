'use strict';

/*
 * Adversarial hardening suite for Perps Risk Sim.
 * Locks the input validation and edge-case behaviour added to the core and
 * risk-lab modules: nonfinite order sizes and prices, invalid side strings,
 * crossing limit orders, degenerate books, funding clamps and dampener units,
 * position field validation, exact liquidation thresholds, cascade input
 * sanitizing, Monte Carlo parameter bounds, percentile clamps, waterfall
 * conservation with degenerate inputs, and page-level hygiene checks.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../src/perps.js');
const A = require('../src/risklab.js');

const root = path.resolve(__dirname, '..');

// ---------------------------------------------------------------
// Section 1: orderbook construction and order validation
// ---------------------------------------------------------------
test('ADV1: orderbook rejects a nonpositive or nonfinite mid', () => {
  for (const mid of [0, -10, NaN, Infinity, -Infinity]) {
    assert.throws(() => P.Orderbook({ mid }), RangeError, 'mid ' + mid);
  }
});

test('ADV2: orderbook rejects parameters that poison the book', () => {
  assert.throws(() => P.Orderbook({ mid: 30000, tick: 0 }), RangeError);
  assert.throws(() => P.Orderbook({ mid: 30000, step: 0 }), RangeError);
  assert.throws(() => P.Orderbook({ mid: 30000, baseSize: 0 }), RangeError);
  assert.throws(() => P.Orderbook({ mid: 30000, levels: 0 }), RangeError);
});

test('ADV3: orderbook rejects levels that would drive bids nonpositive', () => {
  assert.throws(() => P.Orderbook({ mid: 100, levels: 12, step: 10 }), RangeError);
  const ok = P.Orderbook({ mid: 100, levels: 3, step: 10 });
  assert.ok(ok.snapshot().bids.every(l => l.price > 0));
});

test('ADV4: market order rejects nonfinite and nonpositive sizes', () => {
  const b = P.Orderbook({ mid: 30000 });
  for (const size of [Infinity, -Infinity, NaN, 0, -1]) {
    assert.throws(() => b.marketOrder('buy', size), RangeError, 'size ' + size);
    assert.throws(() => b.marketOrder('sell', size), RangeError, 'size ' + size);
  }
});

test('ADV5: orders reject a side string that is not exactly buy or sell', () => {
  const b = P.Orderbook({ mid: 30000 });
  for (const side of ['Buy', 'SELL', 'hold', '', 1, null, undefined]) {
    assert.throws(() => b.marketOrder(side, 1), RangeError, 'side ' + side);
    assert.throws(() => b.quoteImpact(side, 1), RangeError, 'side ' + side);
    assert.throws(() => b.addLimit(side, 100, 1), RangeError, 'side ' + side);
    assert.throws(() => b.cancelLevel(side, 100), RangeError, 'side ' + side);
  }
});

test('ADV6: quoteImpact validates size like marketOrder', () => {
  const b = P.Orderbook({ mid: 30000 });
  for (const size of [0, -3, NaN, Infinity]) {
    assert.throws(() => b.quoteImpact('buy', size), RangeError, 'size ' + size);
  }
});

test('ADV7: limit orders reject nonpositive, nonfinite or zero-rounded prices', () => {
  const b = P.Orderbook({ mid: 30000 });
  assert.throws(() => b.addLimit('buy', -5, 1), RangeError);
  assert.throws(() => b.addLimit('buy', NaN, 1), RangeError);
  assert.throws(() => b.addLimit('buy', Infinity, 1), RangeError);
  assert.throws(() => b.addLimit('buy', 0.00001, 1), RangeError); // rounds to zero
  assert.throws(() => b.addLimit('sell', 0, 1), RangeError);
});

test('ADV8: limit orders reject nonfinite and nonpositive sizes', () => {
  const b = P.Orderbook({ mid: 30000 });
  for (const size of [Infinity, NaN, 0, -2]) {
    assert.throws(() => b.addLimit('buy', 29000, size), RangeError, 'size ' + size);
  }
});

test('ADV9: a limit order may never cross the book', () => {
  const b = P.Orderbook({ mid: 30000 });
  assert.throws(() => b.addLimit('buy', b.bestAsk(), 1), RangeError);
  assert.throws(() => b.addLimit('buy', b.bestAsk() + 1, 1), RangeError);
  assert.throws(() => b.addLimit('sell', b.bestBid(), 1), RangeError);
  assert.throws(() => b.addLimit('sell', b.bestBid() - 1, 1), RangeError);
  assert.ok(b.spread() > 0);
});

test('ADV10: depthWithinBps rejects a negative or nonfinite band', () => {
  const b = P.Orderbook({ mid: 30000 });
  assert.throws(() => b.depthWithinBps(-5), RangeError);
  assert.throws(() => b.depthWithinBps(NaN), RangeError);
  const d = b.depthWithinBps(0);
  assert.equal(d.bid, 0);
  assert.equal(d.ask, 0);
});

test('ADV11: a fully consumed side reports a null average and unfilled size', () => {
  const b = P.Orderbook({ mid: 30000, levels: 1, baseSize: 3 });
  b.marketOrder('buy', 3);
  const r = b.marketOrder('buy', 1);
  assert.equal(r.avgPrice, null);
  assert.equal(r.filled, 0);
  assert.equal(r.unfilled, 1);
});

test('ADV12: mid price falls back to the last two-sided mid when a side empties', () => {
  const b = P.Orderbook({ mid: 30000, levels: 1, baseSize: 3 });
  b.marketOrder('buy', 3);
  assert.equal(b.bestAsk(), null);
  // A drained side cannot fake a mid: the last true two-sided mid holds.
  assert.equal(b.midPrice(), 30000);
  const r2 = b.marketOrder('sell', 3);
  assert.equal(b.bestBid(), null);
  assert.equal(b.midPrice(), 30000);
});

test('ADV13: dust and near-dust orders behave predictably', () => {
  const dust = P.Orderbook({ mid: 30000 }).marketOrder('buy', Number.MIN_VALUE * 10);
  assert.equal(dust.filled, 0);
  assert.equal(dust.avgPrice, null);
  // Sub-micro orders never touch the book; the residual is fully reported.
  const book = P.Orderbook({ mid: 30000 });
  const depthBefore = book.snapshot().depth.asks;
  const tiny = book.marketOrder('buy', 1e-8);
  assert.equal(tiny.fills.length, 0);
  assert.equal(tiny.filled, 0);
  assert.equal(tiny.unfilled, 1e-8);
  assert.equal(tiny.filled + tiny.unfilled, tiny.requested);
  assert.equal(book.snapshot().depth.asks, depthBefore);
});

test('ADV14: total book depth never goes negative under repeated drains', () => {
  const b = P.Orderbook({ mid: 30000, levels: 4, baseSize: 5 });
  for (let i = 0; i < 10; i++) b.marketOrder('buy', 50);
  const d = b.depth();
  assert.ok(d.asks >= 0 && d.bids >= 0);
  assert.ok(b.snapshot().asks.every(l => l.size > 0));
});

// ---------------------------------------------------------------
// Section 2: funding math validation and dampener units
// ---------------------------------------------------------------
test('ADV15: fundingRate rejects a nonpositive or nonfinite interval', () => {
  for (const intervalHours of [0, -8, NaN, Infinity]) {
    assert.throws(() => P.fundingRate({ markTwap: 30030, indexTwap: 30000, intervalHours }), RangeError);
  }
});

test('ADV16: fundingRate rejects a negative or nonfinite clamp band', () => {
  assert.throws(() => P.fundingRate({ markTwap: 30030, indexTwap: 30000, clampBps: -1 }), RangeError);
  assert.throws(() => P.fundingRate({ markTwap: 30030, indexTwap: 30000, clampBps: NaN }), RangeError);
});

test('ADV17: fundingRate rejects nonfinite weight, interest and dampener', () => {
  assert.throws(() => P.fundingRate({ markTwap: 30030, indexTwap: 30000, premiumWeight: NaN }), RangeError);
  assert.throws(() => P.fundingRate({ markTwap: 30030, indexTwap: 30000, interestRateBps: NaN }), RangeError);
  assert.throws(() => P.fundingRate({ markTwap: 30030, indexTwap: 30000, dampener: -0.01 }), RangeError);
});

test('ADV18: the impact dampener contributes at most five basis points', () => {
  const f = P.fundingRate({ markTwap: 30030, indexTwap: 30000, takerVolume: 1e6, openInterest: 1e6 });
  assert.equal(f.dampenerBps, 5);
  assert.ok(f.dampenerBps <= 5);
});

test('ADV19: the dampener scales linearly with the capped OI ratio', () => {
  const full = P.fundingRate({ markTwap: 30030, indexTwap: 30000, takerVolume: 1e6, openInterest: 1e6 });
  const half = P.fundingRate({ markTwap: 30030, indexTwap: 30000, takerVolume: 1e6, openInterest: 5e5 });
  const none = P.fundingRate({ markTwap: 30030, indexTwap: 30000, takerVolume: 1e6, openInterest: -5 });
  assert.equal(half.dampenerBps, full.dampenerBps / 2);
  assert.equal(none.dampenerBps, 0);
});

test('ADV20: funding clamps stay inside the band for extreme premiums', () => {
  for (const prem of [1e6, -1e6]) {
    const mark = 30000 * (1 + prem / 10000);
    if (mark <= 0) continue;
    const f = P.fundingRate({ markTwap: mark, indexTwap: 30000, clampBps: 50 });
    assert.ok(f.clampedBps <= 50 && f.clampedBps >= -50);
  }
  const f = P.fundingRate({ markTwap: 60000, indexTwap: 30000, clampBps: 50 });
  assert.equal(f.clampedBps, 50);
});

test('ADV21: an exactly at-cap raw rate is not flagged as clamped', () => {
  const atCap = P.fundingRate({ markTwap: 30150, indexTwap: 30000, interestRateBps: 0, clampBps: 50 });
  assert.equal(atCap.rawBps, 50);
  assert.equal(atCap.clampedBps, 50);
  assert.equal(atCap.wasClamped, false);
  const justOver = P.fundingRate({ markTwap: 30150.01, indexTwap: 30000, interestRateBps: 0, clampBps: 50 });
  assert.equal(justOver.wasClamped, true);
  assert.equal(justOver.clampedBps, 50);
});

test('ADV22: twap rejects a nonfinite sample price', () => {
  assert.throws(() => P.twap([{ price: NaN, weight: 1 }]), RangeError);
  assert.throws(() => P.twap([{ price: Infinity, weight: 1 }]), RangeError);
});

test('ADV23: premiumBps rejects a nonfinite mark', () => {
  assert.throws(() => P.premiumBps(NaN, 30000), RangeError);
  assert.throws(() => P.premiumBps(Infinity, 30000), RangeError);
  assert.throws(() => P.premiumBps(30000, NaN), RangeError);
});

test('ADV24: fundingPayment validates side and finiteness', () => {
  assert.throws(() => P.fundingPayment(100, 10, 'Short'), RangeError);
  assert.throws(() => P.fundingPayment(100, 10, 'both'), RangeError);
  assert.throws(() => P.fundingPayment(NaN, 10, 'long'), RangeError);
  assert.throws(() => P.fundingPayment(100, NaN, 'long'), RangeError);
});

test('ADV25: fundingArbitrage validates inputs and floors intervals', () => {
  assert.throws(() => P.fundingArbitrage({ notional: 0 }), RangeError);
  assert.throws(() => P.fundingArbitrage({ notional: -100 }), RangeError);
  assert.throws(() => P.fundingArbitrage({ intervals: 0 }), RangeError);
  const a = P.fundingArbitrage({ intervals: 3.9, rateBps: 10 });
  assert.equal(a.gross, 300);
});

// ---------------------------------------------------------------
// Section 3: position validation and exact liquidation thresholds
// ---------------------------------------------------------------
test('ADV26: position rejects a side that is not exactly long or short', () => {
  for (const side of ['Long', 'SHORT', 'flat', '', 0, null]) {
    assert.throws(() => P.position({ side }), RangeError, 'side ' + side);
  }
});

test('ADV27: position rejects an unknown margin mode', () => {
  assert.throws(() => P.position({ marginMode: 'portfolio' }), RangeError);
  assert.throws(() => P.position({ marginMode: 'CROSS' }), RangeError);
});

test('ADV28: position rejects nonpositive or nonfinite size and prices', () => {
  for (const size of [0, -1, NaN, Infinity]) {
    assert.throws(() => P.position({ size }), RangeError, 'size ' + size);
  }
  for (const entryPrice of [0, -100, NaN, Infinity]) {
    assert.throws(() => P.position({ entryPrice }), RangeError, 'entry ' + entryPrice);
  }
  for (const markPrice of [0, -100, NaN]) {
    assert.throws(() => P.position({ markPrice }), RangeError, 'mark ' + markPrice);
  }
});

test('ADV29: position rejects leverage below one and nonfinite leverage', () => {
  for (const leverage of [0, 0.5, -10, NaN, Infinity]) {
    assert.throws(() => P.position({ leverage }), RangeError, 'lev ' + leverage);
  }
});

test('ADV30: position rejects negative or nonfinite collateral', () => {
  for (const collateral of [-1, NaN, Infinity]) {
    assert.throws(() => P.position({ collateral }), RangeError, 'collateral ' + collateral);
  }
  assert.equal(P.position({ collateral: 0 }).collateral, 0);
});

test('ADV31: an unliquidatable long returns null, not NaN', () => {
  const liq = P.liquidationPrice(P.position({ side: 'long', collateral: 1e9, size: 1, entryPrice: 30000 }));
  assert.equal(liq, null);
});

test('ADV32: at the solved price equity equals maintenance margin for a long', () => {
  const base = { side: 'long', size: 1.5, entryPrice: 30000, collateral: 4000 };
  const liq = P.liquidationPrice(P.position(base));
  const atLiq = P.position(Object.assign({}, base, { markPrice: liq }));
  assert.ok(Math.abs(P.equity(atLiq) - P.maintenanceMargin(atLiq)) < 0.05, 'gap at ' + liq);
});

test('ADV33: at the solved price equity equals maintenance margin for a short', () => {
  const base = { side: 'short', size: 2, entryPrice: 30000, collateral: 5000 };
  const liq = P.liquidationPrice(P.position(base));
  const atLiq = P.position(Object.assign({}, base, { markPrice: liq }));
  assert.ok(Math.abs(P.equity(atLiq) - P.maintenanceMargin(atLiq)) < 0.05, 'gap at ' + liq);
});

test('ADV34: the liquidation threshold is inclusive and exact', () => {
  const base = { side: 'long', size: 1, entryPrice: 30000, collateral: 3000 };
  const liq = P.liquidationPrice(P.position(base));
  assert.equal(P.isLiquidatable(P.position(Object.assign({}, base, { markPrice: liq }))), true);
  assert.equal(P.isLiquidatable(P.position(Object.assign({}, base, { markPrice: liq + 1 }))), false);
});

test('ADV35: margin config rejects negative rates and bases', () => {
  const p = P.position({});
  assert.throws(() => P.maintenanceMargin(p, { maintenanceMarginRate: -0.01 }), RangeError);
  assert.throws(() => P.maintenanceMargin(p, { maintenanceMarginRate: NaN }), RangeError);
  assert.throws(() => P.maintenanceMargin(p, { maintenanceBase: -1 }), RangeError);
  assert.throws(() => P.liquidationPrice(p, { maintenanceMarginRate: -1 }), RangeError);
});

test('ADV36: maxLeverage and the penalty reject degenerate config', () => {
  assert.throws(() => P.maxLeverage({ initialMarginRate: 0 }), RangeError);
  assert.throws(() => P.maxLeverage({ initialMarginRate: -0.1 }), RangeError);
  assert.throws(() => P.liquidationPenalty(P.position({}), { liquidationFeeRate: -0.01 }), RangeError);
});

test('ADV37: a zero maintenance margin yields an infinite margin ratio', () => {
  const p = P.position({ size: 1, markPrice: 30000 });
  assert.equal(P.marginRatio(p, { maintenanceMarginRate: 0, maintenanceBase: 0 }), Infinity);
});

// ---------------------------------------------------------------
// Section 4: liquidation cascade hardening
// ---------------------------------------------------------------
test('ADV38: the cascade rejects a total or nonfinite price shock', () => {
  const positions = [P.position({})];
  for (const shockPct of [-100, -150, NaN, Infinity, -Infinity]) {
    assert.throws(() => P.liquidationCascade({ shockPct, positions }), RangeError, 'shock ' + shockPct);
  }
});

test('ADV39: the cascade rejects bad structural inputs', () => {
  assert.throws(() => P.liquidationCascade({ positions: 'nope' }), RangeError);
  assert.throws(() => P.liquidationCascade({ mid: 0 }), RangeError);
  assert.throws(() => P.liquidationCascade({ mmr: -0.1 }), RangeError);
  assert.throws(() => P.liquidationCascade({ liqFeeRate: -0.1 }), RangeError);
});

test('ADV40: a caller-supplied liquidated flag is ignored', () => {
  const flagged = P.position({ side: 'long', size: 2, entryPrice: 30000, collateral: 100, markPrice: 30000 });
  flagged.liquidated = true;
  const c = P.liquidationCascade({ mid: 30000, shockPct: -15, positions: [flagged] });
  assert.equal(c.liquidatedCount, 1);
  assert.equal(c.survivingCount, 0);
});

test('ADV41: an empty position set produces an empty event log', () => {
  const c = P.liquidationCascade({ positions: [] });
  assert.equal(c.events.length, 0);
  assert.equal(c.liquidatedCount, 0);
  assert.equal(c.survivingCount, 0);
});

test('ADV42: liquidated plus surviving always equals the position count', () => {
  const positions = [];
  for (let i = 0; i < 9; i++) {
    positions.push(P.position({ side: i % 3 === 0 ? 'short' : 'long', size: 1 + i, entryPrice: 30000, collateral: 3000 + i * 700, markPrice: 30000 }));
  }
  for (const shockPct of [-40, -10, 10, 40]) {
    const c = P.liquidationCascade({ mid: 30000, shockPct, positions });
    assert.equal(c.liquidatedCount + c.survivingCount, 9, 'shock ' + shockPct);
  }
});

test('ADV43: the rounds cap bounds how many liquidation rounds run', () => {
  const positions = [];
  for (let i = 0; i < 6; i++) {
    positions.push(P.position({ side: 'long', size: 2 + i, entryPrice: 30000, collateral: 600 + i * 200, markPrice: 30000 }));
  }
  const c = P.liquidationCascade({ mid: 30000, shockPct: -12, positions, rounds: 1 });
  assert.ok(c.rounds <= 1);
  assert.ok(c.events.every(e => e.round === 1));
});

test('ADV44: cascade penalties equal executed notional times the fee rate', () => {
  const positions = [P.position({ side: 'long', size: 2, entryPrice: 30000, collateral: 100, markPrice: 30000 })];
  const c = P.liquidationCascade({ mid: 30000, shockPct: -15, positions, liqFeeRate: 0.001 });
  for (const e of c.events) {
    assert.equal(e.penalty, P.round(e.filled * (e.fillPrice || e.markPrice) * 0.001, 4));
  }
});

test('ADV45: cascade inputs never alias into the caller position objects', () => {
  const src = [P.position({ side: 'long', size: 2, entryPrice: 30000, collateral: 100, markPrice: 30000 })];
  P.liquidationCascade({ mid: 30000, shockPct: -15, positions: src });
  assert.equal(src[0].liquidated, undefined);
  assert.equal(src[0].markPrice, 30000);
});

// ---------------------------------------------------------------
// Section 5: Monte Carlo and VaR bounds
// ---------------------------------------------------------------
test('ADV46: simulatePaths validates every numeric parameter', () => {
  assert.throws(() => P.simulatePaths({ s0: 0 }), RangeError);
  assert.throws(() => P.simulatePaths({ s0: -100 }), RangeError);
  assert.throws(() => P.simulatePaths({ s0: NaN }), RangeError);
  assert.throws(() => P.simulatePaths({ sigma: -0.1 }), RangeError);
  assert.throws(() => P.simulatePaths({ sigma: NaN }), RangeError);
  assert.throws(() => P.simulatePaths({ mu: NaN }), RangeError);
  assert.throws(() => P.simulatePaths({ lambda: -1 }), RangeError);
  assert.throws(() => P.simulatePaths({ jumpSigma: -0.1 }), RangeError);
  assert.throws(() => P.simulatePaths({ jumpMu: NaN }), RangeError);
  assert.throws(() => P.simulatePaths({ horizonDays: -1 }), RangeError);
  assert.throws(() => P.simulatePaths({ stepsPerDay: 0 }), RangeError);
  assert.throws(() => P.simulatePaths({ stepsPerDay: -4 }), RangeError);
  assert.throws(() => P.simulatePaths({ paths: 0 }), RangeError);
});

test('ADV47: simulatePaths floors fractional path counts', () => {
  const s = P.simulatePaths({ paths: 10.9, seed: 'floor' });
  assert.equal(s.terminal.length, 10);
});

test('ADV48: terminal prices stay positive even under extreme volatility', () => {
  const s = P.simulatePaths({ paths: 50, sigma: 8, horizonDays: 30, stepsPerDay: 24, seed: 'extreme' });
  assert.ok(s.terminal.every(v => v > 0));
  assert.ok(s.terminal.every(Number.isFinite));
});

test('ADV49: a zero-horizon simulation returns the start price exactly', () => {
  const s = P.simulatePaths({ paths: 20, horizonDays: 0, seed: 'zero' });
  assert.equal(s.steps, 0);
  assert.ok(s.terminal.every(v => v === 30000));
});

test('ADV50: parametricVaR validates horizon, sigma and notional', () => {
  assert.throws(() => P.parametricVaR({ horizonDays: 0 }), RangeError);
  assert.throws(() => P.parametricVaR({ horizonDays: -3 }), RangeError);
  assert.throws(() => P.parametricVaR({ sigma: -0.2 }), RangeError);
  assert.throws(() => P.parametricVaR({ notional: -1 }), RangeError);
});

test('ADV51: monteCarloVaR rejects a negative notional', () => {
  assert.throws(() => P.monteCarloVaR({ notional: -100 }), RangeError);
});

test('ADV52: varFromReturns validates the confidence interval', () => {
  const returns = [0.01, -0.02, 0.03, -0.01, 0.005];
  for (const c of [0, 1, 1.5, -0.2, NaN]) {
    assert.throws(() => P.varFromReturns(returns, c), RangeError, 'confidence ' + c);
  }
  const v = P.varFromReturns(returns);
  assert.equal(v.confidence, 0.99);
});

test('ADV53: percentile clamps an out-of-range quantile to the bounds', () => {
  assert.equal(P.percentile([1, 2, 3], 5), 3);
  assert.equal(P.percentile([1, 2, 3], -2), 1);
  assert.equal(P.percentile([1, 2, 3], NaN), 1);
  assert.equal(P.percentile([], 0.5), 0);
});

test('ADV54: monteCarloVaR notional terms agree with the percentages', () => {
  const mc = P.monteCarloVaR({ paths: 400, seed: 'agree', notional: 50000 });
  assert.equal(mc.varNotional, P.round(mc.varPct * 50000 / 100, 4));
  assert.equal(mc.cvarNotional, P.round(mc.cvarPct * 50000 / 100, 4));
});

test('ADV55: liquidationStress validates and its probabilities sum to one', () => {
  assert.throws(() => P.liquidationStress({ s0: 0 }), RangeError);
  assert.throws(() => P.liquidationStress({ side: 'flat' }), RangeError);
  const s = P.liquidationStress({ paths: 100, seed: 'sum' });
  assert.equal(P.round(s.breachProbability + s.survivalProbability, 6), 1);
});

test('ADV56: riskReport rejects a nonpositive mid', () => {
  assert.throws(() => P.riskReport({ mid: 0 }), RangeError);
  assert.throws(() => P.riskReport({ mid: -100 }), RangeError);
});

// ---------------------------------------------------------------
// Section 6: risk lab hardening
// ---------------------------------------------------------------
test('ADV57: bookVWAP validates side and depth', () => {
  const b = P.Orderbook({ mid: 30000 });
  assert.throws(() => A.bookVWAP(b, 'Buy', 10), RangeError);
  assert.throws(() => A.bookVWAP(b, 'buy', 0), RangeError);
  assert.throws(() => A.bookVWAP(b, 'buy', NaN), RangeError);
  assert.throws(() => A.bookVWAP(b, 'sell', -5), RangeError);
});

test('ADV58: kyleLambda validates its sweep parameters', () => {
  assert.throws(() => A.kyleLambda({ mid: 0 }), RangeError);
  assert.throws(() => A.kyleLambda({ steps: 0 }), RangeError);
  assert.throws(() => A.kyleLambda({ maxSize: 0 }), RangeError);
  assert.throws(() => A.kyleLambda({ maxSize: NaN }), RangeError);
});

test('ADV59: slippageCurve validates its size list', () => {
  assert.throws(() => A.slippageCurve({ mid: 0 }), RangeError);
  assert.throws(() => A.slippageCurve({ sizes: [] }), RangeError);
  assert.throws(() => A.slippageCurve({ sizes: 'x' }), RangeError);
  assert.throws(() => A.slippageCurve({ sizes: [1, 0] }), RangeError);
  assert.throws(() => A.slippageCurve({ sizes: [1, Infinity] }), RangeError);
});

test('ADV60: a negative or nonfinite fund is rejected outright', () => {
  assert.throws(() => A.insuranceWaterfall({ fund: -500 }), RangeError);
  assert.throws(() => A.insuranceWaterfall({ fund: NaN }), RangeError);
  assert.throws(() => A.insuranceWaterfall({ fund: Infinity }), RangeError);
  const w = A.insuranceWaterfall({ fund: 0 });
  assert.equal(w.fundBefore, 0);
  assert.equal(w.fundUsed, 0);
  assert.equal(w.reconciles, true);
});

test('ADV61: with no chargeable notional the remainder is fully uncovered', () => {
  const w = A.insuranceWaterfall({ fund: 0, profitableAccounts: [{ id: 'Z', notional: 0 }] });
  assert.equal(w.socialized.length, 0);
  assert.equal(w.uncovered, w.shortfall);
  assert.equal(w.reconciles, true);
});

test('ADV62: insuranceWaterfall validates prices, size, fee and accounts', () => {
  assert.throws(() => A.insuranceWaterfall({ bankruptcyPrice: 0 }), RangeError);
  assert.throws(() => A.insuranceWaterfall({ fillPrice: -1 }), RangeError);
  assert.throws(() => A.insuranceWaterfall({ size: 0 }), RangeError);
  assert.throws(() => A.insuranceWaterfall({ feeRate: -0.1 }), RangeError);
  assert.throws(() => A.insuranceWaterfall({ profitableAccounts: 'x' }), RangeError);
  assert.throws(() => A.insuranceWaterfall({ profitableAccounts: [{ id: 'A', notional: -5 }] }), RangeError);
});

test('ADV63: fundingLadder validates side, notional and floors intervals', () => {
  assert.throws(() => A.fundingLadder({ side: 'both' }), RangeError);
  assert.throws(() => A.fundingLadder({ notional: 0 }), RangeError);
  assert.throws(() => A.fundingLadder({ intervals: 0 }), RangeError);
  const l = A.fundingLadder({ intervals: 3.7 });
  assert.equal(l.rows.length, 3);
  assert.equal(l.intervals, 3);
});

test('ADV64: returnMoments rejects nonfinite or non-array returns', () => {
  assert.throws(() => A.returnMoments('x'), RangeError);
  assert.throws(() => A.returnMoments([0.01, NaN]), RangeError);
  assert.throws(() => A.returnMoments([0.01, Infinity]), RangeError);
});

test('ADV65: cornishFisherVaR validates confidence and notional', () => {
  const r = [0.01, -0.02, 0.03, -0.01, 0.005, 0.002];
  for (const c of [0, 1, -0.5, NaN]) {
    assert.throws(() => A.cornishFisherVaR(r, c), RangeError, 'confidence ' + c);
  }
  assert.throws(() => A.cornishFisherVaR(r, 0.99, -100), RangeError);
});

test('ADV66: a non-table confidence picks the nearest tabulated quantile', () => {
  const r = [0.01, -0.02, 0.03, -0.01, 0.005, 0.002, -0.005, 0.004];
  const cf = A.cornishFisherVaR(r, 0.97);
  assert.equal(cf.z, 1.96);
  const cf2 = A.cornishFisherVaR(r, 0.94);
  assert.equal(cf2.z, 1.6449);
});

test('ADV67: portfolioMargin rejects a non-array position list', () => {
  assert.throws(() => A.portfolioMargin({ positions: 'nope' }), RangeError);
});

test('ADV68: the verification bundle still passes every self check', () => {
  const b = A.verificationBundle({ paths: 500 });
  assert.equal(b.allChecksPass, true);
  for (const [k, v] of Object.entries(b.selfChecks)) assert.equal(v, true, k);
});

// ---------------------------------------------------------------
// Section 7: cross-module invariants
// ---------------------------------------------------------------
test('ADV69: quote and fill agree exactly across a dense size sweep', () => {
  for (let size = 1; size <= 100; size += 7) {
    const quote = P.Orderbook({ mid: 30000 }).quoteImpact('buy', size);
    const fill = P.Orderbook({ mid: 30000 }).marketOrder('buy', size);
    assert.equal(fill.avgPrice, quote.avgPrice, 'avg at ' + size);
    assert.equal(fill.impactBps, quote.impactBps, 'bps at ' + size);
    assert.equal(fill.filled, quote.filled, 'filled at ' + size);
  }
});

test('ADV70: fills sum exactly and the book loses exactly the filled depth', () => {
  const b = P.Orderbook({ mid: 30000 });
  const before = b.depth().asks;
  const r = b.marketOrder('buy', 33);
  assert.equal(P.round(r.fills.reduce((s, f) => s + f.size, 0), 6), r.filled);
  assert.equal(P.round(before - b.depth().asks, 6), r.filled);
});

test('ADV71: liquidation price responds monotonically to collateral', () => {
  let prev = Infinity;
  for (const collateral of [1000, 2000, 4000, 8000, 16000]) {
    const liq = P.liquidationPrice(P.position({ side: 'long', collateral }));
    if (liq === null) continue;
    assert.ok(liq < prev, 'not monotone at collateral ' + collateral);
    prev = liq;
  }
});

test('ADV72: funding raw and clamped agree when inside the band', () => {
  const f = P.fundingRate({ markTwap: 30010, indexTwap: 30000, interestRateBps: 1, clampBps: 50 });
  assert.equal(f.wasClamped, false);
  assert.equal(f.clampedBps, f.rawBps);
});

// ---------------------------------------------------------------
// Section 8: page hygiene
// ---------------------------------------------------------------
test('ADV73: index.html declares a content security policy', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/i);
  assert.match(html, /default-src 'self'/);
  assert.match(html, /connect-src 'none'/);
});

test('ADV74: no smooth scrolling anywhere in shipped css or markup', () => {
  for (const f of ['style.css', 'index.html']) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    assert.equal(/scroll-behavior/.test(text), false, f);
  }
});

test('ADV75: titles stand alone with no eyebrow, kicker or lede markup', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.equal(/class="eyebrow"/.test(html), false);
  assert.equal(/class="kicker"/.test(html), false);
  assert.equal(/class="lede"/.test(html), false);
});

test('ADV76: focus remains visible on interactive elements', () => {
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  assert.match(css, /:focus-visible/);
  assert.equal(/outline:\s*none/.test(css), false);
  assert.equal(/outline:\s*0(?!\d)/.test(css), false);
});

test('ADV77: the page registers no bare character-key shortcuts', () => {
  const js = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.equal(/addEventListener\('key(down|press|up)'/.test(js), false);
});

test('ADV78: every numeric input read is clamped through the helper', () => {
  const js = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  for (const id of ['casc-count', 'casc-lev', 'var-horizon', 'marg-price', 'clob-mid']) {
    assert.ok(js.indexOf('numIn(\'' + id + '\'') >= 0, id + ' must read through numIn');
  }
});

/* ------------------------------------------------------------------ *
 * Pass 2 regressions: findings reproduced by the hostile audit.        *
 * ------------------------------------------------------------------ */

test('P2-1: cross margin models the shared wallet, not a copy of isolated', () => {
  const pos = P.position({ side: 'short', collateral: 5000 });
  const solo = P.isolatedVsCross(pos);
  assert.equal(solo.isolated.liqPrice, solo.cross.liqPrice);
  const shared = P.isolatedVsCross(pos, undefined, 20000);
  assert.equal(shared.cross.collateralAtRisk, 25000);
  assert.ok(shared.cross.liqPrice > shared.isolated.liqPrice);
});

test('P2-2: cascade fills execute near the shocked mark, not the stale mid', () => {
  const c = P.liquidationCascade({
    mid: 30000, shockPct: -40,
    positions: [P.position({ side: 'long', size: 2, entryPrice: 30000, collateral: 50, markPrice: 30000 })]
  });
  assert.ok(c.events[0].markPrice <= 18500);
  assert.ok(c.events[0].fillPrice < 20000, 'fill ' + c.events[0].fillPrice + ' must track the shocked book');
});

test('P2-3: cascade reports unfilled residual and charges penalty on executed notional', () => {
  const positions = Array.from({ length: 10 }, () => P.position({ side: 'long', size: 200, entryPrice: 30000, collateral: 10, markPrice: 30000 }));
  const c = P.liquidationCascade({ mid: 30000, shockPct: -15, positions, rounds: 1 });
  const ev = c.events[0];
  assert.ok(ev.unfilled >= 0 && ev.filled + ev.unfilled >= ev.size - 1e-6);
  assert.ok(Math.abs(c.totalLiquidatedVolume - c.events.reduce((s, e) => s + e.filled, 0)) < 1e-3);
});

test('P2-4: balanced cascades drift by volume, and zero net is neutral', () => {
  const pos = [
    P.position({ side: 'long', size: 500, entryPrice: 30000, collateral: 10, markPrice: 30000 }),
    ...Array.from({ length: 9 }, () => P.position({ side: 'short', size: 0.001, entryPrice: 30000, collateral: 10, markPrice: 30000 }))
  ];
  const c = P.liquidationCascade({ mid: 30000, shockPct: -15, positions: pos, rounds: 2 });
  assert.ok(c.finalPrice <= c.shockedPrice + 0.01, 'dominant sell volume must not push price up');
});

test('P2-5: non-object cascade entries throw instead of becoming phantom longs', () => {
  for (const bad of [null, 42, 'x', [null]]) {
    assert.throws(() => P.liquidationCascade({ positions: Array.isArray(bad) ? bad : [bad] }), RangeError);
  }
});

test('P2-6/7/8: simulatePaths bounds every loop and never emits nonfinite prices', () => {
  assert.throws(() => P.simulatePaths({ paths: Infinity }), RangeError);
  assert.throws(() => P.simulatePaths({ paths: 0 }), RangeError);
  assert.throws(() => P.simulatePaths({ horizonDays: 1e308 }), RangeError);
  assert.throws(() => P.simulatePaths({ mu: 1e300 }), RangeError);
  assert.throws(() => P.simulatePaths({ sigma: 1e6 }), RangeError);
  const sim = P.simulatePaths({ paths: 50, mu: 50, sigma: 5, lambda: 0 });
  assert.ok(sim.terminal.every(Number.isFinite));
});

test('P2-9: fundingLadder and fundingArbitrage bound intervals', () => {
  assert.throws(() => A.fundingLadder({ intervals: Infinity }), RangeError);
  assert.throws(() => A.fundingLadder({ intervals: 1e9 + 1 }), RangeError);
  assert.throws(() => P.fundingArbitrage({ intervals: Infinity }), RangeError);
  assert.throws(() => P.fundingArbitrage({ rateBps: NaN }), RangeError);
});

test('P2-10: orderbook level count is capped', () => {
  assert.throws(() => P.Orderbook({ levels: 1e8, step: 1e-4, mid: 1e9 }), RangeError);
  assert.throws(() => P.Orderbook({ levels: 10001, mid: 30000 }), RangeError);
});

test('P2-11: parametricVaR validates confidence and returns the real quantile', () => {
  for (const bad of [NaN, 0, 1, -1, 2]) assert.throws(() => P.parametricVaR({ confidence: bad }), RangeError);
  const v95 = P.parametricVaR({ confidence: 0.95 });
  assert.ok(Math.abs(v95.z - 1.6449) < 0.001);
  const v50 = P.parametricVaR({ confidence: 0.5 });
  assert.ok(Math.abs(v50.z) < 0.001, 'median quantile is zero, not the 99 percent z');
});

test('P2-12: VaR readers reject nonfinite returns and empty input', () => {
  assert.throws(() => P.varFromReturns([0.01, NaN, 0.02]), RangeError);
  assert.throws(() => P.varFromReturns([]), RangeError);
  assert.throws(() => P.historicalVaR([Infinity, -0.02, 0.01]), RangeError);
  assert.throws(() => P.historicalVaR([0.01], NaN), RangeError);
  assert.throws(() => P.historicalVaR([0.01], 0), RangeError);
  assert.throws(() => P.historicalVaR('abc'), RangeError);
});

test('P2-13: fractional paths report and divide by the simulated count', () => {
  const s = P.liquidationStress({ paths: 10.9, leverage: 10, collateral: 100, horizonDays: 0 });
  assert.equal(s.paths, 10);
  assert.equal(P.round(s.breachProbability + s.survivalProbability, 6), 1);
  const m = P.monteCarloVaR({ paths: 10.9 });
  assert.equal(m.paths, m.terminal.length);
});

test('P2-14: position caps leverage and rejects non-object params', () => {
  assert.throws(() => P.position({ leverage: 11 }), RangeError);
  assert.throws(() => P.position({ leverage: 1e9 }), RangeError);
  assert.throws(() => P.position('x'), RangeError);
  assert.throws(() => P.position(42), RangeError);
  assert.throws(() => P.position(null), RangeError);
  assert.throws(() => P.position([1, 2]), RangeError);
});

test('P2-15: margin readers validate the position shape', () => {
  assert.throws(() => P.unrealizedPnl({}), RangeError);
  assert.throws(() => P.unrealizedPnl(undefined), RangeError);
  assert.throws(() => P.unrealizedPnl({ side: 'bogus', size: 1, entryPrice: 1, markPrice: 1, collateral: 0, leverage: 1 }), RangeError);
  assert.throws(() => P.equity(P.position(), NaN), RangeError);
  assert.throws(() => P.accountEquity([{}], 100), RangeError);
  assert.throws(() => P.accountEquity(null, 100), RangeError);
  assert.throws(() => P.notional('x'), RangeError);
  assert.throws(() => P.initialMargin(null), RangeError);
});

test('P2-16: notional overflow is rejected at construction', () => {
  assert.throws(() => P.position({ size: 1e200, markPrice: 1e200, entryPrice: 1e200, collateral: 1e200 }), RangeError);
});

test('P2-17: reported liquidation price still liquidates at the mark', () => {
  const p = P.position({ side: 'long', size: 1000, entryPrice: 48514, collateral: 0.7 });
  const liq = P.liquidationPrice(p, { maintenanceMarginRate: 0.001 });
  assert.ok(P.isLiquidatable(Object.assign({}, p, { markPrice: liq }), { maintenanceMarginRate: 0.001 }));
});

test('P2-19: twap rejects infinite weights and overflowing products', () => {
  assert.throws(() => P.twap([{ price: 100, weight: Infinity }]), RangeError);
  assert.throws(() => P.twap([{ price: 1e308, weight: 1e308 }]), RangeError);
});

test('P2-21/22/23/24: cascade validates shock, rounds, and book', () => {
  assert.throws(() => P.liquidationCascade({ mid: 1e308, shockPct: 1e308 }), RangeError);
  assert.throws(() => P.liquidationCascade({ rounds: NaN }), RangeError);
  assert.throws(() => P.liquidationCascade({ rounds: -5 }), RangeError);
  assert.throws(() => P.liquidationCascade({ book: {} }), RangeError);
});

test('P2-25: verificationBundle requires at least four finite paths', () => {
  assert.throws(() => A.verificationBundle({ paths: Infinity }), RangeError);
  assert.throws(() => A.verificationBundle({ paths: 2 }), RangeError);
});

test('P2-26/27: funding primitives reject degenerate inputs', () => {
  assert.throws(() => P.premiumBps(-100, 30000), RangeError);
  assert.throws(() => P.fundingRate({ markTwap: 1, indexTwap: Number.MIN_VALUE }), RangeError);
  assert.throws(() => P.fundingRate({ intervalHours: 5e-324 }), RangeError);
  assert.throws(() => P.fundingPayment(-100000, 10, 'long'), RangeError);
});

test('P2-28/29/30: book enforces tick, size resolution, and cancel validation', () => {
  const b = P.Orderbook({ mid: 30000, tick: 0.5 });
  assert.throws(() => b.addLimit('buy', 29000.13, 1), RangeError);
  assert.throws(() => b.addLimit('buy', 29000, 1e-5), RangeError);
  assert.throws(() => b.cancelLevel('buy', 'abc'), RangeError);
  assert.throws(() => b.cancelLevel('buy', NaN), RangeError);
});

test('P2-32: one-sided books hold the last two-sided mid', () => {
  const b = P.Orderbook({ mid: 30000, levels: 1, baseSize: 2 });
  b.marketOrder('buy', 2);
  const r2 = b.marketOrder('buy', 1);
  assert.ok(r2.newMid >= 29900, 'a buy must not report a mid below the pre-trade value');
});

test('P2-33: waterfall never charges an account a negative amount', () => {
  const w = A.insuranceWaterfall({
    fund: 0, bankruptcyPrice: 100.0005, fillPrice: 100, size: 1,
    profitableAccounts: [{ id: 'A', notional: 1e5 }, { id: 'B', notional: 1e5 }, { id: 'C', notional: 0 }]
  });
  assert.ok(w.socialized.every(s => s.charged >= 0));
});

test('P2-34: subnormal-scale returns degrade to zero moments, not NaN', () => {
  const tiny = [1e-160, -1e-160, 2e-160, -2e-160, 3e-160, -3e-160];
  const cf = A.cornishFisherVaR(tiny, 0.99);
  assert.ok(Number.isFinite(cf.zCornishFisher));
  assert.ok(Number.isFinite(cf.modifiedVarPct));
});

test('P2-35: kyleLambda skips zero and duplicate sweep sizes', () => {
  const k = A.kyleLambda({ maxSize: 0.001, steps: 12 });
  assert.ok(k.points.every(p => p.size > 0));
  const sizes = k.points.map(p => p.size);
  assert.equal(new Set(sizes).size, sizes.length);
});

test('P2-36/39: charts carry accessible names and copy has a fallback', () => {
  const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.ok(src.includes("aria-label"), 'svg charts must expose an accessible name');
  assert.ok(src.includes('fallbackCopy'), 'clipboard fallback must exist');
});

test('P2-37/38: clob input floor is sane and the chart reads the live book', () => {
  const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.ok(src.includes("numIn('clob-mid', 30000, 1, 1e9)"));
  assert.ok(src.includes('clobBook.snapshot()'));
});
