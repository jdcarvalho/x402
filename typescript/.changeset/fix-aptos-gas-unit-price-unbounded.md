---
"@x402/aptos": patch
---

Fixed a security vulnerability where an attacker could submit a sponsored transaction with an unbounded `gas_unit_price`, draining the facilitator's APT balance. Added a `MAX_GAS_UNIT_PRICE` ceiling (1,000 Octas, 10× the Aptos protocol minimum) checked in `verify()` before the fee-payer signature step.
