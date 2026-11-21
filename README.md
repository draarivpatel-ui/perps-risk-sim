# Perps Risk Sim

A zero-dependency Perpetual Futures Orderbook, Funding-Rate Arbitrage, Cross-Margin Liquidation Cascade and VaR Simulator. Everything runs in the browser with plain JavaScript: no build step, no npm packages, no network calls.

Built for the **dreamDEX Perps Builder Bounty** on DoraHacks ($3,000, Somnia Tokyo testnet).

Live demo: https://aariv.me/perps-risk-sim/

## What is inside

- **CLOB depth and impact engine**: a resting limit orderbook with price levels on both sides. Market orders walk the ladder and report average fill, slippage in basis points, levels consumed and unfilled quantity. `quoteImpact` prices an order without mutating the book. Slippage and impact are measured against the pre-trade mid, so a non-mutating quote and a mutating fill agree exactly at every size.
- **Funding rate TWAP clamp math**: time-weighted mark and index premiums, an interest component, a dampener and a symmetric clamp band. Includes the long/short payment direction, annualized rate and a cash-and-carry funding arbitrage break-even calculator.
- **Isolated vs cross margin solver**: exact closed-form liquidation price where account equity equals the maintenance margin, margin ratio, initial margin, liquidation penalty, and isolated versus cross risk comparison.
- **Liquidation cascade**: a price shock marks positions to market, force-closes undercollateralized ones into the book, and uses the resulting price drift to trigger further rounds. Full event log per round.
- **Monte Carlo GBM plus Merton jump diffusion**: seeded geometric Brownian motion with Poisson jumps, terminal-price histogram, 99% VaR, expected shortfall (CVaR), parametric VaR comparison, and a liquidation breach probability stress test.
- **Risk laboratory**: a quote-versus-fill slippage curve, a Kyle lambda price-impact regression solved by least squares, a book VWAP, an insurance fund and auto-deleveraging waterfall that reconciles exactly, cross-margin portfolio netting with hedge-benefit accounting, a multi-interval funding ladder, and Cornish-Fisher modified VaR from the sample skewness and excess kurtosis of a seeded return series.
- **Combined deterministic risk report** with JSON copy and download, plus a full verification bundle that exports every self check.
- **Hardened inputs**: every public entry point validates its arguments. Nonfinite sizes and prices, unknown side strings, crossing limit orders, degenerate books, bad margin config, total price shocks and out-of-range VaR parameters all raise a `RangeError` instead of producing NaN or silently defaulting.

## Quick start

Open `index.html` in a browser. Or serve the folder:

```
python3 -m http.server 8000
```

Then visit `http://localhost:8000/`.

## Tests

```
npm test
```

Which runs:

```
node --test test/perps.test.js test/risklab.test.js test/adversarial.test.js test/compliance.test.js
```

222 passing tests (76 core, 32 risk lab, 104 adversarial hardening, 10 compliance) cover the seeded RNG, CLOB fills and sorting, TWAP and funding clamps, margin and liquidation pricing, the cascade engine, Monte Carlo determinism, VaR/CVaR, the combined report, the slippage curve and the pre-trade-mid regression fix, the ADL waterfall, portfolio netting, funding ladders, Cornish-Fisher moments, the verification bundle, adversarial input validation and edge-case invariants, and repository compliance rules.

Individual suites:

```
npm run test:core         # 76 tests
npm run test:risklab      # 32 tests
npm run test:adversarial  # 78 tests
npm run test:compliance   # 10 tests
```

## Library API

```
const perps = require('./src/perps.js');      // Node
const lab = require('./src/risklab.js');      // Node
// or in the browser: window.Perps and window.PerpsRiskLab
```

Selected core functions: `Orderbook`, `twap`, `premiumBps`, `fundingRate`, `fundingTWAP`, `fundingPayment`, `fundingArbitrage`, `position`, `unrealizedPnl`, `equity`, `maintenanceMargin`, `liquidationPrice`, `isolatedVsCross`, `accountEquity`, `liquidationCascade`, `simulatePaths`, `parametricVaR`, `monteCarloVaR`, `liquidationStress`, `historicalVaR`, `riskReport`.

Selected risk-lab functions: `bookVWAP`, `kyleLambda`, `slippageCurve`, `insuranceWaterfall`, `portfolioMargin`, `fundingLadder`, `returnMoments`, `cornishFisherVaR`, `verificationBundle`.

## Model assumptions

Volatility `sigma` and drift `mu` are annualized. Each simulation step is `1/(365 * stepsPerDay)` years, so a `horizonDays` day horizon spans exactly `horizonDays/365` years of Brownian motion. Jumps fire at an annual Poisson intensity `lambda` with a log-normal jump size. This is a risk-education model, not a pricing library or a trading system: it uses a synthetic book and no live market data.

The risk lab computes a least-squares Kyle lambda on synthetic price-impact observations, an insurance waterfall that reconciles shortfall against fund use and socialized losses, and Cornish-Fisher moments from a seeded Monte Carlo sample. These are model outputs over synthetic data, not calibrated market estimates. The verification bundle reports every check it ran; no figure on screen is asserted without a computation behind it.

## Verification telemetry

The Risk Lab section runs six models at render time and shows a table of their checks. The Report section exports a verification bundle whose `selfChecks` object reports the outcome of eleven checks, including quote-versus-fill agreement, waterfall reconciliation, margin bounds, ladder reconciliation and CVaR ordering.

## X posts

Tag `@DreamDEXSomnia` with a short clip of the liquidation cascade and the funding clamp controls. The workbench is a trader tool in the dreamDEX MVP sense: it makes orderbook impact, funding basis and liquidation risk legible before an order is placed.

## License

MIT. See `LICENSE`.
