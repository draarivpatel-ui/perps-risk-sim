# Perps Risk Sim

A zero-dependency Perpetual Futures Orderbook, Funding-Rate Arbitrage, Cross-Margin Liquidation Cascade and VaR Simulator. Everything runs in the browser with plain JavaScript: no build step, no npm packages, no network calls.

Built for the **dreamDEX Perps Builder Bounty** on DoraHacks ($3,000, Somnia Tokyo testnet).

Live demo: https://aariv.me/perps-risk-sim/

## What is inside

- **CLOB depth and impact engine**: a resting limit orderbook with price levels on both sides. Market orders walk the ladder and report average fill, slippage in basis points, levels consumed and unfilled quantity. `quoteImpact` prices an order without mutating the book.
- **Funding rate TWAP clamp math**: time-weighted mark and index premiums, an interest component, a dampener and a symmetric clamp band. Includes the long/short payment direction, annualized rate and a cash-and-carry funding arbitrage break-even calculator.
- **Isolated vs cross margin solver**: exact closed-form liquidation price where account equity equals the maintenance margin, margin ratio, initial margin, liquidation penalty, and isolated versus cross risk comparison.
- **Liquidation cascade**: a price shock marks positions to market, force-closes undercollateralized ones into the book, and uses the resulting price drift to trigger further rounds. Full event log per round.
- **Monte Carlo GBM plus Merton jump diffusion**: seeded geometric Brownian motion with Poisson jumps, terminal-price histogram, 99% VaR, expected shortfall (CVaR), parametric VaR comparison, and a liquidation breach probability stress test.
- **Combined deterministic risk report** with JSON copy and download.

## Quick start

Open `index.html` in a browser. Or serve the folder:

```
python3 -m http.server 8000
```

Then visit `http://localhost:8000/`.

## Tests

```
node --test test/perps.test.js
```

76 passing unit tests cover the seeded RNG, CLOB fills and sorting, TWAP and funding clamps, margin and liquidation pricing, the cascade engine, Monte Carlo determinism, VaR/CVaR and the combined report.

## Library API

```
const perps = require('./src/perps.js');       // Node
// or in the browser: window.Perps
```

Selected functions: `Orderbook`, `twap`, `premiumBps`, `fundingRate`, `fundingTWAP`, `fundingPayment`, `fundingArbitrage`, `position`, `unrealizedPnl`, `equity`, `maintenanceMargin`, `liquidationPrice`, `isolatedVsCross`, `accountEquity`, `liquidationCascade`, `simulatePaths`, `parametricVaR`, `monteCarloVaR`, `liquidationStress`, `historicalVaR`, `riskReport`.

## Model assumptions

Volatility `sigma` and drift `mu` are annualized. Each simulation step is `1/(365 * stepsPerDay)` years, so a `horizonDays` day horizon spans exactly `horizonDays/365` years of Brownian motion. Jumps fire at an annual Poisson intensity `lambda` with a log-normal jump size. This is a risk-education model, not a pricing library or a trading system: it uses a synthetic book and no live market data.

## X posts

Tag `@DreamDEXSomnia` with a short clip of the liquidation cascade and the funding clamp controls. The workbench is a trader tool in the dreamDEX MVP sense: it makes orderbook impact, funding basis and liquidation risk legible before an order is placed.

## License

MIT. See `LICENSE`.
