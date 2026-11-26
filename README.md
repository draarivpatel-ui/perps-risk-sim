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
- **Liquidation-cascade and margin-regime stress comparator**: five deterministic exchange risk regimes (20x unbuffered cross, 10x isolated with static MMR, dynamic volatility-scaled margin, circuit-breaker plus partial liquidation, insurance fund plus graduated ADL) stressed against four flash-crash and squeeze shocks on a shared synthetic position universe. Each run reports the exact liquidation price, bad-debt socialization, insurance-fund survival ratio, cascading orderbook impact slippage, ADL-triggered account count, and an equity/fund conservation identity that reconciles to the cent.
- **Price-shock sweep chart**: cumulative liquidated notional and insurance-fund spend across shock magnitudes from -5% to -50%, with the first ADL or insolvency trigger cliff marked.
- **SHA-256 checksummed stress-audit export**: a pure-JS FIPS 180-4 digest (honestly labeled as an unkeyed tamper-detection checksum, not a signature) over a canonical JSON report, rendered identically into JSON, CSV and Markdown. CSV fields are escaped against formula injection. In-page verify and tamper-test buttons recompute the digest live. A strict `#prs=` URL hash codec bookmarks the comparator state.
- **In-page self-test battery**: fourteen live checks covering SHA-256 known answers, leverage-to-liquidation-distance scaling, bad-debt nonnegativity and shock monotonicity, the conservation identity across every regime and shock, the circuit-breaker non-worsening invariant, CSV escaping, tamper detection and bookmark round-trips.
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
node --test test/perps.test.js test/risklab.test.js test/adversarial.test.js test/cascadelab.test.js test/compliance.test.js
```

489 passing tests (76 core, 32 risk lab, 104 adversarial hardening, 266 cascade lab, 11 compliance) cover the seeded RNG, CLOB fills and sorting, TWAP and funding clamps, margin and liquidation pricing, the cascade engine, Monte Carlo determinism, VaR/CVaR, the combined report, the slippage curve and the pre-trade-mid regression fix, the ADL waterfall, portfolio netting, funding ladders, Cornish-Fisher moments, the verification bundle, the five-regime stress comparator, the conservation identity across every regime and shock cell, the shock sweep and ADL cliff, SHA-256 known answers, CSV injection escaping, audit tamper detection, bookmark codec round-trips, adversarial input validation and edge-case invariants, and repository compliance rules.

Individual suites:

```
npm run test:core         # 76 tests
npm run test:risklab      # 32 tests
npm run test:adversarial  # 104 tests
npm run test:cascadelab   # 266 tests
npm run test:compliance   # 11 tests
```

## Library API

```
const perps = require('./src/perps.js');      // Node
const lab = require('./src/risklab.js');      // Node
const cascadeLab = require('./src/cascade-lab.js'); // Node
// or in the browser: window.Perps, window.PerpsRiskLab and window.PerpsCascadeLab
```

Selected core functions: `Orderbook`, `twap`, `premiumBps`, `fundingRate`, `fundingTWAP`, `fundingPayment`, `fundingArbitrage`, `position`, `unrealizedPnl`, `equity`, `maintenanceMargin`, `liquidationPrice`, `isolatedVsCross`, `accountEquity`, `liquidationCascade`, `simulatePaths`, `parametricVaR`, `monteCarloVaR`, `liquidationStress`, `historicalVaR`, `riskReport`.

Selected risk-lab functions: `bookVWAP`, `kyleLambda`, `slippageCurve`, `insuranceWaterfall`, `portfolioMargin`, `fundingLadder`, `returnMoments`, `cornishFisherVaR`, `verificationBundle`.

Selected cascade-lab functions: `runRegime`, `compareRegimes`, `shockSweep`, `closedFormLiqPrice`, `buildUniverse`, `sha256Hex`, `buildAuditBundle`, `verifyAuditJson`, `csvEscape`, `encodeBookmark`, `decodeBookmark`, `selfTests`.

## Model assumptions

Volatility `sigma` and drift `mu` are annualized. Each simulation step is `1/(365 * stepsPerDay)` years, so a `horizonDays` day horizon spans exactly `horizonDays/365` years of Brownian motion. Jumps fire at an annual Poisson intensity `lambda` with a log-normal jump size. This is a risk-education model, not a pricing library or a trading system: it uses a synthetic book and no live market data.

The risk lab computes a least-squares Kyle lambda on synthetic price-impact observations, an insurance waterfall that reconciles shortfall against fund use and socialized losses, and Cornish-Fisher moments from a seeded Monte Carlo sample. These are model outputs over synthetic data, not calibrated market estimates. The verification bundle reports every check it ran; no figure on screen is asserted without a computation behind it.

## Verification telemetry

The Risk Lab section runs six models at render time and shows a table of their checks. The Report section exports a verification bundle whose `selfChecks` object reports the outcome of eleven checks, including quote-versus-fill agreement, waterfall reconciliation, margin bounds, ladder reconciliation and CVaR ordering.

## X posts

Tag `@DreamDEXSomnia` with a short clip of the liquidation cascade and the funding clamp controls. The workbench is a trader tool in the dreamDEX MVP sense: it makes orderbook impact, funding basis and liquidation risk legible before an order is placed.

## License

MIT. See `LICENSE`.
