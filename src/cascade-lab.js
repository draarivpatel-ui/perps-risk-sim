/*
 * Perps Risk Sim cascade laboratory.
 *
 * A deterministic exchange-risk-regime comparator layered on src/perps.js.
 * Five margin and backstop regimes are stressed against concrete flash-crash
 * and short-squeeze shocks on a shared synthetic position universe. Every run
 * reports the exact liquidation price of a reference position, the bad-debt
 * socialization split, insurance-fund survival, orderbook impact slippage,
 * auto-deleveraging account counts and a fund/equity conservation identity
 * that reconciles to the cent by construction:
 *
 *   initialCollateral == remainingEquity + fees + insuranceDelta
 *                        + counterpartySettlement - unpaidBadDebt
 *
 * where counterpartySettlement is the net mark-to-market transferred out of
 * the collateral pool to the external book and unpaidBadDebt is any residual
 * shortfall no policy covered (exchange insolvency inside the model).
 *
 * Also inside: a pure-JS FIPS 180-4 SHA-256 used as an unkeyed
 * tamper-detection digest for the JSON/CSV/Markdown stress-audit export, a
 * strict #prs= URL bookmark codec and a self-test battery. Zero
 * dependencies. This is a risk-education model over a synthetic book, not a
 * claim about any live exchange.
 */
(function (root, factory) {
  const P = (typeof module === 'object' && module.exports)
    ? require('./perps.js')
    : root.Perps;
  const api = factory(P);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PerpsCascadeLab = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (P) {
  'use strict';

  function round(x, dp) { const f = Math.pow(10, dp === undefined ? 6 : dp); return Math.round(x * f) / f; }
  function checkFinite(v, what) {
    if (!Number.isFinite(v)) throw new RangeError(what + ' must be a finite number');
    return v;
  }

  // ---------------------------------------------------------------
  // Module 1: regime specifications and the shared position universe
  // ---------------------------------------------------------------

  const MID = 30000;
  const UNIVERSE_SIZE = 14;
  const LIQ_FEE_RATE = 0.0005;
  // Buffer ladder: how much collateral each position posted relative to the
  // initial margin requirement. Deterministic so every regime sees the same
  // traders.
  const COLLATERAL_BUFFERS = [1.15, 0.92, 1.3, 1.05, 1.22, 0.88, 1.4, 1.0, 1.18, 0.95, 1.28, 1.08, 1.12, 0.9];

  const REGIMES = Object.freeze([
    Object.freeze({
      id: 'cross20', name: '20x Unbuffered Cross',
      leverage: 20, marginMode: 'cross', mmr: 0.005, mmrVolScale: 0,
      closeFraction: 1, breakerPct: null, fund: 4000,
      adlPolicy: 'full', adlCapPct: 1, adlMinProfitBps: 0
    }),
    Object.freeze({
      id: 'iso10', name: '10x Isolated + Static MMR',
      leverage: 10, marginMode: 'isolated', mmr: 0.005, mmrVolScale: 0,
      closeFraction: 1, breakerPct: null, fund: 4000,
      adlPolicy: 'full', adlCapPct: 1, adlMinProfitBps: 0
    }),
    Object.freeze({
      id: 'volscaled', name: 'Dynamic Volatility-Scaled Margin',
      leverage: 20, marginMode: 'cross', mmr: 0.005, mmrVolScale: 9,
      closeFraction: 1, breakerPct: null, fund: 4000,
      adlPolicy: 'full', adlCapPct: 1, adlMinProfitBps: 0
    }),
    Object.freeze({
      id: 'circuit', name: 'Circuit-Breaker + Partial Liquidation',
      leverage: 20, marginMode: 'cross', mmr: 0.005, mmrVolScale: 0,
      closeFraction: 0.45, breakerPct: 0.25, fund: 4000,
      adlPolicy: 'full', adlCapPct: 1, adlMinProfitBps: 0
    }),
    Object.freeze({
      id: 'gradadl', name: 'Insurance-Fund + Graduated ADL',
      leverage: 20, marginMode: 'cross', mmr: 0.005, mmrVolScale: 0,
      closeFraction: 1, breakerPct: null, fund: 14000,
      adlPolicy: 'graduated', adlCapPct: 0.5, adlMinProfitBps: 200
    })
  ]);

  const SHOCKS = Object.freeze([-10, -25, -40, 30]);
  const SWEEP_SHOCKS = Object.freeze([-5, -10, -15, -20, -25, -30, -35, -40, -45, -50]);

  function regimeSpec(id) {
    const r = REGIMES.find(x => x.id === id);
    if (!r) throw new RangeError('unknown regime id: ' + String(id));
    return r;
  }

  // Effective leverage under a volatility-scaled margin regime: the exchange
  // raised initial margin as realized vol spiked, so the same trader enters
  // with thicker collateral and a lower effective leverage.
  function effectiveLeverage(regime, shockPct) {
    checkFinite(shockPct, 'shockPct');
    const scale = regime.mmrVolScale ? regime.leverage / (1 + regime.mmrVolScale * Math.abs(shockPct) / 100) : regime.leverage;
    return round(Math.max(1, Math.min(regime.leverage, scale)), 4);
  }

  function effectiveMmr(regime, shockPct) {
    const base = regime.mmr;
    const scaled = regime.mmrVolScale ? base * (1 + regime.mmrVolScale * Math.abs(shockPct) / 200) : base;
    return round(scaled, 8);
  }

  // The deterministic trader universe. Each position is its own account.
  // Shorts sit in the book deliberately: they are the profitable accounts a
  // crash socialize clawbacks against, and they are the casualty side of a
  // short squeeze.
  function buildUniverse(regimeId, shockPct, options) {
    const regime = regimeSpec(regimeId);
    const o = Object.assign({ mid: MID, size: UNIVERSE_SIZE }, options || {});
    if (!(o.mid > 0) || !Number.isFinite(o.mid)) throw new RangeError('universe mid must be a positive finite number');
    const n = Math.floor(o.size);
    if (!(n >= 1) || !(n <= 200)) throw new RangeError('universe size must be between 1 and 200');
    const effLev = effectiveLeverage(regime, shockPct);
    const positions = [];
    for (let i = 0; i < n; i++) {
      const size = 2 + (i % 5);
      const side = (i % 7 === 5 || i === 12) ? 'short' : 'long';
      const buffer = COLLATERAL_BUFFERS[i % COLLATERAL_BUFFERS.length];
      const collateral = regime.marginMode === 'isolated'
        ? round(size * o.mid / effLev, 4) // isolated posts exactly the initial margin
        : round(size * o.mid / effLev * buffer, 4);
      positions.push({
        id: 'T' + i, side, size, entryPrice: o.mid, markPrice: o.mid,
        leverage: effLev, collateral, marginMode: regime.marginMode,
        liquidated: false, closedSize: 0, startCollateral: collateral,
        adlCharged: 0, residualReturned: 0
      });
    }
    return positions;
  }

  // ---------------------------------------------------------------
  // Module 2: the regime stress engine
  // ---------------------------------------------------------------

  // Same closed form the core P.liquidationPrice() solves, applied here to a
  // reference position whose leverage can exceed the core engine's own cap
  // (regimes model venues with their own maximums). equity == maintenance:
  //   C + dir*(P - E)*S == P*S*mmr + base
  function closedFormLiqPrice(side, entry, collateral, size, mmr, base) {
    if (side !== 'long' && side !== 'short') throw new RangeError('closedFormLiqPrice side must be long or short');
    if (!Number.isFinite(entry) || !(entry > 0) || !Number.isFinite(collateral) || !(collateral >= 0) ||
      !Number.isFinite(size) || !(size >= 0) || !Number.isFinite(mmr) || !(mmr >= 0) ||
      !Number.isFinite(base) || !(base >= 0)) {
      throw new RangeError('closedFormLiqPrice fields must be nonnegative finite numbers with a positive entry');
    }
    if (size === 0) return null;
    const dir = side === 'short' ? -1 : 1;
    const denom = dir * size - size * mmr;
    if (Math.abs(denom) < 1e-12) return null;
    const price = (dir * size * entry - collateral + base) / denom;
    return Number.isFinite(price) && price > 0 ? round(price, 4) : null;
  }


  // Run one regime against one shock. Liquidations close into a synthetic
  // book re-pegged at the cascading mark; closing volume drifts the price;
  // deficits queue for the insurance fund, then ADL clawbacks, then an
  // unpaid-bad-debt remainder that marks the venue insolvent in the model.
  function runRegime(regimeId, shockPct, options) {
    const regime = regimeSpec(regimeId);
    const o = Object.assign({ mid: MID, rounds: 12, positions: null, bookLevels: 16, bookBaseSize: 12, driftStep: 0.00008, driftCap: 0.02 }, options || {});
    if (!(o.mid > 0) || !Number.isFinite(o.mid)) throw new RangeError('run mid must be a positive finite number');
    checkFinite(shockPct, 'shockPct');
    if (!(shockPct > -100)) throw new RangeError('shockPct must be greater than -100 percent');
    if (!(shockPct <= 500)) throw new RangeError('shockPct above +500 percent is outside the model range');
    const maxRounds = Math.floor(o.rounds);
    if (!(maxRounds >= 0) || !(maxRounds <= 100)) throw new RangeError('rounds must be between 0 and 100');
    if (!(o.bookBaseSize > 0) || !Number.isFinite(o.bookBaseSize)) throw new RangeError('bookBaseSize must be a positive finite number');
    if (!(o.driftStep >= 0) || !Number.isFinite(o.driftStep)) throw new RangeError('driftStep must be a nonnegative finite number');
    if (!(o.driftCap > 0) || !Number.isFinite(o.driftCap)) throw new RangeError('driftCap must be a positive finite number');
    if (o.fund !== undefined && !(o.fund >= 0 && Number.isFinite(o.fund))) throw new RangeError('fund override must be a nonnegative finite number');
    if (o.universeSize !== undefined) {
      const n = Math.floor(o.universeSize);
      if (!(n >= 1) || !(n <= 200)) throw new RangeError('universeSize must be between 1 and 200');
      o.universeSize = n;
    }

    const mmr = effectiveMmr(regime, shockPct);
    const effLev = effectiveLeverage(regime, shockPct);
    const positions = o.positions || buildUniverse(regimeId, shockPct, { mid: o.mid, size: o.universeSize === undefined ? UNIVERSE_SIZE : o.universeSize });
    for (const p of positions) {
      // The core position() validator caps leverage at the engine's own max;
      // regimes model venues with their own caps, so the shape is checked
      // here instead. Fields must be finite and side must be long or short.
      if (!p || typeof p !== 'object' || Array.isArray(p)) throw new RangeError('universe position must be an object');
      if (p.side !== 'long' && p.side !== 'short') throw new RangeError('universe position side must be long or short');
      if (!(p.size > 0) || !Number.isFinite(p.size)) throw new RangeError('universe position size must be a positive finite number');
      if (!(p.entryPrice > 0) || !Number.isFinite(p.entryPrice)) throw new RangeError('universe entryPrice must be a positive finite number');
      if (!(p.leverage >= 1) || !Number.isFinite(p.leverage)) throw new RangeError('universe leverage must be a finite number of at least one');
      if (!(p.collateral >= 0) || !Number.isFinite(p.collateral)) throw new RangeError('universe collateral must be a nonnegative finite number');
      p.closedSize = 0; p.adlCharged = 0; p.residualReturned = 0; p.liquidated = false;
    }
    const initialCollateral = round(positions.reduce((s, p) => s + p.collateral, 0), 4);
    const fundBefore = round(o.fund !== undefined ? o.fund : regime.fund, 4);

    let price = round(o.mid * (1 + shockPct / 100), 4);
    if (!(price > 0) || !Number.isFinite(price)) throw new RangeError('shock produces a nonpositive or nonfinite mark price');
    const shockedPrice = price;
    const events = [];
    const closeSideOf = side => side === 'long' ? 'sell' : 'buy';

    let totalLiquidatedUnits = 0;
    let totalLiquidatedNotional = 0;
    let impactNotional = 0;
    let impactWeightedBps = 0;
    let fees = 0;
    let deficits = 0;
    let residualReturned = 0;
    let realizedPnl = 0;
    let breakerHalted = false;

    for (let roundIdx = 0; roundIdx < maxRounds; roundIdx++) {
      const triggered = positions.filter(p => {
        if (p.size <= 1e-9) return false;
        p.markPrice = price;
        const probe = { side: p.side, size: p.size, entryPrice: p.entryPrice, markPrice: price, collateral: p.collateral, leverage: p.leverage };
        return P.isLiquidatable(probe, { maintenanceMarginRate: mmr });
      });
      if (!triggered.length) break;
      const book = P.Orderbook({ mid: price, levels: o.bookLevels, baseSize: o.bookBaseSize, step: price * 0.0006 });
      let roundSell = 0;
      for (const p of triggered) {
        // Partial-close regimes take a fixed fraction of the remaining size;
        // everything else closes the position outright.
        let q = p.size;
        if (regime.closeFraction < 1) {
          q = round(Math.min(p.size, Math.max(p.size * regime.closeFraction, Math.min(p.size, 1e-4))), 6);
          if (p.size - q < 1e-4) q = p.size;
        }
        const fill = book.marketOrder(closeSideOf(p.side), q);
        const executedNotional = fill.filled * (fill.avgPrice || price);
        const fillPrice = fill.avgPrice || price;
        const dir = p.side === 'short' ? -1 : 1;
        const pnl = round((fillPrice - p.entryPrice) * fill.filled * dir, 4);
        realizedPnl = round(realizedPnl + pnl, 4);
        // Settle the closed slice against the account collateral pool.
        const afterPnl = round(p.collateral + pnl, 4);
        let deficit = 0, fee = 0;
        if (afterPnl < 0) deficit = round(-afterPnl, 4);
        else fee = round(Math.min(executedNotional * LIQ_FEE_RATE, afterPnl), 4);
        p.collateral = round(Math.max(0, afterPnl - fee), 4);
        p.closedSize = round(p.closedSize + fill.filled, 6);
        p.size = round(p.size - fill.filled, 6);
        p.unfilledShare = round((p.unfilledShare || 0) + fill.unfilled, 6);
        if (p.size <= 1e-9) {
          p.liquidated = true;
          p.residualReturned = p.collateral;
          residualReturned = round(residualReturned + p.collateral, 4);
          p.collateral = 0;
        }
        roundSell += p.side === 'long' ? fill.filled : -fill.filled;
        deficits = round(deficits + deficit, 4);
        fees = round(fees + fee, 4);
        totalLiquidatedUnits = round(totalLiquidatedUnits + fill.filled, 6);
        totalLiquidatedNotional = round(totalLiquidatedNotional + executedNotional, 4);
        impactNotional += executedNotional;
        impactWeightedBps += fill.impactBps * executedNotional;
        events.push({
          round: roundIdx + 1, id: p.id, side: p.side, closed: fill.filled,
          markPrice: price, fillPrice, impactBps: fill.impactBps,
          fee, deficit, remainingSize: p.size
        });
      }
      // Closing volume drifts the mark, same synthetic feedback as the core
      // cascade engine. A circuit breaker compares the total move from the
      // pre-shock mid with its band; ignoring the initial shock would leave
      // loss-bearing residuals active for extra rounds even after a large gap.
      const driftDir = roundSell > 0 ? -1 : roundSell < 0 ? 1 : 0;
      const drift = driftDir * Math.min(o.driftCap, Math.abs(roundSell) * o.driftStep);
      price = round(price * (1 + drift), 4);
      const cascadeDriftPct = Math.abs((price - shockedPrice) / shockedPrice) * 100;
      const totalMovePct = Math.abs((price - o.mid) / o.mid) * 100;
      if (regime.breakerPct !== null && Math.max(cascadeDriftPct, totalMovePct) >= regime.breakerPct) {
        breakerHalted = true;
        events.push({ round: roundIdx + 1, type: 'breaker-halt', markPrice: price, driftPct: round(cascadeDriftPct, 4), totalMovePct: round(totalMovePct, 4) });
        break;
      }
    }

    // ---------------------------------------------------------------
    // Backstop waterfall: fund, then ADL clawback, then unpaid bad debt
    // ---------------------------------------------------------------
    const fundPaid = round(Math.min(fundBefore, deficits), 4);
    const fundAfter = round(fundBefore - fundPaid, 4);
    let uncovered = round(deficits - fundPaid, 4);
    const adlCharges = [];
    if (uncovered > 0) {
      // Auto-deleveraging claws back winner profit, never posted margin: a
      // charge is capped by the account's unrealized profit (and by the
      // regime cap), so it can never push an equity claim below collateral.
      const winners = positions
        .map(p => {
          const upnl = p.size > 1e-9 ? P.unrealizedPnl({ side: p.side, size: p.size, entryPrice: p.entryPrice, markPrice: price, collateral: p.collateral, leverage: p.leverage }) : 0;
          const baseNotional = (p.closedSize + p.size) * price;
          return { p, upnl, profit: Math.max(0, upnl), baseNotional };
        })
        .filter(w => w.profit > 0 && (!regime.adlMinProfitBps || w.upnl >= w.baseNotional * regime.adlMinProfitBps / 10000));
      const totalProfit = winners.reduce((s, w) => s + w.profit, 0);
      let chargedSum = 0;
      for (const w of winners) {
        const proRata = totalProfit > 0 ? uncovered * w.profit / totalProfit : 0;
        const charge = round(Math.min(proRata, w.profit * regime.adlCapPct, uncovered - chargedSum), 4);
        if (charge > 0) {
          adlCharges.push({ id: w.p.id, profit: round(w.profit, 4), charged: charge });
          w.p.adlCharged = round((w.p.adlCharged || 0) + charge, 4);
          chargedSum = round(chargedSum + charge, 4);
        }
      }
    }
    const adlTotal = round(adlCharges.reduce((s, a) => s + a.charged, 0), 4);
    uncovered = round(uncovered - adlTotal, 4);
    const unpaidBadDebt = uncovered;

    // ---------------------------------------------------------------
    // Conservation identity, computed from independent buckets.
    //   initialCollateral
    //     == remainingEquity + fees + insuranceDelta
    //        + counterpartySettlement - unpaidBadDebt
    // remainingEquity holds survivor claims net of ADL clawbacks plus
    // residual collateral returned to fully closed accounts. The
    // counterparty settlement is the net mark-to-market the pool handed to
    // the external book: -(closed pnl + survivor uPnL). An unpaid bad debt
    // is subtracted because it was acknowledged but never actually left the
    // pool; it is the venue's insolvency inside the model.
    // ---------------------------------------------------------------
    let survivorUpnl = 0, adlSum = 0;
    for (const p of positions) {
      const upnl = p.size > 1e-9
        ? P.unrealizedPnl({ side: p.side, size: p.size, entryPrice: p.entryPrice, markPrice: price, collateral: p.collateral, leverage: p.leverage })
        : 0;
      survivorUpnl = round(survivorUpnl + upnl, 4);
      adlSum = round(adlSum + (p.adlCharged || 0), 4);
    }
    const remainingEquity = round(positions.reduce((s, p) => s + p.collateral, 0) + survivorUpnl - adlSum + residualReturned, 4);
    const insuranceDelta = round(fundAfter - fundBefore, 4);
    const counterpartySettlement = round(-(realizedPnl + survivorUpnl), 4);
    const rhs = round(remainingEquity + fees + insuranceDelta + counterpartySettlement - unpaidBadDebt, 4);
    const conservationError = round(initialCollateral - rhs, 6);
    const conserved = Math.abs(conservationError) < Math.max(1e-6, Math.abs(initialCollateral) * 1e-9);

    const liqPrice = closedFormLiqPrice('long', o.mid, round(o.mid / effLev, 4), 1, mmr, 0);
    const cascadeImpactPct = impactNotional > 0 ? round(impactWeightedBps / impactNotional / 100, 6) : 0;

    return {
      regime: regime.id, regimeName: regime.name, shockPct, mid: o.mid,
      shockedPrice, finalPrice: price,
      priceMovePct: round(((price - o.mid) / o.mid) * 100, 4),
      mmr, effectiveLeverage: effLev,
      liquidationPrice: liqPrice,
      liquidationDistancePct: liqPrice === null ? null : round(Math.abs(o.mid - liqPrice) / o.mid * 100, 4),
      liquidatedCount: positions.filter(p => p.closedSize > 1e-9).length,
      fullyLiquidatedCount: positions.filter(p => p.liquidated).length,
      partiallyLiquidatedCount: positions.filter(p => p.closedSize > 1e-9 && !p.liquidated).length,
      survivingCount: positions.filter(p => p.closedSize <= 1e-9).length,
      totalLiquidatedUnits, totalLiquidatedNotional, cascadeImpactPct,
      badDebt: deficits, fundBefore, fundPaid, fundAfter,
      insuranceSurvivalPct: fundBefore > 0 ? round(fundAfter / fundBefore * 100, 4) : 0,
      adlAccounts: adlCharges.length, adlCharges, adlTotal,
      unpaidBadDebt, breakerHalted,
      fees, residualReturned,
      initialCollateral, remainingEquity, insuranceDelta, counterpartySettlement,
      conservationError, conserved,
      rounds: events.length ? events[events.length - 1].round : 0,
      events
    };
  }

  // All five regimes against one shock, in registry order.
  function compareRegimes(shockPct, options) {
    if (!SHOCKS.includes(shockPct) && !(Number.isFinite(shockPct) && shockPct > -100 && shockPct <= 500)) {
      throw new RangeError('compare shockPct must be finite, greater than -100 and at most 500');
    }
    return REGIMES.map(r => runRegime(r.id, shockPct, options));
  }

  // Sweep a regime across shock magnitudes for the chart. Returns one row
  // per shock with the cumulative liquidated notional, fund survival and the
  // bad-debt split, plus the first magnitude where the regime's backstops
  // run out (the ADL or insolvency cliff).
  function shockSweep(regimeId, shocks, options) {
    regimeSpec(regimeId);
    const list = shocks || SWEEP_SHOCKS;
    if (!Array.isArray(list) || !list.length) throw new RangeError('shockSweep needs a nonempty shock list');
    for (const s of list) checkFinite(s, 'shock');
    const rows = list.map(s => {
      const r = runRegime(regimeId, s, options);
      return {
        shockPct: s,
        liquidatedNotional: r.totalLiquidatedNotional,
        liquidatedCount: r.liquidatedCount,
        badDebt: r.badDebt,
        fundSurvivalPct: r.insuranceSurvivalPct,
        adlAccounts: r.adlAccounts,
        unpaidBadDebt: r.unpaidBadDebt,
        impactPct: r.cascadeImpactPct,
        conserved: r.conserved
      };
    });
    const cliff = rows.find(r => r.adlAccounts > 0 || r.unpaidBadDebt > 0 || r.fundSurvivalPct <= 0);
    return { regime: regimeId, rows, cliffShockPct: cliff ? cliff.shockPct : null };
  }

  // ---------------------------------------------------------------
  // Module 3: FIPS 180-4 SHA-256 (pure JS, unkeyed tamper-detection digest)
  // ---------------------------------------------------------------
  const SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  const SHA256_H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

  // UTF-8 encoder so the digest accepts arbitrary strings without relying on
  // TextEncoder (keeps the module identical in old browsers and Node).
  function utf8Bytes(str) {
    const s = String(str);
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        const c2 = s.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00); i++; }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return out;
  }

  function sha256Hex(input) {
    const bytes = input instanceof Array ? input.slice() : utf8Bytes(input);
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    // 64-bit big-endian length, split as two 32-bit words.
    const hi = Math.floor(bitLen / 0x100000000);
    for (let i = 3; i >= 0; i--) bytes.push((hi >>> (i * 8)) & 0xff);
    for (let i = 3; i >= 0; i--) bytes.push((bitLen >>> (i * 8)) & 0xff);
    const h = SHA256_H0.slice();
    const w = new Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < bytes.length; off += 64) {
      for (let i = 0; i < 16; i++) {
        w[i] = ((bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) | (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3]) >>> 0;
      }
      for (let i = 16; i < 64; i++) {
        const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
        const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        const ch = ((e & f) ^ (~e & g)) >>> 0;
        const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
        const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        const t2 = (S0 + maj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    return h.map(x => x.toString(16).padStart(8, '0')).join('');
  }

  // ---------------------------------------------------------------
  // Module 4: checksummed stress-audit export (JSON / CSV / Markdown)
  // ---------------------------------------------------------------

  // CSV injection guard plus RFC-4180 quoting. Values that a spreadsheet
  // would evaluate as formulas get a leading apostrophe; commas, quotes and
  // newlines force quoting with doubled inner quotes.
  function csvEscape(value) {
    const numeric = typeof value === 'number' && Number.isFinite(value);
    let s = value === null || value === undefined ? '' : String(value);
    if (!numeric && /^[\s\p{Cf}\p{Cc}]*[=+\-@\t\r]/u.test(s)) s = "'" + s;
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function comparisonTable(shockPct, options) {
    const runs = compareRegimes(shockPct, options);
    return {
      schema: 'perps-risk-sim/audit-v1',
      shockPct,
      generatedBy: 'src/cascade-lab.js',
      regimes: runs.map(r => ({
        regime: r.regime, regimeName: r.regimeName,
        effectiveLeverage: r.effectiveLeverage, mmr: r.mmr,
        liquidationPrice: r.liquidationPrice,
        liquidationDistancePct: r.liquidationDistancePct,
        liquidatedCount: r.liquidatedCount, survivingCount: r.survivingCount,
        liquidatedNotional: r.totalLiquidatedNotional,
        cascadeImpactPct: r.cascadeImpactPct,
        badDebt: r.badDebt, fundBefore: r.fundBefore, fundPaid: r.fundPaid,
        fundAfter: r.fundAfter, insuranceSurvivalPct: r.insuranceSurvivalPct,
        adlAccounts: r.adlAccounts, adlTotal: r.adlTotal,
        unpaidBadDebt: r.unpaidBadDebt, breakerHalted: r.breakerHalted,
        initialCollateral: r.initialCollateral, remainingEquity: r.remainingEquity,
        fees: r.fees, insuranceDelta: r.insuranceDelta,
        counterpartySettlement: r.counterpartySettlement,
        conserved: r.conserved, conservationError: r.conservationError
      }))
    };
  }

  // One digest-stamped bundle per report object. The digest is computed once
  // over the canonical JSON of the report body and reused across the JSON,
  // CSV and Markdown renderings, so all three carry the same checksum.
  const AUDIT_DISCLAIMER = 'Educational risk-modeling simulation over a synthetic book and synthetic positions. Not financial or trading advice. The sha256 field is an unkeyed FIPS 180-4 tamper-detection digest, not a signature or MAC.';

  function buildAuditBundle(shockPct, options) {
    const report = comparisonTable(shockPct, options);
    report.disclaimer = AUDIT_DISCLAIMER;
    const canonical = JSON.stringify(report);
    const digest = sha256Hex(canonical);
    const json = JSON.stringify({ report, sha256: digest, digestNote: 'unkeyed SHA-256 (FIPS 180-4) tamper-detection digest; recompute sha256Hex(JSON.stringify(report)) to verify' }, null, 2);

    const headers = ['regime', 'liquidationPrice', 'liquidatedCount', 'survivingCount', 'liquidatedNotional', 'cascadeImpactPct', 'badDebt', 'fundPaid', 'fundAfter', 'insuranceSurvivalPct', 'adlAccounts', 'unpaidBadDebt', 'breakerHalted', 'conserved'];
    const csvRows = [headers.join(',')];
    for (const r of report.regimes) {
      csvRows.push(headers.map(h => csvEscape(r[h] === undefined ? '' : r[h])).join(','));
    }
    csvRows.push('');
    csvRows.push('# sha256 (unkeyed tamper-detection digest, FIPS 180-4): ' + digest);
    csvRows.push('# ' + AUDIT_DISCLAIMER);
    const csv = csvRows.join('\n');

    const md = [
      '# Perps Risk Sim stress audit',
      '',
      'Shock: ' + shockPct + '% mark gap. Synthetic book, synthetic positions.',
      '',
      '| Regime | Liq price | Liquidated | Bad debt | Fund survival | ADL accts | Unpaid | Conserved |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      report.regimes.map(r => '| ' + r.regimeName + ' | ' + r.liquidationPrice + ' | ' + r.liquidatedCount + ' | ' + r.badDebt + ' | ' + r.insuranceSurvivalPct + '% | ' + r.adlAccounts + ' | ' + r.unpaidBadDebt + ' | ' + r.conserved + ' |').join('\n'),
      '',
      'Conservation identity: initialCollateral == remainingEquity + fees + insuranceDelta + counterpartySettlement - unpaidBadDebt.',
      '',
      'sha256 (unkeyed tamper-detection digest, FIPS 180-4): ' + digest,
      '',
      AUDIT_DISCLAIMER
    ].join('\n');
    return { report, canonical, digest, json, csv, markdown: md };
  }

  // Recompute the digest over an exported JSON payload. Any edit to the
  // report body, including whitespace-stable field changes, flips the hash.
  function verifyAuditJson(jsonText) {
    let obj;
    try { obj = JSON.parse(String(jsonText)); }
    catch (e) { return { valid: false, reason: 'payload is not valid JSON' }; }
    if (!obj || typeof obj !== 'object' || !obj.report || typeof obj.sha256 !== 'string') {
      return { valid: false, reason: 'payload lacks the report or sha256 field' };
    }
    const recomputed = sha256Hex(JSON.stringify(obj.report));
    return recomputed === obj.sha256
      ? { valid: true, digest: recomputed }
      : { valid: false, reason: 'digest mismatch: the report body was modified after export', expected: obj.sha256, recomputed };
  }

  // ---------------------------------------------------------------
  // Module 5: strict #prs= URL bookmark codec
  // ---------------------------------------------------------------
  const BOOKMARK_FIELDS = Object.freeze(['shock', 'regime', 'fund', 'positions']);
  const BOOKMARK_PREFIX = '#prs=';

  function base64UrlEncode(str) {
    const bytes = utf8Bytes(str);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    let b64;
    if (typeof Buffer !== 'undefined') b64 = Buffer.from(bytes).toString('base64');
    else b64 = btoa(bin);
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64UrlDecode(str) {
    let b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('utf8');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  function encodeBookmark(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new RangeError('bookmark state must be an object');
    const payload = { v: 1 };
    if (state.shock !== undefined) { checkFinite(state.shock, 'bookmark shock'); payload.shock = state.shock; }
    if (state.regime !== undefined) { regimeSpec(state.regime); payload.regime = state.regime; }
    if (state.fund !== undefined) { checkFinite(state.fund, 'bookmark fund'); payload.fund = state.fund; }
    if (state.positions !== undefined) {
      const n = Math.floor(state.positions);
      if (!(n >= 1) || !(n <= 200)) throw new RangeError('bookmark positions must be between 1 and 200');
      payload.positions = n;
    }
    return BOOKMARK_PREFIX + base64UrlEncode(JSON.stringify(payload));
  }

  function decodeBookmark(hash) {
    if (typeof hash !== 'string') return null;
    const raw = hash.startsWith('#') ? hash : '#' + hash;
    if (!raw.startsWith(BOOKMARK_PREFIX)) return null;
    const body = raw.slice(BOOKMARK_PREFIX.length);
    if (!body || !/^[A-Za-z0-9_-]+$/.test(body)) return null;
    let parsed;
    try { parsed = JSON.parse(base64UrlDecode(body)); }
    catch (e) { return null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.v !== 1) return null;
    for (const k of Object.keys(parsed)) {
      if (k !== 'v' && !BOOKMARK_FIELDS.includes(k)) return null;
    }
    const out = {};
    if (parsed.shock !== undefined) {
      if (!Number.isFinite(parsed.shock) || !(parsed.shock > -100) || parsed.shock > 500) return null;
      out.shock = parsed.shock;
    }
    if (parsed.regime !== undefined) {
      if (!REGIMES.some(r => r.id === parsed.regime)) return null;
      out.regime = parsed.regime;
    }
    if (parsed.fund !== undefined) {
      if (!Number.isFinite(parsed.fund) || parsed.fund < 0 || parsed.fund > 1e9) return null;
      out.fund = parsed.fund;
    }
    if (parsed.positions !== undefined) {
      if (!Number.isFinite(parsed.positions) || parsed.positions < 1 || parsed.positions > 200 || parsed.positions !== Math.floor(parsed.positions)) return null;
      out.positions = parsed.positions;
    }
    return out;
  }

  // ---------------------------------------------------------------
  // Module 6: in-page self-test battery
  // ---------------------------------------------------------------
  function selfTests() {
    const results = [];
    const run = (name, fn) => {
      try { const detail = fn(); results.push({ name, pass: true, detail: detail || '' }); }
      catch (e) { results.push({ name, pass: false, detail: String(e && e.message ? e.message : e).slice(0, 140) }); }
    };
    const expect = (cond, msg) => { if (!cond) throw new Error(msg || 'check failed'); };

    run('SHA-256 KAT: empty string', () => {
      expect(sha256Hex('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'empty-vector mismatch');
      return 'e3b0c44...';
    });
    run('SHA-256 KAT: "abc"', () => {
      expect(sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'abc-vector mismatch');
      return 'ba7816b...';
    });
    run('SHA-256 KAT: quick brown fox', () => {
      expect(sha256Hex('The quick brown fox jumps over the lazy dog') === 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592', 'fox-vector mismatch');
      return 'd7a8fbb...';
    });
    run('SHA-256 KAT: 56-byte boundary', () => {
      expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq') === '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1', 'boundary-vector mismatch');
      return '248d6a6...';
    });
    run('SHA-256: UTF-8 multibyte input hashes stably', () => {
      const a = sha256Hex('perps-risk-sim µ ✓');
      expect(/^[0-9a-f]{64}$/.test(a), 'not a 64-char hex digest');
      expect(a !== sha256Hex('perps-risk-sim'), 'multibyte input ignored');
      return a.slice(0, 12);
    });
    run('Liquidation distance scales with leverage', () => {
      const d = lev => {
        const lp = closedFormLiqPrice('long', MID, MID / lev, 1, 0.005, 0);
        return Math.abs(MID - lp) / MID;
      };
      expect(d(10) > d(20) && d(20) > d(50), 'distance did not shrink with leverage');
      return '10x ' + (d(10) * 100).toFixed(2) + '% vs 50x ' + (d(50) * 100).toFixed(2) + '%';
    });
    run('Bad debt nonnegative and monotone in shock depth', () => {
      let prev = -1;
      for (const s of [-5, -15, -25, -35]) {
        const r = runRegime('cross20', s);
        expect(r.badDebt >= -1e-9, 'negative bad debt at ' + s);
        expect(r.badDebt >= prev - 1e-9, 'bad debt fell from ' + prev + ' at ' + s);
        prev = r.badDebt;
      }
      return 'monotone across -5..-35';
    });
    run('Conservation identity holds for every regime x shock', () => {
      let cells = 0;
      for (const reg of REGIMES) for (const s of SHOCKS) {
        const r = runRegime(reg.id, s);
        expect(r.conserved, reg.id + ' @ ' + s + ' off by ' + r.conservationError);
        cells++;
      }
      return cells + ' cells reconcile';
    });
    run('Circuit breaker does not worsen realized liquidation deficits on the dense shock grid', () => {
      let cells = 0;
      for (let s = -50; s <= 50; s += 2.5) {
        const shock = Number(s.toFixed(2));
        const base = runRegime('cross20', shock), cb = runRegime('circuit', shock);
        expect(cb.badDebt <= base.badDebt + 1e-6, shock + ': breaker ' + cb.badDebt + ' worse than ' + base.badDebt);
        cells++;
      }
      return 'breaker <= cross on ' + cells + ' grid points';
    });
    run('CSV escaping blocks formula injection and quoting', () => {
      expect(csvEscape('=1+1') === "'=1+1", 'equals not escaped');
      expect(csvEscape('+cmd') === "'+cmd", 'plus not escaped');
      expect(csvEscape('a,b') === '"a,b"', 'comma not quoted');
      expect(csvEscape('x"y') === '"x""y"', 'quote not doubled');
      return 'injection-safe';
    });
    run('Audit export digest detects tampering', () => {
      const b = buildAuditBundle(-25);
      expect(verifyAuditJson(b.json).valid, 'fresh export failed verification');
      const tampered = b.json.replace('"shockPct": -25', '"shockPct": -30');
      expect(!verifyAuditJson(tampered).valid, 'tampered payload still verified');
      return 'fresh ok, tamper rejected';
    });
    run('#prs= bookmark round-trips and rejects junk', () => {
      const h = encodeBookmark({ shock: -25, regime: 'circuit', fund: 9000, positions: 20 });
      const d = decodeBookmark(h);
      expect(d && d.shock === -25 && d.regime === 'circuit' && d.fund === 9000 && d.positions === 20, 'round-trip mismatch');
      expect(decodeBookmark('#prs=AAAA') === null, 'junk accepted');
      expect(decodeBookmark('#other=x') === null, 'wrong prefix accepted');
      return 'round-trip ok';
    });
    run('Shock sweep reports the ADL cliff for unbuffered cross', () => {
      const s = shockSweep('cross20', [-10, -20, -30, -40, -50]);
      expect(s.cliffShockPct !== null, 'no cliff found where one must exist');
      return 'cliff at ' + s.cliffShockPct + '%';
    });
    run('All five named regimes are registered and stressable', () => {
      const ids = ['cross20', 'iso10', 'volscaled', 'circuit', 'gradadl'];
      for (const id of ids) {
        const r = runRegime(id, -25);
        expect(r.regime === id && r.conserved, id + ' failed');
      }
      return ids.length + ' regimes';
    });
    return { checks: results, passed: results.filter(r => r.pass).length, total: results.length, allPass: results.every(r => r.pass) };
  }

  const api = {
    REGIMES, SHOCKS, SWEEP_SHOCKS, MID, LIQ_FEE_RATE,
    regimeSpec, effectiveLeverage, effectiveMmr, buildUniverse,
    closedFormLiqPrice,
    runRegime, compareRegimes, shockSweep,
    sha256Hex, utf8Bytes,
    csvEscape, comparisonTable, buildAuditBundle, verifyAuditJson, AUDIT_DISCLAIMER,
    encodeBookmark, decodeBookmark, BOOKMARK_PREFIX,
    selfTests
  };
  return api;
}));
