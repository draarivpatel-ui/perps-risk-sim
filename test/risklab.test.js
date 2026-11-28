'use strict';

/*
 * Risk laboratory test suite for Perps Risk Sim.
 * Covers the orderbook VWAP and Kyle lambda estimator, the quote-versus-fill
 * slippage curve (which also locks the core fix that measures impact against
 * the pre-trade mid), the insurance fund and ADL waterfall, cross-margin
 * portfolio netting, multi-interval funding, Cornish-Fisher VaR and the
 * reproducible verification bundle.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/perps.js');
const A = require('../src/risklab.js');

// ---------------------------------------------------------------
// Section 1: orderbook microstructure
// ---------------------------------------------------------------
test('RL1: bookVWAP prices the ask ladder at depth 30', () => {
  const v = A.bookVWAP(P.Orderbook({ mid: 30000 }), 'buy', 30);
  assert.equal(v.requested, 30);
  assert.equal(v.filled, 30);
  assert.ok(v.vwap > 30000 && v.vwap < 30010);
  assert.ok(v.notional > 30000 * 30);
});

test('RL2: bookVWAP caps at the available book depth', () => {
  const v = A.bookVWAP(P.Orderbook({ mid: 30000, levels: 4 }), 'buy', 100000);
  assert.ok(v.filled > 0 && v.filled < 100000);
  assert.ok(v.vwap !== null);
});

test('RL3: quoteImpact and marketOrder now agree on avg and bps for every size', () => {
  for (const size of [1, 5, 10, 20, 40, 80]) {
    const quote = P.Orderbook({ mid: 30000 }).quoteImpact('buy', size);
    const fill = P.Orderbook({ mid: 30000 }).marketOrder('buy', size);
    assert.equal(fill.avgPrice, quote.avgPrice, 'avg at size ' + size);
    assert.equal(fill.impactBps, quote.impactBps, 'bps at size ' + size);
  }
});

test('RL4: marketOrder impact uses the pre-trade mid, not the post-trade mid', () => {
  const fill = P.Orderbook({ mid: 30000 }).marketOrder('buy', 40);
  assert.equal(fill.avgPrice, 30006.3);
  assert.equal(fill.impactBps, 2.1);
  assert.ok(fill.newMid > fill.avgPrice - 5);
});

test('RL5: kyleLambda is positive and reports a fit quality', () => {
  const k = A.kyleLambda({ mid: 30000, steps: 10 });
  assert.ok(k.lambda > 0);
  assert.equal(k.points.length, 10);
  assert.ok(k.r2 >= 0 && k.r2 <= 1);
  assert.ok(k.lambdaBpsPerUnit > 0);
});

test('RL6: slippageCurve confirms every quote matched its fill', () => {
  const c = A.slippageCurve({ mid: 30000 });
  assert.equal(c.allQuotesMatch, true);
  assert.equal(c.rows.length, 6);
  for (const r of c.rows) assert.equal(r.quoteMatchesFill, true);
});

test('RL7: slippage in basis points is monotone non-decreasing in size', () => {
  const rows = A.slippageCurve({ mid: 30000 }).rows;
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].filledBps >= rows[i - 1].filledBps - 1e-6);
  }
});

test('RL8: kyleLambda and slippageCurve are deterministic', () => {
  assert.deepEqual(A.kyleLambda({ mid: 30000 }), A.kyleLambda({ mid: 30000 }));
  assert.deepEqual(A.slippageCurve(), A.slippageCurve());
});

// ---------------------------------------------------------------
// Section 2: insurance fund and auto-deleveraging
// ---------------------------------------------------------------
test('RL9: the waterfall reconciles shortfall = fund used + socialized + uncovered', () => {
  const w = A.insuranceWaterfall();
  assert.equal(w.reconciles, true);
  assert.equal(w.shortfall, w.fundUsed + w.covered - w.fundUsed + w.uncovered);
  assert.equal(w.shortfall, 3000);
  assert.equal(w.fundUsed, 3000);
  assert.equal(w.uncovered, 0);
});

test('RL10: with an empty fund the shortfall is fully socialized by notional weight', () => {
  const w = A.insuranceWaterfall({ fund: 0 });
  assert.equal(w.fundUsed, 0);
  assert.equal(w.remainder, 3000);
  assert.equal(w.reconciles, true);
  const total = w.socialized.reduce((s, a) => s + a.charged, 0);
  assert.equal(Math.abs(total - w.remainder) < 1e-6, true);
  assert.equal(w.socialized[0].charged, 1500);
  assert.equal(w.socialized[1].charged, 900);
  assert.equal(w.socialized[2].charged, 600);
  assert.equal(w.fundExhausted, true);
});

test('RL11: a fund larger than the shortfall leaves the remainder at zero', () => {
  const w = A.insuranceWaterfall({ fund: 100000 });
  assert.equal(w.fundUsed, 3000);
  assert.equal(w.remainder, 0);
  assert.equal(w.fundAfter, 97000);
  assert.equal(w.fundExhausted, false);
  for (const a of w.socialized) assert.equal(a.charged, 0);
});

test('RL12: no price shortfall means no fund use and no socialization', () => {
  const w = A.insuranceWaterfall({ fillPrice: 29500 });
  assert.equal(w.shortfall, 0);
  assert.equal(w.fundUsed, 0);
  assert.equal(w.uncovered, 0);
  assert.equal(w.reconciles, true);
});

test('RL13: the last account absorbs rounding so the allocation is exact', () => {
  const w = A.insuranceWaterfall({ fund: 0, profitableAccounts: [{ id: 'A', notional: 1 }, { id: 'B', notional: 1 }, { id: 'C', notional: 1 }] });
  const total = w.socialized.reduce((s, a) => s + a.charged, 0);
  assert.equal(total, w.remainder);
  assert.equal(w.reconciles, true);
});

// ---------------------------------------------------------------
// Section 3: cross-margin portfolio netting
// ---------------------------------------------------------------
test('RL14: portfolioMargin nets the long and short legs', () => {
  const m = A.portfolioMargin();
  assert.equal(m.legs, 2);
  assert.equal(m.grossNotional, 90000);
  assert.equal(m.netNotional, 30000);
  assert.equal(m.isolatedMargin, 9000);
  assert.equal(m.netMargin, 3000);
  assert.equal(m.hedgeBenefit, 6000);
});

test('RL15: net margin never exceeds isolated margin', () => {
  assert.equal(A.portfolioMargin().netMarginNeverExceedsIsolated, true);
  const opposing = A.portfolioMargin({ positions: [
    { side: 'short', size: 3, markPrice: 30000, leverage: 10, collateral: 9000 },
    { side: 'long', size: 1, markPrice: 30000, leverage: 10, collateral: 3000 }
  ] });
  assert.equal(opposing.netMarginNeverExceedsIsolated, true);
});

test('RL16: a perfectly matched book has zero net notional and zero net margin', () => {
  const m = A.portfolioMargin({ positions: [
    { side: 'long', size: 2, markPrice: 30000, leverage: 10, collateral: 6000 },
    { side: 'short', size: 2, markPrice: 30000, leverage: 10, collateral: 6000 }
  ] });
  assert.equal(m.netNotional, 0);
  assert.equal(m.netMargin, 0);
  assert.equal(m.hedgeBenefit, m.isolatedMargin);
});

test('RL17: portfolioMargin equity matches the core accountEquity', () => {
  const positions = [
    { side: 'long', size: 2, entryPrice: 30000, leverage: 10, collateral: 6000, marginMode: 'cross', markPrice: 30200 },
    { side: 'short', size: 1, entryPrice: 30000, leverage: 10, collateral: 3000, marginMode: 'cross', markPrice: 30200 }
  ];
  const m = A.portfolioMargin({ positions });
  const expected = P.accountEquity(positions.map(P.position), 9000).equity;
  assert.equal(m.equity, expected);
});

// ---------------------------------------------------------------
// Section 4: multi-interval funding
// ---------------------------------------------------------------
test('RL18: the funding ladder sums exactly to perInterval times intervals', () => {
  const l = A.fundingLadder({ intervals: 8 });
  assert.equal(l.cumulativeMatchesSum, true);
  assert.equal(l.rows.length, 8);
  assert.equal(l.cumulativePayment, l.rows[l.rows.length - 1].cumulative);
  assert.equal(l.cumulativePayment, P.round(l.perInterval * 8, 4));
});

test('RL19: longs pay a positive clamped rate and shorts receive it', () => {
  const long = A.fundingLadder({ side: 'long', intervals: 3 });
  const short = A.fundingLadder({ side: 'short', intervals: 3 });
  assert.ok(long.perInterval < 0);
  assert.ok(short.perInterval > 0);
  assert.equal(long.perInterval, -short.perInterval);
});

test('RL20: the clamp band caps an extreme premium', () => {
  const l = A.fundingLadder({ markTwap: 40000, indexTwap: 30000, clampBps: 50 });
  assert.equal(l.rate.wasClamped, true);
  assert.equal(l.rate.clampedBps, 50);
  assert.ok(Math.abs(l.perInterval) <= 100000 * 0.005 + 1e-6);
});

test('RL21: the hedge break-even is derived from fees and borrow cost', () => {
  const l = A.fundingLadder();
  assert.ok(l.hedgeBreakEvenBps > 0);
  assert.equal(typeof l.hedgeNet, 'number');
});

// ---------------------------------------------------------------
// Section 5: Cornish-Fisher VaR
// ---------------------------------------------------------------
test('RL22: returnMoments reports zero skew for a symmetric sample', () => {
  const r = [-3, -2, -1, 0, 1, 2, 3];
  const m = A.returnMoments(r);
  assert.equal(m.mean, 0);
  assert.ok(Math.abs(m.skew) < 1e-6);
  assert.ok(m.sd > 0);
});

test('RL23: returnMoments detects positive skew', () => {
  const m = A.returnMoments([-1, -1, -1, 0, 0, 0, 0, 0, 0, 8]);
  assert.ok(m.skew > 0);
});

test('RL24: cornishFisherVaR needs at least four returns', () => {
  assert.throws(() => A.cornishFisherVaR([0.01, 0.02], 0.99), RangeError);
});

test('RL25: CVaR is at least as large as VaR for a left-skewed sample', () => {
  const sim = P.simulatePaths({ paths: 800, horizonDays: 1, stepsPerDay: 24, seed: 'cf', lambda: 1.5, jumpMu: -0.1 });
  const returns = sim.terminal.map(s => (s - 30000) / 30000);
  const cf = A.cornishFisherVaR(returns, 0.99);
  assert.ok(cf.historicalCvarPct >= cf.historicalVarPct - 1e-6);
  assert.ok(cf.modifiedVarPct > 0);
});

test('RL26: for a symmetric sample the CF quantile stays near the normal z', () => {
  const r = [-0.04, -0.03, -0.02, -0.01, 0, 0.01, 0.02, 0.03, 0.04];
  const cf = A.cornishFisherVaR(r, 0.99);
  assert.ok(Math.abs(cf.zCornishFisher - cf.z) < 0.35);
});

test('RL27: cornishFisherVaR is deterministic for the same returns', () => {
  const r = [-0.05, -0.02, -0.01, 0, 0.01, 0.02, 0.03, 0.06];
  assert.deepEqual(A.cornishFisherVaR(r, 0.99), A.cornishFisherVaR(r, 0.99));
});

// ---------------------------------------------------------------
// Section 6: verification bundle
// ---------------------------------------------------------------
test('RL28: every self check in the verification bundle is true', () => {
  const b = A.verificationBundle({ paths: 600 });
  for (const [k, v] of Object.entries(b.selfChecks)) assert.equal(v, true, k);
  assert.equal(b.allChecksPass, true);
});

test('RL29: the verification bundle is deterministic byte for byte in JSON', () => {
  assert.equal(JSON.stringify(A.verificationBundle({ paths: 300 })),
    JSON.stringify(A.verificationBundle({ paths: 300 })));
});

test('RL30: the bundle declares its schema, seed and source module', () => {
  const b = A.verificationBundle({ seed: 'lab', paths: 300 });
  assert.equal(b.schema, 'perps-risk-sim/verification-v2');
  assert.equal(b.seed, 'lab');
  assert.equal(b.generatedBy, 'src/risklab.js');
  assert.equal(b.paths, 300);
});

test('RL31: the bundle carries the six model sections', () => {
  const b = A.verificationBundle({ paths: 300 });
  assert.ok(b.orderbook.slippage.length >= 6);
  assert.ok(Array.isArray(b.waterfall.socialized));
  assert.equal(typeof b.margin.hedgeBenefit, 'number');
  assert.equal(typeof b.funding.cumulativePayment, 'number');
  assert.equal(typeof b.var.modifiedPct, 'number');
  assert.equal(typeof b.var.monteCarloVarPct, 'number');
});

test('RL32: the regression fix is locked by an independent direct assertion', () => {
  const book = P.Orderbook({ mid: 30000 });
  const quote = book.quoteImpact('buy', 25);
  const fill = P.Orderbook({ mid: 30000 }).marketOrder('buy', 25);
  assert.equal(fill.impactBps, quote.impactBps);
  assert.equal(fill.slippage, quote.slippage);
});

test('RL33: monteCarloDeterministic reruns the seeded simulation and compares numeric outputs', () => {
  const original = P.monteCarloVaR;
  let calls = 0;
  P.monteCarloVaR = function (params) {
    calls += 1;
    const out = original(params);
    out.varPct += calls;
    out.cvarPct += calls;
    return out;
  };
  try {
    const b = A.verificationBundle({ paths: 8, seed: 'determinism-probe' });
    assert.equal(calls, 2);
    assert.equal(b.selfChecks.monteCarloDeterministic, false);
  } finally {
    P.monteCarloVaR = original;
  }
});
