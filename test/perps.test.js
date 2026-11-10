'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/perps.js');

// ---------------------------------------------------------------
// Section 1: RNG and utilities (tests 1-7)
// ---------------------------------------------------------------
test('1: RNG is deterministic for the same seed', () => {
  const a = P.RNG('seed'), b = P.RNG('seed');
  const xa = Array.from({ length: 8 }, () => a.next());
  const xb = Array.from({ length: 8 }, () => b.next());
  assert.deepEqual(xa, xb);
});

test('2: RNG produces different streams for different seeds', () => {
  const a = P.RNG('one'), b = P.RNG('two');
  assert.notEqual(a.next(), b.next());
});

test('3: RNG uniform values stay inside [0,1)', () => {
  const r = P.RNG('uniform');
  for (let i = 0; i < 5000; i++) { const v = r.next(); assert.ok(v >= 0 && v < 1); }
});

test('4: RNG normal has approximately zero mean and unit variance', () => {
  const r = P.RNG('normal');
  const xs = Array.from({ length: 20000 }, () => r.normal());
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length;
  assert.ok(Math.abs(mean) < 0.05);
  assert.ok(Math.abs(variance - 1) < 0.08);
});

test('5: clamp bounds a value', () => {
  assert.equal(P.clamp(5, 0, 3), 3);
  assert.equal(P.clamp(-5, 0, 3), 0);
  assert.equal(P.clamp(2, 0, 3), 2);
});

test('6: round honors decimal places', () => {
  assert.equal(P.round(1.234567, 3), 1.235);
  assert.equal(P.round(1.234567, 0), 1);
});

test('7: hashSeed returns four nonzero 32-bit words', () => {
  const s = P.hashSeed('x');
  assert.equal(s.length, 4);
  assert.ok(s.every(v => Number.isInteger(v) && v > 0));
});

// ---------------------------------------------------------------
// Section 2: CLOB depth and impact (tests 8-22)
// ---------------------------------------------------------------
test('8: a fresh orderbook has symmetric depth and a positive spread', () => {
  const b = P.Orderbook({ mid: 30000 });
  const d = b.depth();
  assert.equal(d.bids, d.asks);
  assert.ok(b.spread() > 0);
  assert.equal(b.bestBid() < b.bestAsk(), true);
});

test('9: mid price is the midpoint of the best bid and ask', () => {
  const b = P.Orderbook({ mid: 30000 });
  assert.equal(b.midPrice(), (b.bestBid() + b.bestAsk()) / 2);
});

test('10: market buy consumes ask levels and lifts the average price', () => {
  const b = P.Orderbook({ mid: 30000 });
  const r = b.marketOrder('buy', 20);
  assert.equal(r.filled, 20);
  assert.ok(r.avgPrice > b.midPrice() - 10);
  assert.ok(r.impactBps >= 0);
  assert.ok(r.levelsHit >= 1);
});

test('11: market sell consumes bid levels', () => {
  const b = P.Orderbook({ mid: 30000 });
  const r = b.marketOrder('sell', 20);
  assert.equal(r.filled, 20);
  assert.ok(r.avgPrice < b.midPrice() + 10);
});

test('12: a large order walks multiple levels and has higher impact', () => {
  const b = P.Orderbook({ mid: 30000 });
  const small = b.quoteImpact('buy', 2);
  const large = b.quoteImpact('buy', 80);
  assert.ok(large.levelsHit >= small.levelsHit);
  assert.ok(large.impactBps >= small.impactBps);
});

test('13: quoteImpact does not mutate the book', () => {
  const b = P.Orderbook({ mid: 30000 });
  const before = JSON.stringify(b.snapshot());
  b.quoteImpact('buy', 50);
  assert.equal(JSON.stringify(b.snapshot()), before);
});

test('14: marketOrder mutates the book depth', () => {
  const b = P.Orderbook({ mid: 30000 });
  const before = b.depth().asks;
  b.marketOrder('buy', 10);
  assert.ok(b.depth().asks < before);
});

test('15: an oversized order reports unfilled quantity', () => {
  const b = P.Orderbook({ mid: 30000, levels: 2, baseSize: 3 });
  const r = b.marketOrder('buy', 1000);
  assert.ok(r.unfilled > 0);
  assert.ok(r.filled < 1000);
});

test('16: addLimit creates or grows a level at the given price', () => {
  const b = P.Orderbook({ mid: 30000 });
  b.addLimit('buy', 29000, 5);
  const snap = b.snapshot();
  const lvl = snap.bids.find(l => l.price === 29000);
  assert.ok(lvl && lvl.size >= 5);
  b.addLimit('buy', 29000, 3);
  assert.equal(b.snapshot().bids.find(l => l.price === 29000).size, lvl.size + 3);
});

test('17: cancelLevel removes a resting level', () => {
  const b = P.Orderbook({ mid: 30000 });
  b.addLimit('sell', 31000, 4);
  assert.ok(b.snapshot().asks.some(l => l.price === 31000));
  b.cancelLevel('sell', 31000);
  assert.equal(b.snapshot().asks.some(l => l.price === 31000), false);
});

test('18: asks are sorted ascending and bids descending', () => {
  const b = P.Orderbook({ mid: 30000 });
  b.addLimit('buy', 29900, 2);
  b.addLimit('sell', 30100, 2);
  const s = b.snapshot();
  for (let i = 1; i < s.asks.length; i++) assert.ok(s.asks[i].price >= s.asks[i - 1].price);
  for (let i = 1; i < s.bids.length; i++) assert.ok(s.bids[i].price <= s.bids[i - 1].price);
});

test('19: depthWithinBps returns bid/ask/imbalance', () => {
  const d = P.Orderbook({ mid: 30000 }).depthWithinBps(10);
  assert.ok(d.bid >= 0 && d.ask >= 0);
  assert.equal(d.imbalance, P.round(d.bid - d.ask, 4));
});

test('20: invalid market order size throws', () => {
  const b = P.Orderbook({ mid: 30000 });
  assert.throws(() => b.marketOrder('buy', 0), RangeError);
  assert.throws(() => b.marketOrder('buy', -5), RangeError);
});

test('21: invalid limit order size throws', () => {
  const b = P.Orderbook({ mid: 30000 });
  assert.throws(() => b.addLimit('buy', 29000, 0), RangeError);
});

test('22: fills array sums to the filled quantity', () => {
  const b = P.Orderbook({ mid: 30000 });
  const r = b.marketOrder('buy', 30);
  const sum = r.fills.reduce((s, f) => s + f.size, 0);
  assert.equal(P.round(sum, 6), r.filled);
});

// ---------------------------------------------------------------
// Section 3: funding rate TWAP and clamp (tests 23-34)
// ---------------------------------------------------------------
test('23: twap computes a weighted average', () => {
  assert.equal(P.twap([{ price: 100, minutes: 10 }, { price: 110, minutes: 30 }]), 107.5);
});

test('24: twap defaults to equal weights', () => {
  assert.equal(P.twap([{ price: 10 }, { price: 20 }]), 15);
});

test('25: twap rejects empty input and nonpositive weights', () => {
  assert.throws(() => P.twap([]), RangeError);
  assert.throws(() => P.twap([{ price: 1, weight: 0 }]), RangeError);
});

test('26: premiumBps is positive when mark trades above index', () => {
  assert.equal(P.premiumBps(30030, 30000), 10);
  assert.equal(P.premiumBps(29970, 30000), -10);
});

test('27: fundingRate combines premium and interest', () => {
  const f = P.fundingRate({ markTwap: 30030, indexTwap: 30000, interestRateBps: 1 });
  assert.equal(f.premiumBps, 10);
  assert.equal(f.rawBps, 11);
  assert.equal(f.rate, 0.0011);
});

test('28: fundingRate clamps at the configured cap', () => {
  const f = P.fundingRate({ markTwap: 33000, indexTwap: 30000, clampBps: 50 });
  assert.equal(f.wasClamped, true);
  assert.equal(f.clampedBps, 50);
  assert.ok(f.rawBps > 50);
});

test('29: fundingRate clamps negative premium symmetrically', () => {
  const f = P.fundingRate({ markTwap: 27000, indexTwap: 30000, interestRateBps: 0, clampBps: 50 });
  assert.equal(f.wasClamped, true);
  assert.equal(f.clampedBps, -50);
});

test('30: fundingRate rejects nonpositive prices', () => {
  assert.throws(() => P.fundingRate({ mark: 0, index: 30000 }), RangeError);
});

test('31: annualizedPct scales with the funding interval', () => {
  const a = P.fundingRate({ markTwap: 30030, indexTwap: 30000, intervalHours: 8 }).annualizedPct;
  const b = P.fundingRate({ markTwap: 30030, indexTwap: 30000, intervalHours: 1 }).annualizedPct;
  assert.equal(b / a, 8);
});

test('32: fundingTWAP uses time-weighted mark and index', () => {
  const f = P.fundingTWAP([{ price: 30020, minutes: 10 }, { price: 30040, minutes: 30 }], [{ price: 30000, weight: 1 }]);
  assert.equal(f.markTwap, 30035);
  assert.equal(f.indexTwap, 30000);
  assert.ok(f.premiumBps > 0);
});

test('33: longs pay positive funding and shorts receive it', () => {
  const long = P.fundingPayment(100000, 10, 'long');
  const short = P.fundingPayment(100000, 10, 'short');
  assert.equal(long, -100);
  assert.equal(short, 100);
  assert.equal(long, -short);
});

test('34: fundingArbitrage computes net carry and break-even', () => {
  const a = P.fundingArbitrage({ notional: 100000, rateBps: 10, intervals: 3, spotFeeBps: 5, perpFeeBps: 4, borrowBpsPerInterval: 2 });
  assert.equal(a.gross, 300);
  assert.equal(a.entryFees, 90);
  assert.equal(a.borrow, 60);
  assert.equal(a.net, 150);
  assert.equal(a.profitable, true);
});

test('35: a zero funding rate is unprofitable after fees', () => {
  const a = P.fundingArbitrage({ rateBps: 0 });
  assert.equal(a.profitable, false);
});

// ---------------------------------------------------------------
// Section 4: margin and liquidation pricing (tests 36-50)
// ---------------------------------------------------------------
test('36: notional is size times mark price', () => {
  assert.equal(P.notional(P.position({ size: 2, markPrice: 30000 })), 60000);
});

test('37: initialMargin reflects leverage', () => {
  const p = P.position({ size: 1, markPrice: 30000, leverage: 10 });
  assert.equal(P.initialMargin(p), 3000);
  assert.equal(P.maxLeverage(), 10);
});

test('38: unrealizedPnl is signed by direction', () => {
  const up = P.position({ side: 'long', size: 1, entryPrice: 30000, markPrice: 31000 });
  const downShort = P.position({ side: 'short', size: 1, entryPrice: 30000, markPrice: 31000 });
  assert.equal(P.unrealizedPnl(up), 1000);
  assert.equal(P.unrealizedPnl(downShort), -1000);
});

test('39: equity is collateral plus unrealized pnl', () => {
  const p = P.position({ side: 'long', size: 1, entryPrice: 30000, markPrice: 30500, collateral: 3000 });
  assert.equal(P.equity(p), 3500);
});

test('40: maintenanceMargin uses the configured rate', () => {
  const p = P.position({ size: 1, markPrice: 30000 });
  assert.equal(P.maintenanceMargin(p), 150);
  assert.equal(P.maintenanceMargin(p, { maintenanceMarginRate: 0.01 }), 300);
});

test('41: liquidation price is below entry for a long and above for a short', () => {
  const long = P.liquidationPrice(P.position({ side: 'long', entryPrice: 30000, collateral: 3000 }));
  const short = P.liquidationPrice(P.position({ side: 'short', entryPrice: 30000, collateral: 3000 }));
  assert.ok(long > 0 && long < 30000);
  assert.ok(short > 30000);
});

test('42: at the liquidation price equity equals maintenance margin', () => {
  const base = { side: 'long', size: 1, entryPrice: 30000, collateral: 3000 };
  const liq = P.liquidationPrice(P.position(base));
  const atLiq = P.position(Object.assign({}, base, { markPrice: liq }));
  assert.ok(Math.abs(P.equity(atLiq) - P.maintenanceMargin(atLiq)) < 1);
});

test('43: a price beyond the liquidation price is liquidatable', () => {
  const p = P.position({ side: 'long', entryPrice: 30000, markPrice: 26000, collateral: 3000 });
  assert.equal(P.isLiquidatable(p), true);
});

test('44: a healthy position is not liquidatable', () => {
  const p = P.position({ side: 'long', entryPrice: 30000, markPrice: 30000, collateral: 3000 });
  assert.equal(P.isLiquidatable(p), false);
});

test('45: more collateral pushes the liquidation price further away', () => {
  const a = P.liquidationPrice(P.position({ collateral: 3000 }));
  const b = P.liquidationPrice(P.position({ collateral: 6000 }));
  assert.ok(b < a);
});

test('46: higher leverage pushes the liquidation price closer to entry', () => {
  const lowLev = P.liquidationPrice(P.position({ leverage: 2, collateral: 15000 }));
  const highLev = P.liquidationPrice(P.position({ leverage: 20, collateral: 1500 }));
  assert.ok(highLev > lowLev || lowLev === null);
});

test('47: marginRatio falls as the mark price drops', () => {
  const healthy = P.marginRatio(P.position({ markPrice: 30000 }));
  const stressed = P.marginRatio(P.position({ markPrice: 28000 }));
  assert.ok(stressed < healthy);
});

test('48: liquidationPenalty scales with notional', () => {
  const p = P.position({ size: 2, markPrice: 30000 });
  assert.equal(P.liquidationPenalty(p), 30);
});

test('49: isolatedVsCross reports both modes', () => {
  const r = P.isolatedVsCross(P.position({}));
  assert.equal(r.isolated.mode, 'isolated');
  assert.equal(r.cross.mode, 'cross');
  assert.ok(r.note.length > 20);
});

test('50: accountEquity aggregates pnl across positions', () => {
  const positions = [
    P.position({ side: 'long', size: 1, entryPrice: 30000, markPrice: 31000 }),
    P.position({ side: 'short', size: 1, entryPrice: 30000, markPrice: 31000 })
  ];
  const e = P.accountEquity(positions, 10000);
  assert.equal(e.unrealizedPnl, 0);
  assert.equal(e.equity, 10000);
  assert.equal(e.totalNotional, 62000);
});

// ---------------------------------------------------------------
// Section 5: liquidation cascade (tests 51-56)
// ---------------------------------------------------------------
function makePositions(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(P.position({ side: 'long', size: 2 + i, entryPrice: 30000, leverage: 10, collateral: 600 + i * 200, markPrice: 30000 }));
  return out;
}

test('51: a mild shock leaves well collateralized positions untouched', () => {
  const safe = [];
  for (let i = 0; i < 5; i++) {
    safe.push(P.position({ side: 'long', size: 2 + i, entryPrice: 30000, leverage: 2, collateral: 30000 + i * 1000, markPrice: 30000 }));
  }
  const c = P.liquidationCascade({ mid: 30000, shockPct: -1, positions: safe });
  assert.equal(c.liquidatedCount, 0);
  assert.equal(c.events.length, 0);
});

test('52: a severe shock liquidates leveraged longs', () => {
  const c = P.liquidationCascade({ mid: 30000, shockPct: -10, positions: makePositions(5) });
  assert.ok(c.liquidatedCount > 0);
  assert.ok(c.totalPenalty > 0);
});

test('53: cascade events carry mark, fill and impact', () => {
  const c = P.liquidationCascade({ mid: 30000, shockPct: -12, positions: makePositions(3) });
  for (const e of c.events) {
    assert.ok(e.markPrice > 0);
    assert.ok(typeof e.impactBps === 'number');
    assert.ok(e.penalty >= 0);
  }
});

test('54: cascade final price can move beyond the initial shock', () => {
  const c = P.liquidationCascade({ mid: 30000, shockPct: -9, positions: makePositions(8), rounds: 6 });
  assert.ok(c.finalPrice <= c.shockedPrice + 1);
});

test('55: cascade is deterministic for the same seed', () => {
  const opts = { mid: 30000, shockPct: -11, positions: makePositions(6), seed: 'fixed' };
  const a = P.liquidationCascade(opts);
  const b = P.liquidationCascade(opts);
  assert.equal(a.liquidatedCount, b.liquidatedCount);
  assert.equal(a.finalPrice, b.finalPrice);
});

test('56: survivingCount plus liquidatedCount equals the input', () => {
  const c = P.liquidationCascade({ mid: 30000, shockPct: -8, positions: makePositions(7) });
  assert.equal(c.survivingCount + c.liquidatedCount, 7);
});

// ---------------------------------------------------------------
// Section 6: Monte Carlo, GBM, jumps and VaR (tests 57-70)
// ---------------------------------------------------------------
test('57: simulatePaths returns the requested number of terminal prices', () => {
  const s = P.simulatePaths({ paths: 50, seed: 'x' });
  assert.equal(s.terminal.length, 50);
  assert.equal(s.pathData.length, 50);
});

test('58: simulatePaths is deterministic for the same seed', () => {
  const a = P.simulatePaths({ paths: 30, seed: 'same' }).terminal;
  const b = P.simulatePaths({ paths: 30, seed: 'same' }).terminal;
  assert.deepEqual(a, b);
});

test('59: terminal prices are positive', () => {
  assert.ok(P.simulatePaths({ paths: 200, seed: 'pos' }).terminal.every(v => v > 0));
});

test('60: path minimum never exceeds the path maximum', () => {
  assert.ok(P.simulatePaths({ paths: 100, seed: 'bounds' }).pathData.every(p => p.min <= p.max && p.min <= p.terminal && p.max >= p.terminal));
});

test('61: with zero volatility and no drift price stays at s0', () => {
  const s = P.simulatePaths({ paths: 5, sigma: 0, mu: 0, lambda: 0, seed: 'flat' });
  assert.ok(s.terminal.every(v => Math.abs(v - 30000) < 1e-6));
});

test('62: higher volatility widens the terminal price distribution', () => {
  const low = P.simulatePaths({ paths: 400, sigma: 0.2, lambda: 0, seed: 'v' }).terminal;
  const high = P.simulatePaths({ paths: 400, sigma: 0.9, lambda: 0, seed: 'v' }).terminal;
  const range = arr => Math.max(...arr) - Math.min(...arr);
  assert.ok(range(high) > range(low));
});

test('63: jump diffusion produces fatter left tails than pure GBM', () => {
  const noJump = P.monteCarloVaR({ paths: 4000, includeJump: false, horizonDays: 1, seed: 'j', lambda: 0 });
  const withJump = P.monteCarloVaR({ paths: 4000, includeJump: true, horizonDays: 1, seed: 'j', lambda: 2, jumpMu: -0.05, jumpSigma: 0.05 });
  // Downward jumps deepen the extreme tail; CVaR and the worst terminal
  // price are robust tail statistics that must move in the adverse direction.
  assert.ok(withJump.cvarPct >= noJump.cvarPct);
  assert.ok(withJump.minTerminal <= noJump.minTerminal);
});

test('64: percentile interpolates between ordered values', () => {
  assert.equal(P.percentile([0, 10, 20, 30, 40], 0.5), 20);
  assert.equal(P.percentile([0, 10], 0.25), 2.5);
});

test('65: varFromReturns reports VaR and CVaR', () => {
  const r = Array.from({ length: 1000 }, (_, i) => (i - 500) / 1000);
  const v = P.varFromReturns(r, 0.95);
  assert.ok(v.varReturn < 0);
  assert.ok(v.cvarReturn <= v.varReturn);
});

test('66: parametricVaR grows with confidence and volatility', () => {
  const a = P.parametricVaR({ confidence: 0.95, sigma: 0.4 });
  const b = P.parametricVaR({ confidence: 0.99, sigma: 0.8 });
  assert.ok(b.varAbs > a.varAbs);
});

test('67: parametricVaR is deterministic and positive', () => {
  const a = P.parametricVaR({ notional: 100000 });
  assert.deepEqual(a, P.parametricVaR({ notional: 100000 }));
  assert.ok(a.varAbs > 0 && a.varPct > 0);
});

test('68: monteCarloVaR is deterministic and reports tail statistics', () => {
  const a = P.monteCarloVaR({ paths: 300, seed: 'var' });
  const b = P.monteCarloVaR({ paths: 300, seed: 'var' });
  assert.equal(a.varPct, b.varPct);
  assert.ok(a.cvarPct >= a.varPct);
  assert.ok(a.minTerminal <= a.p05Terminal);
  assert.ok(a.p05Terminal <= a.medianTerminal);
  assert.ok(a.medianTerminal <= a.p95Terminal);
});

test('69: Monte Carlo VaR is broadly consistent with parametric VaR at a matched horizon', () => {
  // Match the Monte Carlo horizon and the parametric horizon explicitly.
  const mc = P.monteCarloVaR({ paths: 6000, includeJump: false, horizonDays: 1, stepsPerDay: 24, confidence: 0.99, seed: 'cmp' });
  const pa = P.parametricVaR({ notional: 100000, sigma: 0.6, horizonDays: 1, confidence: 0.99 });
  // Both are 1-day 99% loss estimates; allow a generous Monte Carlo band.
  assert.ok(mc.varPct > pa.varPct * 0.6 && mc.varPct < pa.varPct * 1.6);
});

test('70: historicalVaR rejects empty input', () => {
  assert.throws(() => P.historicalVaR([], 0.99), RangeError);
});

test('71: liquidationStress reports a probability in [0,1]', () => {
  const s = P.liquidationStress({ paths: 200, seed: 'stress' });
  assert.ok(s.breachProbability >= 0 && s.breachProbability <= 1);
  assert.equal(P.round(s.breachProbability + s.survivalProbability, 6), 1);
});

test('72: lower leverage reduces breach probability', () => {
  const high = P.liquidationStress({ paths: 400, leverage: 20, collateral: 1500, seed: 'lev' });
  const low = P.liquidationStress({ paths: 400, leverage: 2, collateral: 15000, seed: 'lev' });
  assert.ok(low.breachProbability <= high.breachProbability);
});

test('73: liquidationStress is deterministic', () => {
  const a = P.liquidationStress({ paths: 100, seed: 'd' });
  const b = P.liquidationStress({ paths: 100, seed: 'd' });
  assert.equal(a.breachProbability, b.breachProbability);
});

// ---------------------------------------------------------------
// Section 7: risk report (tests 74-76)
// ---------------------------------------------------------------
test('74: riskReport includes book, impact, funding, position and VaR', () => {
  const r = P.riskReport();
  assert.ok(r.book && r.impact && r.funding && r.position && r.var99);
  assert.ok(r.maxLeverage > 0);
});

test('75: riskReport is deterministic', () => {
  assert.deepEqual(P.riskReport({ mid: 30000 }), P.riskReport({ mid: 30000 }));
});

test('76: riskReport position liquidation price is finite', () => {
  const r = P.riskReport({ mid: 42000 });
  assert.ok(Number.isFinite(r.position.liquidationPrice));
  assert.ok(r.position.liquidationPrice < 42000);
});
