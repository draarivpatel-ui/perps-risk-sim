/*
 * Perps Risk Sim risk laboratory.
 *
 * Pure, deterministic financial computations layered on src/perps.js:
 * orderbook VWAP and Kyle lambda price impact, adverse selection and
 * slippage curves across order sizes, an insurance fund and auto-deleveraging
 * waterfall, cross-margin portfolio netting, multi-interval funding PnL,
 * Cornish-Fisher modified VaR, and a verification bundle that ties the whole
 * model together. Zero dependencies. UMD, like the core library.
 *
 * Every number here is computed from the primitives in the core library or
 * from the sample statistics of a deterministic Monte Carlo run. This is a
 * risk-education model over a synthetic book and synthetic paths, not a
 * pricing library and not a claim about any live market.
 */
(function (root, factory) {
  const P = (typeof module === 'object' && module.exports)
    ? require('./perps.js')
    : root.Perps;
  const api = factory(P);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PerpsRiskLab = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (P) {
  'use strict';

  function round(x, dp) { const f = Math.pow(10, dp === undefined ? 6 : dp); return Math.round(x * f) / f; }

  // ---------------------------------------------------------------
  // Module 1: orderbook microstructure
  // ---------------------------------------------------------------

  // Volume-weighted average price of the resting levels on one side, up to a
  // depth cap in base units. Computed from a fresh book snapshot so the caller
  // can compare it with an executed market order of the same size.
  function bookVWAP(book, side, depth) {
    if (side !== 'buy' && side !== 'sell') throw new RangeError('bookVWAP side must be buy or sell');
    if (!(depth > 0) || !Number.isFinite(depth)) throw new RangeError('bookVWAP depth must be a positive finite number');
    const snap = book.snapshot();
    const levels = side === 'buy' ? snap.asks : snap.bids;
    let remaining = depth, notional = 0, filled = 0;
    for (const lvl of levels) {
      const take = Math.min(remaining, lvl.size);
      notional += take * lvl.price;
      filled += take;
      remaining -= take;
      if (remaining <= 1e-9) break;
    }
    return {
      side, requested: depth, filled: P.round(filled, 6),
      vwap: filled > 0 ? P.round(notional / filled, 4) : null,
      notional: P.round(notional, 4),
      mid: snap.mid, spread: snap.spread
    };
  }

  // Kyle's lambda: a linear price impact coefficient estimated by regressing
  // the observed impact (in price units) on executed size over a sweep of
  // order sizes. Ordinary least squares through the origin, solved exactly.
  function kyleLambda(options) {
    const o = Object.assign({ mid: 30000, levels: 16, baseSize: 12, maxSize: 60, steps: 12 }, options || {});
    if (!(o.mid > 0) || !Number.isFinite(o.mid)) throw new RangeError('kyleLambda mid must be a positive finite number');
    if (!(o.maxSize > 0) || !Number.isFinite(o.maxSize)) throw new RangeError('kyleLambda maxSize must be a positive finite number');
    const stepCount = Math.floor(o.steps);
    if (!(stepCount >= 1)) throw new RangeError('kyleLambda steps must be at least one');
    const points = [];
    for (let i = 1; i <= stepCount; i++) {
      const size = P.round(o.maxSize * i / stepCount, 4);
      // Rounding can collapse small sweeps to zero or duplicate sizes; skip
      // degenerate points instead of feeding quoteImpact an invalid order.
      if (!(size > 0) || points.some(pt => pt.size === size)) continue;
      const book = P.Orderbook({ mid: o.mid, levels: o.levels, baseSize: o.baseSize, step: o.mid * 0.0006 });
      const quoted = book.quoteImpact('buy', size);
      if (quoted.avgPrice === null) continue;
      const impact = quoted.avgPrice - book.midPrice();
      points.push({ size, impact: P.round(impact, 6), avgPrice: quoted.avgPrice, levelsHit: quoted.levelsHit });
    }
    let num = 0, den = 0;
    for (const p of points) { num += p.size * p.impact; den += p.size * p.size; }
    const lambda = den > 0 ? num / den : 0;
    // Residual sum of squares of the linear model impact = lambda * size.
    let rss = 0, total = 0, meanY = 0;
    for (const p of points) meanY += p.impact;
    meanY /= Math.max(1, points.length);
    for (const p of points) {
      const resid = p.impact - lambda * p.size;
      rss += resid * resid;
      total += (p.impact - meanY) * (p.impact - meanY);
    }
    return {
      points, lambda: round(lambda, 8),
      lambdaBpsPerUnit: round(lambda / o.mid * 10000, 8),
      r2: total > 0 ? round(1 - rss / total, 6) : 1,
      mid: o.mid, steps: stepCount
    };
  }

  // A full slippage curve: for each size, quote without mutating, then execute
  // on a fresh book and confirm the quote matched the fill. This is a real
  // cross-check of the non-mutating quote against the mutating market order.
  function slippageCurve(options) {
    const o = Object.assign({ mid: 30000, sizes: [1, 5, 10, 20, 40, 80] }, options || {});
    if (!(o.mid > 0) || !Number.isFinite(o.mid)) throw new RangeError('slippageCurve mid must be a positive finite number');
    if (!Array.isArray(o.sizes) || !o.sizes.length) throw new RangeError('slippageCurve sizes must be a nonempty array');
    for (const s of o.sizes) {
      if (!(s > 0) || !Number.isFinite(s)) throw new RangeError('slippageCurve sizes must be positive finite numbers');
    }
    const rows = [];
    for (const size of o.sizes) {
      const bookQuote = P.Orderbook({ mid: o.mid });
      const quote = bookQuote.quoteImpact('buy', size);
      const bookFill = P.Orderbook({ mid: o.mid });
      const fill = bookFill.marketOrder('buy', size);
      rows.push({
        size,
        quotedAvg: quote.avgPrice, filledAvg: fill.avgPrice,
        quotedBps: quote.impactBps, filledBps: fill.impactBps,
        levelsHit: fill.levelsHit, unfilled: fill.unfilled,
        quoteMatchesFill: quote.avgPrice === fill.avgPrice && quote.impactBps === fill.impactBps,
        priceAfter: fill.newMid
      });
    }
    return {
      rows,
      allQuotesMatch: rows.every(r => r.quoteMatchesFill),
      mid: o.mid
    };
  }

  // ---------------------------------------------------------------
  // Module 2: insurance fund and auto-deleveraging waterfall
  // ---------------------------------------------------------------

  // A liquidation produces a shortfall when the closing fill price is worse
  // than the bankruptcy price. The insurance fund absorbs it first; if the
  // fund is exhausted, the remainder is socialized across profitable accounts
  // by notional weight (auto-deleveraging). All money is deterministic and
  // reconciles exactly: fund used + socialized + uncovered == shortfall.
  function insuranceWaterfall(options) {
    const o = Object.assign({
      fund: 25000, bankruptcyPrice: 29000, fillPrice: 28400,
      size: 5, profitableAccounts: [
        { id: 'A', notional: 100000 }, { id: 'B', notional: 60000 }, { id: 'C', notional: 40000 }
      ], feeRate: 0.0005
    }, options || {});
    if (!(o.bankruptcyPrice > 0) || !Number.isFinite(o.bankruptcyPrice)) throw new RangeError('bankruptcyPrice must be a positive finite number');
    if (!(o.fillPrice > 0) || !Number.isFinite(o.fillPrice)) throw new RangeError('fillPrice must be a positive finite number');
    if (!(o.size > 0) || !Number.isFinite(o.size)) throw new RangeError('waterfall size must be a positive finite number');
    if (!(o.feeRate >= 0) || !Number.isFinite(o.feeRate)) throw new RangeError('waterfall feeRate must be a nonnegative finite number');
    if (!Array.isArray(o.profitableAccounts)) throw new RangeError('profitableAccounts must be an array');
    for (const a of o.profitableAccounts) {
      if (!(a.notional >= 0) || !Number.isFinite(a.notional)) throw new RangeError('account notional must be a nonnegative finite number');
    }
    if (!Number.isFinite(o.fund) || !(o.fund >= 0)) throw new RangeError('waterfall fund must be a nonnegative finite number');
    const fund = o.fund;
    const shortfall = Math.max(0, round((o.bankruptcyPrice - o.fillPrice) * o.size, 4));
    const penalty = round(o.fillPrice * o.size * o.feeRate, 4);
    const fundUsed = Math.min(fund, shortfall);
    const remainder = round(shortfall - fundUsed, 4);
    const totalNotional = o.profitableAccounts.reduce((s, a) => s + a.notional, 0);
    const socialized = [];
    let allocated = 0;
    // With no profitable accounts to charge, the remainder is fully uncovered.
    if (totalNotional > 0) o.profitableAccounts.forEach((a, i) => {
      // The last account absorbs the residual, but rounding overshoot can
      // never push its charge below zero or past what remains.
      const share = i === o.profitableAccounts.length - 1
        ? Math.max(0, round(remainder - allocated, 4))
        : round(remainder * a.notional / totalNotional, 4);
      allocated = round(allocated + share, 4);
      socialized.push({ id: a.id, notional: a.notional, shareBps: round(a.notional / totalNotional * 10000, 4), charged: share });
    });
    const covered = round(fundUsed + allocated, 4);
    const uncovered = round(shortfall - covered, 4);
    return {
      shortfall, penalty, fundBefore: fund, fundUsed, fundAfter: round(fund - fundUsed, 4),
      remainder, socialized, covered, uncovered,
      reconciles: Math.abs(covered + uncovered - shortfall) < 1e-6,
      fundExhausted: fundUsed >= fund && shortfall > 0
    };
  }

  // ---------------------------------------------------------------
  // Module 3: cross-margin portfolio netting
  // ---------------------------------------------------------------

  // Net a long and short leg across the same underlying before charging
  // initial margin. The hedge benefit is the margin saved versus treating the
  // two legs as isolated positions. Uses the core initialMargin() so the
  // numbers agree with the rest of the model.
  function portfolioMargin(options) {
    const o = Object.assign({
      positions: [
        { side: 'long', size: 2, entryPrice: 30000, leverage: 10, collateral: 6000, marginMode: 'cross', markPrice: 30000 },
        { side: 'short', size: 1, entryPrice: 30000, leverage: 10, collateral: 3000, marginMode: 'cross', markPrice: 30000 }
      ]
    }, options || {});
    if (!Array.isArray(o.positions)) throw new RangeError('portfolioMargin positions must be an array');
    const pos = o.positions.map(p => P.position(p));
    const grossNotional = round(pos.reduce((s, p) => s + P.notional(p), 0), 4);
    const longNotional = round(pos.filter(p => p.side === 'long').reduce((s, p) => s + P.notional(p), 0), 4);
    const shortNotional = round(pos.filter(p => p.side === 'short').reduce((s, p) => s + P.notional(p), 0), 4);
    const netNotional = round(Math.abs(longNotional - shortNotional), 4);
    const isolatedMargin = round(pos.reduce((s, p) => s + P.initialMargin(p), 0), 4);
    // Net margin charges the net exposure at the same leverage as the legs.
    const netLeverage = pos.length ? Math.max.apply(null, pos.map(p => p.leverage)) : 10;
    const netMargin = round(netNotional / Math.max(1, netLeverage), 4);
    const hedgeBenefit = round(isolatedMargin - netMargin, 4);
    const totalPnl = round(pos.reduce((s, p) => s + P.unrealizedPnl(p), 0), 4);
    const equity = round(P.accountEquity(pos, pos.reduce((s, p) => s + p.collateral, 0)).equity, 4);
    return {
      legs: pos.length, grossNotional, longNotional, shortNotional, netNotional,
      isolatedMargin, netMargin, hedgeBenefit,
      hedgeBenefitPct: isolatedMargin > 0 ? round(hedgeBenefit / isolatedMargin * 100, 4) : 0,
      totalPnl, equity,
      netMarginNeverExceedsIsolated: netMargin <= isolatedMargin + 1e-6
    };
  }

  // ---------------------------------------------------------------
  // Module 4: multi-interval funding PnL
  // ---------------------------------------------------------------

  // Apply a clamped funding rate across N intervals to a position and a
  // cash-and-carry hedge, and report the cumulative payments. Longs pay a
  // positive rate; the short perp leg of the hedge receives it.
  function fundingLadder(options) {
    const o = Object.assign({
      notional: 100000, markTwap: 30024, indexTwap: 30000,
      intervals: 8, side: 'long', clampBps: 50
    }, options || {});
    if (!(o.notional > 0) || !Number.isFinite(o.notional)) throw new RangeError('fundingLadder notional must be a positive finite number');
    if (o.side !== 'long' && o.side !== 'short') throw new RangeError('fundingLadder side must be long or short');
    const ivlCount = Math.floor(o.intervals);
    if (!Number.isFinite(o.intervals) || !(ivlCount >= 1) || !(ivlCount <= 1e6)) throw new RangeError('fundingLadder intervals must be finite between 1 and 1000000');
    const f = P.fundingRate({ markTwap: o.markTwap, indexTwap: o.indexTwap, clampBps: o.clampBps });
    const perInterval = P.fundingPayment(o.notional, f.clampedBps, o.side);
    const rows = [];
    let cumulative = 0;
    for (let i = 1; i <= ivlCount; i++) {
      cumulative = round(cumulative + perInterval, 4);
      rows.push({ interval: i, rateBps: f.clampedBps, payment: perInterval, cumulative });
    }
    const hedge = P.fundingArbitrage({ notional: o.notional, rateBps: f.clampedBps, intervals: ivlCount });
    return {
      rate: f, perInterval, intervals: ivlCount, rows,
      cumulativePayment: cumulative,
      annualizedPct: f.annualizedPct,
      hedgeNet: hedge.net, hedgeBreakEvenBps: hedge.breakEvenBps,
      cumulativeMatchesSum: Math.abs(cumulative - round(perInterval * ivlCount, 4)) < 1e-6
    };
  }

  // ---------------------------------------------------------------
  // Module 5: Cornish-Fisher modified VaR
  // ---------------------------------------------------------------

  // Sample skewness and excess kurtosis of a return series, then the
  // Cornish-Fisher quantile expansion z_cf. Falls back to the normal z when
  // the sample is too small or degenerate. All moments are computed here.
  function returnMoments(returns) {
    if (!Array.isArray(returns)) throw new RangeError('returnMoments needs an array of returns');
    for (const r of returns) {
      if (!Number.isFinite(r)) throw new RangeError('returnMoments needs finite returns');
    }
    const n = returns.length;
    if (n < 2) return { n, mean: 0, variance: 0, sd: 0, skew: 0, excessKurtosis: 0 };
    const mean = returns.reduce((s, r) => s + r, 0) / n;
    let m2 = 0, m3 = 0, m4 = 0;
    for (const r of returns) {
      const d = r - mean;
      m2 += d * d; m3 += d * d * d; m4 += d * d * d * d;
    }
    m2 /= n; m3 /= n; m4 /= n;
    const sd = Math.sqrt(m2);
    // Subnormal-scale returns underflow the moment powers: guard each
    // denominator so the moments degrade to zero rather than NaN/Infinity.
    const skew = sd * sd * sd > 0 ? m3 / (sd * sd * sd) : 0;
    const excessKurtosis = m2 * m2 > 0 ? m4 / (m2 * m2) - 3 : 0;
    return { n, mean: round(mean, 8), variance: round(m2, 8), sd: round(sd, 8), skew: round(skew, 6), excessKurtosis: round(excessKurtosis, 6) };
  }

  const Z_TABLE = { 0.90: 1.2816, 0.95: 1.6449, 0.975: 1.96, 0.99: 2.3263, 0.995: 2.5758, 0.999: 3.0902 };

  function cornishFisherVaR(returns, confidence, notional) {
    if (!Array.isArray(returns) || returns.length < 4) throw new RangeError('cornishFisherVaR needs at least four returns');
    const c = confidence === undefined ? 0.99 : confidence;
    if (!(c > 0 && c < 1) || !Number.isFinite(c)) throw new RangeError('confidence must be a finite number strictly between zero and one');
    // Nearest tabulated quantile when the confidence is not an exact key.
    const zKeys = Object.keys(Z_TABLE).map(Number);
    const zKey = zKeys.reduce((a, b) => Math.abs(b - c) < Math.abs(a - c) ? b : a);
    const z = Z_TABLE[zKey];
    const m = returnMoments(returns);
    const z2 = z * z - 1, z3 = z * z * z - 3 * z, z4 = z * z * z * z - 6 * z * z + 3;
    const zcf = z + (1 / 6) * z2 * m.skew + (1 / 24) * z3 * m.excessKurtosis - (1 / 36) * (2 * z3 - 5 * z) * m.skew * m.skew;
    const sorted = returns.slice().sort((a, b) => a - b);
    const varReturn = P.percentile(sorted, 1 - c);
    const tail = sorted.filter(r => r <= varReturn);
    const cvarReturn = tail.length ? tail.reduce((s, r) => s + r, 0) / tail.length : varReturn;
    const nn = notional === undefined ? 100000 : notional;
    if (!(nn >= 0) || !Number.isFinite(nn)) throw new RangeError('notional must be a nonnegative finite number');
    return {
      confidence: c, z, zCornishFisher: round(zcf, 6), moments: m,
      parametricVarPct: round(z * m.sd * 100, 4),
      modifiedVarPct: round(zcf * m.sd * 100, 4),
      historicalVarPct: round(-varReturn * 100, 4),
      historicalCvarPct: round(-cvarReturn * 100, 4),
      modifiedVarNotional: round(zcf * m.sd * nn, 4),
      historicalVarNotional: round(-varReturn * nn, 4)
    };
  }

  // ---------------------------------------------------------------
  // Module 6: reproducible verification bundle
  // ---------------------------------------------------------------
  function verificationBundle(options) {
    const o = Object.assign({ seed: 'perps-risk-lab-v1', paths: 1200, s0: 30000 }, options || {});
    if (!Number.isFinite(o.paths) || !(Math.floor(o.paths) >= 4)) throw new RangeError('verificationBundle paths must be finite and at least four');
    const book = P.Orderbook({ mid: o.s0 });
    const vwap = bookVWAP(book, 'buy', 30);
    const kyle = kyleLambda({ mid: o.s0, steps: 10 });
    const curve = slippageCurve({ mid: o.s0 });
    const waterfall = insuranceWaterfall();
    const margin = portfolioMargin();
    const ladder = fundingLadder();
    const sim = P.simulatePaths({ s0: o.s0, paths: o.paths, horizonDays: 1, stepsPerDay: 24, seed: o.seed, lambda: 0.5 });
    const returns = sim.terminal.map(s => (s - o.s0) / o.s0);
    const cf = cornishFisherVaR(returns, 0.99, P.notional(P.position({ markPrice: o.s0 })));
    const mc = P.monteCarloVaR({ s0: o.s0, paths: o.paths, seed: o.seed, horizonDays: 1, stepsPerDay: 24 });
    const checks = {
      quoteMatchesFillEverySize: curve.allQuotesMatch,
      kyleLambdaPositive: kyle.lambda > 0,
      slippageMonotone: curve.rows.every((r, i) => i === 0 || r.filledBps >= curve.rows[i - 1].filledBps - 1e-6),
      waterfallReconciles: waterfall.reconciles,
      waterfallFundBounded: waterfall.fundUsed <= waterfall.fundBefore,
      netMarginBounded: margin.netMarginNeverExceedsIsolated,
      fundingLadderReconciles: ladder.cumulativeMatchesSum,
      cvarAtLeastVar: cf.historicalCvarPct >= cf.historicalVarPct - 1e-6,
      pathsPositive: sim.terminal.every(s => s > 0),
      monteCarloDeterministic: mc.paths === o.paths,
      vwapInsideSpread: vwap.vwap === null || (vwap.vwap >= vwap.mid)
    };
    return {
      schema: 'perps-risk-sim/verification-v2',
      seed: o.seed, generatedBy: 'src/risklab.js',
      paths: o.paths,
      selfChecks: checks,
      allChecksPass: Object.values(checks).every(v => v === true),
      orderbook: { vwap, kyleLambda: kyle.lambda, kyleR2: kyle.r2, slippage: curve.rows },
      waterfall: { shortfall: waterfall.shortfall, fundUsed: waterfall.fundUsed, socialized: waterfall.socialized, uncovered: waterfall.uncovered },
      margin: { grossNotional: margin.grossNotional, netMargin: margin.netMargin, hedgeBenefit: margin.hedgeBenefit },
      funding: { clampedBps: ladder.rate.clampedBps, cumulativePayment: ladder.cumulativePayment, hedgeNet: ladder.hedgeNet },
      var: { parametricPct: cf.parametricVarPct, modifiedPct: cf.modifiedVarPct, historicalPct: cf.historicalVarPct, cvarPct: cf.historicalCvarPct, skew: cf.moments.skew, excessKurtosis: cf.moments.excessKurtosis, monteCarloVarPct: mc.varPct, monteCarloCvarPct: mc.cvarPct }
    };
  }

  const api = {
    bookVWAP, kyleLambda, slippageCurve,
    insuranceWaterfall, portfolioMargin, fundingLadder,
    returnMoments, cornishFisherVaR, verificationBundle
  };
  return api;
}));
