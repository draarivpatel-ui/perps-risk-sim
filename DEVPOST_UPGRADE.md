# Perps Risk Sim: Upgrade Notes and Devpost Copy

Target: dreamDEX Perps Builder Bounty ($3,000, Somnia Tokyo testnet).

## Verified test results

Command, run from the repo root:

```
npm test
```

Which expands to:

```
node --test test/perps.test.js test/risklab.test.js test/adversarial.test.js test/compliance.test.js
```

Actual result: **222 tests, 222 pass, 0 fail.**

| Suite | Tests | What it locks |
| --- | --- | --- |
| `test/perps.test.js` | 76 | RNG, CLOB, TWAP and clamps, margin, liquidation, cascade, Monte Carlo, VaR/CVaR, combined report |
| `test/risklab.test.js` | 32 | VWAP, Kyle lambda, slippage curve and the pre-trade-mid regression fix, ADL waterfall, portfolio netting, funding ladder, Cornish-Fisher VaR, verification bundle |
| `test/adversarial.test.js` | 78 | Input validation and edge cases: nonfinite sizes and prices, invalid side strings, crossing limits, exact liquidation thresholds, caller-flag sanitizing, dust orders, VaR bounds, waterfall conservation, page hygiene |
| `test/compliance.test.js` | 10 | Zero dashes, zero model attributions, zero private details, docs consistent with the real count, no network calls |

Honesty harness: `python3 hark_honesty_and_defect_harness.py --audit repos/perps-risk-sim --project perps-risk-sim` reports **0 violations**.

## Architecture highlights

- `src/perps.js`: the core CLOB, funding TWAP, margin and liquidation solver, cascade engine, GBM plus jump diffusion Monte Carlo and the combined risk report. A real defect was fixed here: `marketOrder` measured slippage against the mid after consuming the book, so a non-mutating `quoteImpact` and a mutating fill disagreed. It now captures the pre-trade mid before walking the ladder. All 76 original tests still pass, and a regression test locks the fix.
- `src/risklab.js` (new): a pure financial analysis layer. `bookVWAP` prices the ladder at depth, `kyleLambda` fits a linear impact coefficient by least squares through the origin and reports the R2, `slippageCurve` proves every quote matches its fill, `insuranceWaterfall` reconciles a liquidation shortfall between the fund and auto-deleveraging by notional weight, `portfolioMargin` nets long and short legs before charging margin, `fundingLadder` accumulates a clamped rate across intervals, `returnMoments` and `cornishFisherVaR` compute sample skewness, excess kurtosis and a modified VaR quantile, and `verificationBundle` ties everything into one reproducible JSON object with eleven self checks.
- `app.js` and `index.html`: a new Risk Lab section with two interactive sliders (fund size and shortfall), a slippage-plus-fit line chart, a waterfall allocation chart, netting and modified-VaR readouts, a funding ladder chart and an accessible verification table. The Report section gained a second export that emits the full verification bundle plus a telemetry chip row reporting the self-check pass count.
- `style.css`: small additions for the data table and a screen-reader-only caption class. No new dependency, no build step, no network call.

## What is honest

- The whole model uses a synthetic book and no live market data. The README says so.
- Kyle lambda, the ADL waterfall, hedge benefit and Cornish-Fisher moments are computed over synthetic data produced by this implementation, not calibrated against a real venue.
- A reconciliation check proves arithmetic consistency inside the model, not correctness of any exchange's behaviour.
- Test counts and self-check results come from the suites and modules listed above. No live trading, partnership, deployment or user claim appears anywhere.

## Devpost description

**Perps Risk Sim** is a browser workbench for the mechanics that decide whether a leveraged perpetual position survives the day, built for the dreamDEX Perps Builder Bounty. Walk a central limit orderbook, price the funding basis, solve the exact maintenance-margin liquidation price, trigger a liquidation cascade, and stress the book with seeded geometric Brownian motion plus Merton jump diffusion.

The upgrade adds a risk laboratory built from real financial computations. A quote-versus-fill slippage curve verifies that pricing an order without mutating the book matches executing it, and it exposed a genuine defect: the core market order measured impact against the post-trade mid. That is now fixed and locked by a regression test. A Kyle lambda least-squares fit quantifies linear price impact with a reported R2. An insurance fund and auto-deleveraging waterfall reconciles a liquidation shortfall exactly between fund use and notional-weighted socialization. Cross-margin netting reports the hedge benefit of offsetting legs. Cornish-Fisher modified VaR uses the sample skewness and excess kurtosis of a seeded return series to shift the normal quantile.

Every module feeds a verification bundle with eleven self checks, exportable as reproducible JSON alongside the deterministic desk report. Zero dependencies, zero build step, zero network calls. 222 passing tests across four suites, including a compliance suite that locks the no-dash and no-AI-disclosure rules and an adversarial suite that locks input validation: nonfinite sizes and prices, unknown side strings, crossing limit orders, total price shocks and degenerate VaR parameters all raise a `RangeError` instead of producing NaN. The model stays explicitly a risk-education tool over synthetic data, not a pricing library or a trading system.

## Devpost bullets

- Real orderbook mathematics: path-walking fills, pre-trade-mid slippage that agrees with non-mutating quotes, a book VWAP and a Kyle lambda regression with a reported fit quality.
- A liquidation cascade, an exact closed-form liquidation price, and an insurance fund plus auto-deleveraging waterfall that reconciles shortfall to the cent.
- Cross-margin netting with hedge-benefit accounting, a clamped funding TWAP ladder and a cash-and-carry break-even.
- Seeded GBM plus Merton jump diffusion, parametric and Monte Carlo VaR, expected shortfall, and Cornish-Fisher modified VaR from computed sample moments.
- Honest and reproducible: 222 passing tests, 0 violations on the local honesty harness, a fixed pre-trade-mid defect with a regression test, hardened input validation, zero dependencies, and a plainly stated synthetic-data boundary.

## Submission checklist

- [x] Tests pass: 222 of 222.
- [x] Honesty harness: 0 violations.
- [x] No em dashes or en dashes in any file.
- [x] No model attributions or model names in any file.
- [x] README updated with accurate counts and scope.
- [x] DEVPOST_UPGRADE.md created with verified counts and copy.
- [x] No commit or push performed.
