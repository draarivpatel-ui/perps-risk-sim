# Perps Risk Sim: Upgrade Notes and Devpost Copy

Target: dreamDEX Perps Builder Bounty ($3,000, Somnia Tokyo testnet).

## Verified test results

Command, run from the repo root:

```
npm test
```

Which expands to:

```
node --test test/perps.test.js test/risklab.test.js test/adversarial.test.js test/cascadelab.test.js test/compliance.test.js
```

Actual result: **488 tests, 488 pass, 0 fail.**

| Suite | Tests | What it locks |
| --- | --- | --- |
| `test/perps.test.js` | 76 | RNG, CLOB, TWAP and clamps, margin, liquidation, cascade, Monte Carlo, VaR/CVaR, combined report |
| `test/risklab.test.js` | 32 | VWAP, Kyle lambda, slippage curve and the pre-trade-mid regression fix, ADL waterfall, portfolio netting, funding ladder, Cornish-Fisher VaR, verification bundle |
| `test/adversarial.test.js` | 104 | Input validation and edge cases: nonfinite sizes and prices, invalid side strings, crossing limits, exact liquidation thresholds, caller-flag sanitizing, dust orders, VaR bounds, waterfall conservation, page hygiene |
| `test/cascadelab.test.js` | 265 | Five-regime comparator, conservation identity across every regime and shock cell, shock sweep and ADL cliff, SHA-256 known answers, CSV escaping, audit tamper detection, bookmark codec, input hardening |
| `test/compliance.test.js` | 11 | Zero dashes, zero model attributions, zero private details, docs consistent with the real count, no network calls |

Honesty harness: `python3 hark_honesty_and_defect_harness.py --audit repos/perps-risk-sim --project perps-risk-sim` reports **0 violations**.

## Architecture highlights

- `src/perps.js`: the core CLOB, funding TWAP, margin and liquidation solver, cascade engine, GBM plus jump diffusion Monte Carlo and the combined risk report. A real defect was fixed here: `marketOrder` measured slippage against the mid after consuming the book, so a non-mutating `quoteImpact` and a mutating fill disagreed. It now captures the pre-trade mid before walking the ladder. All 76 original tests still pass, and a regression test locks the fix.
- `src/risklab.js` (new): a pure financial analysis layer. `bookVWAP` prices the ladder at depth, `kyleLambda` fits a linear impact coefficient by least squares through the origin and reports the R2, `slippageCurve` proves every quote matches its fill, `insuranceWaterfall` reconciles a liquidation shortfall between the fund and auto-deleveraging by notional weight, `portfolioMargin` nets long and short legs before charging margin, `fundingLadder` accumulates a clamped rate across intervals, `returnMoments` and `cornishFisherVaR` compute sample skewness, excess kurtosis and a modified VaR quantile, and `verificationBundle` ties everything into one reproducible JSON object with eleven self checks.
- `app.js` and `index.html`: a new Risk Lab section with two interactive sliders (fund size and shortfall), a slippage-plus-fit line chart, a waterfall allocation chart, netting and modified-VaR readouts, a funding ladder chart and an accessible verification table. The Report section gained a second export that emits the full verification bundle plus a telemetry chip row reporting the self-check pass count.
- `src/cascade-lab.js` (new): a five-regime stress comparator. Each regime (20x unbuffered cross, 10x isolated with static MMR, dynamic volatility-scaled margin, circuit-breaker plus partial liquidation, insurance fund plus graduated ADL) runs the same shock against the same deterministic 14-position universe, closes liquidations into the synthetic book, drifts the mark, settles collateral slice by slice, and waterfalls bad debt through the insurance fund, profit-weighted ADL clawbacks and an unpaid remainder. Every run reports the exact liquidation price, bad-debt socialization, fund survival, orderbook impact slippage, ADL account count and a conservation identity (initialCollateral == remainingEquity + fees + insuranceDelta + counterpartySettlement - unpaidBadDebt) verified across all twenty regime-and-shock cells. The module also carries a pure-JS FIPS 180-4 SHA-256, a CSV-injection-safe audit export in JSON, CSV and Markdown with one shared digest, a strict `#prs=` URL bookmark codec and a fourteen-check self-test battery.
- `style.css`: additions for the data table, the screen-reader-only caption class and the self-test result list. No new dependency, no build step, no network call.

## What is honest

- The whole model uses a synthetic book and no live market data. The README says so.
- Kyle lambda, the ADL waterfall, hedge benefit and Cornish-Fisher moments are computed over synthetic data produced by this implementation, not calibrated against a real venue.
- A reconciliation check proves arithmetic consistency inside the model, not correctness of any exchange's behaviour.
- Test counts and self-check results come from the suites and modules listed above. No live trading, partnership, deployment or user claim appears anywhere.

## Devpost description

**Perps Risk Sim** is a browser workbench for the mechanics that decide whether a leveraged perpetual position survives the day, built for the dreamDEX Perps Builder Bounty. Walk a central limit orderbook, price the funding basis, solve the exact maintenance-margin liquidation price, trigger a liquidation cascade, and stress the book with seeded geometric Brownian motion plus Merton jump diffusion.

The upgrade adds a risk laboratory built from real financial computations. A quote-versus-fill slippage curve verifies that pricing an order without mutating the book matches executing it, and it exposed a genuine defect: the core market order measured impact against the post-trade mid. That is now fixed and locked by a regression test. A Kyle lambda least-squares fit quantifies linear price impact with a reported R2. An insurance fund and auto-deleveraging waterfall reconciles a liquidation shortfall exactly between fund use and notional-weighted socialization. Cross-margin netting reports the hedge benefit of offsetting legs. Cornish-Fisher modified VaR uses the sample skewness and excess kurtosis of a seeded return series to shift the normal quantile.

The newest layer is a margin-regime stress comparator. Five deterministic exchange risk regimes are stressed against gap-down shocks and a short squeeze: the unbuffered 20x cross book socializes deep bad debt, isolated 10x caps account loss at posted margin, volatility-scaled margin thickens collateral before the gap lands, the circuit breaker plus partial liquidation halts the cascade mid-flight, and the graduated ADL policy spends a bigger fund before capping clawbacks at half of winner profit. Every run reconciles an exact conservation identity across the collateral pool, fees, the fund, counterparty settlement and any unpaid remainder. A shock sweep from -5% to -50% marks the first magnitude where ADL or insolvency triggers. The stress audit exports as checksummed JSON, CSV and Markdown under one unkeyed SHA-256 tamper-detection digest, and a strict URL hash codec bookmarks the comparator state.

Every module feeds a verification bundle with eleven self checks, exportable as reproducible JSON alongside the deterministic desk report. Zero dependencies, zero build step, zero network calls. 488 passing tests across five suites, including a compliance suite that locks the no-dash and no-AI-disclosure rules and an adversarial suite that locks input validation: nonfinite sizes and prices, unknown side strings, crossing limit orders, total price shocks and degenerate VaR parameters all raise a `RangeError` instead of producing NaN. The model stays explicitly a risk-education tool over synthetic data, not a pricing library or a trading system.

## Devpost bullets

- Real orderbook mathematics: path-walking fills, pre-trade-mid slippage that agrees with non-mutating quotes, a book VWAP and a Kyle lambda regression with a reported fit quality.
- A liquidation cascade, an exact closed-form liquidation price, and an insurance fund plus auto-deleveraging waterfall that reconciles shortfall to the cent.
- Cross-margin netting with hedge-benefit accounting, a clamped funding TWAP ladder and a cash-and-carry break-even.
- Seeded GBM plus Merton jump diffusion, parametric and Monte Carlo VaR, expected shortfall, and Cornish-Fisher modified VaR from computed sample moments.
- A five-regime liquidation and margin comparator with per-regime liquidation prices, bad-debt waterfalls, fund survival, ADL account counts and a cent-exact conservation identity, plus a -5% to -50% sweep chart with the insolvency cliff marked.
- Honest and reproducible: 488 passing tests, 0 violations on the local honesty harness, a fixed pre-trade-mid defect with a regression test, hardened input validation, zero dependencies, and a plainly stated synthetic-data boundary.

## Submission checklist

- [x] Tests pass: 488 of 488.
- [x] Honesty harness: 0 violations.
- [x] No em dashes or en dashes in any file.
- [x] No model attributions or model names in any file.
- [x] README updated with accurate counts and scope.
- [x] DEVPOST_UPGRADE.md created with verified counts and copy.
- [x] No commit or push performed.
