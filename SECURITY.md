# Security policy

## Reporting a vulnerability

Use the private GitHub Security Advisory form at [Report a vulnerability](https://github.com/draarivpatel-ui/perps-risk-sim/security/advisories/new). Do not open a public issue, pull request or discussion with exploit details.

Never include a live secret, token, cookie, private key, victim hostname or proprietary payload in a report. Use synthetic values and redacted transcripts.

## Supported versions

| Version | Status |
| --- | --- |
| latest `main` | Supported |

Security fixes are applied to the latest state of the default branch.

## Scope

This policy covers the zero-dependency perpetual futures orderbook, funding, liquidation cascade, VaR simulator, browser application, shareable state handling and report exports.

In scope:

- A cross-site scripting or HTML injection path through market state, imported text, share links or report output.
- A serialization, deserialization or validation flaw that executes attacker-controlled code or corrupts another user workspace.
- A report export or spreadsheet escaping flaw that makes generated output execute a formula or script when opened.
- A client-side boundary flaw that sends simulator data off the device without a clear user action.

Out of scope:

- Browser, operating system, firmware or hardware vulnerabilities outside this repository.
- Damage caused by modified copies that do not come from this repository.
- Documented approximation or simulation limits, unless a report shows a specific validation or output integrity failure.

## Coordinated disclosure

- Acknowledgment: within 3 business days.
- Initial triage: within 14 calendar days.
- Fix or mitigation target: within 90 calendar days for confirmed reports.
- Coordinated public disclosure: up to 90 days by default, adjusted by mutual agreement when exploitation or user risk requires a different date.
