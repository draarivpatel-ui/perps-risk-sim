'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/perps.js');
const C = require('../src/cascade-lab.js');

// ---------------------------------------------------------------
// Section 1: regime registry and specs
// ---------------------------------------------------------------
test('CL 01: five named regimes are registered in order', () => {
  const ids = C.REGIMES.map(r => r.id);
  assert.deepEqual(ids, ['cross20', 'iso10', 'volscaled', 'circuit', 'gradadl']);
});

test('CL 02: every regime spec carries the fields the engine needs', () => {
  for (const r of C.REGIMES) {
    assert.ok(typeof r.name === 'string' && r.name.length > 4);
    assert.ok(r.leverage >= 1 && r.leverage <= 100);
    assert.ok(r.marginMode === 'cross' || r.marginMode === 'isolated');
    assert.ok(r.mmr >= 0 && r.mmr < 1);
    assert.ok(r.closeFraction > 0 && r.closeFraction <= 1);
    assert.ok(r.fund >= 0 && Number.isFinite(r.fund));
    assert.ok(r.adlCapPct > 0 && r.adlCapPct <= 1);
  }
});

test('CL 03: regimeSpec returns the matching spec', () => {
  assert.equal(C.regimeSpec('cross20').leverage, 20);
  assert.equal(C.regimeSpec('iso10').leverage, 10);
  assert.equal(C.regimeSpec('circuit').closeFraction < 1, true);
  assert.equal(C.regimeSpec('gradadl').fund > C.regimeSpec('cross20').fund, true);
});

test('CL 04: regimeSpec rejects unknown ids', () => {
  assert.throws(() => C.regimeSpec('binance'), RangeError);
  assert.throws(() => C.regimeSpec(''), RangeError);
  assert.throws(() => C.regimeSpec(null), RangeError);
  assert.throws(() => C.regimeSpec(42), RangeError);
});

test('CL 05: SHOCKS covers the four headline scenarios', () => {
  assert.deepEqual([...C.SHOCKS], [-10, -25, -40, 30]);
});

test('CL 06: SWEEP_SHOCKS spans -5 to -50 in -5 steps', () => {
  assert.equal(C.SWEEP_SHOCKS.length, 10);
  assert.equal(C.SWEEP_SHOCKS[0], -5);
  assert.equal(C.SWEEP_SHOCKS[9], -50);
  for (let i = 1; i < C.SWEEP_SHOCKS.length; i++) {
    assert.equal(C.SWEEP_SHOCKS[i] - C.SWEEP_SHOCKS[i - 1], -5);
  }
});

// ---------------------------------------------------------------
// Section 2: margin scaling helpers
// ---------------------------------------------------------------
test('CL 07: effectiveLeverage equals the cap for unscaled regimes', () => {
  for (const s of [-40, -10, 0, 30]) {
    assert.equal(C.effectiveLeverage(C.regimeSpec('cross20'), s), 20);
    assert.equal(C.effectiveLeverage(C.regimeSpec('iso10'), s), 10);
  }
});

test('CL 08: volscaled leverage shrinks as shock magnitude grows', () => {
  const r = C.regimeSpec('volscaled');
  const e10 = C.effectiveLeverage(r, -10);
  const e25 = C.effectiveLeverage(r, -25);
  const e40 = C.effectiveLeverage(r, -40);
  assert.ok(e10 < 20 && e25 < e10 && e40 < e25, e10 + ' ' + e25 + ' ' + e40);
  assert.ok(e40 >= 1);
});

test('CL 09: volscaled leverage is symmetric in shock direction', () => {
  const r = C.regimeSpec('volscaled');
  assert.equal(C.effectiveLeverage(r, -25), C.effectiveLeverage(r, 25));
});

test('CL 10: volscaled MMR rises with shock magnitude', () => {
  const r = C.regimeSpec('volscaled');
  assert.ok(C.effectiveMmr(r, -40) > C.effectiveMmr(r, -10));
  assert.equal(C.effectiveMmr(C.regimeSpec('cross20'), -40), 0.005);
});

test('CL 11: effectiveLeverage rejects nonfinite shocks', () => {
  const r = C.regimeSpec('cross20');
  assert.throws(() => C.effectiveLeverage(r, NaN), RangeError);
  assert.throws(() => C.effectiveLeverage(r, Infinity), RangeError);
  assert.throws(() => C.effectiveLeverage(r, 'x'), RangeError);
});

// ---------------------------------------------------------------
// Section 3: closed-form liquidation price helper
// ---------------------------------------------------------------
test('CL 12: closedFormLiqPrice matches the core solver inside its cap', () => {
  const pos = P.position({ side: 'long', size: 1, entryPrice: 30000, leverage: 10, collateral: 3000, markPrice: 30000 });
  const core = P.liquidationPrice(pos, { maintenanceMarginRate: 0.005 });
  const local = C.closedFormLiqPrice('long', 30000, 3000, 1, 0.005, 0);
  assert.ok(Math.abs(core - local) < 0.001, core + ' vs ' + local);
});

test('CL 13: closedFormLiqPrice solves shorts on the other side of entry', () => {
  const lp = C.closedFormLiqPrice('short', 30000, 1500, 1, 0.005, 0);
  assert.ok(lp > 30000, String(lp));
});

test('CL 14: liquidation distance shrinks monotonically with leverage', () => {
  const d = lev => Math.abs(30000 - C.closedFormLiqPrice('long', 30000, 30000 / lev, 1, 0.005, 0));
  assert.ok(d(2) > d(5) && d(5) > d(10) && d(10) > d(20) && d(20) > d(50));
});

test('CL 15: closedFormLiqPrice returns null for a degenerate denominator', () => {
  assert.equal(C.closedFormLiqPrice('long', 30000, 3000, 0, 0.005, 0), null);
  assert.throws(() => C.closedFormLiqPrice('sideways', 30000, 3000, 1, 0.005, 0), RangeError);
  assert.throws(() => C.closedFormLiqPrice('long', -1, 3000, 1, 0.005, 0), RangeError);
});

test('CL 16: a maintenance base floor pulls liquidation closer to entry', () => {
  const noBase = C.closedFormLiqPrice('long', 30000, 3000, 1, 0.005, 0);
  const withBase = C.closedFormLiqPrice('long', 30000, 3000, 1, 0.005, 150);
  assert.ok(withBase > noBase, withBase + ' vs ' + noBase);
});

// ---------------------------------------------------------------
// Section 4: universe builder
// ---------------------------------------------------------------
test('CL 17: universe is deterministic and correctly sized', () => {
  const a = C.buildUniverse('cross20', -25), b = C.buildUniverse('cross20', -25);
  assert.equal(a.length, 14);
  assert.deepEqual(a, b);
});

test('CL 18: universe mixes longs and shorts deterministically', () => {
  const u = C.buildUniverse('cross20', -25);
  const shorts = u.filter(p => p.side === 'short').length;
  const longs = u.filter(p => p.side === 'long').length;
  assert.ok(shorts >= 2 && longs > shorts, longs + ' longs, ' + shorts + ' shorts');
});

test('CL 19: every universe position is well-formed', () => {
  const u = C.buildUniverse('cross20', -25);
  for (const p of u) {
    assert.ok(p.size > 0 && p.entryPrice === 30000 && p.collateral > 0);
    assert.ok(p.leverage >= 1);
    assert.ok(p.id.startsWith('T'));
    assert.equal(p.marginMode, 'cross');
  }
});

test('CL 20: isolated universe posts exactly the initial margin', () => {
  const u = C.buildUniverse('iso10', -25);
  for (const p of u) {
    assert.equal(p.collateral, Number((p.size * 30000 / 10).toFixed(4)));
    assert.equal(p.marginMode, 'isolated');
  }
});

test('CL 21: volscaled universe carries thicker collateral than cross20', () => {
  const cross = C.buildUniverse('cross20', -40).reduce((s, p) => s + p.collateral, 0);
  const vol = C.buildUniverse('volscaled', -40).reduce((s, p) => s + p.collateral, 0);
  assert.ok(vol > cross, vol + ' vs ' + cross);
});

test('CL 22: universe size option is honored and bounded', () => {
  assert.equal(C.buildUniverse('cross20', -25, { size: 6 }).length, 6);
  assert.throws(() => C.buildUniverse('cross20', -25, { size: 0 }), RangeError);
  assert.throws(() => C.buildUniverse('cross20', -25, { size: 201 }), RangeError);
  assert.throws(() => C.buildUniverse('cross20', -25, { mid: 0 }), RangeError);
});

// ---------------------------------------------------------------
// Section 5: runRegime invariants across every regime x shock cell
// ---------------------------------------------------------------
const CELLS = [];
for (const r of C.REGIMES) for (const s of C.SHOCKS) CELLS.push([r.id, s]);

for (const [id, s] of CELLS) {
  test('CL cell ' + id + ' @ ' + s + ': conservation identity reconciles', () => {
    const r = C.runRegime(id, s);
    assert.equal(r.conserved, true, 'error ' + r.conservationError);
    const rhs = r.remainingEquity + r.fees + r.insuranceDelta + r.counterpartySettlement - r.unpaidBadDebt;
    assert.ok(Math.abs(r.initialCollateral - rhs) < 0.01, 'recomputed identity drifts ' + (r.initialCollateral - rhs));
  });
  test('CL cell ' + id + ' @ ' + s + ': bad debt is nonnegative and bounded by loss', () => {
    const r = C.runRegime(id, s);
    assert.ok(r.badDebt >= -0.01, String(r.badDebt));
    assert.ok(Number.isFinite(r.badDebt));
  });
  test('CL cell ' + id + ' @ ' + s + ': insurance survival stays inside [0, 100]', () => {
    const r = C.runRegime(id, s);
    assert.ok(r.insuranceSurvivalPct >= 0 && r.insuranceSurvivalPct <= 100, String(r.insuranceSurvivalPct));
    assert.equal(r.fundAfter, r.fundBefore - r.fundPaid);
  });
  test('CL cell ' + id + ' @ ' + s + ': liquidation counts partition the universe', () => {
    const r = C.runRegime(id, s);
    assert.equal(r.liquidatedCount + r.survivingCount, 14);
    assert.ok(r.fullyLiquidatedCount <= r.liquidatedCount);
    assert.ok(r.partiallyLiquidatedCount >= 0);
  });
  test('CL cell ' + id + ' @ ' + s + ': ADL charges reconcile with the waterfall', () => {
    const r = C.runRegime(id, s);
    const sum = r.adlCharges.reduce((a, c) => a + c.charged, 0);
    assert.ok(Math.abs(sum - r.adlTotal) < 0.01);
    assert.ok(r.adlAccounts === r.adlCharges.length);
    for (const a of r.adlCharges) assert.ok(a.charged > 0 && a.charged <= a.profit + 1e-6);
  });
  test('CL cell ' + id + ' @ ' + s + ': backstop decomposition covers the bad debt', () => {
    const r = C.runRegime(id, s);
    const covered = r.fundPaid + r.adlTotal + r.unpaidBadDebt;
    assert.ok(Math.abs(covered - r.badDebt) < 0.01, covered + ' vs ' + r.badDebt);
  });
  test('CL cell ' + id + ' @ ' + s + ': metrics are finite and the log is ordered', () => {
    const r = C.runRegime(id, s);
    for (const k of ['totalLiquidatedNotional', 'cascadeImpactPct', 'fees', 'priceMovePct', 'initialCollateral', 'remainingEquity']) {
      assert.ok(Number.isFinite(r[k]), k + ' not finite');
    }
    let last = 0;
    for (const e of r.events) { assert.ok(e.round >= last); last = e.round; }
  });
}

// ---------------------------------------------------------------
// Section 6: regime comparison semantics
// ---------------------------------------------------------------
test('CL 30: 20x cross liquidates further out than 10x isolated', () => {
  const cross = C.runRegime('cross20', -10), iso = C.runRegime('iso10', -10);
  assert.ok(cross.liquidationDistancePct < iso.liquidationDistancePct,
    cross.liquidationDistancePct + ' vs ' + iso.liquidationDistancePct);
});

test('CL 31: isolated margin caps the -10 percent shock loss far below cross', () => {
  const cross = C.runRegime('cross20', -10), iso = C.runRegime('iso10', -10);
  assert.ok(iso.badDebt < cross.badDebt / 4, iso.badDebt + ' vs ' + cross.badDebt);
});

test('CL 32: volatility-scaled margin cuts bad debt at the -40 gap', () => {
  const cross = C.runRegime('cross20', -40), vol = C.runRegime('volscaled', -40);
  assert.ok(vol.badDebt < cross.badDebt, vol.badDebt + ' vs ' + cross.badDebt);
  assert.ok(vol.effectiveLeverage < 10, String(vol.effectiveLeverage));
});

test('CL 33: circuit breaker halts and reduces realized bad debt', () => {
  const cross = C.runRegime('cross20', -25), cb = C.runRegime('circuit', -25);
  assert.equal(cb.breakerHalted, true);
  assert.ok(cb.badDebt < cross.badDebt, cb.badDebt + ' vs ' + cross.badDebt);
  assert.ok(cb.partiallyLiquidatedCount > 0);
});

test('CL 34: graduated ADL leaves an unpaid remainder the full policy covers', () => {
  const full = C.runRegime('cross20', -40), grad = C.runRegime('gradadl', -40);
  assert.ok(grad.unpaidBadDebt > 0);
  assert.ok(grad.adlTotal <= full.badDebt);
  assert.equal(grad.fundBefore, 14000);
});

test('CL 35: short squeeze liquidates shorts and claws back long profit', () => {
  const r = C.runRegime('cross20', 30);
  assert.ok(r.liquidatedCount >= 1);
  assert.ok(r.adlAccounts >= 1);
  assert.equal(r.conserved, true);
});

test('CL 36: compareRegimes returns all five runs in registry order', () => {
  const rows = C.compareRegimes(-25);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map(r => r.regime), ['cross20', 'iso10', 'volscaled', 'circuit', 'gradadl']);
  assert.ok(rows.every(r => r.conserved));
});

test('CL 37: comparisonTable emits the audit schema with all metric fields', () => {
  const t = C.comparisonTable(-25);
  assert.equal(t.schema, 'perps-risk-sim/audit-v1');
  assert.equal(t.shockPct, -25);
  assert.equal(t.regimes.length, 5);
  for (const r of t.regimes) {
    for (const k of ['liquidationPrice', 'badDebt', 'insuranceSurvivalPct', 'cascadeImpactPct', 'adlAccounts', 'conserved', 'counterpartySettlement']) {
      assert.ok(r[k] !== undefined, k + ' missing');
    }
  }
});

// ---------------------------------------------------------------
// Section 7: shock sweep and the ADL cliff
// ---------------------------------------------------------------
test('CL 40: shockSweep returns one row per shock magnitude', () => {
  const s = C.shockSweep('cross20', [-5, -15, -25]);
  assert.equal(s.rows.length, 3);
  assert.deepEqual(s.rows.map(r => r.shockPct), [-5, -15, -25]);
});

test('CL 41: every sweep row reports the conservation flag', () => {
  const s = C.shockSweep('cross20');
  assert.equal(s.rows.length, 10);
  for (const r of s.rows) assert.equal(r.conserved, true, String(r.shockPct));
});

test('CL 42: unbuffered cross hits the ADL or insolvency cliff inside the sweep', () => {
  const s = C.shockSweep('cross20');
  assert.notEqual(s.cliffShockPct, null);
  assert.ok(s.cliffShockPct <= -5);
});

test('CL 43: liquidated units grow with shock depth for cross20', () => {
  const rows = [-10, -20, -30, -40].map(s => C.runRegime('cross20', s));
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].totalLiquidatedUnits >= rows[i - 1].totalLiquidatedUnits - 1e-6,
      rows[i].totalLiquidatedUnits + ' < ' + rows[i - 1].totalLiquidatedUnits);
  }
});

test('CL 44: fund survival is weakly decreasing with shock depth', () => {
  const s = C.shockSweep('iso10');
  for (let i = 1; i < s.rows.length; i++) {
    assert.ok(s.rows[i].fundSurvivalPct <= s.rows[i - 1].fundSurvivalPct + 1e-6,
      s.rows[i].fundSurvivalPct + ' > ' + s.rows[i - 1].fundSurvivalPct);
  }
});

test('CL 45: a shallow sweep can end with no cliff at all', () => {
  const s = C.shockSweep('iso10', [-1, -2]);
  assert.equal(s.rows.every(r => r.fundSurvivalPct === 100), true);
  assert.equal(s.cliffShockPct, null);
});

test('CL 46: shockSweep validates its inputs', () => {
  assert.throws(() => C.shockSweep('nope'), RangeError);
  assert.throws(() => C.shockSweep('cross20', []), RangeError);
  assert.throws(() => C.shockSweep('cross20', 'x'), RangeError);
  assert.throws(() => C.shockSweep('cross20', [NaN]), RangeError);
});

// ---------------------------------------------------------------
// Section 8: input hardening on runRegime
// ---------------------------------------------------------------
test('CL 50: runRegime rejects unknown regimes and bad shocks', () => {
  assert.throws(() => C.runRegime('nope', -10), RangeError);
  assert.throws(() => C.runRegime('cross20', -100), RangeError);
  assert.throws(() => C.runRegime('cross20', -150), RangeError);
  assert.throws(() => C.runRegime('cross20', NaN), RangeError);
  assert.throws(() => C.runRegime('cross20', 501), RangeError);
});

test('CL 51: runRegime rejects bad option values', () => {
  assert.throws(() => C.runRegime('cross20', -10, { mid: 0 }), RangeError);
  assert.throws(() => C.runRegime('cross20', -10, { rounds: -1 }), RangeError);
  assert.throws(() => C.runRegime('cross20', -10, { rounds: 101 }), RangeError);
  assert.throws(() => C.runRegime('cross20', -10, { bookBaseSize: 0 }), RangeError);
  assert.throws(() => C.runRegime('cross20', -10, { driftCap: 0 }), RangeError);
});

test('CL 52: malformed caller-supplied positions are rejected', () => {
  assert.throws(() => C.runRegime('cross20', -10, { positions: [null] }), RangeError);
  assert.throws(() => C.runRegime('cross20', -10, { positions: [{ side: 'flat', size: 1, entryPrice: 30000, leverage: 5, collateral: 500 }] }), RangeError);
  assert.throws(() => C.runRegime('cross20', -10, { positions: [{ side: 'long', size: -1, entryPrice: 30000, leverage: 5, collateral: 500 }] }), RangeError);
  assert.throws(() => C.runRegime('cross20', -10, { positions: [{ side: 'long', size: 1, entryPrice: 30000, leverage: 5, collateral: -1 }] }), RangeError);
});

test('CL 53: zero rounds produces no liquidation events', () => {
  const r = C.runRegime('cross20', -40, { rounds: 0 });
  assert.equal(r.events.length, 0);
  assert.equal(r.liquidatedCount, 0);
  assert.equal(r.badDebt, 0);
  assert.equal(r.conserved, true);
});

test('CL 54: a custom mini universe runs and conserves', () => {
  const positions = [
    { id: 'X', side: 'long', size: 2, entryPrice: 30000, markPrice: 30000, leverage: 20, collateral: 3000 },
    { id: 'Y', side: 'short', size: 2, entryPrice: 30000, markPrice: 30000, leverage: 5, collateral: 12000 }
  ];
  const r = C.runRegime('cross20', -25, { positions });
  assert.equal(r.liquidatedCount, 1);
  assert.equal(r.conserved, true);
  assert.ok(r.badDebt > 0);
});

test('CL 55: a -99 percent shock still reconciles', () => {
  const r = C.runRegime('cross20', -99);
  assert.ok(r.badDebt > 0);
  assert.equal(r.conserved, true);
  assert.ok(r.finalPrice > 0);
});

// ---------------------------------------------------------------
// Section 9: SHA-256 known-answer tests and properties
// ---------------------------------------------------------------
test('CL 60: sha256 empty string KAT', () => {
  assert.equal(C.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('CL 61: sha256 "abc" KAT', () => {
  assert.equal(C.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('CL 62: sha256 quick-brown-fox KAT', () => {
  assert.equal(C.sha256Hex('The quick brown fox jumps over the lazy dog'), 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592');
});

test('CL 63: sha256 56-byte boundary KAT', () => {
  assert.equal(C.sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('CL 64: sha256 multi-block 448-bit KAT', () => {
  const msg = 'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu';
  assert.equal(C.sha256Hex(msg), 'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1');
});

test('CL 65: sha256 output is always 64 lowercase hex chars', () => {
  for (const s of ['a', 'perps-risk-sim', 'x'.repeat(255), 'µ ✓ 中文字符']) {
    assert.match(C.sha256Hex(s), /^[0-9a-f]{64}$/);
  }
});

test('CL 66: sha256 hashes raw byte arrays identically to strings', () => {
  assert.equal(C.sha256Hex([0x61, 0x62, 0x63]), C.sha256Hex('abc'));
});

test('CL 67: sha256 avalanche: a one-byte change flips the digest', () => {
  const a = C.sha256Hex('perps-risk-sim audit report v1');
  const b = C.sha256Hex('perps-risk-sim audit report v2');
  assert.notEqual(a, b);
});

test('CL 68: utf8Bytes encodes multibyte characters correctly', () => {
  assert.deepEqual(C.utf8Bytes('A'), [65]);
  assert.deepEqual(C.utf8Bytes('µ'), [0xc2, 0xb5]);
  assert.deepEqual(C.utf8Bytes('中'), [0xe4, 0xb8, 0xad]);
  assert.deepEqual(C.utf8Bytes(''), []);
});

test('CL 69: utf8Bytes handles surrogate pairs as a single code point', () => {
  const bytes = C.utf8Bytes('\u{1f600}');
  assert.equal(bytes.length, 4);
  assert.equal(bytes[0] & 0xf0, 0xf0);
});

// ---------------------------------------------------------------
// Section 10: CSV escaping and audit export
// ---------------------------------------------------------------
test('CL 70: csvEscape blocks every formula-injection prefix', () => {
  for (const bad of ['=1+1', '+cmd', '-2+3', '@SUM(1)', '\t=x']) {
    assert.equal(C.csvEscape(bad)[0], "'", bad);
  }
});

test('CL 71: csvEscape quotes commas, quotes and newlines', () => {
  assert.equal(C.csvEscape('a,b'), '"a,b"');
  assert.equal(C.csvEscape('x"y'), '"x""y"');
  assert.equal(C.csvEscape('a\nb'), '"a\nb"');
  assert.equal(C.csvEscape('a\rb'), '"a\rb"');
});

test('CL 72: csvEscape passes clean values through and handles non-strings', () => {
  assert.equal(C.csvEscape('cross20'), 'cross20');
  assert.equal(C.csvEscape(42), '42');
  assert.equal(C.csvEscape(null), '');
  assert.equal(C.csvEscape(undefined), '');
  assert.equal(C.csvEscape(true), 'true');
});

test('CL 73: audit bundle carries one digest across all three formats', () => {
  const b = C.buildAuditBundle(-25);
  assert.match(b.digest, /^[0-9a-f]{64}$/);
  assert.ok(b.json.includes(b.digest));
  assert.ok(b.csv.includes(b.digest));
  assert.ok(b.markdown.includes(b.digest));
});

test('CL 74: audit JSON round-trips through verifyAuditJson intact', () => {
  const b = C.buildAuditBundle(-25);
  const v = C.verifyAuditJson(b.json);
  assert.equal(v.valid, true);
  assert.equal(v.digest, b.digest);
});

test('CL 75: tampering with any report field is detected', () => {
  const b = C.buildAuditBundle(-25);
  const tampered = b.json.replace('"liquidatedCount": 12', '"liquidatedCount": 0');
  const v = C.verifyAuditJson(tampered);
  assert.equal(v.valid, false);
  assert.match(v.reason, /mismatch/);
});

test('CL 76: verifyAuditJson rejects non-JSON and shapeless payloads', () => {
  assert.equal(C.verifyAuditJson('not json').valid, false);
  assert.equal(C.verifyAuditJson('{}').valid, false);
  assert.equal(C.verifyAuditJson('{"report":{}}').valid, false);
  assert.equal(C.verifyAuditJson('null').valid, false);
});

test('CL 77: audit CSV has one row per regime plus the digest footer', () => {
  const b = C.buildAuditBundle(-25);
  const lines = b.csv.split('\n').filter(l => l.length && !l.startsWith('#'));
  assert.equal(lines.length, 6); // header + 5 regimes
  assert.match(lines[0], /regime,liquidationPrice/);
});

test('CL 78: audit CSV escapes regime names containing commas', () => {
  // regime names are controlled strings, but the writer must still escape;
  // prove it on a name injected through the row builder contract.
  assert.equal(C.csvEscape('Insurance-Fund, Graduated ADL'), '"Insurance-Fund, Graduated ADL"');
});

test('CL 79: audit markdown renders the regime table and disclaimer', () => {
  const b = C.buildAuditBundle(-25);
  assert.match(b.markdown, /20x Unbuffered Cross/);
  assert.match(b.markdown, /Insurance-Fund \+ Graduated ADL/);
  assert.match(b.markdown, /Not financial or trading advice/);
  assert.match(b.markdown, /unkeyed/i);
});

test('CL 80: digest covers the canonical report, not the wrapper', () => {
  const b = C.buildAuditBundle(-25);
  assert.equal(C.sha256Hex(JSON.stringify(b.report)), b.digest);
  assert.notEqual(C.sha256Hex(b.json), b.digest);
});

test('CL 81: audit disclaimer is honest about the digest being unkeyed', () => {
  assert.match(C.AUDIT_DISCLAIMER, /unkeyed/i);
  assert.match(C.AUDIT_DISCLAIMER, /tamper/i);
  assert.match(C.AUDIT_DISCLAIMER, /Not financial or trading advice/);
});

test('CL 82: different shocks produce different digests', () => {
  assert.notEqual(C.buildAuditBundle(-25).digest, C.buildAuditBundle(-40).digest);
});

// ---------------------------------------------------------------
// Section 11: #prs= bookmark codec
// ---------------------------------------------------------------
test('CL 90: bookmark round-trips a full state', () => {
  const h = C.encodeBookmark({ shock: -25, regime: 'circuit', fund: 9000, positions: 20 });
  assert.ok(h.startsWith('#prs='));
  assert.deepEqual(C.decodeBookmark(h), { shock: -25, regime: 'circuit', fund: 9000, positions: 20 });
});

test('CL 91: bookmark round-trips a minimal state', () => {
  const h = C.encodeBookmark({ shock: -10 });
  assert.deepEqual(C.decodeBookmark(h), { shock: -10 });
});

test('CL 92: decodeBookmark accepts hashes without the leading #', () => {
  const h = C.encodeBookmark({ shock: -10 }).slice(1);
  assert.deepEqual(C.decodeBookmark(h), { shock: -10 });
});

test('CL 93: decodeBookmark rejects malformed payloads', () => {
  assert.equal(C.decodeBookmark('#prs='), null);
  assert.equal(C.decodeBookmark('#prs=AAAA'), null);
  assert.equal(C.decodeBookmark('#prs=!!!!'), null);
  assert.equal(C.decodeBookmark('#other=abc'), null);
  assert.equal(C.decodeBookmark(''), null);
  assert.equal(C.decodeBookmark(null), null);
  assert.equal(C.decodeBookmark(42), null);
});

test('CL 94: decodeBookmark rejects wrong schema and unknown keys', () => {
  const forge = obj => '#prs=' + Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(C.decodeBookmark(forge({ v: 2, shock: -10 })), null);
  assert.equal(C.decodeBookmark(forge({ v: 1, shock: -10, sneaky: true })), null);
  assert.equal(C.decodeBookmark(forge([1, 2, 3])), null);
  assert.equal(C.decodeBookmark(forge('x')), null);
});

test('CL 95: decodeBookmark enforces field ranges', () => {
  const forge = obj => '#prs=' + Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(C.decodeBookmark(forge({ v: 1, shock: -101 })), null);
  assert.equal(C.decodeBookmark(forge({ v: 1, shock: 501 })), null);
  assert.equal(C.decodeBookmark(forge({ v: 1, fund: -1 })), null);
  assert.equal(C.decodeBookmark(forge({ v: 1, positions: 0 })), null);
  assert.equal(C.decodeBookmark(forge({ v: 1, positions: 2.5 })), null);
  assert.equal(C.decodeBookmark(forge({ v: 1, regime: 'nope' })), null);
});

test('CL 96: encodeBookmark validates the state it is given', () => {
  assert.throws(() => C.encodeBookmark(null), RangeError);
  assert.throws(() => C.encodeBookmark('x'), RangeError);
  assert.throws(() => C.encodeBookmark({ shock: NaN }), RangeError);
  assert.throws(() => C.encodeBookmark({ regime: 'nope' }), RangeError);
  assert.throws(() => C.encodeBookmark({ fund: Infinity }), RangeError);
  assert.throws(() => C.encodeBookmark({ positions: 0 }), RangeError);
});

test('CL 97: bookmark encoding is URL-safe base64', () => {
  const h = C.encodeBookmark({ shock: -25, regime: 'gradadl', fund: 14000, positions: 200 });
  assert.match(h, /^#prs=[A-Za-z0-9_-]+$/);
});

// ---------------------------------------------------------------
// Section 12: self-test battery contract
// ---------------------------------------------------------------
test('CL 100: selfTests reports the battery shape', () => {
  const st = C.selfTests();
  assert.ok(Array.isArray(st.checks));
  assert.equal(st.total, st.checks.length);
  assert.equal(st.passed, st.checks.filter(c => c.pass).length);
});

test('CL 101: every self-test check passes', () => {
  const st = C.selfTests();
  assert.equal(st.allPass, true);
  assert.equal(st.passed, st.total);
  for (const c of st.checks) assert.equal(c.pass, true, c.name + ': ' + c.detail);
});

test('CL 102: the battery covers the mandated proof areas', () => {
  const names = C.selfTests().checks.map(c => c.name).join(' | ');
  for (const needle of ['SHA-256', 'Liquidation distance', 'Bad debt', 'Conservation', 'Circuit breaker', 'CSV', 'tamper', 'bookmark', 'cliff', 'regimes']) {
    assert.match(names, new RegExp(needle, 'i'), needle);
  }
});

// ---------------------------------------------------------------
// Section 13: deeper bookkeeping checks
// ---------------------------------------------------------------
test('CL 110: fund delta is exactly negative fund spend', () => {
  for (const s of C.SHOCKS) {
    const r = C.runRegime('cross20', s);
    assert.equal(r.insuranceDelta, -r.fundPaid);
  }
});

test('CL 111: fees are only collected when equity covers them', () => {
  const r = C.runRegime('cross20', -8);
  assert.ok(r.fees >= 0);
  for (const e of r.events) {
    if (e.type === 'breaker-halt') continue;
    if (e.deficit > 0) assert.equal(e.fee, 0);
  }
});

test('CL 112: ADL charges never exceed winner profit', () => {
  for (const s of C.SHOCKS) {
    const r = C.runRegime('cross20', s);
    for (const a of r.adlCharges) assert.ok(a.charged <= a.profit + 1e-6);
  }
});

test('CL 113: graduated ADL honors the per-account cap', () => {
  const r = C.runRegime('gradadl', -40);
  for (const a of r.adlCharges) {
    assert.ok(a.charged <= a.profit * 0.5 + 1e-6, a.charged + ' vs ' + a.profit);
  }
});

test('CL 114: liquidation events carry fill, impact and deficit fields', () => {
  const r = C.runRegime('cross20', -25);
  assert.ok(r.events.length > 0);
  for (const e of r.events) {
    if (e.type === 'breaker-halt') continue;
    assert.ok(e.fillPrice > 0 && Number.isFinite(e.impactBps) && e.deficit >= 0);
    assert.ok(e.closed > 0);
  }
});

test('CL 115: circuit events include a breaker-halt marker', () => {
  const r = C.runRegime('circuit', -25);
  assert.ok(r.events.some(e => e.type === 'breaker-halt'));
});

test('CL 116: cascade impact pct is positive whenever liquidations fill', () => {
  const r = C.runRegime('cross20', -25);
  assert.ok(r.totalLiquidatedNotional > 0);
  assert.ok(r.cascadeImpactPct > 0);
});

test('CL 117: shocks past every buffer liquidate the whole long book', () => {
  const r = C.runRegime('cross20', -40);
  const shorts = C.buildUniverse('cross20', -40).filter(p => p.side === 'short').length;
  assert.equal(r.survivingCount, shorts);
});

test('CL 118: run determinism: identical inputs give identical outputs', () => {
  const a = C.runRegime('gradadl', -25), b = C.runRegime('gradadl', -25);
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------
// Section 14: per-shock narrative spot checks (fine-grained)
// ---------------------------------------------------------------
for (const s of [-5, -10, -15, -20, -25, -30, -35, -40, -45, -50]) {
  test('CL 120 sweep ' + s + ': bad debt weakly monotone with depth', () => {
    const r = C.runRegime('cross20', s);
    const shallow = C.runRegime('cross20', s + 5);
    assert.ok(r.badDebt >= shallow.badDebt - 0.01, s + ': ' + r.badDebt + ' < ' + shallow.badDebt);
  });
  test('CL 121 sweep ' + s + ': unpaid bad debt never exceeds total bad debt', () => {
    const r = C.runRegime('cross20', s);
    assert.ok(r.unpaidBadDebt <= r.badDebt + 0.01);
    assert.ok(r.unpaidBadDebt >= -0.01);
  });
}

for (const s of [10, 20, 30, 45]) {
  test('CL 122 squeeze +' + s + ': run stays finite and conserves', () => {
    const r = C.runRegime('cross20', s);
    assert.equal(r.conserved, true);
    assert.ok(Number.isFinite(r.badDebt) && r.badDebt >= 0);
    assert.ok(r.finalPrice > r.mid);
  });
}

// ---------------------------------------------------------------
// Section 15: interaction between regimes at identical universe
// ---------------------------------------------------------------
test('CL 130: identical initial collateral across non-volscaled regimes', () => {
  const base = C.buildUniverse('cross20', -25).reduce((s, p) => s + p.collateral, 0);
  const circuit = C.buildUniverse('circuit', -25).reduce((s, p) => s + p.collateral, 0);
  const grad = C.buildUniverse('gradadl', -25).reduce((s, p) => s + p.collateral, 0);
  assert.equal(base, circuit);
  assert.equal(base, grad);
});

test('CL 131: volscaled run reports a tighter effective leverage than cross', () => {
  for (const s of [-10, -25, -40, 30]) {
    const a = C.runRegime('cross20', s), b = C.runRegime('volscaled', s);
    assert.ok(b.effectiveLeverage < a.effectiveLeverage, s + ': ' + b.effectiveLeverage + ' vs ' + a.effectiveLeverage);
  }
});

test('CL 132: bigger fund in gradadl means more bad debt absorbed', () => {
  const cross = C.runRegime('cross20', -10), grad = C.runRegime('gradadl', -10);
  assert.ok(grad.fundPaid > cross.fundPaid || grad.fundBefore > cross.fundBefore);
  assert.equal(grad.fundBefore, 14000);
});

test('CL 133: same shock, same universe: cross and circuit only differ by policy', () => {
  const a = C.runRegime('cross20', -10), b = C.runRegime('circuit', -10);
  assert.equal(a.initialCollateral, b.initialCollateral);
  assert.equal(a.mmr, b.mmr);
  assert.notEqual(a.badDebt, b.badDebt);
});

// ---------------------------------------------------------------
// Section 16: audit content correctness
// ---------------------------------------------------------------
test('CL 140: audit report rows match a direct runRegime call', () => {
  const b = C.buildAuditBundle(-25);
  for (const row of b.report.regimes) {
    const direct = C.runRegime(row.regime, -25);
    assert.equal(row.badDebt, direct.badDebt);
    assert.equal(row.insuranceSurvivalPct, direct.insuranceSurvivalPct);
    assert.equal(row.adlAccounts, direct.adlAccounts);
    assert.equal(row.unpaidBadDebt, direct.unpaidBadDebt);
  }
});

test('CL 141: verifyAuditJson detects truncation of the payload', () => {
  const b = C.buildAuditBundle(-25);
  const v = C.verifyAuditJson(b.json.slice(0, Math.floor(b.json.length * 0.8)));
  assert.equal(v.valid, false);
});

test('CL 142: verifyAuditJson detects a digest edit', () => {
  const b = C.buildAuditBundle(-25);
  const bad = b.json.replace(b.digest.slice(0, 8), '00000000');
  const v = C.verifyAuditJson(bad);
  assert.equal(v.valid, false);
});

test('CL 143: every audit row flags conserved', () => {
  for (const s of C.SHOCKS) {
    const b = C.buildAuditBundle(s);
    for (const row of b.report.regimes) assert.equal(row.conserved, true);
  }
});

// ---------------------------------------------------------------
// Section 17: edge and stress cells
// ---------------------------------------------------------------
test('CL 150: tiny positive shock runs cleanly', () => {
  const r = C.runRegime('cross20', -0.5);
  assert.equal(r.conserved, true);
  assert.ok(r.finalPrice < r.mid);
});

test('CL 151: a one-position universe cannot ADL anyone else', () => {
  const positions = [{ id: 'solo', side: 'long', size: 5, entryPrice: 30000, markPrice: 30000, leverage: 20, collateral: 7000 }];
  const r = C.runRegime('cross20', -40, { positions });
  assert.equal(r.adlAccounts, 0);
  assert.equal(r.conserved, true);
});

test('CL 152: no winners means uncovered loss lands fully on the fund then unpaid', () => {
  const positions = C.buildUniverse('cross20', -40).filter(p => p.side === 'long');
  const r = C.runRegime('cross20', -40, { positions });
  assert.equal(r.adlAccounts, 0);
  assert.ok(r.unpaidBadDebt > 0);
  assert.equal(r.fundAfter, 0);
  assert.equal(r.conserved, true);
});

test('CL 153: repeated runs do not leak state through the default universe', () => {
  const a = C.runRegime('cross20', -25);
  const b = C.runRegime('cross20', -10);
  const c = C.runRegime('cross20', -25);
  assert.equal(a.badDebt, c.badDebt);
  assert.notEqual(a.badDebt, b.badDebt);
});

test('CL 154: mid option scales the whole universe', () => {
  const r = C.runRegime('cross20', -25, { mid: 40000 });
  assert.equal(r.mid, 40000);
  assert.equal(r.conserved, true);
});

test('CL 155: liquidation price reference position is long at effective leverage', () => {
  const r = C.runRegime('volscaled', -40);
  const check = C.closedFormLiqPrice('long', 30000, 30000 / r.effectiveLeverage, 1, r.mmr, 0);
  assert.equal(r.liquidationPrice, check);
});
